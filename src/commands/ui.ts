import { agentProvider, listAgents, readAgent, recordAttached } from "../state";
import { attachOrSwitch, hasSession, shQuote, tmux } from "../tmux";
import { cliEntrypoint } from "../settings";
import { expandHome } from "../paths";
import { cachedRemoteRow, fleetPickerItems, shortHost, splitFleetKey } from "../fleet";
import { sshAm, sshRun } from "../remote";
import { handoffHandler, moveHandler } from "./fleetActions";
import { pick, type PickerHandlers } from "../picker";
import { displayStatus, relativeTime, shortenHome, STATUS_ICONS } from "./ls";
import { queueDepth } from "../queue";
import { newCommand } from "./new";
import { destroyAgent, stopAgent } from "./rm";
import { reviveAgent } from "./resume";
import { readLastAttached } from "../state";

// Persistent split view: a hub tmux session whose left pane runs the sidebar
// (`am __sidebar`) and whose right pane shows the selected agent via a nested
// `tmux attach`. Nesting keeps the agent fully interactive — real keyboard,
// colors, mouse — without am re-implementing a terminal.
const HUB_SESSION = "am-hub";
const SIDEBAR_WIDTH = 38;

const HUB_HELP = "f filter · ↑/↓/j/k preview · enter/→ lock in · ctrl-q sidebar · n new · m move · h handoff · x stop · d remove · q/esc detach · ctrl-c quit";
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

  // Point the right pane at an agent (key = name, or host:name for remote).
  // With focus=false (scroll preview) the sidebar keeps focus; enter/→ pass
  // focus=true to move into the session.
  const showAgent = (key: string, focus: boolean): string | null => {
    const { host, name } = splitFleetKey(key);
    const pane = ensureRightPane();
    if (!pane) return "could not create the agent pane";

    if (host) {
      if (!name) {
        tmux("respawn-pane", "-k", "-t", pane, messageCommand(`${host} unreachable`));
        return null;
      }
      // Remote agent: the pane runs ssh -t into a nested remote attach. Dead
      // remote agents are revived first (on focus only).
      const row = cachedRemoteRow(host, name);
      const dead = row && (row.status === "exited" || row.status === "dead");
      if (dead) {
        shown = null;
        if (!focus) {
          tmux("respawn-pane", "-k", "-t", pane,
            messageCommand(`${name}@${shortHost(host)}: no live session (${row.status})`));
          return null;
        }
        tmux("respawn-pane", "-k", "-t", pane, messageCommand(`reviving ${name} on ${host}…`));
        const revived = sshAm(host, ["resume", name]);
        if (revived.exitCode !== 0) {
          tmux("respawn-pane", "-k", "-t", pane,
            messageCommand(`remote revive failed: ${revived.stderr.trim()}`));
          return `remote revive failed`;
        }
      }
      if (shown !== key) {
        sshRun(host, `tmux set-option -t '=agentmgr-${name}:' status off`, { timeoutMs: 4000 });
        const attach = `env -u TMUX ssh -t ${shQuote(host)} -- ${shQuote(`tmux attach-session -t '=agentmgr-${name}'`)}`;
        const respawned = tmux("respawn-pane", "-k", "-t", pane, attach);
        if (respawned.exitCode !== 0) return `remote attach failed: ${respawned.stderr.trim()}`;
        shown = key;
      }
      if (focus) tmux("select-pane", "-t", pane);
      return null;
    }

    const agent = readAgent(name);
    if (!agent) return focus ? `unknown agent "${name}"` : null;

    if (!hasSession(agent.tmuxSession)) {
      shown = null;
      if (!focus) {
        tmux("respawn-pane", "-k", "-t", pane,
          messageCommand(`${name}: no live session (${displayStatus(agent)})`));
        return null;
      }
      // Enter on a dead agent revives it, then re-enters to attach the pane.
      tmux("respawn-pane", "-k", "-t", pane, messageCommand(`reviving ${name}…`));
      reviveAgent(agent).then(
        () => showAgent(name, true),
        (error: Error) => {
          const failPane = ensureRightPane();
          if (failPane) {
            tmux("respawn-pane", "-k", "-t", failPane,
              messageCommand(`revive failed: ${error.message}`));
          }
        },
      );
      return `reviving ${name}…`;
    }

    if (shown !== key) {
      // The nested attach needs TMUX unset, or the inner tmux refuses to
      // start. The inner session's status bar is noise inside the pane.
      tmux("set-option", "-t", `=${agent.tmuxSession}:`, "status", "off");
      const attach = `env -u TMUX tmux attach-session -t ${shQuote(`=${agent.tmuxSession}`)}`;
      const respawned = tmux("respawn-pane", "-k", "-t", pane, attach);
      if (respawned.exitCode !== 0) return `attach failed: ${respawned.stderr.trim()}`;
      shown = key;
    }
    if (focus) {
      tmux("select-pane", "-t", pane);
      recordAttached(name);
    }
    return null;
  };

  const load = fleetPickerItems;

  const handlers: PickerHandlers = {
    highlight: (key: string) => {
      clearTimeout(highlightTimer);
      highlightTimer = setTimeout(() => showAgent(key, false), HIGHLIGHT_DEBOUNCE_MS);
    },
    select: (key: string) => {
      clearTimeout(highlightTimer);
      return showAgent(key, true);
    },
    stop: (key: string) => {
      const { host, name } = splitFleetKey(key);
      if (host) {
        const result = sshAm(host, ["stop", name]);
        return result.exitCode === 0 ? `stopped ${name} on ${host}` : `stop failed: ${result.stderr.trim()}`;
      }
      const agent = readAgent(name);
      if (agent) stopAgent(agent);
      return `stopped ${name} (resume with \`am resume ${name}\`)`;
    },
    remove: (key: string) => {
      const { host, name } = splitFleetKey(key);
      if (host) {
        const result = sshAm(host, ["rm", name]);
        return result.exitCode === 0 ? `removed ${name} on ${host}` : `rm failed: ${result.stderr.trim()}`;
      }
      const agent = readAgent(name);
      if (agent) destroyAgent(agent, { clean: false });
      return `removed ${name}`;
    },
    create: async (name: string, task: string | undefined, dir: string | undefined) => {
      await newCommand({ name, message: task, dir: dir ? expandHome(dir) : undefined, jump: false, quiet: true });
      return name;
    },
    // Dir prompt prefill: the highlighted agent's dir (related work usually
    // lives in the same project), else the hub's launch dir.
    defaultDir: (highlighted: string | null) => {
      const { host, name } = highlighted ? splitFleetKey(highlighted) : { host: undefined, name: "" };
      const agent = !host && name ? readAgent(name) : null;
      return shortenHome(agent?.dir ?? process.cwd());
    },
    move: moveHandler,
    handoff: handoffHandler,
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
