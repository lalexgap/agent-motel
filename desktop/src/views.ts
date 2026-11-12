// What the window shows. The screen is the whole window (the connections setup
// or the fleet: sidebar plus main area); the main view is what fills the main
// area next to the sidebar. A page such as search registers a main view and
// shows it; switching main views never changes the screen.
import { $ } from "./dom";

export type Screen = "setup" | "fleet";

export function setScreen(screen: Screen): void {
  document.body.dataset.view = screen;
  $("am-setup").hidden = screen !== "setup";
  $("am-shell").hidden = screen !== "fleet";
}

export const screen = (): Screen => (document.body.dataset.view === "setup" ? "setup" : "fleet");

export interface MainView {
  id: string;
  element: HTMLElement;
  onShow?: () => void;
  // Runs before the view is hidden for another one (not when shown again).
  onHide?: () => void;
}
const views: MainView[] = [];
const listeners: (() => void)[] = [];
let active: string | null = null;

// The one view-change hook: runs after every showMainView, for nav marks and
// anything else that depends on which view is up.
export function onMainViewChange(listener: () => void): void {
  listeners.push(listener);
}

export function registerMainView(view: MainView): void {
  views.push(view);
}

export function showMainView(id: string): void {
  const previous = active;
  if (previous !== id) views.find((view) => view.id === previous)?.onHide?.();
  for (const view of views) view.element.hidden = view.id !== id;
  active = id;
  $("am-main").dataset.mainView = id;
  views.find((view) => view.id === id)?.onShow?.();
  for (const listener of listeners) listener();
}

export const mainView = (): string | null => active;
