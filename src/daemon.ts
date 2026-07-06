import { closeSync, existsSync, readFileSync, rmSync, statSync, truncateSync, writeFileSync } from "node:fs";
import { DAEMON_LOG_MAX_BYTES, daemonLogFile, daemonPidFile, daemonSocket, ensureDirs } from "./paths";
import { listAgents, readAgent, setStatus } from "./state";
import { queueAppend, queueDepth } from "./queue";
import { hasSession, sessionName } from "./tmux";
import { openLogFd } from "./fsutil";
import { deliverNext } from "./deliver";
import { agentRows } from "./commands/ls";
import { cliEntrypoint } from "./settings";
import { loadConfig } from "./config";
import { sshAmAsync } from "./remote";
import { attribute, seenRecently } from "./comms";
import { collectedSender, type OutboxEntry } from "./outbox";
import { newMsgId } from "./msgid";

export const DELIVERY_DELAY_MS = 500;
const RECONCILE_INTERVAL_MS = 15_000;

// The daemon's stdout/stderr are redirected to daemonLogFile() by ensureDaemon,
// so these lines are what you find when cross-machine mail stops flowing.
function log(message: string): void {
  console.error(`[${new Date().toISOString()}] ${message}`);
}

// Adaptive poll backoff: snap to the hot floor when mail just arrived, else
// grow ×1.5 toward the idle cap. Pure for testing.
export function nextPollMs(current: number, hotMs: number, maxMs: number, collected: number): number {
  if (collected > 0) return hotMs;
  return Math.min(Math.floor(current * 1.5), maxMs);
}

// Inject one collected outbox entry into its local target. Attribution +
// rate limiting happen here (point 3): a cross-machine flood trips the same
// per-pair guard as a local send. The sender is qualified by host so the
// recipient sees "[am · from <host>:<name>] …" and can reply across machines.
// Dedup by msgId makes redelivery (the price of at-least-once) invisible.
//
// Returns whether this entry is DONE (safe to ack). A rate-limited entry is NOT
// done: it returns false so the caller withholds the ack, and the claim is
// reclaimed and retried on a later sweep once the per-pair window clears —
// rather than being dropped *and* acked (= lost). msgId dedup keeps the retry
// from double-delivering the entries that did get through. [fixes review M1]
async function injectCollected(entry: OutboxEntry, host: string): Promise<boolean> {
  const target = readAgent(entry.to);
  // No readable state for this name. If a live managed session still exists,
  // the state is merely damaged (quarantined), not gone — defer (no ack)
  // rather than eat mail addressed to a running agent; the remote's TTL
  // bounces it observably if the state never comes back.
  if (!target) return !hasSession(sessionName(entry.to));
  if (entry.msgId && seenRecently(entry.msgId)) return true; // already delivered — dedup
  const sender = collectedSender(entry.from, entry.fromHost, host);
  const att = attribute(sender, entry.to, entry.body, "send", entry.msgId);
  if (!att.allowed) {
    // loop guard tripped — defer (don't ack) so it's retried, not lost
    log(`outbox: rate-limited collected message from ${sender} to ${entry.to} (deferred for retry)`);
    return false;
  }
  queueAppend(entry.to, att.body);
  if (target.status === "idle" || target.status === "starting") {
    try {
      await deliverNext(entry.to);
    } catch (error) {
      log(`outbox delivery to ${entry.to} failed: ${error}`);
    }
  }
  return true;
}

// Sweep one remote: claim its mail for our names, inject locally, then ack so
// it's deleted only after durable local delivery. Falls back to the legacy
// destructive `__outbox-take` when the remote predates claim/ack. Returns the
// number of messages collected (drives adaptive cadence).
async function collectFromHost(host: string, localNames: string[]): Promise<number> {
  const cid = newMsgId();
  const claim = await sshAmAsync(host, ["__outbox-claim", cid, ...localNames], { timeoutMs: 8000 });
  if (claim.exitCode === 0) {
    let entries: OutboxEntry[];
    try {
      entries = JSON.parse(claim.stdout) as OutboxEntry[];
    } catch {
      return 0; // not JSON — ignore this host this sweep
    }
    let ackable = true;
    for (const entry of entries) {
      if (!(await injectCollected(entry, host))) ackable = false;
    }
    // Ack only after every entry is durably queued locally AND none were
    // deferred (rate-limited). If we crash here, or withhold the ack, the remote
    // reclaims and redelivers → dedup absorbs what already landed, retries the rest.
    if (entries.length > 0 && ackable) await sshAmAsync(host, ["__outbox-ack", cid], { timeoutMs: 8000 });
    return entries.length;
  }
  // Old remote without claim/ack → legacy take (lossy, as before).
  const take = await sshAmAsync(host, ["__outbox-take", ...localNames], { timeoutMs: 8000 });
  if (take.exitCode !== 0) return 0; // unreachable, or remote am predates outbox
  let entries: OutboxEntry[];
  try {
    entries = JSON.parse(take.stdout) as OutboxEntry[];
  } catch {
    return 0;
  }
  for (const entry of entries) await injectCollected(entry, host);
  return entries.length;
}

// Sweep each configured remote's outbox for messages addressed to our local
// agents — the collector half of store-and-forward. Never blocks the poll loop
// (ssh is async, errors swallowed per host). Returns total messages collected.
let collecting = false;
async function collectFromRemotes(): Promise<number> {
  if (collecting) return 0; // a prior sweep is still running — don't overlap
  const remotes = loadConfig().remotes ?? [];
  const localNames = listAgents().map((a) => a.name);
  if (remotes.length === 0 || localNames.length === 0) return 0;
  collecting = true;
  let total = 0;
  try {
    for (const host of remotes) {
      try {
        total += await collectFromHost(host, localNames);
      } catch (error) {
        log(`outbox collect from ${host} failed: ${error}`);
      }
    }
  } finally {
    collecting = false;
  }
  return total;
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
            // .catch, not try/catch: deliverNext is async, so a try around a
            // `void` call could never see its failures.
            deliverNext(agent).catch((error) => log(`delivery to ${agent} failed: ${error}`));
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
    // Bound the log during a long run — rotation at spawn can't help a daemon
    // that stays up for weeks. Truncate in place: the inherited append fd
    // keeps writing at the (new) end, whereas a rename would divorce the fd
    // from the path.
    try {
      if (statSync(daemonLogFile()).size > DAEMON_LOG_MAX_BYTES) {
        truncateSync(daemonLogFile(), 0);
        log("log truncated (size cap)");
      }
    } catch {
      // no log yet
    }
    for (const agent of listAgents()) {
      if (agent.status !== "exited" && !hasSession(agent.tmuxSession)) {
        setStatus(agent.name, "exited");
        continue;
      }
      if (agent.status === "idle" && queueDepth(agent.name) > 0) {
        deliverNext(agent.name).catch((error) => log(`delivery to ${agent.name} failed: ${error}`));
      }
    }
  }, RECONCILE_INTERVAL_MS);

  // Pull store-and-forward messages from the remotes on its own ADAPTIVE
  // cadence (separate from the 15s local self-heal): poll the hot floor right
  // after mail arrives, back off ×1.5 to the cap when idle, snap back to hot on
  // the next message. A self-rescheduling timeout (not setInterval) so the
  // interval can change each tick; the `collecting` guard prevents pile-up.
  const cfg = loadConfig();
  const hotMs = Math.max(1, cfg.outboxPollSeconds) * 1000;
  const maxMs = Math.max(cfg.outboxPollSeconds, cfg.outboxPollMaxSeconds) * 1000;
  let pollMs = hotMs;
  let pollTimer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;

  function scheduleCollect(): void {
    const jitter = 0.9 + Math.random() * 0.2; // ±10% so multiple daemons don't thunder
    pollTimer = setTimeout(async () => {
      if (stopped) return;
      let collected = 0;
      try {
        collected = await collectFromRemotes();
      } catch (error) {
        log(`outbox collect failed: ${error}`);
      }
      pollMs = nextPollMs(pollMs, hotMs, maxMs, collected);
      if (!stopped) scheduleCollect();
    }, Math.floor(pollMs * jitter));
  }
  if (cfg.outboxPollSeconds > 0) scheduleCollect();

  return {
    stop() {
      stopped = true;
      clearInterval(reconciler);
      if (pollTimer) clearTimeout(pollTimer);
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
  log(`am daemon listening on ${daemonSocket()} (pid ${process.pid})`);
}

export async function ensureDaemon(): Promise<boolean> {
  if (await daemonHealth()) return true;
  let out: number | "ignore" = "ignore";
  try {
    out = openLogFd(daemonLogFile(), DAEMON_LOG_MAX_BYTES);
  } catch {
    // can't open a log file — run the daemon silent rather than not at all
  }
  try {
    Bun.spawn({
      cmd: [process.execPath, cliEntrypoint(), "__daemon"],
      env: { ...process.env },
      stdin: "ignore",
      stdout: out,
      stderr: out,
    }).unref();
  } finally {
    // The child holds its own copy — close ours so repeated failed starts
    // from a long-lived caller (hub, watch) don't leak an fd per attempt.
    if (typeof out === "number") closeSync(out);
  }
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
