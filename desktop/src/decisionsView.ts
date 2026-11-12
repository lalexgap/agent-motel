import { apiGet, ApiError } from "./api";
import { selectAgent } from "./chat";
import { DecisionsInbox, type DecisionsReport } from "./decisionsInbox";
import { $, h } from "./dom";
import { agentKey } from "./fleet";
import { registerShortcut } from "./keyboard";
import { state, subscribe } from "./state";
import { pickConnection } from "./usage";
import { onMainViewChange, registerMainView, screen, showMainView } from "./views";

interface DecisionsActions {
  refresh(): void;
  setQuery(query: string): void;
  setBlockingOnly(blocking: boolean): void;
  openAgent(name: string): void;
}
declare global {
  interface Window {
    agentDecisionsPage: {
      buildPage(root: HTMLElement): HTMLElement;
      render(root: HTMLElement, data: {
        report: DecisionsReport | null; loading: boolean; error: string | null;
        query: string; blockingOnly: boolean; notice?: string;
      }, actions: DecisionsActions): void;
    };
  }
}

let page: HTMLElement;
let root: HTMLElement;
let picker: HTMLSelectElement;
let nav: HTMLButtonElement;
let badge: HTMLElement;
let query = "";
let blockingOnly = false;
let notice = "";
let seenAgents = 0;
const visible = () => !!page && !page.hidden && screen() === "fleet";
const inbox = new DecisionsInbox(async (connection) => {
  try { return await apiGet(connection, "/api/decisions"); }
  catch (error) {
    if (error instanceof ApiError && error.status === 404) throw new Error("Update this server to view its decisions inbox.");
    throw error;
  }
}, render);

function render(): void {
  if (!page) return;
  const reported = inbox.report?.groups.reduce((total, group) => total + group.decisions.length, 0);
  const rows = state.conns.get(inbox.connection ?? "")?.rows ?? [];
  if (reported !== undefined) {
    badge.textContent = String(reported);
    badge.hidden = !reported;
    badge.title = `${reported} open decisions on the selected server`;
    if (visible()) window.agentDecisionsPage.render(root, {
      report: inbox.report, loading: inbox.loading, error: inbox.error,
      query, blockingOnly, notice: notice || (!inbox.connection ? "Connect a server to view decisions." : ""),
    }, actions);
    return;
  }
  const count = rows.filter((row) => !row.host).reduce((total, row) => total + (row.openDecisions ?? 0), 0);
  badge.textContent = String(count);
  badge.hidden = !count;
  badge.title = `${count} open decisions on the selected server`;
  if (visible()) window.agentDecisionsPage.render(root, {
    report: inbox.report, loading: inbox.loading, error: inbox.error,
    query, blockingOnly, notice: notice || (!inbox.connection ? "Connect a server to view decisions." : ""),
  }, actions);
}

const actions: DecisionsActions = {
  refresh() { notice = ""; void inbox.refresh(); },
  setQuery(value) { query = value; render(); },
  setBlockingOnly(value) { blockingOnly = value; render(); },
  openAgent(name) {
    const conn = state.conns.get(inbox.connection ?? "");
    const row = conn?.rows.find((row) => !row.host && row.name === name);
    if (conn && row) selectAgent(agentKey(conn.conn.id, row), false, "chat");
    else { notice = `${name} is no longer in this server's fleet. Its open decisions are still shown here.`; render(); }
  },
};

function setConnection(connection: string | null): void {
  if (connection === inbox.connection) return;
  inbox.select(connection);
  notice = "";
  query = "";
  blockingOnly = false;
  seenAgents = state.conns.get(connection ?? "")?.agentsApplied ?? 0;
  picker.value = connection ?? "";
  render();
}

function renderPicker(): void {
  const connections = [...state.conns.values()];
  const signature = JSON.stringify(connections.map(({ conn }) => [conn.id, conn.name]));
  if (picker.dataset.options !== signature) {
    picker.replaceChildren(...connections.map(({ conn }) => new Option(conn.name, conn.id)));
    picker.dataset.options = signature;
  }
  picker.value = inbox.connection ?? "";
}

export function showDecisionsForAgent(connection: string, name: string): void {
  showDecisions();
  setConnection(connection);
  query = name;
  renderPicker();
  render();
  void inbox.refresh();
}

export function showDecisions(): void {
  if (screen() !== "fleet") return;
  const target = pickConnection([...state.conns.keys()], { openKey: state.selected, saved: inbox.connection });
  if (state.selected) selectAgent(null);
  showMainView("decisions");
  setConnection(target);
  renderPicker();
  render();
  void inbox.refresh();
}

export function initDecisionsPage(): void {
  page = h("section");
  page.id = "am-decisions-page";
  page.hidden = true;
  page.setAttribute("aria-label", "Open decisions");
  const header = h("header", "am-usage-head");
  const titles = h("div", "am-usage-titles");
  titles.append(h("h1", "", "Decisions"), h("p", "am-usage-sub", "Open questions from agents on this server, including stopped agents."));
  const label = h("label", "am-usage-conn");
  picker = h("select");
  picker.id = "am-decisions-connection";
  label.append("Server", picker);
  picker.addEventListener("change", () => { setConnection(picker.value || null); void inbox.refresh(); });
  header.append(titles, label);
  root = h("div");
  window.agentDecisionsPage.buildPage(root);
  page.append(header, root);
  $("am-main").append(page);
  nav = h("button", "am-nav-item");
  nav.id = "am-nav-decisions";
  nav.type = "button";
  nav.title = "Decisions (d)";
  badge = h("span", "am-nav-count");
  badge.hidden = true;
  nav.append(h("span", "am-nav-icon", "?"), h("span", "am-nav-label", "Decisions"), badge, h("kbd", "", "d"));
  nav.addEventListener("click", () => showDecisions());
  $("am-nav").append(nav);
  registerMainView({ id: "decisions", element: page });
  registerShortcut({ keys: ["d"], run: showDecisions });
  onMainViewChange(() => {
    if (visible()) nav.setAttribute("aria-current", "page");
    else nav.removeAttribute("aria-current");
  });
  subscribe("fleet", () => {
    if (!inbox.connection || !state.conns.has(inbox.connection)) {
      setConnection(pickConnection([...state.conns.keys()], {}));
    }
    renderPicker();
    const applied = state.conns.get(inbox.connection ?? "")?.agentsApplied ?? 0;
    if (applied !== seenAgents) {
      seenAgents = applied;
      if (Date.now() - inbox.fetchedAt > 2000) void inbox.refresh();
    }
    render();
  });
  setInterval(() => {
    if (!document.hidden && Date.now() - inbox.fetchedAt >= 15000) void inbox.refresh();
  }, 3000);
}
