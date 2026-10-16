import { existsSync } from "node:fs";
import { join } from "node:path";
import { codexHome } from "./codexHooks";
import { loadConfig } from "./config";
import { nestedSessionVars } from "./nestedSession";
import { agentProvider, agentSessionId, type AgentState } from "./state";

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
  for (const key of Object.keys(scrubbed)) if (key.startsWith("AGENTMGR_") || key === "CODEX_THREAD_ID") delete scrubbed[key];
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
  if (loadConfig().skipPermissions && !runDetached("trust-dir", dir)) {
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

export async function stopCodexThread(
  threadId: string,
  opts: { socket?: string; timeoutMs?: number } = {},
): Promise<{ interrupted: boolean; cleaned: boolean }> {
  return withCodexAppServer(opts.socket ?? codexDaemonSocket(), opts.timeoutMs ?? 4000, async (call) => {
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

// Child process so sync callers stay sync and a wedged daemon stays bounded.
function runDetached(command: "stop-thread" | "trust-dir", arg: string): boolean {
  const result = Bun.spawnSync([process.execPath, import.meta.path, command, arg, codexDaemonSocket()], {
    stdout: "ignore",
    stderr: "ignore",
    timeout: 6000,
  });
  return result.exitCode === 0;
}

// Killing the tmux pane only kills the TUI; the daemon keeps running the turn.
export function stopCodexDaemonWork(agent: AgentState): void {
  if (agentProvider(agent) !== "codex" || !agent.codexDaemon) return;
  const threadId = agentSessionId(agent);
  if (!threadId || !existsSync(codexDaemonSocket())) return;
  runDetached("stop-thread", threadId);
}

if (import.meta.main) {
  const [command, arg, socket] = process.argv.slice(2);
  try {
    if (command === "stop-thread" && arg) await stopCodexThread(arg, { socket });
    else if (command === "trust-dir" && arg) await trustCodexDir(arg, { socket });
    else process.exit(2);
    process.exit(0);
  } catch {
    process.exit(1);
  }
}
