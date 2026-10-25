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

// One overall budget per user-facing command, shared by every daemon call in
// it, so a wedged daemon costs one deadline rather than a stack of timeouts.
// Once a call misses it, the rest of the command skips the daemon.
export interface CodexDeadline {
  at: number;
  missed: boolean;
  parent?: CodexDeadline;
}

export const CODEX_LAUNCH_BUDGET_MS = 10_000;
export const CODEX_STOP_BUDGET_MS = 6_000;

export function codexDeadline(ms: number, parent?: CodexDeadline): CodexDeadline {
  const at = Date.now() + ms;
  return { at: parent ? Math.min(at, parent.at) : at, missed: parent?.missed ?? false, parent };
}

export function deadlineRemaining(deadline: CodexDeadline): number {
  return deadline.missed ? 0 : Math.max(0, deadline.at - Date.now());
}

export function missDeadline(deadline: CodexDeadline): void {
  for (let d: CodexDeadline | undefined = deadline; d; d = d.parent) d.missed = true;
}

// Too little time left to start a child and get an answer back.
const MIN_CALL_MS = 500;

function codexDaemonRunning(deadline: CodexDeadline): boolean {
  const timeout = deadlineRemaining(deadline);
  if (timeout < MIN_CALL_MS) return false;
  const result = Bun.spawnSync(["codex", "app-server", "daemon", "version"], {
    stdout: "pipe",
    stderr: "ignore",
    timeout,
  });
  if (result.exitCode === null) missDeadline(deadline);
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

export function ensureCodexDaemon(deadline: CodexDeadline): boolean {
  if (codexDaemonRunning(deadline)) return true;
  const timeout = deadlineRemaining(deadline);
  if (timeout < MIN_CALL_MS) return false;
  const started = Bun.spawnSync(["codex", "app-server", "daemon", "start"], {
    env: codexDaemonEnv(),
    stdout: "ignore",
    stderr: "ignore",
    timeout,
  });
  if (started.exitCode === null) missDeadline(deadline);
  return started.exitCode === 0 && codexDaemonRunning(deadline);
}

const IN_PROCESS = "launching codex in-process (no remote control)";

function warnUnavailable(deadline: CodexDeadline, what: string): void {
  const why = deadline.missed ? "the codex app-server daemon didn't respond in time" : what;
  console.error(`warning: ${why} — ${IN_PROCESS}`);
}

// Falls back to an in-process launch when the daemon can't be used.
export function codexDaemonLaunch(requested: boolean, dir: string, deadline: CodexDeadline): boolean {
  if (!requested) return false;
  if (!ensureCodexDaemon(deadline)) {
    warnUnavailable(deadline, "codex app-server daemon unavailable");
    return false;
  }
  // A daemon-attached TUI prompts to trust its exact dir (not its repo root),
  // and nobody is there to answer for a fresh worktree.
  if (loadConfig().skipPermissions && !pretrustCodexDir(dir, deadline)) {
    warnUnavailable(deadline, `could not mark ${dir} trusted for codex`);
    return false;
  }
  return true;
}

// Resuming without a thread id (--continue, the picker, a pre-capture state
// file) leaves nothing to load with the current permissions first.
export function codexDaemonWanted(requested: boolean, resumesWithoutThread: boolean): boolean {
  if (!requested) return false;
  if (!resumesWithoutThread) return true;
  console.error(`note: no codex thread id to load into the daemon first — ${IN_PROCESS}`);
  return false;
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

async function loadedThreadIds(call: Call): Promise<string[]> {
  const ids: string[] = [];
  let cursor: string | null = null;
  do {
    const page = await call("thread/loaded/list", cursor ? { cursor } : {});
    ids.push(...(page?.data ?? []));
    cursor = page?.nextCursor ?? null;
  } while (cursor);
  return ids;
}

type ThreadMeta = { id: string; sessionId?: string; parentThreadId?: string | null };

// The loaded threads in rootId's tree: a parent chain back to it, or its
// session id (shared by a session's subagents).
export async function codexSubagentThreads(call: Call, rootId: string): Promise<string[]> {
  const ids = (await loadedThreadIds(call)).filter((id) => id !== rootId);
  const read = async (threadId: string): Promise<ThreadMeta | undefined> => {
    try {
      return (await call("thread/read", { threadId }))?.thread;
    } catch {
      return undefined;
    }
  };
  const [root, ...metas] = await Promise.all([read(rootId), ...ids.map(read)]);
  const threads = metas.filter((t): t is ThreadMeta => !!t?.parentThreadId);
  const parentOf = new Map(threads.map((t) => [t.id, t.parentThreadId!]));
  const descends = (id: string): boolean => {
    const seen = new Set<string>();
    for (let p = parentOf.get(id); p && !seen.has(p); p = parentOf.get(p)) {
      if (p === rootId) return true;
      seen.add(p);
    }
    return false;
  };
  return threads.filter((t) => descends(t.id) || (!!root?.sessionId && t.sessionId === root.sessionId)).map((t) => t.id);
}

// The root first, then its subagents over the same connection. Codex marks a
// subagent done at each turn end, so the ledger misses one still working
// after its parent's turn; it is only the fallback for a codex that can't
// list loaded threads.
export async function stopCodexThreadTree(
  rootId: string,
  fallbackSubagents: string[] = [],
  opts: { socket?: string; timeoutMs?: number } = {},
): Promise<StopResult[]> {
  return withCodexAppServer(opts.socket ?? codexDaemonSocket(), opts.timeoutMs ?? 4000, async (call) => {
    const results = [await stopThread(call, rootId)];
    let subagents: string[];
    try {
      subagents = await codexSubagentThreads(call, rootId);
    } catch {
      subagents = fallbackSubagents;
    }
    for (const id of new Set(subagents)) if (id !== rootId) results.push(await stopThread(call, id));
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
    // A fresh rollout has no turn context. Persist the permissions before the
    // TUI reconstructs it; thread/start's in-memory settings alone are lost.
    if (opts.bypass) {
      await call("thread/settings/update", { threadId, approvalPolicy: "never", sandboxPolicy: { type: "dangerFullAccess" } });
    }
    return threadId;
  });
}

// The thread takes this launch's permissions: bypass, or codex's defaults for
// its dir. Resume overrides only reach a thread the daemon hasn't loaded; a
// loaded one keeps its old settings (and a TUI resume keeps those), so they
// are replaced.
// The same goes for the agent's model and effort.
export async function resumeCodexThread(
  threadId: string,
  opts: { bypass: boolean } & CodexModelSettings,
  conn: { socket?: string; timeoutMs?: number } = {},
): Promise<void> {
  const model = {
    ...(opts.model ? { model: opts.model } : {}),
    ...(opts.effort ? { effort: opts.effort } : {}),
  };
  await withCodexAppServer(conn.socket ?? codexDaemonSocket(), conn.timeoutMs ?? 4000, async (call) => {
    const loaded = (await loadedThreadIds(call)).includes(threadId);
    const resumed = await call("thread/resume", {
      threadId,
      excludeTurns: true,
      ...(opts.model ? { model: opts.model } : {}),
      ...(opts.effort ? { config: { model_reasoning_effort: opts.effort } } : {}),
      ...(opts.bypass ? { approvalPolicy: "never", sandbox: "danger-full-access" } : {}),
    });
    if (!loaded) return;
    if (opts.bypass) {
      await call("thread/settings/update", { threadId, ...model, approvalPolicy: "never", sandboxPolicy: { type: "dangerFullAccess" } });
      return;
    }
    // Codex's defaults for the dir, read off a throwaway thread. It runs no
    // turn, so no hooks fire, and unloads once idle.
    const probe = await call("thread/start", { cwd: resumed?.cwd, ephemeral: true });
    if (probe?.thread?.id) await call("thread/unsubscribe", { threadId: probe.thread.id }).catch(() => undefined);
    if (!probe?.approvalPolicy) throw new Error("app-server returned no default permissions");
    const profile = probe.activePermissionProfile?.id;
    await call("thread/settings/update", {
      threadId,
      ...model,
      approvalPolicy: probe.approvalPolicy,
      ...(profile ? { permissions: profile } : { sandboxPolicy: probe.sandbox }),
    });
  });
}

export interface CodexModelSettings {
  model?: string;
  effort?: string;
}

// Resume can't pass permission flags, so the thread is loaded with the
// current skipPermissions (and the agent's model and effort) first.
export function codexPreload(
  threadId: string,
  deadline: CodexDeadline,
  load = (id: string, bypass: boolean, settings: CodexModelSettings) =>
    runDetached("load-thread", [id, bypass ? "bypass" : "default", settings.model ?? "", settings.effort ?? ""], deadline),
  settings: CodexModelSettings = {},
): boolean {
  if (load(threadId, loadConfig().skipPermissions, settings)) return true;
  warnUnavailable(deadline, "could not load the codex thread into the daemon");
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
export function pretrustCodexDir(
  dir: string,
  deadline: CodexDeadline,
  write = (d: string) => runDetached("trust-dir", [d], deadline),
): boolean {
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
  deadline = codexDeadline(CODEX_STOP_BUDGET_MS),
  remove = (d: string) => existsSync(codexDaemonSocket()) && runDetached("untrust-dir", [d], deadline),
): boolean {
  if (!readCodexTrustLedger()[dir]) return true;
  const entry = codexProjectEntry(dir);
  if (entry === undefined) return false;
  if (entry && isAmTrustEntry(entry) && !remove(dir)) return false;
  updateCodexTrustLedger((ledger) => void delete ledger[dir]);
  return true;
}

// On rm: release the agent's trusted dir unless another agent still uses it.
export function releaseCodexTrust(dir: string, owner: string, deadline?: CodexDeadline, remove?: (dir: string) => boolean): void {
  if (!readCodexTrustLedger()[dir]) return;
  if (listAgents().some((a) => a.name !== owner && (a.dir === dir || a.codexTrustedDir === dir))) return;
  forgetCodexTrust(dir, deadline, remove);
}

const CHILD_STARTUP_MS = 300;
const EXIT_TIMED_OUT = 3;

// Child process so sync callers stay sync; it gets what's left of the
// deadline, and a wedged daemon marks the deadline missed.
function runDetached(
  command: "stop-thread" | "load-thread" | "trust-dir" | "untrust-dir",
  args: string[],
  deadline: CodexDeadline,
): boolean {
  const timeout = deadlineRemaining(deadline);
  if (timeout < MIN_CALL_MS) return false;
  const result = Bun.spawnSync(
    [process.execPath, import.meta.path, command, codexDaemonSocket(), String(timeout - CHILD_STARTUP_MS), ...args],
    { stdout: "ignore", stderr: "ignore", timeout },
  );
  if (result.exitCode === null || result.exitCode === EXIT_TIMED_OUT) missDeadline(deadline);
  return result.exitCode === 0;
}

// Killing the tmux pane only kills the TUI; the daemon keeps running the turn,
// and each codex subagent's turn on its own thread. False when the daemon
// couldn't be told; the caller kills the pane regardless.
export function stopCodexDaemonWork(
  agent: AgentState,
  deadline = codexDeadline(CODEX_STOP_BUDGET_MS),
  stop = (ids: string[]) => runDetached("stop-thread", ids, deadline),
): boolean {
  if (agentProvider(agent) !== "codex" || !agent.codexDaemon) return true;
  const threadId = agentSessionId(agent);
  if (!threadId || !existsSync(codexDaemonSocket())) return true;
  const ledger = activeSubagents(agent.name).map((r) => r.id).filter((id) => id !== threadId);
  if (stop([threadId, ...new Set(ledger)])) return true;
  if (deadline.missed) console.error(`warning: the codex app-server daemon didn't respond in time — ${agent.name}'s turn may still be running in it`);
  return false;
}

if (import.meta.main) {
  const [command, socket, timeout, ...args] = process.argv.slice(2);
  const arg = args[0];
  const timeoutMs = Math.max(Number(timeout) || 0, 100);
  try {
    if (command === "stop-thread" && arg) await stopCodexThreadTree(arg, args.slice(1), { socket, timeoutMs });
    else if (command === "load-thread" && arg) {
      await resumeCodexThread(arg, { bypass: args[1] === "bypass", model: args[2] || undefined, effort: args[3] || undefined }, { socket, timeoutMs });
    }
    else if (command === "trust-dir" && arg) await trustCodexDir(arg, { socket, timeoutMs });
    else if (command === "untrust-dir" && arg) await untrustCodexDir(arg, { socket, timeoutMs });
    else process.exit(2);
    process.exit(0);
  } catch (error) {
    process.exit(/timed out/.test((error as Error).message) ? EXIT_TIMED_OUT : 1);
  }
}
