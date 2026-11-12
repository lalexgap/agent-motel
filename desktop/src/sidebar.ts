// The sidebar: the agent tree with its pinned concierge, filter, show-stopped
// toggle, keyboard navigation and the resizable divider.
import { selectAgent } from "./chat";
import { $, composerInput, dot, h } from "./dom";
import {
  buildTree,
  conciergeTarget,
  isPinnedConcierge,
  moveCursor,
  repoLabel,
  statusLabel,
  statusShort,
  STOPPED,
  type AgentItem,
  type GroupItem,
  type TreeItem,
} from "./fleet";
import { relativeTime } from "./format";
import { registerShortcut } from "./keyboard";
import { fleets, loadProblem, persist, state, subscribe } from "./state";

const SIDEBAR_MIN = 200;

const sidebarMax = () => Math.max(SIDEBAR_MIN, Math.min(560, Math.round(window.innerWidth * 0.5)));
export function applySidebarWidth(): void {
  const width = Math.max(SIDEBAR_MIN, Math.min(sidebarMax(), state.sidebarWidth));
  document.documentElement.style.setProperty("--am-sidebar-width", `${width}px`);
}

function groupNode(item: GroupItem): HTMLElement {
  const node = h("div", `am-row am-group tone-${item.tone ?? "repo"}`);
  node.setAttribute("role", "treeitem");
  node.setAttribute("aria-expanded", String(!item.collapsed));
  node.setAttribute("aria-level", String(item.depth + 1));
  node.tabIndex = -1;
  node.dataset.itemId = item.id;
  node.dataset.groupId = item.id;
  node.style.setProperty("--depth", String(item.depth));
  node.append(window.agentTranscript.icon("chevron", "icon am-chevron"), h("span", "am-group-label", item.label));
  if (item.marker) node.append(h("span", "am-group-marker", item.marker));
  node.append(h("span", "am-group-count", String(item.count)));
  node.title = `${item.label} · ${item.count} agent${item.count === 1 ? "" : "s"}${item.marker ? ` · ${item.marker}` : ""}`;
  return node;
}

function agentNode(item: AgentItem): HTMLElement {
  const { row } = item;
  const node = h("div", `am-row am-agent${STOPPED.has(row.status) ? " stopped" : ""}`);
  node.setAttribute("role", "treeitem");
  node.setAttribute("aria-level", String(item.depth + 1));
  node.setAttribute("aria-selected", String(item.key === state.selected));
  node.tabIndex = -1;
  node.dataset.itemId = item.id;
  node.dataset.agentKey = item.key;
  node.style.setProperty("--depth", String(item.depth));
  const text = h("div", "am-agent-text");
  const line = h("div", "am-agent-line");
  const time = h("span", "am-agent-time", relativeTime(row.statusChangedAt));
  time.dataset.since = row.statusChangedAt || "";
  time.title = `${statusLabel(row.status)} since ${new Date(row.statusChangedAt).toLocaleString()}`;
  line.append(h("span", "am-agent-name", row.name), time);
  const meta = h("div", "am-agent-meta");
  meta.append(h("span", "", row.provider));
  if (row.status !== "idle") meta.append(h("span", `am-status-text s-${row.status}`, statusShort(row.status)));
  if ((row.queued ?? 0) > 0) meta.append(h("span", "am-queued", `${row.queued} queued`));
  if (item.parent === "attention") meta.append(h("span", "am-agent-context", `${repoLabel(row)} · ${item.hostLabel}`));
  text.append(line, meta);
  node.append(dot(row.status), text);
  node.title = `${row.host ? `${row.host}:` : ""}${row.name} · ${statusLabel(row.status)}${row.statusReason ? ` — ${row.statusReason}` : ""}`;
  return node;
}

function conciergeNode(item: AgentItem): HTMLElement {
  const { row } = item;
  const stopped = STOPPED.has(row.status);
  const node = h("div", `am-row am-agent am-concierge${stopped ? " stopped" : ""}${row.status === "needs-attention" ? " attention" : ""}`);
  node.setAttribute("role", "treeitem");
  node.setAttribute("aria-level", "1");
  node.setAttribute("aria-selected", String(item.key === state.selected));
  node.tabIndex = -1;
  node.dataset.itemId = item.id;
  node.dataset.agentKey = item.key;
  node.dataset.concierge = "";
  const text = h("div", "am-agent-text");
  const line = h("div", "am-agent-line");
  const label = h("span", "am-agent-name am-concierge-name");
  label.append(h("span", "am-concierge-mark", "✳"), document.createTextNode("Concierge"));
  if (item.connectionName) label.append(h("span", "am-concierge-conn", item.connectionName));
  const time = h("span", "am-agent-time", relativeTime(row.statusChangedAt));
  time.dataset.since = row.statusChangedAt || "";
  time.title = `${statusLabel(row.status)} since ${new Date(row.statusChangedAt).toLocaleString()}`;
  line.append(label, time);
  const meta = h("div", "am-agent-meta");
  meta.append(h("span", "", row.provider));
  if (stopped) meta.append(h("span", "am-status-text s-stopped", `stopped · ${statusShort(row.status)}`));
  else if (row.status !== "idle") meta.append(h("span", `am-status-text s-${row.status}`, statusShort(row.status)));
  if ((row.queued ?? 0) > 0) meta.append(h("span", "am-queued", `${row.queued} queued`));
  text.append(line, meta);
  node.append(dot(row.status), text);
  const where = item.connectionName ? ` on ${item.connectionName}` : "";
  node.title = `Concierge${where} · ${statusLabel(row.status)}${row.statusReason ? ` — ${row.statusReason}` : ""} · press c to open`;
  return node;
}

function renderTree(): void {
  const tree = $("am-tree");
  const hadFocus = tree.contains(document.activeElement);
  state.tree = buildTree(fleets(), { filter: state.filter, showStopped: state.showStopped, collapsed: state.collapsed });
  const { items } = state.tree;
  if (state.cursor && !items.some((item) => item.id === state.cursor)) {
    // Keep the cursor on the same agent if it moved groups, else fall back.
    const key = state.cursor.split(">").pop();
    state.cursor = items.find((item) => item.kind === "agent" && item.key === key)?.id ?? null;
  }
  if (!state.cursor && state.selected) state.cursor = items.find((item) => item.kind === "agent" && item.key === state.selected)?.id ?? null;
  if (!state.cursor) state.cursor = items[0]?.id ?? null;
  const nodes: HTMLElement[] = [];
  let pinned: HTMLElement | null = null;
  for (const item of items) {
    const node = item.kind === "group" ? groupNode(item) : isPinnedConcierge(item) ? conciergeNode(item) : agentNode(item);
    if (item.id === state.cursor) node.tabIndex = 0;
    if (isPinnedConcierge(item)) {
      if (!pinned) {
        pinned = h("div", "am-pinned");
        pinned.setAttribute("role", "none");
        nodes.push(pinned);
      }
      pinned.append(node);
    } else nodes.push(node);
  }
  if (!items.some((item) => !isPinnedConcierge(item))) {
    const loading = [...state.conns.values()].some((conn) => !conn.loaded);
    const message = state.filter ? `No agents match “${state.filter}”.`
      : loading ? loadProblem() ?? "Loading agents…"
      : state.tree.hiddenStopped ? "Every agent is stopped. Turn on “Show stopped” to see them."
      : "No agents on this server yet. Start one with am new.";
    nodes.push(h("div", "am-tree-empty", message));
  }
  tree.replaceChildren(...nodes);
  // Background refreshes keep focus on the cursor row without yanking the scroll position.
  if (hadFocus) focusCursor(false);
  const summary = $("am-fleet-summary");
  const { shown, total, hiddenStopped } = state.tree;
  summary.textContent = state.filter ? `${shown} of ${total - hiddenStopped} match` : hiddenStopped ? `${hiddenStopped} stopped hidden` : `${total} agent${total === 1 ? "" : "s"}`;
  const toggle = $("am-show-stopped");
  toggle.setAttribute("aria-pressed", String(state.showStopped));
}

export function focusCursor(scroll = true): void {
  const node = state.cursor ? document.querySelector<HTMLElement>(`#am-tree [data-item-id="${CSS.escape(state.cursor)}"]`) : null;
  if (!node) {
    $("am-tree").focus();
    return;
  }
  for (const other of $("am-tree").querySelectorAll<HTMLElement>("[tabindex='0']")) if (other !== node) other.tabIndex = -1;
  node.tabIndex = 0;
  node.focus({ preventScroll: !scroll });
  if (scroll) node.scrollIntoView({ block: "nearest" });
}

function setCursor(id: string | null): void {
  state.cursor = id;
  focusCursor();
}

function toggleGroup(id: string, collapse?: boolean): void {
  const next = collapse ?? !state.collapsed.has(id);
  if (next) state.collapsed.add(id);
  else state.collapsed.delete(id);
  persist();
  renderTree();
  focusCursor();
}

function activateItem(item: TreeItem): void {
  if (item.kind === "group") toggleGroup(item.id);
  else selectAgent(item.key);
}

function openConcierge(): void {
  const key = conciergeTarget(fleets(), state.selected);
  if (!key) return;
  const item = state.tree.items.find((candidate) => isPinnedConcierge(candidate) && candidate.key === key);
  if (item) state.cursor = item.id;
  selectAgent(key);
  focusCursor();
  if (!composerInput().disabled) composerInput().focus();
}

export function focusFilter(): void {
  if (document.body.dataset.view !== "fleet") return;
  const filter = $("am-filter") as HTMLInputElement;
  filter.focus();
  filter.select();
}

// Relative times on the rows, kept current by the app clock.
export function tickTimes(now: number): void {
  for (const node of document.querySelectorAll<HTMLElement>("#am-tree [data-since]")) {
    const text = relativeTime(node.dataset.since, now);
    if (node.textContent !== text) node.textContent = text;
  }
}

const cursorItem = (): TreeItem | undefined => state.tree.items.find((item) => item.id === state.cursor);

function registerShortcuts(): void {
  const filter = $("am-filter") as HTMLInputElement;
  const inFilter = (event: KeyboardEvent) => event.target === filter;
  registerShortcut({
    keys: ["Escape"], whileTyping: true, when: inFilter, run: () => {
      if (filter.value) {
        filter.value = "";
        state.filter = "";
        renderTree();
      }
      focusCursor();
    },
  });
  registerShortcut({
    keys: ["ArrowDown", "Enter"], whileTyping: true, when: inFilter, run: (event) => {
      // The pinned concierge always shows; Enter means the first match below it.
      const first = state.tree.items.find((item) => item.kind === "agent" && !item.concierge);
      if (event.key === "Enter" && first?.kind === "agent") selectAgent(first.key);
      setCursor(first?.id ?? state.cursor);
    },
  });
  registerShortcut({ keys: ["/"], run: focusFilter });
  registerShortcut({ keys: ["Escape"], run: () => focusCursor() });
  // Prevented before focus moves to the message box, or the c would be typed into it.
  registerShortcut({ keys: ["c"], run: openConcierge });

  // Arrow keys belong to whatever has focus (the transcript scrolls with them);
  // the list takes them when it, or nothing in particular, is focused.
  const tree = $("am-tree");
  const inTree = ({ target }: KeyboardEvent) =>
    (target instanceof Node && tree.contains(target)) || target === document.body || target === document.documentElement;
  const onItem = (event: KeyboardEvent) => inTree(event) && !!cursorItem();
  const items = () => state.tree.items;
  registerShortcut({ keys: ["ArrowDown", "j"], when: inTree, run: () => setCursor(moveCursor(items(), state.cursor, 1)) });
  registerShortcut({ keys: ["ArrowUp", "k"], when: inTree, run: () => setCursor(moveCursor(items(), state.cursor, -1)) });
  registerShortcut({ keys: ["Home"], when: inTree, run: () => setCursor(items()[0]?.id ?? null) });
  registerShortcut({ keys: ["End"], when: inTree, run: () => setCursor(items()[items().length - 1]?.id ?? null) });
  registerShortcut({
    keys: ["Enter", " "], when: onItem, run: (event) => {
      const current = cursorItem()!;
      activateItem(current);
      // Enter opens the agent to write to it; Space only opens it.
      if (event.key === "Enter" && current.kind === "agent" && !composerInput().disabled) composerInput().focus();
    },
  });
  registerShortcut({
    keys: ["ArrowLeft"], when: onItem, run: () => {
      const current = cursorItem()!;
      if (current.kind === "group" && !current.collapsed) toggleGroup(current.id, true);
      else if (current.parent && items().some((item) => item.id === current.parent)) setCursor(current.parent);
    },
  });
  registerShortcut({
    keys: ["ArrowRight"], when: onItem, run: () => {
      const current = cursorItem()!;
      if (current.kind === "group" && current.collapsed) toggleGroup(current.id, false);
      else if (current.kind === "group") setCursor(moveCursor(items(), current.id, 1));
    },
  });
}

function wireDivider(): void {
  const divider = $("am-divider");
  divider.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    divider.setPointerCapture(event.pointerId);
    document.body.classList.add("am-resizing");
    const move = (moveEvent: PointerEvent) => {
      state.sidebarWidth = Math.max(SIDEBAR_MIN, Math.min(sidebarMax(), moveEvent.clientX));
      applySidebarWidth();
    };
    const up = () => {
      document.body.classList.remove("am-resizing");
      divider.removeEventListener("pointermove", move);
      divider.removeEventListener("pointerup", up);
      divider.removeEventListener("pointercancel", up);
      persist();
    };
    divider.addEventListener("pointermove", move);
    divider.addEventListener("pointerup", up);
    divider.addEventListener("pointercancel", up);
  });
  divider.addEventListener("keydown", (event) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    event.stopPropagation();
    state.sidebarWidth = Math.max(SIDEBAR_MIN, Math.min(sidebarMax(), state.sidebarWidth + (event.key === "ArrowRight" ? 16 : -16)));
    applySidebarWidth();
    persist();
  });
  window.addEventListener("resize", applySidebarWidth);
}

export function initSidebar(): void {
  subscribe("fleet", renderTree);
  registerShortcuts();
  const tree = $("am-tree");
  tree.addEventListener("click", (event) => {
    const node = (event.target as HTMLElement).closest<HTMLElement>("[data-item-id]");
    const item = node && state.tree.items.find((candidate) => candidate.id === node.dataset.itemId);
    if (!item) return;
    state.cursor = item.id;
    activateItem(item);
    focusCursor(false);
  });
  tree.addEventListener("focusin", (event) => {
    const node = (event.target as HTMLElement).closest<HTMLElement>("[data-item-id]");
    if (node?.dataset.itemId) state.cursor = node.dataset.itemId;
  });
  $("am-filter").addEventListener("input", (event) => {
    state.filter = (event.target as HTMLInputElement).value;
    state.cursor = null;
    renderTree();
  });
  $("am-show-stopped").addEventListener("click", () => {
    state.showStopped = !state.showStopped;
    persist();
    renderTree();
  });
  wireDivider();
}
