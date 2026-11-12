// The open agent's interactive terminal: the Chat / Terminal switch in the
// agent header, and the shared browser client (web/terminal.js) driven over the
// bridge instead of a WebSocket. At most one terminal is open: the one for the
// agent whose chat view shows in Terminal mode. Anything else closes it, and
// nothing reconnects in the background.
import { call, on } from "./bridge";
import { selectAgent } from "./chat";
import { $, composerInput } from "./dom";
import { parseAgentKey } from "./fleet";
import { registerChord } from "./keyboard";
import { focusCursor } from "./sidebar";
import { agentSource, agentViewMode, setAgentView, state, subscribe } from "./state";
import {
  BridgeSocket,
  isFocusChord,
  mayReopen,
  planSignature,
  retryControl,
  SESSION_EXPIRED_TEXT,
  terminalPlan,
  type AgentViewMode,
  TerminalOpens,
  TerminalRouter,
  type TerminalBridge,
} from "./terminalModel";
import { mainView, onMainViewChange, screen } from "./views";

interface TerminalController {
  open(name: string, agentStatus?: string): void;
  close(): void;
  focus(): void;
  reconnect(): void;
}
declare global {
  interface Window {
    createAgentTerminal(options: {
      screen: HTMLElement;
      status: HTMLElement;
      onUnauthorized: () => void;
      preflight: (name: string) => Promise<{ ok: boolean; status?: number; error?: string }>;
      connect: (name: string) => BridgeSocket;
    }): TerminalController;
  }
}

const router = new TerminalRouter();
const bridge: TerminalBridge = {
  open: (connection, agent) => call("terminal.open", { connection, agent }),
  input: (id, data) => call("terminal.input", { id, data }),
  resize: (id, cols, rows) => call("terminal.resize", { id, cols, rows }),
  close: (id) => call("terminal.close", { id }),
  warn: (message, error) => console.warn(message, error),
  declined: () => { declined = true; },
};

const opens = new TerminalOpens(bridge, router);

let controller: TerminalController;
let statusLine: HTMLElement;
let retryButton: HTMLButtonElement;
let shownPlan = "closed";
// The last open came back with consent declined: the button asks again.
let declined = false;
let lastReopen = -Infinity;

function connectionOf(key: string | null): string | null {
  const parsed = key ? parseAgentKey(key) : null;
  return parsed && state.conns.has(parsed.connection) ? parsed.connection : null;
}

function onUnauthorized(): void {
  const now = Date.now();
  if (!mayReopen(lastReopen, now)) {
    statusLine.textContent = SESSION_EXPIRED_TEXT;
    return;
  }
  lastReopen = now;
  controller.reconnect();
}

const terminalShown = (): boolean => !$("am-terminal-panel").hidden && !$("am-chat").hidden;

// Applies the mode to the switch and the panes, then opens or closes the terminal.
function render(): void {
  const mode = agentViewMode();
  const terminal = mode === "terminal";
  const main = $("am-main");
  $("am-view-chat").setAttribute("aria-pressed", String(!terminal));
  $("am-view-terminal").setAttribute("aria-pressed", String(terminal));
  $("am-chat-pane").hidden = terminal;
  $("am-terminal-panel").hidden = !terminal;
  if (mainView() === "chat" && state.selected) main.dataset.agentView = mode;
  else delete main.dataset.agentView;
  const plan = terminalPlan({
    screen: screen(),
    mainView: mainView(),
    mode,
    selected: state.selected,
    connectionKnown: !!connectionOf(state.selected),
    status: state.selected ? agentSource(state.selected).status : undefined,
  });
  const signature = planSignature(plan);
  if (signature === shownPlan) return;
  shownPlan = signature;
  declined = false;
  lastReopen = -Infinity;
  if (plan.kind === "closed") {
    controller.close();
    statusLine.textContent = "";
  } else controller.open(plan.key, plan.kind === "stopped" ? "exited" : plan.status);
}

// Puts the keyboard where the open agent takes input: the terminal or the message box.
export function focusAgentInput(): void {
  if (agentViewMode() === "terminal") {
    if (terminalShown()) controller.focus();
  } else if (!composerInput().disabled) composerInput().focus();
}

function switchTo(mode: AgentViewMode): void {
  const wasChat = agentViewMode() === "chat";
  setAgentView(mode);
  render();
  if (mode === "chat" && !wasChat) {
    // A hidden transcript can't scroll, so open the chat at its latest message.
    const view = $("transcript");
    view.scrollTop = view.scrollHeight;
    view.dispatchEvent(new Event("scroll"));
  }
}

// View → Show Chat / Show Terminal: the saved choice, shown for the open agent
// (back from its subagent's transcript), with the keyboard in it.
export function showAgentView(mode: AgentViewMode): void {
  switchTo(mode);
  if (!state.selected || screen() !== "fleet") return;
  if (mainView() !== "chat") selectAgent(state.selected);
  focusAgentInput();
}

function wireStatus(): void {
  const hint = document.querySelector<HTMLElement>(".am-terminal-hint")!;
  const update = () => {
    const control = retryControl(statusLine.textContent ?? "", declined);
    retryButton.hidden = control.hidden;
    retryButton.textContent = control.label;
    // The way out by keyboard matters only while there is a terminal to be in.
    hint.hidden = !(statusLine.textContent ?? "").startsWith("●");
  };
  new MutationObserver(update).observe(statusLine, { childList: true, characterData: true, subtree: true });
  update();
  retryButton.addEventListener("click", () => {
    declined = false;
    lastReopen = -Infinity;
    controller.reconnect();
    controller.focus();
  });
}

function wireEvents(): void {
  on("terminal.output", ({ id, data }) => {
    if (typeof id === "string" && typeof data === "string") router.dispatch({ name: "output", id, data });
  });
  on("terminal.control", ({ id, message }) => {
    if (typeof id === "string") router.dispatch({ name: "control", id, message });
  });
  on("terminal.closed", ({ id, code, reason }) => {
    if (typeof id === "string")
      router.dispatch({ name: "closed", id, code: typeof code === "number" ? code : 1006, reason: typeof reason === "string" ? reason : "" });
  });
}

export function initTerminal(): void {
  statusLine = $("am-terminal-status");
  retryButton = $<HTMLButtonElement>("am-terminal-reconnect");
  controller = window.createAgentTerminal({
    screen: $("am-terminal"),
    status: statusLine,
    onUnauthorized,
    // terminal.open does the real preflight; its refusal arrives as the socket's close.
    preflight: async () => ({ ok: true, status: 200 }),
    connect: (name) => {
      const parsed = parseAgentKey(name);
      return new BridgeSocket(bridge, opens, parsed?.connection ?? "", parsed?.id ?? name);
    },
  });
  wireStatus();
  wireEvents();
  $("am-view-chat").addEventListener("click", () => switchTo("chat"));
  $("am-view-terminal").addEventListener("click", () => {
    switchTo("terminal");
    if (terminalShown()) controller.focus();
  });
  onMainViewChange(render);
  subscribe("agent", render);
  subscribe("fleet", render);
  registerChord({
    matches: isFocusChord,
    run: () => {
      if (screen() !== "fleet") return false;
      if ($("am-terminal").contains(document.activeElement)) focusCursor();
      else if (terminalShown() && shownPlan.startsWith("open:")) controller.focus();
      else return false;
      return true;
    },
  });
  render();
}
