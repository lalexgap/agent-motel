import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { daemonPidFile, daemonSocket, ensureDirs } from "./paths";
import { listAgents, readAgent, setStatus } from "./state";
import { queueAppend, queueDepth } from "./queue";
import { hasSession } from "./tmux";
import { deliverNext } from "./deliver";
import { agentRows } from "./commands/ls";
import { cliEntrypoint } from "./settings";
import { loadConfig } from "./config";
import { sshAmAsync } from "./remote";
import { attribute } from "./comms";
import { collectedSender, type OutboxEntry } from "./outbox";

export const DELIVERY_DELAY_MS = 500;
const RECONCILE_INTERVAL_MS = 15_000;

// Inject one collected outbox entry into its local target. Attribution +
// rate limiting happen here (point 3): a cross-machine flood trips the same
// per-pair guard as a local send. The sender is qualified by host so the
// recipient sees "[am · from <name>@<host>] …" and can tell it came from afar.
async function injectCollected(entry: OutboxEntry, host: string): Promise<void> {
  const target = readAgent(entry.to);
  if (!target) return; // the name stopped being local since we advertised it
  const sender = collectedSender(entry.from, entry.fromHost, host);
  const att = attribute(sender, entry.to, entry.body, "send");
  if (!att.allowed) return; // cross-machine loop guard tripped
  queueAppend(entry.to, att.body);
  if (target.status === "idle" || target.status === "starting") {
    try {
      await deliverNext(entry.to);
    } catch (error) {
      console.error(`outbox delivery to ${entry.to} failed:`, error);
    }
  }
}

// Sweep each configured remote's outbox for messages addressed to our local
// agents — the collector half of store-and-forward. `am outbox --take`
// atomically returns-and-removes them; we inject locally. Never blocks the
// reconcile loop (ssh is async, errors are swallowed per host).
let collecting = false;
async function collectFromRemotes(): Promise<void> {
  if (collecting) return; // a prior sweep is still running — don't overlap
  const remotes = loadConfig().remotes ?? [];
  const localNames = listAgents().map((a) => a.name);
  if (remotes.length === 0 || localNames.length === 0) return;
  collecting = true;
  try {
    for (const host of remotes) {
      const res = await sshAmAsync(host, ["outbox", "--take", ...localNames], { timeoutMs: 8000 });
      if (res.exitCode !== 0) continue; // unreachable, or remote am predates outbox
      let entries: OutboxEntry[];
      try {
        entries = JSON.parse(res.stdout) as OutboxEntry[];
      } catch {
        continue; // not JSON — old am, ignore
      }
      for (const entry of entries) await injectCollected(entry, host);
    }
  } finally {
    collecting = false;
  }
}

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
          setTimeout(() => {
            try {
              void deliverNext(agent);
            } catch (error) {
              console.error(`delivery to ${agent} failed:`, error);
            }
          }, DELIVERY_DELAY_MS);
        }
        return Response.json({ ok: true });
      }
      return new Response("not found", { status: 404 });
    },
  });

  // Sessions can die without a SessionEnd hook (tmux kill, reboot) — sweep
  // them to exited so status stays honest. Also self-heal queues that got
  // stranded while an agent was idle (e.g. a send racing a status change):
  // an idle agent fires no Stop hook, so nothing else would drain them.
  const reconciler = setInterval(() => {
    for (const agent of listAgents()) {
      if (agent.status !== "exited" && !hasSession(agent.tmuxSession)) {
        setStatus(agent.name, "exited");
        continue;
      }
      if (agent.status === "idle" && queueDepth(agent.name) > 0) {
        try {
          void deliverNext(agent.name);
        } catch (error) {
          console.error(`delivery to ${agent.name} failed:`, error);
        }
      }
    }
    // Pull any store-and-forward messages waiting on the remotes for our
    // local agents. Fire-and-forget — must not stall the reconcile tick.
    void collectFromRemotes().catch((error) => console.error("outbox collect failed:", error));
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
