// Agent actions, as the browser UI offers them: in the sidebar's context menu,
// in the chat header (Resume, Interrupt, Restart and a "⋯" menu), and as Resume
// on a stopped agent's message box. Restart, interrupt, stop and remove are
// confirmed by the bridge's native sheet; nothing here asks again.
import { actionAvailable, AGENT_CHANGED, LIFECYCLE, selectionAfterRemove, type ActionSubject, type LifecycleAction } from "./actions";
import { openHandover, openModel, openMove, openRename } from "./actionDialogs";
import {
  activationReleased,
  callOutcome,
  clearFailure,
  failures,
  isPending,
  noteFailure,
  reportFailure,
  setPending,
  trackActivationKeys,
} from "./actionRuntime";
import { registerHeaderAction, selectAgent } from "./chat";
import { registerAgentMenuItem, type AgentMenuGroup } from "./contextMenu";
import { refreshConnection } from "./data";
import { $, h } from "./dom";
import { parseAgentKey } from "./fleet";
import { agentSource, findRow, state, subscribe } from "./state";
import { mainView } from "./views";

export async function runLifecycle(key: string, action: LifecycleAction, subject: () => ActionSubject | null): Promise<void> {
  const parsed = parseAgentKey(key);
  if (!parsed || isPending(key)) return;
  // The menu re-checks its items on click; the header and the message box check here.
  if (!actionAvailable(subject(), action)) {
    reportFailure(key, AGENT_CHANGED);
    return;
  }
  const method = LIFECYCLE[action];
  setPending(key, true);
  clearFailure(key);
  try {
    if (!(await activationReleased(method))) return;
    const outcome = await callOutcome(method, { connection: parsed.connection, agent: parsed.id });
    if (outcome.kind === "cancelled") return;
    if (outcome.kind === "failed") {
      noteFailure(key, outcome);
      reportFailure(key, outcome.message);
      return;
    }
    if (action === "delete" && selectionAfterRemove(state.selected, key) === null) selectAgent(null);
    // A stopped parent's subagents end with it: leave its subagent view for its chat (and Resume).
    else if (action === "stop" && state.selected === key && mainView() === "subagent") selectAgent(key);
    await refreshConnection(parsed.connection);
  } finally {
    setPending(key, false);
  }
}

function registerMenu(): void {
  const add = (id: string, label: string, group: AgentMenuGroup, action: string, run: (key: string) => void, danger = false) =>
    registerAgentMenuItem({
      id, label, group, danger,
      visible: (row) => actionAvailable(row, action),
      enabled: (_row, key) => !isPending(key),
      run: (key) => run(key),
    });
  // Dialogs opened from the menu return focus to the sidebar row, which the menu just refocused.
  add("handover", "Handover…", "manage", "handover", (key) => openHandover(key));
  add("rename", "Rename…", "manage", "rename", (key) => openRename(key));
  add("move", "Move to host…", "manage", "move", (key) => openMove(key));
  for (const action of ["resume", "restart", "interrupt", "stop"] as const) {
    add(action, action[0]!.toUpperCase() + action.slice(1), "lifecycle", action, (key) => void runLifecycle(key, action, () => findRow(key)));
  }
  add("delete", "Remove…", "danger", "delete", (key) => void runLifecycle(key, "delete", () => findRow(key)), true);
}

// The open agent's detail (it has capabilities), with the fresher status of it and the fleet row.
function headerSubject(key: string): ActionSubject | null {
  if (state.detail?.key === key && state.detail.notFound) return null;
  const source = agentSource(key) as ActionSubject;
  return source.name ? source : null;
}

let bar: HTMLElement | null = null;
const buttons = new Map<string, HTMLButtonElement>();
let more: HTMLDetailsElement;
let summary: HTMLElement;

function actionButton(action: string, label: string, className = ""): HTMLButtonElement {
  const button = h("button", className, label);
  button.type = "button";
  button.dataset.action = action;
  buttons.set(action, button);
  return button;
}

function closeMore(focusSummary: boolean): void {
  if (!more.open) return;
  more.open = false;
  if (focusSummary) summary.focus();
}

function moreItems(): HTMLButtonElement[] {
  return [...more.querySelectorAll<HTMLButtonElement>(".more-menu button")].filter((button) => !button.hidden && !button.disabled);
}

function buildBar(): HTMLElement {
  const box = h("div", "actions am-agent-actions");
  box.setAttribute("role", "group");
  box.setAttribute("aria-label", "Agent actions");
  more = h("details", "more-actions");
  summary = h("summary", "", "⋯");
  summary.setAttribute("aria-label", "More agent actions");
  summary.title = "More actions";
  const menu = h("div", "more-menu");
  menu.append(actionButton("model", "Change model…"), actionButton("handover", "Handover…"), actionButton("stop", "Stop"), actionButton("delete", "Remove…", "danger"));
  more.append(summary, menu);
  box.append(actionButton("resume", "Resume"), actionButton("interrupt", "Interrupt"), actionButton("restart", "Restart"), more);
  box.addEventListener("click", (event) => {
    const button = (event.target as Element).closest<HTMLButtonElement>("button[data-action]");
    const key = state.selected;
    if (!button || button.disabled || !key) return;
    const action = button.dataset.action!;
    const inMenu = more.contains(button);
    if (inMenu) closeMore(false);
    // A dialog opened from the "⋯" menu gives focus back to its summary.
    const returnTo = inMenu ? summary : button;
    if (action === "model") openModel(key, returnTo);
    else if (action === "handover") openHandover(key, returnTo);
    else void runLifecycle(key, action as LifecycleAction, () => headerSubject(key));
  });
  more.addEventListener("toggle", () => {
    if (more.open) moreItems()[0]?.focus();
  });
  more.addEventListener("keydown", (event) => {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.key === "Escape" && more.open) {
      event.preventDefault();
      event.stopPropagation();
      closeMore(true);
      return;
    }
    if (!more.open) {
      if (event.key === "ArrowDown" && event.target === summary) {
        event.preventDefault();
        more.open = true;
      }
      return;
    }
    const items = moreItems();
    const index = items.indexOf(document.activeElement as HTMLButtonElement);
    if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
      event.preventDefault();
      event.stopPropagation();
      const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1
        : index < 0 ? (event.key === "ArrowDown" ? 0 : items.length - 1)
        : (index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
      items[next]?.focus();
    } else if (event.key === "Tab") {
      closeMore(false);
    } else if (event.key.length === 1 && event.key !== " ") {
      // Keep letters away from the window's shortcuts while the menu is open.
      event.stopPropagation();
    }
  });
  document.addEventListener("pointerdown", (event) => {
    if (more.open && !(event.target instanceof Node && more.contains(event.target))) closeMore(false);
  }, true);
  return box;
}

function renderBar(key: string): HTMLElement | null {
  bar ??= buildBar();
  const subject = headerSubject(key);
  const busy = isPending(key);
  for (const [action, button] of buttons) {
    button.hidden = !actionAvailable(subject, action);
    button.disabled = busy;
  }
  const empty = [...buttons.values()].filter((button) => more.contains(button)).every((button) => button.hidden);
  if (empty) closeMore(more.contains(document.activeElement));
  more.hidden = empty;
  return [...buttons.values()].some((button) => !button.hidden) ? bar : null;
}

function renderAgentExtras(): void {
  const key = state.selected;
  if (!key) return;
  const failure = failures.get(key) ?? "";
  const line = $("am-action-error");
  line.hidden = !failure;
  const text = $("am-action-error-text");
  if (text.textContent !== failure) text.textContent = failure;
  const resume = $<HTMLButtonElement>("am-composer-resume");
  resume.hidden = !actionAvailable(headerSubject(key), "resume");
  resume.disabled = isPending(key);
  const label = resume.disabled ? "Resuming…" : "Resume";
  if (resume.textContent !== label) resume.textContent = label;
}

// The bar comes before the inspector's toggle in the header, so it registers first.
// It is built once and updated in place on every "agent" change.
export function registerAgentHeader(): void {
  registerHeaderAction(renderBar);
}

export function initAgentActions(): void {
  trackActivationKeys();
  registerMenu();
  subscribe("agent", renderAgentExtras);
  $("am-action-error-dismiss").addEventListener("click", () => {
    if (state.selected) clearFailure(state.selected);
  });
  $("am-composer-resume").addEventListener("click", () => {
    const key = state.selected;
    if (key) void runLifecycle(key, "resume", () => headerSubject(key));
  });
}
