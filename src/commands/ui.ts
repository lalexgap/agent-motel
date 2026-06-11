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

const HUB_HELP = "f filter · ↑/↓/j/k preview · enter/→ lock in · ctrl-q sidebar · n new · x stop · d remove · q/esc detach · ctrl-c quit";
const HIGHLIGHT_DEBOUNCE_MS = 150;

function hubTarget(): string {
  return `=${HUB_SESSION}:`;
}

// A long-lived pane command that just displays a message — used before any
// agent is shown and for agents without a live session.
function messageCommand(message: string): string {
  return `printf '\\n\\n   %s\\n' ${shQuote(message)}; sleep 86400000`;
}

function paneIdWhere(atLeft: "0" | "1"): string | null {
  const result = tmux("list-panes", "-t", hubTarget(), "-F", "#{pane_id} #{pane_at_left}");
  if (result.exitCode !== 0) return null;
  for (const line of result.stdout.trim().split("\n")) {
    const [id, left] = line.split(" ");
    if (id && left === atLeft) return id;
  }
  return null;
}

const rightPaneId = (): string | null => paneIdWhere("0");
const sidebarPaneId = (): string | null => paneIdWhere("1");

function sidebarShellCommand(): string {
  return `${shQuote(process.execPath)} ${shQuote(cliEntrypoint())} __sidebar`;
}

// A lingering hub keeps running whatever sidebar build it was started with —
// respawn the sidebar on reattach so `am ui` always runs the current code.
function refreshSidebar(): void {
  const pane = sidebarPaneId();
  if (pane) {
    tmux("respawn-pane", "-k", "-t", pane, sidebarShellCommand());
    tmux("resize-pane", "-t", pane, "-x", String(SIDEBAR_WIDTH));
    tmux("select-pane", "-t", pane);
    return;
  }
  // Sidebar pane got closed somehow: re-split it to the left of the agent pane.
  const right = rightPaneId();
  if (!right) return;
  tmux("split-window", "-hb", "-d", "-t", right, "-c", process.cwd(), sidebarShellCommand());
  const created = sidebarPaneId();
  if (created) tmux("resize-pane", "-t", created, "-x", String(SIDEBAR_WIDTH));
}

function ensureRightPane(): string | null {
  const existing = rightPaneId();
  if (existing) return existing;
  tmux("split-window", "-h", "-d", "-t", `${hubTarget()}.0`, "-c", process.cwd(),
    messageCommand("select an agent in the sidebar"));
  tmux("resize-pane", "-t", `${hubTarget()}.0`, "-x", String(SIDEBAR_WIDTH));
  return rightPaneId();
}

export function createHub(): void {
  const result = tmux("new-session", "-d", "-s", HUB_SESSION, "-c", process.cwd(), "-x", "200", "-y", "50", sidebarShellCommand());
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
  else refreshSidebar();
  attachOrSwitch(HUB_SESSION);
}

// The left pane's process: the picker in persistent mode. The right pane
// follows the highlighted agent as you scroll (debounced); enter/→ locks
// focus into it. Runs until ctrl-c, which tears down the whole hub.
export async function sidebarCommand(): Promise<void> {
  let shown: string | null = null;
  let highlightTimer: ReturnType<typeof setTimeout> | undefined;

  // Point the right pane at an agent. With focus=false (scroll preview) the
  // sidebar keeps focus; enter/→ pass focus=true to move into the session.
  const showAgent = (name: string, focus: boolean): string | null => {
    const agent = readAgent(name);
    if (!agent) return focus ? `unknown agent "${name}"` : null;
    const pane = ensureRightPane();
    if (!pane) return "could not create the agent pane";

    if (!hasSession(agent.tmuxSession)) {
      shown = null;
      tmux("respawn-pane", "-k", "-t", pane,
        messageCommand(`${name}: no live session (${displayStatus(agent)})`));
      return focus ? `"${name}" has no live session — \`am resume ${name}\`` : null;
    }

    if (shown !== name) {
      // The nested attach needs TMUX unset, or the inner tmux refuses to
      // start. The inner session's status bar is noise inside the pane.
      tmux("set-option", "-t", `=${agent.tmuxSession}:`, "status", "off");
      const attach = `env -u TMUX tmux attach-session -t ${shQuote(`=${agent.tmuxSession}`)}`;
      const respawned = tmux("respawn-pane", "-k", "-t", pane, attach);
      if (respawned.exitCode !== 0) return `attach failed: ${respawned.stderr.trim()}`;
      shown = name;
    }
    if (focus) {
      tmux("select-pane", "-t", pane);
      recordAttached(name);
    }
    return null;
  };

  const load = () => {
    const agents = listAgents();
    return agents.map((a) => {
      const status = displayStatus(a);
      const queued = queueDepth(a.name);
      return {
        name: a.name,
        label: `${STATUS_ICONS[status]} ${a.name}`,
        right: queued > 0 ? `${status} ${queued}q` : status,
        // shortenHome: a raw /Users/... prefix would make filters like
        // "ser" match every agent.
        search: `${a.task ?? ""} ${shortenHome(a.dir)}`,
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
    highlight: (name: string) => {
      clearTimeout(highlightTimer);
      highlightTimer = setTimeout(() => showAgent(name, false), HIGHLIGHT_DEBOUNCE_MS);
    },
    select: (name: string) => {
      clearTimeout(highlightTimer);
      return showAgent(name, true);
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

  await pick(load, handlers, readLastAttached().current ?? undefined);
  // Only ctrl-c resolves the persistent picker: quit the whole hub with it.
  clearTimeout(highlightTimer);
  tmux("kill-session", "-t", `=${HUB_SESSION}`);
}
