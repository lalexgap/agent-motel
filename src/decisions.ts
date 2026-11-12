import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { notificationPrUrl } from "./notifications";
import { trashDir } from "./paths";

// Read-only view of the decisions skill's per-agent store (agent-skills
// `decision` CLI). That store is the source of truth; am never writes its
// decisions, only moves the file with the agent.

export interface OpenDecision {
  id: string;
  question: string;
  blocking: boolean;
  askedAt?: string;
  link?: string;
  // Canonical PR URLs this decision is about: explicit `prs`, else a PR `link`.
  prs: string[];
}

const STORE_VERSION = 1;
const MAX_BYTES = 512 * 1024;

export function decisionsHome(): string {
  return process.env.DECISIONS_HOME || join(process.env.HOME ?? homedir(), ".local", "state", "agent-decisions");
}

// Mirrors the CLI's file naming.
function slug(name: string): string {
  return name.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[-.]+|[-.]+$/g, "") || "agent";
}

// Accepts a PR URL with a trailing path, query or fragment (`/files`, `#discussion_r1`).
function prUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const match = /^(https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/[1-9][0-9]*)(?:[/?#].*)?$/.exec(value.trim());
  return match ? notificationPrUrl(match[1]) : undefined;
}

// Store text reaches terminals: whitespace and C0/C1 controls (ESC, CSI, BEL) become one space.
export function flattenStoreText(text: string): string {
  return text.replace(/[\s\x00-\x1f\x7f-\x9f]+/g, " ").trim();
}

export function parseOpenDecisions(text: string): OpenDecision[] {
  let store: any;
  try { store = JSON.parse(text); } catch { return []; }
  if (!store || typeof store !== "object" || store.version !== STORE_VERSION || !Array.isArray(store.decisions)) return [];
  const open: OpenDecision[] = [];
  for (const item of store.decisions) {
    if (!item || item.status !== "open" || typeof item.id !== "string" || typeof item.question !== "string") continue;
    const tagged = ((Array.isArray(item.prs) ? item.prs : [item.pr]) as unknown[]).map(prUrl).filter((url): url is string => !!url);
    const link = prUrl(item.link);
    open.push({
      id: item.id.slice(0, 40),
      question: flattenStoreText(item.question).slice(0, 300),
      blocking: item.blocking === true,
      ...(typeof item.asked_at === "string" && Number.isFinite(Date.parse(item.asked_at)) ? { askedAt: item.asked_at } : {}),
      ...(typeof item.link === "string" && /^https:\/\//.test(item.link) ? { link: item.link.slice(0, 500) } : {}),
      prs: [...new Set(tagged.length ? tagged : link ? [link] : [])],
    });
  }
  return open;
}

export function readOpenDecisions(agent: string): OpenDecision[] {
  const text = readDecisionStoreText(agent);
  return text === undefined ? [] : parseOpenDecisions(text);
}

export type DecisionStatus = "open" | "decided" | "withdrawn";

// A whole-store entry, as the CLI writes it.
export interface Decision {
  id: string;
  status: DecisionStatus;
  question: string;
  options?: string[];
  recommendation?: string | null;
  why?: string | null;
  blocking?: boolean;
  link?: string | null;
  prs?: string[];
  asked_at?: string;
  updated_at?: string;
  decided_at?: string | null;
  answer?: string | null;
  answered_via?: string | null;
  acked_at?: string | null;
}

export interface DecisionStore {
  version: number;
  agent: string;
  host?: string;
  dir?: string;
  plan?: string | null;
  updated_at?: string;
  next_id?: number;
  decisions: Decision[];
}

export interface DecisionSummary {
  open: number;
  blocking: number;
  oldestAskedAt?: string;
  // The question shown first: blocking before the rest, then oldest.
  first?: string;
}

export function decisionStoreFile(name: string): string {
  return join(decisionsHome(), `${slug(name)}.json`);
}

// A name the CLI slugs to another agent's file (`foo-` → `foo.json`) does not own
// that store: it reads as having none and never moves it.
export function ownsStore(name: string): boolean {
  return slug(name) === name;
}

// Only a regular file within the cap: a FIFO or a huge stray file must not stall `am ls`.
function readStoreFile(path: string): string | undefined {
  const stat = statSync(path);
  return stat.isFile() && stat.size <= MAX_BYTES ? readFileSync(path, "utf8") : undefined;
}

const STATUSES = new Set<string>(["open", "decided", "withdrawn"]);

function validDecision(item: unknown): item is Decision {
  if (!item || typeof item !== "object") return false;
  const d = item as Record<string, unknown>;
  return typeof d.id === "string" && typeof d.status === "string" && STATUSES.has(d.status) && typeof d.question === "string";
}

// Same rules as parseOpenDecisions: a store it does not understand reads as
// none. Malformed entries are skipped.
export function parseDecisionStore(text: string): DecisionStore | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const store = raw as Record<string, unknown>;
  if (store.version !== STORE_VERSION || !Array.isArray(store.decisions)) return null;
  return { ...(store as unknown as DecisionStore), decisions: store.decisions.filter(validDecision) };
}

// The raw file, or undefined when it is missing, unreadable or oversized.
export function readDecisionStoreText(name: string): string | undefined {
  try {
    return readStoreFile(decisionStoreFile(name));
  } catch {
    return undefined;
  }
}

export function readDecisionStore(name: string): DecisionStore | null {
  const text = readDecisionStoreText(name);
  return text === undefined ? null : parseDecisionStore(text);
}

function sortOpen(decisions: Decision[]): Decision[] {
  return decisions
    .filter((d) => d.status === "open")
    .sort((a, b) => Number(!!b.blocking) - Number(!!a.blocking) || (a.asked_at ?? "").localeCompare(b.asked_at ?? ""));
}

// Blocking first, then oldest.
export function openDecisions(name: string): Decision[] {
  return sortOpen(readDecisionStore(name)?.decisions ?? []);
}

export function summarizeDecisions(decisions: Decision[]): DecisionSummary {
  const open = sortOpen(decisions);
  const asked = open.map((d) => d.asked_at).filter((at): at is string => !!at).sort();
  return {
    open: open.length,
    blocking: open.filter((d) => d.blocking).length,
    ...(asked[0] ? { oldestAskedAt: asked[0] } : {}),
    ...(open[0] ? { first: flattenStoreText(open[0].question) } : {}),
  };
}

export function decisionSummary(name: string): DecisionSummary {
  return summarizeDecisions(readDecisionStore(name)?.decisions ?? []);
}

// Every store's text in one directory read: `am ls` lists hundreds of agents
// every second and most have no store. Look one up with decisionStoreTextFor.
export function readDecisionStoreTexts(): Map<string, string> {
  return readDecisionStoreTextsResult()?.texts ?? new Map();
}

export function readDecisionStoreTextsIfAvailable(): Map<string, string> | null {
  return readDecisionStoreTextsResult()?.texts ?? null;
}

export function readDecisionStoreTextsResult(relevantNames?: string[]): { texts: Map<string, string>; complete: boolean } | null {
  const out = new Map<string, string>();
  const relevantSlugs = relevantNames === undefined ? null : new Set(relevantNames.filter(ownsStore).map(slug));
  let complete = true;
  let files: string[];
  try {
    files = readdirSync(decisionsHome());
  } catch {
    return null;
  }
  for (const file of files) {
    if (file.startsWith(".") || !file.endsWith(".json")) continue;
    try {
      const text = readStoreFile(join(decisionsHome(), file));
      if (text !== undefined) out.set(file.slice(0, -".json".length), text);
    } catch {
      if (relevantSlugs === null || relevantSlugs.has(file.slice(0, -".json".length))) complete = false;
    }
  }
  return { texts: out, complete };
}

export function decisionStoreTextFor(texts: Map<string, string>, name: string): string | undefined {
  return ownsStore(name) ? texts.get(slug(name)) : undefined;
}

// "2 decisions" / "1 decision (blocking)" / "3 decisions (1 blocking)". Pure.
export function decisionsLabel(open: number, blocking: number): string {
  const noun = `${open} decision${open === 1 ? "" : "s"}`;
  if (blocking === 0) return noun;
  return blocking === open ? `${noun} (blocking)` : `${noun} (${blocking} blocking)`;
}

// Rewrites the store's own fields after it changed hands; a file the reader
// cannot parse moves untouched.
function rewriteStore(path: string, fields: (raw: Record<string, unknown>) => Partial<DecisionStore>): void {
  try {
    const raw = JSON.parse(readFileSync(path, "utf8"));
    if (!raw || typeof raw !== "object" || Array.isArray(raw) || raw.version !== STORE_VERSION) return;
    const tmp = join(dirname(path), `.${basename(path)}.am-${process.pid}`);
    writeFileSync(tmp, JSON.stringify({ ...raw, ...fields(raw) }, null, 2) + "\n");
    renameSync(tmp, path);
  } catch {
    // the content is the CLI's; a failed rewrite leaves it as it was
  }
}

// The CLI's per-turn markers (`.<agent>.turn`, `.<agent>.nudge`).
function markerFile(name: string, kind: string): string {
  return join(decisionsHome(), `.${slug(name)}.${kind}`);
}

export function decisionStoreExists(name: string): boolean {
  return ownsStore(name) && existsSync(decisionStoreFile(name));
}

// The file is moved, never rewritten: the CLI may be writing it under its own lock,
// and it re-derives `agent` and `plan` from the file name on every load and save.
export function renameDecisionStore(oldName: string, newName: string): void {
  const from = decisionStoreFile(oldName);
  const to = decisionStoreFile(newName);
  if (!ownsStore(oldName) || !ownsStore(newName) || from === to || !existsSync(from) || existsSync(to)) return;
  renameSync(from, to);
  for (const kind of ["turn", "nudge"]) {
    try {
      if (existsSync(markerFile(oldName, kind))) renameSync(markerFile(oldName, kind), markerFile(newName, kind));
    } catch {
      // markers only scope the next stop check
    }
  }
}

// Not .json: listTrashed reads every .json in trash as an agent snapshot.
function trashedStoreFile(name: string): string {
  return join(trashDir(), `${name}.decisions`);
}

// Trash takes the store with the plan, so a removed agent's questions leave
// the decisions page and come back with `am restore`.
export function trashDecisionStore(name: string): void {
  const from = decisionStoreFile(name);
  if (!ownsStore(name) || !existsSync(from)) return;
  try {
    mkdirSync(trashDir(), { recursive: true });
    renameSync(from, trashedStoreFile(name));
  } catch {
    // losing the store must not leave a half-removed agent
  }
  for (const kind of ["turn", "nudge"]) rmSync(markerFile(name, kind), { force: true });
}

export function restoreDecisionStore(name: string): void {
  if (!ownsStore(name) || !existsSync(trashedStoreFile(name)) || existsSync(decisionStoreFile(name))) return;
  try {
    mkdirSync(decisionsHome(), { recursive: true });
    renameSync(trashedStoreFile(name), decisionStoreFile(name));
  } catch {
    // the agent comes back without its open questions
  }
}

export function removeTrashedDecisionStore(name: string): void {
  rmSync(trashedStoreFile(name), { force: true });
}

// Moved agents carry their store in the move payload; an existing local store
// wins. Returns whether this call created the file.
export function importDecisionStore(name: string, content: string | undefined, fields: Partial<DecisionStore>): boolean {
  if (content === undefined || !ownsStore(name) || !parseDecisionStore(content) || existsSync(decisionStoreFile(name))) return false;
  mkdirSync(decisionsHome(), { recursive: true });
  writeFileSync(decisionStoreFile(name), content, { flag: "wx" });
  rewriteStore(decisionStoreFile(name), () => ({ agent: name, ...fields }));
  return true;
}

export function removeDecisionStore(name: string): void {
  rmSync(decisionStoreFile(name), { force: true });
}
