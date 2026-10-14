import { existsSync } from "node:fs";
import { join } from "node:path";
import { codexHome } from "./codexHooks";
import { loadConfig } from "./config";
import { agentProvider, agentSessionId, type AgentState } from "./state";

// Codex agents with remote control on attach their TUI to the machine's
// shared app-server daemon (`codex --remote unix://`) instead of running the
// agent in-process, which makes them reachable from Codex remote control.
// The daemon then owns the turn: its tool commands, its hooks, and its
// lifetime, which outlives the tmux pane.

// The default control socket; `--remote unix://` connects to the same one.
export const CODEX_DAEMON_ENDPOINT = "unix://";

export function codexDaemonSocket(): string {
  return join(codexHome(), "app-server-control", "app-server-control.sock");
}

// With --remote the TUI ignores the pane's cwd (the session would start in
// ~), so the agent's dir has to ride along explicitly.
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

// Make sure the daemon is up before a TUI tries to attach to it.
export function ensureCodexDaemon(): boolean {
  if (codexDaemonRunning()) return true;
  const started = Bun.spawnSync(["codex", "app-server", "daemon", "start"], {
    stdout: "ignore",
    stderr: "ignore",
    timeout: 20000,
  });
  return started.exitCode === 0 && codexDaemonRunning();
}

// Whether to launch daemon-attached, given the agent's requested mode. A
// daemon that won't come up must not cost the operator their agent: fall
// back to the in-process launch, and say so.
export function codexDaemonLaunch(requested: boolean, dir: string): boolean {
  if (!requested) return false;
  if (!ensureCodexDaemon()) {
    console.error("warning: codex app-server daemon unavailable — launching codex in-process (no remote control)");
    return false;
  }
  // A daemon-attached TUI asks to trust its exact dir, even one an in-process
  // codex would trust through its repo root — and nobody is there to answer
  // for a fresh worktree. Permissionless agents get it pre-trusted, which is
  // what answering that prompt writes.
  if (loadConfig().skipPermissions && !runDetached("trust-dir", dir)) {
    console.error(`warning: could not mark ${dir} trusted for codex — launching codex in-process (no remote control)`);
    return false;
  }
  return true;
}

type Call = (method: string, params: unknown) => Promise<any>;

// One JSON-RPC session over the daemon's control socket, which speaks
// websocket. Everything is bounded by timeoutMs; a wedged daemon rejects.
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

// Interrupt the thread's in-flight turn and kill its background terminals —
// what killing an in-process codex used to do implicitly.
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

// Record the dir as trusted through the daemon (it owns config.toml, and the
// TUI asks it), upserting only this project's entry.
export async function trustCodexDir(dir: string, opts: { socket?: string; timeoutMs?: number } = {}): Promise<void> {
  await withCodexAppServer(opts.socket ?? codexDaemonSocket(), opts.timeoutMs ?? 4000, (call) =>
    call("config/value/write", {
      keyPath: "projects",
      value: { [dir]: { trust_level: "trusted" } },
      mergeStrategy: "upsert",
    }),
  );
}

// Runs one of the commands at the bottom of this file in a child process, so
// the sync callers stay sync and a wedged daemon costs a few seconds at most.
function runDetached(command: "stop-thread" | "trust-dir", arg: string): boolean {
  const result = Bun.spawnSync([process.execPath, import.meta.path, command, arg, codexDaemonSocket()], {
    stdout: "ignore",
    stderr: "ignore",
    timeout: 6000,
  });
  return result.exitCode === 0;
}

// Synchronous, best-effort teardown for the kill paths (rm, stop, restart,
// move): killing the tmux pane only kills the TUI, and the daemon would keep
// working on the turn invisibly.
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
