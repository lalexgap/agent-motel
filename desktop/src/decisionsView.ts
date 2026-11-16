import { apiGet, ApiError } from "./api";
import { call, on } from "./bridge";
import { selectAgent } from "./chat";
import { submitDecision } from "./decisionSubmit";
import { countOpenDecisions, DecisionReports } from "./decisionReports";
import { refreshConnection } from "./data";
import { DecisionsInbox, type DecisionsReport } from "./decisionsInbox";
import { $, h } from "./dom";
import { agentKey } from "./fleet";
import { registerShortcut } from "./keyboard";
import { state, subscribe } from "./state";
import { pickConnection } from "./usage";
import { onMainViewChange, registerMainView, screen, setScreen, showMainView, type Screen } from "./views";

interface DecisionsActions {
  refresh(): void;
  setQuery(query: string): void;
  setBlockingOnly(blocking: boolean): void;
  openAgent(name: string): void;
  onSubmit?(decision: { id: string }, agent: string, action: "answer" | "withdraw", text: string, scope: string): Promise<void>;
}
declare global {
  interface Window {
    agentDecisionsPage: {
      buildPage(root: HTMLElement): HTMLElement;
      render(root: HTMLElement, data: {
        report: DecisionsReport | null; loading: boolean; error: string | null;
        query: string; blockingOnly: boolean; notice?: string; scope?: string;
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
let actionSequence = 0;
let seenAgents = 0;
let publishedCount: number | null = null;
const visible = () => !!page && !page.hidden && screen() === "fleet";
const reports = new DecisionReports(async (connection) => {
  try { return await apiGet(connection, "/api/decisions"); }
  catch (error) {
    if (error instanceof ApiError && error.status === 404) throw new Error("Update this server to view its decisions inbox.");
    throw error;
  }
}, render);
const inbox = new DecisionsInbox((connection, latest) => reports.fetch(connection, latest), render);

export function isDecisionsChanged(payload: { event: string; data: unknown }): boolean {
  return payload.event === "fleet" && !!payload.data && typeof payload.data === "object"
    && (payload.data as { event?: unknown }).event === "decisions-changed";
}

export function decisionsScreen(current: Screen, connections: number): Screen {
  return current === "setup" && connections === 0 ? "setup" : "fleet";
}

function publishDecisionCount(): void {
  const count = reports.count();
  if (count === publishedCount) return;
  publishedCount = count;
  void call("decisions.count", { count }).catch(() => {
    if (publishedCount === count) publishedCount = null;
  });
}

function render(): void {
  if (!page) return;
  publishDecisionCount();
  const reported = inbox.report ? countOpenDecisions(inbox.report) : undefined;
  if (reported !== undefined) {
    badge.textContent = String(reported);
    badge.hidden = !reported;
    badge.title = `${reported} open decisions on the selected server`;
    if (visible()) window.agentDecisionsPage.render(root, {
      report: inbox.report, loading: inbox.loading, error: inbox.error,
      query, blockingOnly, scope: inbox.connection ?? "", notice: notice || (inbox.report && !inbox.report.complete ? "Some local decision stores could not be read; refresh to try again." : !inbox.connection ? "Connect a server to view decisions." : ""),
    }, actions);
    return;
  }
  badge.textContent = "0";
  badge.hidden = true;
  badge.title = "0 open decisions on the selected server";
  if (visible()) window.agentDecisionsPage.render(root, {
    report: inbox.report, loading: inbox.loading, error: inbox.error,
    query, blockingOnly, scope: inbox.connection ?? "", notice: notice || (inbox.report && !inbox.report.complete ? "Some local decision stores could not be read; refresh to try again." : !inbox.connection ? "Connect a server to view decisions." : ""),
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
  async onSubmit(decision, agent, action, text, scope) {
    const connection = scope;
    if (!connection) throw new Error("Select a server to answer this decision.");
    const request = ++actionSequence;
    try {
      await submitDecision(connection, agent, decision.id, action, text);
      await Promise.all([inbox.refreshLatest(), refreshConnection(connection)]);
      if (request === actionSequence && inbox.connection === connection && notice) {
        notice = "";
        render();
      }
    } catch (cause) {
      if (request === actionSequence && inbox.connection === connection) {
        notice = cause instanceof Error ? cause.message : "Could not submit this decision.";
        render();
      }
      throw cause;
    }
  },
};

function setConnection(connection: string | null): void {
  if (connection === inbox.connection) return;
  actionSequence++;
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
  const targetScreen = decisionsScreen(screen(), state.conns.size);
  if (targetScreen !== "fleet") return;
  if (screen() !== targetScreen) setScreen(targetScreen);
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
    reports.setConnections(state.conns.keys());
    reports.refreshStale(Date.now(), 2000);
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
  on("events.message", (payload) => {
    if (!isDecisionsChanged(payload)) return;
    if (payload.connection === inbox.connection) void inbox.refreshLatest();
    else void reports.refresh(payload.connection, true);
  });
  setInterval(() => {
    if (document.hidden) return;
    reports.refreshStale(Date.now(), 15000);
    if (Date.now() - inbox.fetchedAt >= 15000) void inbox.refresh();
  }, 3000);
}
