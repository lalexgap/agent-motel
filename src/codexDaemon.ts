import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { codexConfigFile, codexHome, tomlBasicString } from "./codexHooks";
import { loadConfig } from "./config";
import { nestedSessionVars } from "./nestedSession";
import { baseDir } from "./paths";
import { readJsonOrNull, writeJsonAtomic } from "./fsutil";
import { withFileLock } from "./filelock";
import { agentProvider, agentSessionId, listAgents, type AgentState } from "./state";
import { activeSubagents } from "./subagents";

// Remote-control codex agents attach their TUI to the shared app-server
// daemon. The daemon owns the turn, which outlives the tmux pane.

// The default control socket; `--remote unix://` connects to the same one.
export const CODEX_DAEMON_ENDPOINT = "unix://";

export function codexDaemonSocket(): string {
  return join(codexHome(), "app-server-control", "app-server-control.sock");
}

// With --remote the TUI ignores the pane's cwd, so pass the dir explicitly.
export function codexDaemonArgs(dir: string): string[] {
  return ["--remote", CODEX_DAEMON_ENDPOINT, "-C", dir];
}

function codexDaemonRunning(): boolean {
  const result = Bun.spawnSync(["codex", "app-server", "daemon", "version"], {
    stdout: "pipe",
    stderr: "ignore",
    timeout: 5000,
  });
  if (result.exitCode !== 0) return false;
  try {
    return JSON.parse(result.stdout.toString()).status === "running";
  } catch {
    return false;
  }
}

// The daemon outlives this process and runs every session's hooks: it must
// not inherit a spawning agent's identity or nested-session vars.
export function codexDaemonEnv(env: Record<string, string | undefined> = process.env): Record<string, string | undefined> {
  const scrubbed = { ...env };
  for (const key of nestedSessionVars(env)) delete scrubbed[key];
  for (const key of Object.keys(scrubbed)) {
    if (key.startsWith("AGENTMGR_") || key === "CODEX_THREAD_ID" || key === "CODEX_SESSION_ID") delete scrubbed[key];
  }
  return scrubbed;
}

export function ensureCodexDaemon(): boolean {
  if (codexDaemonRunning()) return true;
  const started = Bun.spawnSync(["codex", "app-server", "daemon", "start"], {
    env: codexDaemonEnv(),
    stdout: "ignore",
    stderr: "ignore",
    timeout: 20000,
  });
  return started.exitCode === 0 && codexDaemonRunning();
}

// Falls back to an in-process launch when the daemon can't be used.
export function codexDaemonLaunch(requested: boolean, dir: string): boolean {
  if (!requested) return false;
  if (!ensureCodexDaemon()) {
    console.error("warning: codex app-server daemon unavailable — launching codex in-process (no remote control)");
    return false;
  }
  // A daemon-attached TUI prompts to trust its exact dir (not its repo root),
  // and nobody is there to answer for a fresh worktree.
  if (loadConfig().skipPermissions && !pretrustCodexDir(dir)) {
    console.error(`warning: could not mark ${dir} trusted for codex — launching codex in-process (no remote control)`);
    return false;
  }
  return true;
}

type Call = (method: string, params: unknown) => Promise<any>;

// JSON-RPC over the daemon's websocket control socket, bounded by timeoutMs.
export async function withCodexAppServer<T>(
  socket: string,
  timeoutMs: number,
  fn: (call: Call) => Promise<T>,
): Promise<T> {
  const ws = new WebSocket(`ws+unix://${socket}`);
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  let nextId = 1;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const failAll = (error: Error) => {
    for (const p of pending.values()) p.reject(error);
    pending.clear();
  };
  ws.onmessage = (event) => {
    let msg: any;
    try {
      msg = JSON.parse(String(event.data));
    } catch {
      return;
    }
    // Responses only; notifications and server requests carry a method.
    if (typeof msg?.id !== "number" || "method" in msg) return;
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    if (msg.error) p.reject(new Error(msg.error.message ?? "app-server error"));
    else p.resolve(msg.result);
  };
  ws.onclose = () => failAll(new Error("app-server connection closed"));
  const call: Call = (method, params) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });
  const opened = new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = () => reject(new Error("app-server connection failed"));
  });
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("app-server timed out")), timeoutMs);
  });
  try {
    return await Promise.race([
      (async () => {
        await opened;
        // experimentalApi unlocks thread/backgroundTerminals/*.
        await call("initialize", {
          clientInfo: { name: "agent-motel", title: null, version: "0" },
          capabilities: { experimentalApi: true, requestAttestation: false },
        });
        ws.send(JSON.stringify({ method: "initialized" }));
        return fn(call);
      })(),
      deadline,
    ]);
  } finally {
    clearTimeout(timer);
    ws.close();
  }
}

type StopResult = { interrupted: boolean; cleaned: boolean };

async function stopThread(call: Call, threadId: string): Promise<StopResult> {
  let interrupted = false;
  let cleaned = false;
  try {
    const turns = await call("thread/turns/list", { threadId, limit: 1, sortDirection: "desc" });
    const active = (turns?.data ?? []).find((t: { status?: string }) => t.status === "inProgress");
    if (active) {
      await call("turn/interrupt", { threadId, turnId: active.id });
      interrupted = true;
    }
  } catch {
    // not loaded in the daemon, or nothing running — nothing to interrupt
  }
  try {
    await call("thread/backgroundTerminals/clean", { threadId });
    cleaned = true;
  } catch {
    // unsupported by this codex, or the thread isn't loaded
  }
  return { interrupted, cleaned };
}

export async function stopCodexThread(
  threadId: string,
  opts: { socket?: string; timeoutMs?: number } = {},
): Promise<StopResult> {
  return withCodexAppServer(opts.socket ?? codexDaemonSocket(), opts.timeoutMs ?? 4000, (call) => stopThread(call, threadId));
}

// One connection for all of them, in order.
export async function stopCodexThreads(
  threadIds: string[],
  opts: { socket?: string; timeoutMs?: number } = {},
): Promise<StopResult[]> {
  return withCodexAppServer(opts.socket ?? codexDaemonSocket(), opts.timeoutMs ?? 4000, async (call) => {
    const results: StopResult[] = [];
    for (const id of threadIds) results.push(await stopThread(call, id));
    return results;
  });
}

// Written through the daemon, which owns config.toml.
export async function trustCodexDir(dir: string, opts: { socket?: string; timeoutMs?: number } = {}): Promise<void> {
  await withCodexAppServer(opts.socket ?? codexDaemonSocket(), opts.timeoutMs ?? 4000, (call) =>
    call("config/value/write", {
      keyPath: "projects",
      value: { [dir]: { trust_level: "trusted" } },
      mergeStrategy: "upsert",
    }),
  );
}

export async function untrustCodexDir(dir: string, opts: { socket?: string; timeoutMs?: number } = {}): Promise<void> {
  await withCodexAppServer(opts.socket ?? codexDaemonSocket(), opts.timeoutMs ?? 4000, (call) =>
    call("config/value/write", { keyPath: `projects.${tomlBasicString(dir)}`, value: null, mergeStrategy: "replace" }),
  );
}

export interface CodexThreadOpts {
  cwd: string;
  name: string;
  model?: string;
  effort?: string;
  // Resume rejects the bypass flag, so the thread gets its permissions here.
  bypass: boolean;
}

// Created before the TUI so the agent's session id is known from the start.
// Naming it writes the rollout, without which `codex resume` can't find it.
export async function startCodexThread(
  opts: CodexThreadOpts,
  conn: { socket?: string; timeoutMs?: number } = {},
): Promise<string> {
  return withCodexAppServer(conn.socket ?? codexDaemonSocket(), conn.timeoutMs ?? 10000, async (call) => {
    const started = await call("thread/start", {
      cwd: opts.cwd,
      ...(opts.model ? { model: opts.model } : {}),
      ...(opts.effort ? { config: { model_reasoning_effort: opts.effort } } : {}),
      ...(opts.bypass ? { approvalPolicy: "never", sandbox: "danger-full-access" } : {}),
    });
    const threadId = started?.thread?.id;
    if (typeof threadId !== "string" || !threadId) throw new Error("app-server returned no thread id");
    await call("thread/name/set", { threadId, name: opts.name });
    return threadId;
  });
}

// A thread reloaded after a daemon restart takes config's permissions, not
// the ones it started with; a TUI resume of a loaded thread keeps these.
export async function resumeCodexThread(
  threadId: string,
  opts: { bypass: boolean },
  conn: { socket?: string; timeoutMs?: number } = {},
): Promise<void> {
  await withCodexAppServer(conn.socket ?? codexDaemonSocket(), conn.timeoutMs ?? 4000, (call) =>
    call("thread/resume", {
      threadId,
      ...(opts.bypass ? { approvalPolicy: "never", sandbox: "danger-full-access" } : {}),
    }),
  );
}

// Resume can't pass the bypass flag, so the thread is loaded with it first.
export function codexPreload(threadId: string | undefined, load = (id: string) => runDetached("load-thread", [id])): boolean {
  if (!threadId || !loadConfig().skipPermissions || load(threadId)) return true;
  console.error("warning: could not load the codex thread into the daemon — launching codex in-process (no remote control)");
  return false;
}

// Trust entries am wrote to config.toml (dir -> when), so cleanup never
// removes one the user made.
export function codexTrustLedgerFile(): string {
  return join(baseDir(), "codex-trusted-dirs.json");
}

export function readCodexTrustLedger(): Record<string, string> {
  return readJsonOrNull<Record<string, string>>(codexTrustLedgerFile()) ?? {};
}

function updateCodexTrustLedger(fn: (ledger: Record<string, string>) => void): void {
  mkdirSync(baseDir(), { recursive: true });
  withFileLock(`${codexTrustLedgerFile()}.lock`, () => {
    const ledger = readCodexTrustLedger();
    fn(ledger);
    writeJsonAtomic(codexTrustLedgerFile(), ledger);
  });
}

// The dir's [projects] entry: null when absent, undefined when config.toml
// can't be read or parsed.
export function codexProjectEntry(dir: string): Record<string, unknown> | null | undefined {
  try {
    const file = codexConfigFile();
    if (!existsSync(file)) return null;
    const projects = (Bun.TOML.parse(readFileSync(file, "utf8")) as { projects?: Record<string, unknown> }).projects;
    const entry = projects?.[dir];
    return entry && typeof entry === "object" ? (entry as Record<string, unknown>) : null;
  } catch {
    return undefined;
  }
}

function isAmTrustEntry(entry: Record<string, unknown>): boolean {
  const keys = Object.keys(entry);
  return keys.length === 1 && entry.trust_level === "trusted";
}

// An explicit trust level other than trusted is the user's choice: never
// overridden.
export function pretrustCodexDir(dir: string, write = (d: string) => runDetached("trust-dir", [d])): boolean {
  const entry = codexProjectEntry(dir);
  if (entry?.trust_level === "trusted") return true;
  if (entry && "trust_level" in entry) return false;
  if (!write(dir)) return false;
  if (entry === null) updateCodexTrustLedger((ledger) => void (ledger[dir] = new Date().toISOString()));
  return true;
}

// The dir, when its trust entry is am's to clean up.
export function amTrustedCodexDir(dir: string): string | undefined {
  return readCodexTrustLedger()[dir] ? dir : undefined;
}

// Drops am's trust entry for dir. False leaves it in the ledger for gc to
// retry. An entry the user has since edited is theirs: forgotten, kept.
export function forgetCodexTrust(
  dir: string,
  remove = (d: string) => existsSync(codexDaemonSocket()) && runDetached("untrust-dir", [d]),
): boolean {
  if (!readCodexTrustLedger()[dir]) return true;
  const entry = codexProjectEntry(dir);
  if (entry === undefined) return false;
  if (entry && isAmTrustEntry(entry) && !remove(dir)) return false;
  updateCodexTrustLedger((ledger) => void delete ledger[dir]);
  return true;
}

// On rm: release the agent's trusted dir unless another agent still uses it.
export function releaseCodexTrust(dir: string, owner: string, remove?: (dir: string) => boolean): void {
  if (!readCodexTrustLedger()[dir]) return;
  if (listAgents().some((a) => a.name !== owner && (a.dir === dir || a.codexTrustedDir === dir))) return;
  forgetCodexTrust(dir, remove);
}

// Child process so sync callers stay sync and a wedged daemon stays bounded.
function runDetached(command: "stop-thread" | "load-thread" | "trust-dir" | "untrust-dir", args: string[]): boolean {
  const result = Bun.spawnSync([process.execPath, import.meta.path, command, codexDaemonSocket(), ...args], {
    stdout: "ignore",
    stderr: "ignore",
    timeout: 6000,
  });
  return result.exitCode === 0;
}

// Killing the tmux pane only kills the TUI; the daemon keeps running the turn,
// and each codex subagent's turn on its own thread.
export function stopCodexDaemonWork(agent: AgentState, stop = (ids: string[]) => runDetached("stop-thread", ids)): void {
  if (agentProvider(agent) !== "codex" || !agent.codexDaemon) return;
  const threadId = agentSessionId(agent);
  if (!threadId || !existsSync(codexDaemonSocket())) return;
  const subagents = activeSubagents(agent.name).map((r) => r.id).filter((id) => id !== threadId);
  stop([threadId, ...new Set(subagents)]);
}

if (import.meta.main) {
  const [command, socket, ...args] = process.argv.slice(2);
  const arg = args[0];
  try {
    if (command === "stop-thread" && arg) await stopCodexThreads(args, { socket, timeoutMs: 5000 });
    else if (command === "load-thread" && arg) await resumeCodexThread(arg, { bypass: true }, { socket });
    else if (command === "trust-dir" && arg) await trustCodexDir(arg, { socket });
    else if (command === "untrust-dir" && arg) await untrustCodexDir(arg, { socket });
    else process.exit(2);
    process.exit(0);
  } catch {
    process.exit(1);
  }
}
