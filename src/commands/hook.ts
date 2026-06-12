import { readAgent, writeAgent, type AgentStatus } from "../state";
import { queueAppend, queueDepth } from "../queue";
import { deliverNext, spawnDeliver } from "../deliver";
import { notifyDaemon } from "../daemon";
import { loadConfig, shouldNotifyIdle } from "../config";
import { notify } from "../notify";
import { writeSnapshot } from "../snapshots";
import { capturePane, hasAttachedClient, hasSession } from "../tmux";
import { attribute, hasMessagedSince, shouldReport } from "../comms";

async function readStdinPayload(): Promise<Record<string, unknown>> {
  if (process.stdin.isTTY) return {};
  try {
    const text = await Bun.stdin.text();
    return text.trim() ? JSON.parse(text) : {};
  } catch {
    return {};
  }
}

export function formatDuration(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m${Math.round(seconds % 60)}s`;
  return `${Math.floor(seconds / 3600)}h${Math.floor((seconds % 3600) / 60)}m`;
}

export interface HookEffects {
  status: AgentStatus;
  notify?: string;
  drainQueue?: boolean;
}

export function hookEffects(event: string, payload: Record<string, unknown>): HookEffects {
  switch (event) {
    case "session-start":
      // Drain so initial messages queued at spawn time (the remote-control
      // flag swallows positional prompts) are delivered as soon as the TUI
      // is up.
      return { status: "idle", drainQueue: true };
    case "user-prompt-submit":
    case "pre-tool-use":
    case "post-tool-use":
      return { status: "working" };
    case "stop":
      return { status: "idle", drainQueue: true };
    case "notification": {
      const message = typeof payload.message === "string" ? payload.message : "needs attention";
      // Claude Code also sends a notification after ~60s of idleness; that
      // isn't "needs attention" — treating it as such would make sends queue
      // forever (no turn → no Stop hook to drain them).
      if (/waiting for .*input/i.test(message)) return { status: "idle" };
      return { status: "needs-attention", notify: message };
    }
    // Codex's dedicated approval event (PermissionRequest) — unlike Claude's
    // Notification, it only ever means "waiting on the user".
    case "permission-request": {
      const tool = typeof payload.tool_name === "string" ? ` — ${payload.tool_name}` : "";
      return { status: "needs-attention", notify: `approval requested${tool}` };
    }
    case "session-end":
      return { status: "exited" };
    default:
      throw new Error(`unknown hook event: ${event}`);
  }
}

// Send a backstop report to a local, live reportTo target. Cross-host targets
// are out of scope for the hook (it must exit fast and can't block on ssh);
// the agent's own `am send` covers those via fleet resolution.
function deliverReport(from: string, target: string, body: string): void {
  const t = readAgent(target);
  if (!t || !hasSession(t.tmuxSession)) return;
  const att = attribute(from, target, body, "report");
  if (!att.allowed) return; // rate limited — a loop guard tripped
  queueAppend(target, att.body);
  if (t.status === "idle" || t.status === "starting") deliverNext(target);
}

export async function hookCommand(event: string): Promise<void> {
  const name = process.env.AGENTMGR_AGENT;
  if (!name) return; // not a managed session
  const agent = readAgent(name);
  if (!agent) return;

  const payload = await readStdinPayload();
  const effects = hookEffects(event, payload);

  const workingSince = agent.workingSince;
  const workedSeconds = workingSince
    ? Math.max(0, (Date.now() - Date.parse(workingSince)) / 1000)
    : 0;

  agent.status = effects.status;
  if (typeof payload.session_id === "string") agent.sessionId = payload.session_id;
  // Codex includes the rollout file path; saves `am transcript` a search.
  if (typeof payload.transcript_path === "string") agent.transcriptPath = payload.transcript_path;
  if (event === "user-prompt-submit" && !agent.workingSince) {
    agent.workingSince = new Date().toISOString();
  }
  if (event === "stop" || event === "session-end") agent.workingSince = undefined;
  writeAgent(agent);

  // Keep a last-screen snapshot so the picker can preview dead agents.
  if (event === "stop" || event === "session-end") {
    const pane = capturePane(agent.tmuxSession, { colors: true });
    if (pane && pane.length > 0) writeSnapshot(name, pane);
  }

  // Standing-relationship backstop: if the agent finished a real work stint
  // and didn't post its own update to reportTo, send a terse heads-up so the
  // lead always hears something. attribute() applies the rate limiter.
  if (event === "stop" && agent.reportTo) {
    const alreadyReported = workingSince
      ? hasMessagedSince(name, agent.reportTo, workingSince)
      : false;
    if (
      shouldReport({
        reportTo: agent.reportTo,
        workedSeconds,
        minSeconds: loadConfig().idleNotifyMinSeconds,
        alreadyReported,
      })
    ) {
      const body = `went idle after ${formatDuration(workedSeconds)}${agent.task ? ` · task: ${agent.task}` : ""}`;
      deliverReport(name, agent.reportTo, body);
    }
  }

  if (effects.notify) notify(`am: ${name}`, effects.notify);

  if (effects.drainQueue) {
    const depth = queueDepth(name);
    if (depth > 0) {
      // Prefer the daemon as scheduler; fall back to a detached one-shot
      // delivery process when it isn't running.
      if (!(await notifyDaemon(name, "stop"))) spawnDeliver(name);
    } else if (
      event === "stop" &&
      shouldNotifyIdle({
        config: loadConfig(),
        workedSeconds,
        queueDepth: depth,
        attached: hasAttachedClient(agent.tmuxSession),
      })
    ) {
      notify(`am: ${name}`, `finished — idle after ${formatDuration(workedSeconds)}`);
    }
  }
}
