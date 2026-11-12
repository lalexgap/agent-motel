import { accessSync, constants, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "./config";
import { openDecisions, ownsStore } from "./decisions";

// The web UI's view of open decisions, and the link to the operator's
// decisions page. That page belongs to the `drop` service: whoever holds its
// URL can answer for the operator, so the URL is only ever returned to the
// caller of decisionsPageLink and never cached, logged or put in an error.

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

const text = (value: unknown): string | null => (typeof value === "string" && value.trim() ? value : null);

function decisionsEnabled(): boolean {
  try {
    return loadConfig().decisions !== false;
  } catch {
    return true;
  }
}

// Open decisions only, blocking first then oldest. A name the store CLI would
// slug to another agent's file owns no store (see ownsStore).
export function agentDecisions(name: string): WebDecision[] {
  if (!decisionsEnabled() || !ownsStore(name)) return [];
  return openDecisions(name).map((d) => ({
    id: d.id,
    question: d.question,
    options: Array.isArray(d.options) ? d.options.filter((o): o is string => typeof o === "string") : [],
    recommendation: text(d.recommendation),
    why: text(d.why),
    blocking: d.blocking === true,
    link: text(d.link),
    prs: Array.isArray(d.prs) ? d.prs.filter((p): p is string => typeof p === "string") : [],
    asked_at: text(d.asked_at),
  }));
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
