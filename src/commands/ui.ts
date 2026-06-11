import { listAgents, readAgent, recordAttached } from "../state";
import { attachOrSwitch, hasSession, shQuote, tmux } from "../tmux";
import { cliEntrypoint } from "../settings";
import { pick, type PickerHandlers } from "../picker";
import { displayStatus, relativeTime, shortenHome, STATUS_ICONS } from "./ls";
import { queueDepth } from "../queue";
import { newCommand } from "./new";
import { destroyAgent, stopAgent } from "./rm";
import { readLastAttached } from "../state";

// Persistent split view: a hub tmux session whose left pane runs the sidebar
// (`am __sidebar`) and whose right pane shows the selected agent via a nested
// `tmux attach`. Nesting keeps the agent fully interactive — real keyboard,
// colors, mouse — without am re-implementing a terminal.
const HUB_SESSION = "am-hub";
const SIDEBAR_WIDTH = 38;

const HUB_HELP = "↑/↓ · enter shows agent → · ctrl-q back here · ctrl-n new · ctrl-x stop · ctrl-d remove · esc detach · ctrl-c quit";

function hubTarget(): string {
  return `=${HUB_SESSION}:`;
}

// The placeholder keeps the right pane alive until an agent is selected.
function placeholderCommand(): string {
  return `sh -c 'printf "\\n\\n   select an agent in the sidebar (enter)\\n   ctrl-q toggles focus between panes\\n"; sleep 86400000'`;
}

function rightPaneId(): string | null {
  const result = tmux("list-panes", "-t", hubTarget(), "-F", "#{pane_id} #{pane_at_left}");
  if (result.exitCode !== 0) return null;
  for (const line of result.stdout.trim().split("\n")) {
    const [id, atLeft] = line.split(" ");
    if (id && atLeft === "0") return id;
  }
  return null;
}

function ensureRightPane(): string | null {
  const existing = rightPaneId();
  if (existing) return existing;
  tmux("split-window", "-h", "-d", "-t", `${hubTarget()}.0`, "-c", process.cwd(), placeholderCommand());
  tmux("resize-pane", "-t", `${hubTarget()}.0`, "-x", String(SIDEBAR_WIDTH));
  return rightPaneId();
}

export function createHub(): void {
  const sidebar = `${shQuote(process.execPath)} ${shQuote(cliEntrypoint())} __sidebar`;
  const result = tmux("new-session", "-d", "-s", HUB_SESSION, "-c", process.cwd(), "-x", "200", "-y", "50", sidebar);
  if (result.exitCode !== 0) throw new Error(`tmux new-session failed: ${result.stderr.trim()}`);
  ensureRightPane();

  // Hub chrome: no status bar, and ctrl-q toggles between sidebar and agent
  // pane. The binding lives in a hub-only key table, so the outer client
  // intercepts ctrl-q before the nested agent session (whose own ctrl-q
  // binding means detach) ever sees it.
  tmux("set-option", "-t", hubTarget(), "status", "off");
  tmux("set-option", "-t", hubTarget(), "mouse", "on");
  tmux("bind-key", "-T", "am-hub", "C-q", "select-pane", "-l");
  tmux("set-option", "-t", hubTarget(), "key-table", "am-hub");
}

export function uiCommand(): void {
  if (!hasSession(HUB_SESSION)) createHub();
  attachOrSwitch(HUB_SESSION);
}

// Point the right pane at an agent's session. Returns footer feedback.
function showAgent(name: string): string | null {
  const agent = readAgent(name);
  if (!agent) return `unknown agent "${name}"`;
  if (!hasSession(agent.tmuxSession)) return `"${name}" has no live session (${displayStatus(agent)})`;
  const pane = ensureRightPane();
  if (!pane) return "could not create the agent pane";

  // The nested attach needs TMUX unset, or the inner tmux refuses to start.
  // The inner session's status bar is noise inside the pane — turn it off.
  tmux("set-option", "-t", `=${agent.tmuxSession}:`, "status", "off");
  const attach = `env -u TMUX tmux attach-session -t ${shQuote(`=${agent.tmuxSession}`)}`;
  const respawned = tmux("respawn-pane", "-k", "-t", pane, attach);
  if (respawned.exitCode !== 0) return `attach failed: ${respawned.stderr.trim()}`;
  tmux("select-pane", "-t", pane);
  recordAttached(name);
  return null;
}

// The left pane's process: the picker in persistent mode. Runs until ctrl-c,
// which tears down the whole hub.
export async function sidebarCommand(): Promise<void> {
  let active: string | null = readLastAttached().current ?? null;

  const load = () => {
    const agents = listAgents();
    const nameWidth = Math.max(0, ...agents.map((a) => a.name.length));
    return agents.map((a) => {
      const status = displayStatus(a);
      const queued = queueDepth(a.name);
      return {
        name: a.name,
        label: `${STATUS_ICONS[status]}${a.name === active ? "▶" : " "}${a.name.padEnd(nameWidth)}  ${status}${queued > 0 ? ` · ${queued}q` : ""}`,
        search: `${a.task ?? ""} ${a.dir}`,
        meta: [
          `status   ${status}${queued > 0 ? ` (${queued} queued)` : ""}`,
          `dir      ${shortenHome(a.dir)}`,
          ...(a.worktreeBranch ? [`branch   ${a.worktreeBranch}`] : []),
          ...(a.task ? [`task     ${a.task}`] : []),
          `updated  ${relativeTime(a.updatedAt)}`,
        ],
      };
    });
  };

  const handlers: PickerHandlers = {
    select: (name: string) => {
      const feedback = showAgent(name);
      if (!feedback) active = name;
      return feedback;
    },
    stop: (name: string) => {
      const agent = readAgent(name);
      if (agent) stopAgent(agent);
      return `stopped ${name} (resume with \`am resume ${name}\`)`;
    },
    remove: (name: string) => {
      const agent = readAgent(name);
      if (agent) destroyAgent(agent, { clean: false });
      return `removed ${name}`;
    },
    create: async (name: string, task?: string) => {
      await newCommand({ name, message: task, jump: false, quiet: true });
      return name;
    },
    quit: () => {
      tmux("detach-client", "-s", `=${HUB_SESSION}`);
    },
    help: HUB_HELP,
  };

  await pick(load, handlers, active ?? undefined);
  // Only ctrl-c resolves the persistent picker: quit the whole hub with it.
  tmux("kill-session", "-t", `=${HUB_SESSION}`);
}
