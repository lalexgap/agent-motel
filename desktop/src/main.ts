// Agent Motel desktop frontend: wires the views together and starts the app.
// All server traffic goes through the bridge.
import { call, isNative, on, startBridge } from "./bridge";
import { initChat, selectAgent, tickWorking } from "./chat";
import { initComposer } from "./composerView";
import { initConnections, openSetup } from "./connections";
import { initContextMenu } from "./contextMenu";
import { onStreamMessage, onStreamState, poll, reloadAll, startConnection } from "./data";
import { initOverview, tickOverview } from "./overview";
import { parseAgentKey } from "./fleet";
import { initKeyboard } from "./keyboard";
import { applySidebarWidth, focusFilter, initSidebar, tickTimes } from "./sidebar";
import { changed, newConnState, state } from "./state";
import { initStatusbar } from "./statusbar";
import type { BridgeEvents, Connection } from "./types";
import { setScreen } from "./views";

function onMenu(payload: BridgeEvents["menu.command"]): void {
  if (payload.command === "connections") openSetup();
  else if (payload.command === "find") focusFilter();
  else if (payload.command === "reload") void reloadAll();
}

// Listeners and subscriptions run in registration order, so the order here is
// the order views render in.
function wire(): void {
  initKeyboard();
  initComposer();
  initSidebar();
  // After the sidebar, so a fleet re-render has replaced the rows before the menu checks its row.
  initContextMenu();
  initStatusbar();
  initConnections();
  initOverview();
  initChat();
  // Links in chat open in the user's browser, never inside the app's web view.
  document.addEventListener("click", (event) => {
    const link = (event.target as HTMLElement).closest?.("a[href]") as HTMLAnchorElement | null;
    if (!link || !/^https?:/i.test(link.href)) return;
    event.preventDefault();
    call("open.external", { url: link.href })
      .then(() => { if (!isNative()) window.open(link.href, "_blank", "noopener"); })
      .catch((error: unknown) => console.warn("open.external failed", error));
  });
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) void reloadAll();
  });

  on("events.state", onStreamState);
  on("events.message", onStreamMessage);
  on("menu.command", onMenu);
}

// One clock: relative times, the working indicator, and the polls that cover
// what the fleet stream does not (transcript appends, a stream that is down).
function tick(): void {
  const now = Date.now();
  tickTimes(now);
  tickWorking();
  tickOverview(now);
  if (document.hidden) return;
  poll(now);
}

async function start(): Promise<void> {
  applySidebarWidth();
  startBridge();
  wire();
  call("app.info", {})
    .then((info) => {
      state.info = info;
      changed("status");
    })
    .catch((error: unknown) => console.warn("app.info failed", error));
  let connections: Connection[] = [];
  try {
    connections = await call("connections.list", {});
  } catch (error) {
    console.error("connections.list failed", error);
  }
  for (const conn of connections) state.conns.set(conn.id, newConnState(conn));
  if (!connections.length) {
    state.selected = null;
    openSetup();
  } else {
    setScreen("fleet");
    if (state.selected && !state.conns.has(parseAgentKey(state.selected)?.connection ?? "")) state.selected = null;
    const restored = state.selected;
    state.selected = null;
    changed("fleet");
    if (restored) selectAgent(restored);
    else selectAgent(null);
    for (const conn of connections) void startConnection(conn);
  }
  changed("status");
  setInterval(tick, 1000);
  document.body.dataset.ready = "true";
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", () => void start());
else void start();
