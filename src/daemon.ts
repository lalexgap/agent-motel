import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { daemonPidFile, daemonSocket, ensureDirs } from "./paths";
import { listAgents, setStatus } from "./state";
import { queueDepth } from "./queue";
import { hasSession } from "./tmux";
import { deliverNext } from "./deliver";
import { agentRows } from "./commands/ls";
import { cliEntrypoint } from "./settings";

export const DELIVERY_DELAY_MS = 500;
const RECONCILE_INTERVAL_MS = 15_000;

export interface DaemonHandle {
  stop(): void;
}

// The daemon layers on the file-based core: state files stay the source of
// truth; the daemon adds a place to connect to (live status) and takes over
// delivery scheduling from detached one-shot processes.
export function startDaemonServer(socketPath: string = daemonSocket()): DaemonHandle {
  ensureDirs();
  rmSync(socketPath, { force: true }); // clear stale socket from a crashed daemon
  const startedAt = new Date().toISOString();

  const server = Bun.serve({
    unix: socketPath,
    async fetch(req) {
      const path = new URL(req.url).pathname;

      if (req.method === "GET" && path === "/health") {
        return Response.json({ ok: true, pid: process.pid, startedAt });
      }
      if (req.method === "GET" && path === "/agents") {
        return Response.json(agentRows());
      }
      if (req.method === "POST" && path === "/event") {
        const { agent, event } = (await req.json()) as { agent?: string; event?: string };
        if (!agent || !event) return new Response("agent and event required", { status: 400 });
        if (event === "stop" && queueDepth(agent) > 0) {
          setTimeout(() => deliverNext(agent), DELIVERY_DELAY_MS);
        }
        return Response.json({ ok: true });
      }
      return new Response("not found", { status: 404 });
    },
  });

  // Sessions can die without a SessionEnd hook (tmux kill, reboot) — sweep
  // them to exited so status stays honest.
  const reconciler = setInterval(() => {
    for (const agent of listAgents()) {
      if (agent.status !== "exited" && !hasSession(agent.tmuxSession)) {
        setStatus(agent.name, "exited");
      }
    }
  }, RECONCILE_INTERVAL_MS);

  return {
    stop() {
      clearInterval(reconciler);
      server.stop(true);
      rmSync(socketPath, { force: true });
    },
  };
}

export async function daemonRequest(
  path: string,
  init?: RequestInit & { timeoutMs?: number },
): Promise<Response | null> {
  if (!existsSync(daemonSocket())) return null;
  try {
    return await fetch(`http://am${path}`, {
      ...init,
      unix: daemonSocket(),
      signal: AbortSignal.timeout(init?.timeoutMs ?? 1000),
    });
  } catch {
    return null;
  }
}

export async function daemonHealth(): Promise<{ pid: number; startedAt: string } | null> {
  const res = await daemonRequest("/health");
  if (!res?.ok) return null;
  return (await res.json()) as { pid: number; startedAt: string };
}

// Fire-and-forget event ping from a hook. Returns false if the daemon is
// unreachable so the caller can fall back to direct delivery.
export async function notifyDaemon(agent: string, event: string): Promise<boolean> {
  const res = await daemonRequest("/event", {
    method: "POST",
    body: JSON.stringify({ agent, event }),
    headers: { "content-type": "application/json" },
  });
  return !!res?.ok;
}

export function runForegroundDaemon(): void {
  const handle = startDaemonServer();
  writeFileSync(daemonPidFile(), String(process.pid) + "\n");
  const shutdown = () => {
    handle.stop();
    rmSync(daemonPidFile(), { force: true });
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  console.log(`am daemon listening on ${daemonSocket()} (pid ${process.pid})`);
}

export async function ensureDaemon(): Promise<boolean> {
  if (await daemonHealth()) return true;
  Bun.spawn({
    cmd: [process.execPath, cliEntrypoint(), "__daemon"],
    env: { ...process.env },
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  }).unref();
  // Give it a moment to bind the socket.
  for (let i = 0; i < 20; i++) {
    await Bun.sleep(100);
    if (await daemonHealth()) return true;
  }
  return false;
}

export function readDaemonPid(): number | null {
  if (!existsSync(daemonPidFile())) return null;
  const pid = Number(readFileSync(daemonPidFile(), "utf8").trim());
  return Number.isFinite(pid) ? pid : null;
}
