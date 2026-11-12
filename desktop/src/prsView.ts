// The PRs page: every pull request the fleet's agents track, with its status in
// agent terms. web/prs.js renders it, as in the browser UI; this is the glue:
// one connection at a time, refreshes, the nav badge, and the row actions.
// Shown with `p` or the sidebar's PRs control.
import { apiGet } from "./api";
import { call, isNative } from "./bridge";
import { selectAgent } from "./chat";
import { $, composerInput, h } from "./dom";
import { saveDrafts, onComposerInput } from "./drafts";
import { registerShortcut } from "./keyboard";
import {
  errorText,
  fleetRefetchDelay,
  mergeNudge,
  needsMeCount,
  parsePrsPrefs,
  periodicDue,
  prAgentKey,
  prsPath,
  serializePrsPrefs,
} from "./prs";
import { state, subscribe } from "./state";
import { loadPrsPrefsRaw, savePrsPrefsRaw } from "./store";
import { pickConnection } from "./usage";
import { onMainViewChange, registerMainView, screen, showMainView } from "./views";

interface PrsReport {
  generatedAt?: string;
  counts?: { needsMe?: number };
  prs?: unknown[];
}
interface PrsActions {
  openAgent(key: string): void;
  openUrl(url: string): void;
  nudge(key: string, text: string): void;
  refresh(): void;
  setIncludeOlder(include: boolean): void;
}
interface PrsData {
  report: PrsReport | null;
  loading: boolean;
  error: string | null;
  includeOlder: boolean;
  notice?: string;
}
interface AgentPrsApi {
  buildPage(root: HTMLElement): HTMLElement;
  render(root: HTMLElement, data: PrsData, actions: PrsActions): void;
}
declare global {
  interface Window {
    agentPrs: AgentPrsApi;
  }
}

const VIEW = "prs";
const SUBTITLE = "Every PR your agents track, the ones that need you first.";
// How often the periodic check runs; PRS_INTERVAL_MS decides whether it fetches.
const TICK_MS = 5000;

const prefs = parsePrsPrefs(loadPrsPrefsRaw());
// Everything below belongs to `connection`; switching connections resets it.
let connection: string | null = null;
let report: PrsReport | null = null;
let error: string | null = null;
// A message for the status line until the next user action on the page.
let notice = "";
let inFlight = false;
let fetchedAt = 0;
let seq = 0;
// The connection's agents load last seen: a newer one means a fleet event (or poll) landed.
let seenAgents = 0;
let backgroundTimer: ReturnType<typeof setTimeout> | null = null;

let page: HTMLElement;
let root: HTMLElement;
let picker: HTMLSelectElement;
let navButton: HTMLButtonElement;
let navCount: HTMLElement;

const savePrefs = () => savePrsPrefsRaw(serializePrsPrefs(prefs));
const pageVisible = () => !!page && !page.hidden && screen() === "fleet";

function render(): void {
  if (!pageVisible()) return;
  window.agentPrs.render(root, { report, loading: inFlight && !report, error, includeOlder: prefs.includeOlder, notice }, actions);
}

function updateBadge(): void {
  const count = needsMeCount(report);
  navCount.textContent = count ? String(count) : "";
  navCount.hidden = !count;
  const name = connection && state.conns.size > 1 ? state.conns.get(connection)?.conn.name : "";
  navCount.title = `${count} PR${count === 1 ? " needs" : "s need"} you${name ? ` on ${name}` : ""}`;
}

async function refresh(): Promise<void> {
  const conn = connection;
  if (!conn || !state.conns.has(conn)) return;
  if (backgroundTimer) clearTimeout(backgroundTimer);
  backgroundTimer = null;
  const id = ++seq;
  fetchedAt = Date.now();
  inFlight = true;
  if (!report) render();
  try {
    const data = await apiGet<PrsReport>(conn, prsPath(prefs.includeOlder));
    if (id !== seq || conn !== connection) return;
    if (!data || typeof data !== "object" || !Array.isArray(data.prs)) throw new Error("unexpected response from /api/prs");
    report = data;
    error = null;
  } catch (failure) {
    if (id !== seq || conn !== connection) return;
    // The last good report stays; the module says it could not refresh.
    error = errorText(failure);
  }
  inFlight = false;
  updateBadge();
  render();
}

// A fleet event (or the fleet poll) for the page's connection: the report may have moved.
function onFleetLoad(): void {
  const delay = fleetRefetchDelay({ pageVisible: pageVisible(), fetchedAt, now: Date.now() });
  if (delay === 0) {
    void refresh();
    return;
  }
  backgroundTimer ??= setTimeout(() => {
    backgroundTimer = null;
    void refresh();
  }, delay);
}

function fleetKey(key: string): string | null {
  const conn = connection ? state.conns.get(connection) : undefined;
  return conn ? prAgentKey(conn.conn.id, conn.rows, key) : null;
}

function clearNotice(): void {
  if (!notice) return;
  notice = "";
  render();
}

function notInFleet(key: string): void {
  notice = `${key} is not in the fleet any more`;
  render();
}

const actions: PrsActions = {
  openAgent(key) {
    clearNotice();
    const target = fleetKey(key);
    if (target) selectAgent(target, true);
    else notInFleet(key);
  },
  openUrl(url) {
    clearNotice();
    call("open.external", { url })
      .then(() => { if (!isNative()) window.open(url, "_blank", "noopener"); })
      .catch((failure: unknown) => console.warn("open.external failed", failure));
  },
  // Opens the agent with the text in its message box, after any draft; never sends.
  nudge(key, text) {
    clearNotice();
    const target = fleetKey(key);
    if (!target) {
      notInFleet(key);
      return;
    }
    selectAgent(target);
    const input = composerInput();
    input.value = mergeNudge(input.value, text);
    onComposerInput();
    saveDrafts();
    if (input.disabled) {
      // A stopped agent: its composer explains why it can't take the message.
      $("transcript").focus({ preventScroll: true });
      return;
    }
    input.focus({ preventScroll: true });
    input.setSelectionRange(input.value.length, input.value.length);
    input.scrollTop = input.scrollHeight;
  },
  refresh() {
    clearNotice();
    void refresh();
  },
  setIncludeOlder(include) {
    notice = "";
    prefs.includeOlder = !!include;
    savePrefs();
    render();
    void refresh();
  },
};

// A fresh root on every connection change, so nothing from another server (its
// rows, or a repo filter only it has) stays on screen.
function buildRoot(): void {
  const next = h("div");
  next.id = "prs-page";
  window.agentPrs.buildPage(next);
  if (root) root.replaceWith(next);
  else page.append(next);
  root = next;
}

function setConnection(id: string | null): void {
  if (id === connection) return;
  connection = id;
  seq++;
  report = null;
  error = null;
  notice = "";
  inFlight = false;
  fetchedAt = 0;
  seenAgents = id ? state.conns.get(id)?.agentsApplied ?? 0 : 0;
  if (backgroundTimer) clearTimeout(backgroundTimer);
  backgroundTimer = null;
  if (id) prefs.connection = id;
  savePrefs();
  buildRoot();
  updateBadge();
  renderPicker();
}

function renderPicker(): void {
  const conns = [...state.conns.values()];
  const signature = JSON.stringify(conns.map((conn) => [conn.conn.id, conn.conn.name]));
  if (picker.dataset.options !== signature) {
    picker.replaceChildren(...conns.map((conn) => new Option(conn.conn.name, conn.conn.id)));
    picker.dataset.options = signature;
  }
  picker.value = connection ?? "";
  picker.closest<HTMLElement>(".am-usage-conn")!.hidden = conns.length <= 1;
}

export function showPrs(): void {
  if (screen() !== "fleet") return;
  const target = pickConnection([...state.conns.keys()], { openKey: state.selected, saved: prefs.connection });
  if (state.selected) selectAgent(null);
  showMainView(VIEW);
  setConnection(target);
  render();
  void refresh();
}

function navStrip(): HTMLElement {
  let nav = document.getElementById("am-nav");
  if (!nav) {
    nav = h("nav");
    nav.id = "am-nav";
    nav.setAttribute("aria-label", "Pages");
    $("am-sidebar").prepend(nav);
  }
  return nav;
}

function buildPage(): void {
  page = h("section");
  page.id = "am-prs";
  page.hidden = true;
  page.setAttribute("aria-label", "Pull requests");
  const head = h("header", "am-usage-head");
  const titles = h("div", "am-usage-titles");
  titles.append(h("h1", "", "Pull requests"), h("p", "am-usage-sub", SUBTITLE));
  const label = h("label", "am-usage-conn");
  picker = h("select");
  picker.id = "am-prs-connection";
  label.append("Server", picker);
  label.hidden = true;
  picker.addEventListener("change", () => {
    setConnection(picker.value || null);
    render();
    void refresh();
  });
  head.append(titles, label);
  page.append(head);
  $("am-main").append(page);
  // The module has already opened a plain click on a PR or decision link
  // (actions.openUrl); the app-wide link handler must not open it again.
  page.addEventListener("click", (event) => {
    if (event.defaultPrevented && (event.target as HTMLElement).closest?.("a[href]")) event.stopPropagation();
  });

  navButton = h("button", "am-nav-item");
  navButton.id = "am-nav-prs";
  navButton.type = "button";
  navButton.title = "Pull requests (p)";
  navCount = h("span", "am-nav-count");
  navCount.hidden = true;
  navButton.append(h("span", "am-nav-icon", "⇄"), h("span", "am-nav-label", "PRs"), navCount, h("kbd", "", "p"));
  navButton.addEventListener("click", showPrs);
  navStrip().append(navButton);

  onMainViewChange(() => {
    if (pageVisible()) navButton.setAttribute("aria-current", "page");
    else navButton.removeAttribute("aria-current");
  });
}

export function initPrs(): void {
  buildPage();
  buildRoot();
  registerMainView({ id: VIEW, element: page });
  registerShortcut({ keys: ["p"], run: showPrs });
  subscribe("fleet", () => {
    if (connection === null || !state.conns.has(connection)) {
      setConnection(pickConnection([...state.conns.keys()], { saved: prefs.connection }));
      render();
      if (connection && state.conns.get(connection)?.loaded) void refresh();
    }
    renderPicker();
    const conn = connection ? state.conns.get(connection) : undefined;
    if (!conn || conn.agentsApplied === seenAgents) return;
    seenAgents = conn.agentsApplied;
    onFleetLoad();
  });
  setInterval(() => {
    if (periodicDue({ pageVisible: pageVisible(), documentHidden: document.hidden, fetchedAt, now: Date.now() })) void refresh();
  }, TICK_MS);
}
