// The inspector: a panel on the right of the open agent's chat (and of its
// subagents' transcripts) with sections about that agent. Docked when the
// window leaves the transcript room, otherwise it opens as an overlay. `i` or
// the header button toggles it; its width and open state persist.
//
// Sections register themselves and render for the open agent on every "agent"
// change; returning null hides the section.
import { registerHeaderAction } from "./chat";
import { $, h } from "./dom";
import {
  clampInspectorWidth,
  INSPECTOR_MIN,
  inspectorDocks,
  inspectorMax,
  parseInspectorPrefs,
  serializeInspectorPrefs,
} from "./inspectorModel";
import { registerShortcut } from "./keyboard";
import { state, subscribe, type DetailState } from "./state";
import { loadInspectorPrefsRaw, saveInspectorPrefsRaw } from "./store";
import { mainView, onMainViewChange } from "./views";

export interface InspectorSection {
  id: string;
  title: string;
  // Lower comes first.
  order: number;
  // The section's body for the open agent, or null to hide the section.
  render(key: string, detail: DetailState | null): HTMLElement | null;
  // Controls for the section's header (a count, a toggle).
  accessory?(key: string, detail: DetailState | null): HTMLElement | null;
}

const sections: InspectorSection[] = [];
export function registerInspectorSection(section: InspectorSection): void {
  sections.push(section);
  sections.sort((a, b) => a.order - b.order);
  renderInspector();
}

export const inspectorPrefs = parseInspectorPrefs(loadInspectorPrefsRaw());
export const saveInspectorPrefs = (): void => saveInspectorPrefsRaw(serializeInspectorPrefs(inspectorPrefs));

const HOST_VIEWS = new Set(["chat", "subagent"]);
// Open as an overlay because the window is too narrow to dock it; not saved.
let overlayOpen = false;
let panel: HTMLElement;
let body: HTMLElement;
let divider: HTMLElement;

const docks = (): boolean =>
  inspectorDocks({ windowWidth: window.innerWidth, sidebarWidth: currentSidebarWidth(), inspectorWidth: inspectorPrefs.width });
function currentSidebarWidth(): number {
  const value = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--am-sidebar-width"));
  return Number.isFinite(value) ? value : state.sidebarWidth;
}

export type InspectorMode = "docked" | "overlay" | "closed";
export function inspectorMode(): InspectorMode {
  if (!state.selected || !HOST_VIEWS.has(mainView() ?? "")) return "closed";
  if (docks()) return inspectorPrefs.open ? "docked" : "closed";
  return overlayOpen ? "overlay" : "closed";
}

export function toggleInspector(): void {
  if (docks()) {
    inspectorPrefs.open = !inspectorPrefs.open;
    saveInspectorPrefs();
  } else overlayOpen = !overlayOpen;
  applyLayout();
  if (inspectorMode() === "overlay") panel.focus({ preventScroll: true });
}
export function closeOverlay(): boolean {
  if (inspectorMode() !== "overlay") return false;
  overlayOpen = false;
  applyLayout();
  return true;
}

function applyWidth(): void {
  const width = clampInspectorWidth(inspectorPrefs.width, window.innerWidth);
  document.documentElement.style.setProperty("--am-inspector-width", `${width}px`);
}

export function applyLayout(): void {
  if (!panel) return;
  // The overlay is for this view at this width only.
  if (docks() || !state.selected || !HOST_VIEWS.has(mainView() ?? "")) overlayOpen = false;
  const mode = inspectorMode();
  applyWidth();
  document.body.classList.toggle("am-inspector-docked", mode === "docked");
  panel.hidden = mode === "closed";
  panel.classList.toggle("overlay", mode === "overlay");
  divider.hidden = mode !== "docked";
  const shown = mode !== "closed";
  for (const button of document.querySelectorAll<HTMLButtonElement>(".am-inspector-toggle")) markToggle(button, shown);
  if (shown) renderInspector();
}

// Markup without inline styles: status dots carry a per-render animation phase.
const signature = (node: HTMLElement): string => node.outerHTML.replace(/ style="[^"]*"/g, "");

// Keeps keyboard focus on the same control when a section re-renders.
function focusKey(): string | null {
  const active = document.activeElement as HTMLElement | null;
  return active && panel.contains(active) ? active.dataset.focusKey ?? null : null;
}

export function renderInspector(): void {
  if (!panel || panel.hidden) return;
  const key = state.selected;
  if (!key) return;
  const detail = state.detail?.key === key ? state.detail : null;
  const focused = focusKey();
  const existing = new Map([...body.querySelectorAll<HTMLElement>(":scope > [data-section]")].map((node) => [node.dataset.section!, node]));
  const nodes: HTMLElement[] = [];
  for (const section of sections) {
    const content = section.render(key, detail);
    if (!content) continue;
    const node = h("section", "am-insp-section");
    node.dataset.section = section.id;
    node.setAttribute("aria-labelledby", `am-insp-${section.id}-title`);
    const head = h("header", "am-insp-head");
    const title = h("h2", "", section.title);
    title.id = `am-insp-${section.id}-title`;
    head.append(title);
    const accessory = section.accessory?.(key, detail);
    if (accessory) head.append(accessory);
    node.append(head, content);
    // Unchanged sections keep their nodes, so a background refresh never moves focus or hover.
    const old = existing.get(section.id);
    nodes.push(old && signature(old) === signature(node) ? old : node);
  }
  if (!nodes.length) nodes.push(h("p", "am-insp-empty", "Nothing to show for this agent."));
  if (nodes.length === body.children.length && nodes.every((node, index) => body.children[index] === node)) return;
  body.replaceChildren(...nodes);
  if (focused) body.querySelector<HTMLElement>(`[data-focus-key="${CSS.escape(focused)}"]`)?.focus({ preventScroll: true });
}

export function inspectorToggle(): HTMLButtonElement {
  const button = h("button", "am-icon-button am-inspector-toggle");
  button.type = "button";
  button.setAttribute("aria-controls", "am-inspector");
  button.setAttribute("aria-label", "Inspector");
  button.append(panelIcon());
  button.addEventListener("click", toggleInspector);
  markToggle(button, inspectorMode() !== "closed");
  return button;
}
function markToggle(button: HTMLButtonElement, shown: boolean): void {
  button.setAttribute("aria-pressed", String(shown));
  button.title = `${shown ? "Hide" : "Show"} the inspector (i)`;
}

function panelIcon(): SVGElement {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  for (const [attr, value] of Object.entries({
    class: "icon", viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", "stroke-width": "1.8", "stroke-linejoin": "round", "aria-hidden": "true",
  })) svg.setAttribute(attr, value);
  const frame = document.createElementNS(ns, "rect");
  for (const [attr, value] of Object.entries({ x: "3", y: "4", width: "18", height: "16", rx: "2.5" })) frame.setAttribute(attr, value);
  const line = document.createElementNS(ns, "path");
  line.setAttribute("d", "M15 4v16");
  svg.append(frame, line);
  return svg;
}

const focusMain = () => $(mainView() === "subagent" ? "am-sub-transcript" : "transcript").focus({ preventScroll: true });

function wireDivider(): void {
  const shell = $("am-shell");
  const widthAt = (clientX: number) => clampInspectorWidth(shell.getBoundingClientRect().right - clientX - 2, window.innerWidth);
  divider.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    divider.setPointerCapture(event.pointerId);
    document.body.classList.add("am-resizing");
    const move = (moveEvent: PointerEvent) => {
      inspectorPrefs.width = widthAt(moveEvent.clientX);
      applyWidth();
    };
    const up = () => {
      document.body.classList.remove("am-resizing");
      divider.removeEventListener("pointermove", move);
      divider.removeEventListener("pointerup", up);
      divider.removeEventListener("pointercancel", up);
      saveInspectorPrefs();
      // A wider panel may no longer leave the transcript room.
      applyLayout();
    };
    divider.addEventListener("pointermove", move);
    divider.addEventListener("pointerup", up);
    divider.addEventListener("pointercancel", up);
  });
  divider.addEventListener("keydown", (event) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    event.stopPropagation();
    inspectorPrefs.width = clampInspectorWidth(inspectorPrefs.width + (event.key === "ArrowLeft" ? 16 : -16), window.innerWidth);
    saveInspectorPrefs();
    applyLayout();
  });
}

function build(): void {
  divider = h("div");
  divider.id = "am-inspector-divider";
  divider.setAttribute("role", "separator");
  divider.setAttribute("aria-orientation", "vertical");
  divider.setAttribute("aria-label", "Resize inspector");
  divider.setAttribute("aria-valuemin", String(INSPECTOR_MIN));
  divider.tabIndex = 0;
  divider.hidden = true;
  panel = h("aside");
  panel.id = "am-inspector";
  panel.tabIndex = -1;
  panel.setAttribute("aria-label", "Inspector");
  panel.hidden = true;
  const head = h("div", "am-insp-bar");
  const close = h("button", "am-icon-button am-insp-close", "×");
  close.type = "button";
  close.title = "Hide the inspector (i)";
  close.setAttribute("aria-label", "Hide the inspector");
  close.addEventListener("click", () => {
    toggleInspector();
    focusMain();
  });
  head.append(h("span", "am-insp-bar-title", "Inspector"), close);
  body = h("div", "am-insp-body");
  panel.append(head, body);
  $("am-shell").append(divider, panel);
}

export function initInspector(): void {
  build();
  wireDivider();
  const chatToggle = inspectorToggle();
  registerHeaderAction(() => chatToggle);
  subscribe("agent", applyLayout);
  onMainViewChange(applyLayout);
  // The sidebar's width decides whether the panel still docks.
  new ResizeObserver(() => applyLayout()).observe($("am-sidebar"));
  // Overlay: Esc closes it, before anything else Esc does.
  registerShortcut({ keys: ["Escape"], whileTyping: true, when: () => inspectorMode() === "overlay", run: () => {
    closeOverlay();
    focusMain();
  } });
  registerShortcut({ keys: ["i"], when: () => !!state.selected && HOST_VIEWS.has(mainView() ?? ""), run: toggleInspector });
  // A click outside the overlay closes it.
  document.addEventListener("pointerdown", (event) => {
    if (inspectorMode() !== "overlay") return;
    const target = event.target as HTMLElement;
    if (panel.contains(target) || target.closest?.(".am-inspector-toggle")) return;
    closeOverlay();
  });
  window.addEventListener("resize", () => {
    divider.setAttribute("aria-valuemax", String(inspectorMax(window.innerWidth)));
    applyLayout();
  });
  divider.setAttribute("aria-valuemax", String(inspectorMax(window.innerWidth)));
  applyLayout();
}
