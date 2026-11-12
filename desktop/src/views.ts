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
  // Runs after the view is shown, to fill it.
  onShow?: () => void;
}
const views: MainView[] = [];
let active: string | null = null;

export function registerMainView(view: MainView): void {
  views.push(view);
}

export function showMainView(id: string): void {
  for (const view of views) view.element.hidden = view.id !== id;
  active = id;
  views.find((view) => view.id === id)?.onShow?.();
}

export const mainView = (): string | null => active;
