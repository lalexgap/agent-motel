import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { notificationPrUrl } from "./notifications";
import { planFile, trashDir } from "./paths";

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
      question: item.question.replace(/[\s\x00-\x1f\x7f]+/g, " ").trim().slice(0, 300),
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
    const path = decisionStoreFile(name);
    return statSync(path).size > MAX_BYTES ? undefined : readFileSync(path, "utf8");
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
    ...(open[0] ? { first: open[0].question } : {}),
  };
}

export function decisionSummary(name: string): DecisionSummary {
  return summarizeDecisions(readDecisionStore(name)?.decisions ?? []);
}

// Every store's text in one directory read: `am ls` lists hundreds of agents
// every second and most have no store. Look one up with decisionStoreTextFor.
export function readDecisionStoreTexts(): Map<string, string> {
  const out = new Map<string, string>();
  let files: string[];
  try {
    files = readdirSync(decisionsHome());
  } catch {
    return out;
  }
  for (const file of files) {
    if (file.startsWith(".") || !file.endsWith(".json")) continue;
    try {
      const text = readFileSync(join(decisionsHome(), file), "utf8");
      if (text.length <= MAX_BYTES) out.set(file.slice(0, -".json".length), text);
    } catch {
      // unreadable: no decisions
    }
  }
  return out;
}

export function decisionStoreTextFor(texts: Map<string, string>, name: string): string | undefined {
  return texts.get(slug(name));
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
  return existsSync(decisionStoreFile(name));
}

// The store's plan path follows the plan only when it pointed at am's plan file.
export function renameDecisionStore(oldName: string, newName: string): void {
  const from = decisionStoreFile(oldName);
  const to = decisionStoreFile(newName);
  if (from === to || !existsSync(from) || existsSync(to)) return;
  renameSync(from, to);
  rewriteStore(to, (raw) => ({ agent: newName, ...(raw.plan === planFile(oldName) ? { plan: planFile(newName) } : {}) }));
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
  if (!existsSync(from)) return;
  try {
    mkdirSync(trashDir(), { recursive: true });
    renameSync(from, trashedStoreFile(name));
  } catch {
    // losing the store must not leave a half-removed agent
  }
  for (const kind of ["turn", "nudge"]) rmSync(markerFile(name, kind), { force: true });
}

export function restoreDecisionStore(name: string): void {
  if (!existsSync(trashedStoreFile(name)) || existsSync(decisionStoreFile(name))) return;
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
  if (content === undefined || !parseDecisionStore(content) || existsSync(decisionStoreFile(name))) return false;
  mkdirSync(decisionsHome(), { recursive: true });
  writeFileSync(decisionStoreFile(name), content, { flag: "wx" });
  rewriteStore(decisionStoreFile(name), () => ({ agent: name, ...fields }));
  return true;
}

export function removeDecisionStore(name: string): void {
  rmSync(decisionStoreFile(name), { force: true });
}
