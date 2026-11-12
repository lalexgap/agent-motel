// Context menus. The web view's own menu (whose only item is Reload) is kept
// away except where it helps: in text fields and on a text selection, so Copy
// and Look Up still work. Sidebar agents get an agent menu whose items other
// modules register; groups render in a fixed order, separated by dividers.
import { h } from "./dom";
import { parseAgentKey } from "./fleet";
import { findRow, subscribe } from "./state";
import type { AgentRow } from "./types";

// --- Pure parts -------------------------------------------------------------

export interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}
export const pointInRects = (x: number, y: number, rects: Iterable<Rect>): boolean => {
  for (const rect of rects) if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) return true;
  return false;
};

// Whether the web view may show its own menu for a right-click.
export const allowDefaultMenu = (target: { editable: boolean; inSelection: boolean }): boolean =>
  target.editable || target.inSelection;

// Where a menu of `size` opened at `point` goes so it stays `margin` inside the viewport.
export function placeMenu(
  point: { x: number; y: number },
  size: { width: number; height: number },
  viewport: { width: number; height: number },
  margin = 8,
): { left: number; top: number } {
  return {
    left: Math.max(margin, Math.min(point.x, viewport.width - size.width - margin)),
    top: Math.max(margin, Math.min(point.y, viewport.height - size.height - margin)),
  };
}

// What Copy name copies: the agent id from its key, `name` or `host:name` for a remote agent.
export const copyNameText = (key: string): string => parseAgentKey(key)?.id ?? key;

export const AGENT_MENU_GROUPS = ["open", "manage", "lifecycle", "copy", "danger"] as const;
export type AgentMenuGroup = (typeof AGENT_MENU_GROUPS)[number];

export interface AgentMenuItem {
  id: string;
  label: string;
  group: AgentMenuGroup;
  // Shown for this agent; default always.
  visible?: (row: AgentRow, key: string) => boolean;
  // Shown but greyed out when false; default enabled.
  enabled?: (row: AgentRow, key: string) => boolean;
  danger?: boolean;
  run: (key: string, row: AgentRow) => void;
}

const agentItems: AgentMenuItem[] = [];
export function registerAgentMenuItem(item: AgentMenuItem): void {
  if (agentItems.some((other) => other.id === item.id)) throw new Error(`agent menu item ${item.id} registered twice`);
  agentItems.push(item);
}

export interface MenuSection {
  group: AgentMenuGroup;
  entries: { item: AgentMenuItem; enabled: boolean }[];
}
// The visible items for an agent, by group in menu order, registration order within a group.
export function menuSections(items: readonly AgentMenuItem[], row: AgentRow, key: string): MenuSection[] {
  const sections: MenuSection[] = [];
  for (const group of AGENT_MENU_GROUPS) {
    const entries = items
      .filter((item) => item.group === group && (item.visible?.(row, key) ?? true))
      .map((item) => ({ item, enabled: item.enabled?.(row, key) ?? true }));
    if (entries.length) sections.push({ group, entries });
  }
  return sections;
}

// --- Default menu suppression ---------------------------------------------------

const EDITABLE = "input, textarea, select, [contenteditable]:not([contenteditable='false'])";

function inSelection(x: number, y: number): boolean {
  const selection = document.getSelection();
  if (!selection || selection.isCollapsed || !selection.rangeCount) return false;
  for (let index = 0; index < selection.rangeCount; index++)
    if (pointInRects(x, y, selection.getRangeAt(index).getClientRects())) return true;
  return false;
}

function onDefaultMenu(event: MouseEvent): void {
  const target = event.target instanceof Element ? event.target : (event.target as Node | null)?.parentElement ?? null;
  const editable = !!target?.closest(EDITABLE) || (target instanceof HTMLElement && target.isContentEditable);
  if (!allowDefaultMenu({ editable, inSelection: inSelection(event.clientX, event.clientY) })) event.preventDefault();
}

// --- The agent menu -------------------------------------------------------------

interface OpenMenu {
  key: string;
  // The sidebar row it was opened from (its data-item-id), to close when it goes away.
  itemId: string;
  onClose: (restoreFocus: boolean) => void;
}
let menu: HTMLElement | null = null;
let current: OpenMenu | null = null;
// Scrolls that happened before the menu opened are reported in the next frame;
// they must not close it.
let settling = false;

function menuButtons(): HTMLButtonElement[] {
  return menu ? [...menu.querySelectorAll<HTMLButtonElement>("button[role='menuitem']:not(:disabled)")] : [];
}

// Focus goes back to the row on Esc, Tab or an item, and whenever the menu
// had it (so closing on a scroll or a fleet update does not drop it).
export function closeAgentMenu(restoreFocus = false): void {
  if (!current || !menu) return;
  if (menu.contains(document.activeElement)) restoreFocus = true;
  const closing = current;
  current = null;
  menu.hidden = true;
  menu.replaceChildren();
  closing.onClose(restoreFocus);
}

function onMenuKeydown(event: KeyboardEvent): void {
  // The menu owns the keyboard while focused: no list or window shortcuts.
  event.stopPropagation();
  if (event.metaKey || event.ctrlKey || event.altKey) return;
  if (event.key === "Escape" || event.key === "Tab") {
    event.preventDefault();
    closeAgentMenu(true);
    return;
  }
  const buttons = menuButtons();
  const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    buttons[index]?.click();
    return;
  }
  if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
    // Letters must not reach the list (j/k, c, /) through the document either.
    if (event.key.length === 1) event.preventDefault();
    return;
  }
  event.preventDefault();
  const next = event.key === "Home" ? 0
    : event.key === "End" ? buttons.length - 1
    : index < 0 ? (event.key === "ArrowDown" ? 0 : buttons.length - 1)
    : (index + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length;
  buttons[next]?.focus();
}

function ensureMenu(): HTMLElement {
  if (menu) return menu;
  menu = h("div", "agent-context-menu am-context-menu");
  menu.id = "am-agent-menu";
  menu.setAttribute("role", "menu");
  menu.setAttribute("aria-label", "Agent actions");
  menu.tabIndex = -1;
  menu.hidden = true;
  menu.addEventListener("keydown", onMenuKeydown);
  // Keep focus on the highlighted item while clicking, so nothing blurs mid-click.
  menu.addEventListener("pointerdown", (event) => event.preventDefault());
  menu.addEventListener("contextmenu", (event) => event.preventDefault());
  // One highlight, as in a native menu: the item under the pointer takes focus,
  // and leaving the items hands focus back to the menu itself.
  menu.addEventListener("pointermove", (event) => {
    const button = (event.target as Element).closest<HTMLButtonElement>("button[role='menuitem']");
    if (button && !button.disabled && document.activeElement !== button) button.focus({ preventScroll: true });
  });
  menu.addEventListener("pointerleave", () => menu?.focus({ preventScroll: true }));
  menu.addEventListener("click", (event) => {
    const button = (event.target as Element).closest<HTMLButtonElement>("button[data-menu-item]");
    if (!button || button.disabled || !current) return;
    const item = agentItems.find((candidate) => candidate.id === button.dataset.menuItem);
    const { key } = current;
    const row = findRow(key);
    closeAgentMenu(true);
    if (item && row) item.run(key, row);
  });
  document.body.append(menu);
  return menu;
}

// Opens the agent menu for `key` at a viewport point (the pointer, or a spot on
// the row for the keyboard). From the keyboard the first item takes focus; from
// the pointer the menu itself does, so nothing is highlighted until the pointer
// or an arrow key picks an item. False when the agent has no row or no item applies.
export function openAgentMenu(options: OpenMenu & { x: number; y: number; focusFirst: boolean }): boolean {
  closeAgentMenu();
  const row = findRow(options.key);
  if (!row) return false;
  const sections = menuSections(agentItems, row, options.key);
  if (!sections.length) return false;
  const box = ensureMenu();
  const nodes: HTMLElement[] = [];
  for (const section of sections) {
    if (nodes.length) {
      const separator = h("div", "menu-separator");
      separator.setAttribute("role", "separator");
      nodes.push(separator);
    }
    for (const { item, enabled } of section.entries) {
      const button = h("button", item.danger ? "danger" : "", item.label);
      button.type = "button";
      button.setAttribute("role", "menuitem");
      button.tabIndex = -1;
      button.dataset.menuItem = item.id;
      button.disabled = !enabled;
      nodes.push(button);
    }
  }
  box.replaceChildren(...nodes);
  box.hidden = false;
  const { left, top } = placeMenu({ x: options.x, y: options.y }, { width: box.offsetWidth, height: box.offsetHeight }, { width: window.innerWidth, height: window.innerHeight });
  box.style.left = `${left}px`;
  box.style.top = `${top}px`;
  current = { key: options.key, itemId: options.itemId, onClose: options.onClose };
  settling = true;
  requestAnimationFrame(() => { settling = false; });
  (options.focusFirst ? menuButtons()[0] ?? box : box).focus({ preventScroll: true });
  return true;
}

export function initContextMenu(): void {
  document.addEventListener("contextmenu", onDefaultMenu);
  document.addEventListener("pointerdown", (event) => {
    if (current && !(event.target instanceof Node && menu?.contains(event.target))) closeAgentMenu();
  }, true);
  // A key pressed with focus somewhere else (the menu lost it) closes the menu first.
  document.addEventListener("keydown", (event) => {
    if (current && !(event.target instanceof Node && menu?.contains(event.target))) closeAgentMenu();
  }, true);
  document.addEventListener("scroll", () => { if (!settling) closeAgentMenu(); }, true);
  window.addEventListener("resize", () => closeAgentMenu());
  window.addEventListener("blur", () => closeAgentMenu());
  // After the sidebar re-renders: close when the row it was opened from is gone.
  subscribe("fleet", () => {
    if (!current) return;
    const stillThere = document.querySelector(`#am-tree [data-item-id="${CSS.escape(current.itemId)}"]`) && findRow(current.key);
    if (!stillThere) closeAgentMenu();
  });
}
