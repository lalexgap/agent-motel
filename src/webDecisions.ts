import { accessSync, constants, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "./config";
import { openDecisions, ownsStore, parseDecisionStore, readDecisionStoreTextsResult, type Decision } from "./decisions";

// The decisions page URL lets its holder answer for the operator: return it
// only to decisionsPageLink's caller; never cache, log or put it in an error.

export interface WebDecision {
  id: string;
  question: string;
  options: string[];
  recommendation: string | null;
  why: string | null;
  blocking: boolean;
  link: string | null;
  prs: string[];
  asked_at: string | null;
}

export interface WebDecisionGroup {
  agent: string;
  decisions: WebDecision[];
}

export interface WebDecisionsReport {
  groups: WebDecisionGroup[];
  remoteHosts: string[];
  enabled: boolean;
  complete: boolean;
}

const text = (value: unknown): string | null => (typeof value === "string" && value.trim() ? value : null);

function decisionsEnabled(): boolean {
  try {
    return loadConfig().decisions !== false;
  } catch {
    return true;
  }
}

export type DecisionAction = "answer" | "withdraw";
export const DECISION_TEXT_MAX_BYTES = 4_000;
export const DECISION_CLI_TIMEOUT_MS = 20_000;

export function validDecisionId(value: unknown): value is string {
  return typeof value === "string" && /^d-[1-9][0-9]*$/.test(value) && value.length <= 40;
}

export function decisionText(value: unknown, required: boolean): string | null {
  if (value === undefined || value === null) return required ? null : "";
  if (typeof value !== "string" || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/.test(value)) return null;
  const trimmed = value.trim();
  if ((required && !trimmed) || new TextEncoder().encode(trimmed).length > DECISION_TEXT_MAX_BYTES) return null;
  return trimmed;
}

function webDecision(d: Decision): WebDecision {
  return {
    id: d.id,
    question: d.question,
    options: Array.isArray(d.options) ? d.options.filter((o): o is string => typeof o === "string") : [],
    recommendation: text(d.recommendation),
    why: text(d.why),
    blocking: d.blocking === true,
    link: text(d.link),
    prs: Array.isArray(d.prs) ? d.prs.filter((p): p is string => typeof p === "string") : [],
    asked_at: text(d.asked_at),
  };
}

function sortOpen(decisions: Decision[]): Decision[] {
  return decisions.filter((d) => d.status === "open").sort((a, b) =>
    Number(!!b.blocking) - Number(!!a.blocking) || (text(a.asked_at) ?? "").localeCompare(text(b.asked_at) ?? ""));
}

// Open decisions only, blocking first then oldest. A name the store CLI would
// slug to another agent's file owns no store (see ownsStore).
export function agentDecisions(name: string): WebDecision[] {
  if (!decisionsEnabled() || !ownsStore(name)) return [];
  return openDecisions(name).map(webDecision);
}

// This server's local stores only. Remote hosts are disclosed for coverage, but
// never traversed: their inboxes require a direct connection to that server.
export function decisionsReport(): WebDecisionsReport {
  const config = loadConfig();
  const remoteHosts = [...new Set(config.remotes ?? [])];
  if (config.decisions === false) return { groups: [], remoteHosts, enabled: false, complete: true };
  const groups: WebDecisionGroup[] = [];
  const result = readDecisionStoreTextsResult();
  let complete = result?.complete === true;
  for (const [agent, source] of result?.texts ?? []) {
    if (!validDecisionsAgent(agent)) continue;
    const store = parseDecisionStore(source);
    if (!store) { complete = false; continue; }
    const decisions = sortOpen(store.decisions).map(webDecision);
    if (decisions.length) groups.push({ agent, decisions });
  }
  groups.sort((a, b) => {
    const aBlocking = a.decisions.some((d) => d.blocking);
    const bBlocking = b.decisions.some((d) => d.blocking);
    const aOldest = a.decisions.map((d) => d.asked_at ?? "").sort()[0] ?? "";
    const bOldest = b.decisions.map((d) => d.asked_at ?? "").sort()[0] ?? "";
    return Number(bBlocking) - Number(aBlocking) || aOldest.localeCompare(bOldest) || a.agent.localeCompare(b.agent);
  });
  return { groups, remoteHosts, enabled: true, complete };
}

// The store's file-name rule, within drop's own `--agent` limit.
export function validDecisionsAgent(name: unknown): name is string {
  return typeof name === "string" && name.length > 0 && name.length <= 100 && ownsStore(name);
}

function executable(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function dropBinary(): string | null {
  const onPath = Bun.which("drop", { PATH: process.env.PATH ?? "" });
  if (onPath) return onPath;
  const fallback = join(process.env.HOME ?? homedir(), ".local", "bin", "drop");
  return executable(fallback) ? fallback : null;
}

function binary(name: string): string | null {
  const onPath = Bun.which(name, { PATH: process.env.PATH ?? "" });
  if (onPath) return onPath;
  const fallback = join(process.env.HOME ?? homedir(), ".local", "bin", name);
  return executable(fallback) ? fallback : null;
}

export type DecisionActionResult =
  | { ok: true; changed: boolean; status: "decided" | "withdrawn" }
  | { ok: false; status: 404 | 409 | 503; reason: "decision_cli_missing" | "decision_cli_failed" | "decision_cli_timeout" | "decision_not_found" | "decision_closed"; error: string };

function toolEnv(): Record<string, string> {
  const env = { ...process.env } as Record<string, string>;
  delete env.AGENTMGR_AGENT;
  delete env.DECISIONS_AGENT;
  delete env.DECISIONS_PLAN;
  return env;
}

async function notifyDecision(agent: string, id: string, action: DecisionAction, env: Record<string, string>): Promise<void> {
  const am = binary("am");
  if (!am) return;
  const verb = action === "answer" ? "answered" : "dismissed";
  const message = `[decision ${id}] Alex ${verb} this on the decisions page. Run \`decision inbox\`, then \`decision show ${id}\`, and act on it.`;
  const proc = Bun.spawn([am, "send", agent, message, "--from", "decisions-page"], {
    env, stdin: "ignore", stdout: "ignore", stderr: "ignore",
  });
  const timer = setTimeout(() => proc.kill("SIGKILL"), 10_000);
  try { await proc.exited; } catch { /* The outcome is already safely stored. */ }
  finally { clearTimeout(timer); }
}

export async function applyDecisionAction(
  agent: string,
  id: string,
  action: DecisionAction,
  value: string,
  timeoutMs = DECISION_CLI_TIMEOUT_MS,
): Promise<DecisionActionResult> {
  const cli = binary("decision");
  if (!cli) return { ok: false, status: 503, reason: "decision_cli_missing", error: "Decision answering is not available on this server." };
  const args = action === "answer"
    ? [cli, `--agent=${agent}`, "resolve", id, `--answer=${value}`, "--via", "page"]
    : [cli, `--agent=${agent}`, "withdraw", id, ...(value ? [`--reason=${value}`] : []), "--via", "page"];
  const env = toolEnv();
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn(args, { env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  } catch {
    return { ok: false, status: 503, reason: "decision_cli_failed", error: "Could not record this decision. Try again." };
  }
  const output = Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]).catch(() => null);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => { proc.kill("SIGKILL"); resolve("timeout"); }, timeoutMs);
  });
  try {
    const done = await Promise.race([output, timeout]);
    if (done === "timeout") return { ok: false, status: 503, reason: "decision_cli_timeout", error: "Recording the decision timed out. Refresh before trying again." };
    if (!done) return { ok: false, status: 503, reason: "decision_cli_failed", error: "Could not record this decision. Try again." };
    const [stdout, stderr, code] = done;
    if (code !== 0) {
      if (/\bis already (?:decided|withdrawn)\b/.test(stderr))
        return { ok: false, status: 409, reason: "decision_closed", error: "This decision is no longer open. Refresh to see its current state." };
      if (/\bno decision\b/.test(stderr))
        return { ok: false, status: 404, reason: "decision_not_found", error: "This decision no longer exists. Refresh the list." };
      return { ok: false, status: 503, reason: "decision_cli_failed", error: "Could not record this decision. Try again." };
    }
    const changed = !!stdout.trim();
    if (changed) await notifyDecision(agent, id, action, env);
    return { ok: true, changed, status: action === "answer" ? "decided" : "withdrawn" };
  } finally {
    clearTimeout(timer);
  }
}

export type DecisionsLinkResult =
  | { ok: true; url: string }
  | { ok: false; status: 404 | 503; reason: "drop_missing" | "drop_failed" | "drop_timeout" | "drop_bad_output"; error: string };

export const DROP_TIMEOUT_MS = 10_000;

export async function decisionsPageLink(agent?: string, timeoutMs = DROP_TIMEOUT_MS): Promise<DecisionsLinkResult> {
  const binary = dropBinary();
  if (!binary) return { ok: false, status: 404, reason: "drop_missing", error: "The decisions page is not available on this server (drop is not installed)." };
  const proc = Bun.spawn([binary, "decisions", ...(agent ? ["--agent", agent] : [])], {
    stdin: "ignore", stdout: "pipe", stderr: "ignore",
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  // A killed drop can leave a child holding stdout open, so the timeout does not wait for it.
  const output = Promise.all([new Response(proc.stdout).text(), proc.exited]).catch(() => null);
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => { proc.kill("SIGKILL"); resolve("timeout"); }, timeoutMs);
  });
  try {
    const done = await Promise.race([output, timeout]);
    if (done === "timeout") return { ok: false, status: 503, reason: "drop_timeout", error: "The decisions page link timed out. Try again." };
    if (!done) return { ok: false, status: 503, reason: "drop_failed", error: "Could not get the decisions page link." };
    const [stdout, exitCode] = done;
    if (exitCode !== 0) return { ok: false, status: 503, reason: "drop_failed", error: "Could not get the decisions page link." };
    const url = stdout.split("\n").map((line) => line.trim()).find((line) => /^https:\/\/\S+$/.test(line));
    if (!url) return { ok: false, status: 503, reason: "drop_bad_output", error: "Could not get the decisions page link." };
    return { ok: true, url };
  } finally {
    clearTimeout(timer);
  }
}
