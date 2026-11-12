import { parsedInputBoxText, turnRunning } from "./deliver";
import { listPermissions, refreshPermissions, resolvePending, type PermissionRecord } from "./permissions";
import {
  agentNamesAndAliases,
  agentProvider,
  readAgent,
  updateAgentIf,
  updateAgentStatus,
  type AgentState,
  type Provider,
} from "./state";
import { capturePane, hasSession, stripSgr } from "./tmux";

// Answering a provider's dialog fires no hook: an approved call reports only
// once it has run, a denied one never, and a subagent's hooks don't speak for
// its parent. The pane does show it, so the dialog's absence there is what
// ends a "needs-attention" that a prompt started.

export type PaneView = "dialog" | "composer" | "unknown";

const RULE_RE = /─{8,}/;
const CLAUDE_SELECTED_RE = /^\s*❯\s*\d+\.\s+\S/;
const CLAUDE_FOOTER_RE = /^\s*(?:Esc to cancel|Enter to (?:select|confirm))\b/i;
const CODEX_FOOTER_RE = /^\s*Press enter to confirm or esc to cancel\b/i;
// Rows under the composer: the mode line, plus one per background subagent.
const CLAUDE_STATUS_ROWS = 40;

function plainLines(pane: string[]): string[] {
  const lines = pane.map((line) => stripSgr(line).trimEnd());
  while (lines.length && !lines.at(-1)) lines.pop();
  return lines;
}

// Claude draws a dialog in place of its composer, under the last rule. Only
// what is under that rule is read, so transcript text can't pass for either.
export function claudePaneView(pane: string[]): PaneView {
  const lines = plainLines(pane);
  const rules: number[] = [];
  for (let i = 0; i < lines.length; i++) if (RULE_RE.test(lines[i]!)) rules.push(i);
  const last = rules.at(-1) ?? -1;
  const below = lines.slice(last + 1);
  if (below.some((line) => CLAUDE_SELECTED_RE.test(line) || CLAUDE_FOOTER_RE.test(line))) return "dialog";
  if (rules.length < 2 || below.length > CLAUDE_STATUS_ROWS) return "unknown";
  const box = lines.slice(rules.at(-2)! + 1, last);
  return box.length > 0 && /^\s*❯/.test(box[0]!) ? "composer" : "unknown";
}

// Codex's approval and question overlays end in the same hint, with no
// composer or status line under them.
export function codexPaneView(pane: string[]): PaneView {
  const tail = plainLines(pane).filter(Boolean).slice(-3);
  if (tail.some((line) => CODEX_FOOTER_RE.test(line))) return "dialog";
  return parsedInputBoxText(pane, "codex") !== null ? "composer" : "unknown";
}

export function paneView(pane: string[], provider: Provider): PaneView {
  if (provider === "claude") return claudePaneView(pane);
  return provider === "codex" ? codexPaneView(pane) : "unknown";
}

export function isPromptAttention(agent: AgentState): boolean {
  const provider = agentProvider(agent);
  return agent.status === "needs-attention" && agent.statusKind === "prompt" && (provider === "claude" || provider === "codex");
}

// How long after a request ends its dialog may still be on its way to the pane.
const HELD_GRACE_MS = 3000;

// A request the provider has not put in the pane (yet): Claude holds a
// subagent's dialog until its PermissionRequest hook ends, and a daemon-attached
// Codex request stays recorded until it is answered. The pane can't speak for
// these.
export function promptHeld(agent: AgentState, now = Date.now(), records: PermissionRecord[] = listPermissions()): boolean {
  const names = agentNamesAndAliases(agent);
  return records.some((r) => {
    if (!names.includes(r.agent) || (r.provider === "claude" && !r.claude?.agentId)) return false;
    if (r.state === "pending" || r.state === "answered") return true;
    return r.provider === "claude" && !!r.resolvedAt && now - Date.parse(r.resolvedAt) < HELD_GRACE_MS;
  });
}

// For a hook about to move an agent off a prompt: whether one still waits.
// Never throws; unreadable means no.
export function promptStillWaiting(
  agent: AgentState,
  capture: (session: string) => string[] | null = capturePane,
): boolean {
  if (!isPromptAttention(agent)) return false;
  try {
    if (promptHeld(agent)) return true;
    const pane = capture(agent.tmuxSession);
    return !!pane && paneView(pane, agentProvider(agent)) === "dialog";
  } catch {
    return false;
  }
}

// The hook that sets the status runs as the dialog goes up (Claude) or just
// before it (Codex shows its dialog once the hook returns).
const SETTLE_MS: Record<Provider, number> = { claude: 2000, codex: 5000, antigravity: 5000 };
const WORKING_SAMPLES = 2;
// Ending a turn on the pane's word takes more than resuming one.
const IDLE_SAMPLES = 3;
// With no dialog and no composer recognized, a pane that keeps changing is an
// agent at work; this long of it ends the prompt.
export const PROMPT_ACTIVITY_TTL_MS = 30_000;

export interface PromptWatch {
  working: number;
  idle: number;
  activeSince?: number;
  lastPane?: string;
}

export interface PromptSample {
  view: PaneView;
  running: boolean;
  pane: string;
  held: boolean;
  now: number;
  statusAgeMs: number;
  provider: Provider;
}

export type PromptVerdict = "keep" | "working" | "idle";

export function newPromptWatch(): PromptWatch {
  return { working: 0, idle: 0 };
}

// One sample of a prompting agent's pane, folded into its watch. Pure but for
// the watch it updates.
export function promptVerdict(watch: PromptWatch, sample: PromptSample): PromptVerdict {
  const changed = watch.lastPane !== undefined && watch.lastPane !== sample.pane;
  watch.lastPane = sample.pane;
  const reset = (): PromptVerdict => {
    watch.working = 0;
    watch.idle = 0;
    watch.activeSince = undefined;
    return "keep";
  };
  if (sample.held || sample.view === "dialog" || sample.statusAgeMs < SETTLE_MS[sample.provider]) return reset();
  if (sample.view === "composer") {
    watch.activeSince = undefined;
    if (sample.running) {
      watch.idle = 0;
      return ++watch.working >= WORKING_SAMPLES ? "working" : "keep";
    }
    watch.working = 0;
    return ++watch.idle >= IDLE_SAMPLES ? "idle" : "keep";
  }
  watch.working = 0;
  watch.idle = 0;
  if (!changed && !sample.running) {
    watch.activeSince = undefined;
    return "keep";
  }
  watch.activeSince ??= sample.now;
  return sample.now - watch.activeSince >= PROMPT_ACTIVITY_TTL_MS ? "working" : "keep";
}

export interface SettledPrompt {
  status: "working" | "idle";
  // The prompt aborted a turn that was running (a denial): it ended here.
  turnEnded: boolean;
  // Main-agent requests still recorded as waiting, now ended.
  retired: number;
}

// Move an agent off the prompt it was seen to leave. Under the state lock, and
// only if it is still at the same prompt: a hook since then wins.
export function settlePrompt(agent: AgentState, status: "working" | "idle"): SettledPrompt | null {
  let turnEnded = false;
  const settled = updateAgentIf(agent.name, (current) => {
    if (!isPromptAttention(current) || current.createdAt !== agent.createdAt) return false;
    if (current.statusChangedAt !== agent.statusChangedAt) return false;
    updateAgentStatus(current, status);
    if (status === "idle") {
      turnEnded = !!current.workingSince;
      delete current.workingSince;
    }
    return true;
  });
  if (!settled) return null;
  let retired = 0;
  try {
    // The main agent's dialog is the pane's; its request went with it.
    const names = agentNamesAndAliases(agent);
    for (const record of listPermissions()) {
      if (record.state !== "pending" || record.provider !== "claude" || record.claude?.agentId) continue;
      if (names.includes(record.agent) && resolvePending(record.id, "stale", "answered in the pane")) retired++;
    }
  } catch {
    // bookkeeping only; the request expires on its own
  }
  return { status, turnEnded, retired };
}

export interface PromptWatcherOptions {
  // After a prompt ends: what it settled to, for the caller's follow-ups.
  onSettled?: (agent: AgentState, settled: SettledPrompt) => void;
  log?: (message: string) => void;
  tickMs?: number;
  capture?: (session: string) => string[] | null;
  alive?: (session: string) => boolean;
  now?: () => number;
}

export interface PromptWatcher {
  // An agent whose state changed, or was seen at a prompt: checked next tick.
  note(name: string): void;
  // One pass now (tests; also the timer's body).
  tick(): void;
  stop(): void;
}

// Samples the pane of each agent waiting on a prompt, about once a second,
// until the prompt is gone or a hook moves the agent on.
export function startPromptWatcher(opts: PromptWatcherOptions = {}): PromptWatcher {
  const capture = opts.capture ?? capturePane;
  const alive = opts.alive ?? hasSession;
  const now = opts.now ?? Date.now;
  const noted = new Set<string>();
  const watching = new Map<string, PromptWatch>();

  const tick = () => {
    for (const name of noted) if (!watching.has(name)) watching.set(name, newPromptWatch());
    noted.clear();
    if (watching.size === 0) return;
    let records: PermissionRecord[] = [];
    try {
      refreshPermissions();
      records = listPermissions();
    } catch {
      // the pane alone decides
    }
    for (const [name, watch] of watching) {
      try {
        const agent = readAgent(name);
        if (!agent || !isPromptAttention(agent) || !alive(agent.tmuxSession)) {
          watching.delete(name);
          continue;
        }
        const provider = agentProvider(agent);
        const pane = capture(agent.tmuxSession);
        if (!pane) continue;
        const at = now();
        const verdict = promptVerdict(watch, {
          view: paneView(pane, provider),
          running: turnRunning(pane, provider),
          pane: pane.join("\n"),
          held: promptHeld(agent, at, records),
          now: at,
          statusAgeMs: at - (Date.parse(agent.statusChangedAt ?? "") || 0),
          provider,
        });
        if (verdict === "keep") continue;
        watching.delete(name);
        const settled = settlePrompt(agent, verdict);
        if (settled) {
          opts.log?.(`${name}: prompt gone from the pane — ${settled.status}`);
          opts.onSettled?.(agent, settled);
        }
      } catch (error) {
        watching.delete(name);
        opts.log?.(`prompt watch for ${name} failed: ${error}`);
      }
    }
  };

  const timer = setInterval(tick, opts.tickMs ?? 1000);
  return {
    note: (name) => void noted.add(name),
    tick,
    stop: () => clearInterval(timer),
  };
}
