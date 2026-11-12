// The token usage page: the browser UI's dashboard (web/usage.js renders it)
// for one connection at a time, with the same requests, refresh cadence and
// controls as web/app.js's glue. Shown with `u` or the sidebar's Usage control.
import { apiGet } from "./api";
import { selectAgent } from "./chat";
import { openSubagent } from "./subagentView";
import { $, dot, h } from "./dom";
import { agentId, conciergeId } from "./fleet";
import { registerShortcut } from "./keyboard";
import { state, subscribe } from "./state";
import { loadUsagePrefsRaw, saveUsagePrefsRaw } from "./store";
import {
  breakdownPath,
  parseUsagePrefs,
  periodicDue,
  pickConnection,
  scopeForKey,
  serializeUsagePrefs,
  summaryPath,
  summaryStatus,
  usageAgentKey,
  type UsageRange,
  type UsageUnit,
} from "./usage";
import { onMainViewChange, registerMainView, screen, showMainView } from "./views";

interface UsageView {
  range: UsageRange;
  unit: UsageUnit;
  summary: UsageSummary | null;
  fetchedAt: number;
  showAllAgents: boolean;
}
interface UsageSummary {
  generatedAt?: string;
  indexing?: { pendingFiles?: number };
}
interface UsageAgentReport {
  name: string;
}
interface UsageReport {
  agents?: UsageAgentReport[];
  anomalies?: { agent?: string; subagentId?: string }[];
}
interface UsageActions {
  statusDot(status: string): Node;
  setRange(range: number): void;
  setUnit(unit: string): void;
  changeSummaryFilter(): void;
  refreshSummary(): void;
  breakdownToggled(open: boolean): void;
  changeBreakdownFilter(): void;
  refreshBreakdown(): void;
  openBreakdown(agentName: string): void;
  toggleAllAgents(): void;
  toggleSubagents?(agentName: string): void;
  openAgent(name: string): void;
  openSubagent(agentName: string, id: string, label: string, statusLabel: string): void;
  chartResized(): void;
}
interface UsageDashboardApi {
  buildPage(root: HTMLElement): HTMLElement;
  bindControls(root: HTMLElement, actions: UsageActions): void;
  populateAgentSelect(root: HTMLElement, fleetNames: string[], reportAgents?: UsageAgentReport[]): void;
  renderQuota(root: HTMLElement, quota: unknown[] | null): void;
  renderDashboard(root: HTMLElement, view: UsageView, actions: UsageActions): void;
  renderChart(root: HTMLElement, view: UsageView): void;
  renderTopAgents(root: HTMLElement, view: UsageView, actions: UsageActions): void;
  renderBreakdown(root: HTMLElement, report: UsageReport, options: { expanded: Set<string> }, actions: UsageActions): void;
}
declare global {
  interface Window {
    usageDashboard: UsageDashboardApi;
  }
}

const SUBTITLE = "What the fleet costs, who is spending it, and whether caching is paying off. Dollars are API-equivalent list prices, not a bill.";

const prefs = parseUsagePrefs(loadUsagePrefsRaw());
const view: UsageView = { range: prefs.range, unit: prefs.unit, summary: null, fetchedAt: 0, showAllAgents: false };
// Everything below belongs to `connection`; switching connections resets it.
let connection: string | null = null;
let quota: unknown[] | null = null;
let summarySeq = 0;
let breakdownSeq = 0;
// The agent/provider scope the breakdown last loaded, so reopening it does not refetch.
let breakdownKey: string | null = null;
let report: UsageReport | null = null;
const expanded = new Set<string>();

let page: HTMLElement;
let root: HTMLElement;
let picker: HTMLSelectElement;
let navButton: HTMLButtonElement;

const dashboard = () => window.usageDashboard;
const find = <T extends HTMLElement = HTMLElement>(id: string): T => root.querySelector<T>("#" + id)!;
const savePrefs = () => saveUsagePrefsRaw(serializeUsagePrefs(prefs));
const pageVisible = () => !!page && !page.hidden && screen() === "fleet";
const setStatus = (text: string) => { find("usage-status").textContent = text; };

// Sets a select's value, adding the option first so a saved filter survives
// until the server's filter list arrives (populateFilter keeps unknown values too).
function setSelect(select: HTMLSelectElement, value: string): void {
  if (value && ![...select.options].some((option) => option.value === value)) select.add(new Option(value, value));
  select.value = value;
}

function fleetNames(): string[] {
  const conn = connection ? state.conns.get(connection) : undefined;
  if (!conn) return [];
  const concierge = conciergeId(conn);
  return conn.rows.filter((row) => !row.host && agentId(row) !== concierge).map((row) => row.name);
}

function populateAgentSelect(): void {
  dashboard().populateAgentSelect(root, fleetNames(), report?.agents ?? []);
}

const breakdownScope = () => `${find<HTMLSelectElement>("usage-agent").value}\u0000${find<HTMLSelectElement>("usage-provider").value}`;

async function refreshSummary({ periodic = false, refresh = false } = {}): Promise<void> {
  if (!pageVisible() || !connection) return;
  if (periodic && !periodicDue({ pageVisible: true, documentHidden: document.hidden, fetchedAt: view.fetchedAt, now: Date.now() })) return;
  view.fetchedAt = Date.now();
  const seq = ++summarySeq;
  const conn = connection;
  const path = summaryPath({
    range: view.range,
    repo: find<HTMLSelectElement>("usage-repo").value,
    provider: find<HTMLSelectElement>("usage-summary-provider").value,
    refresh,
    quotaLoaded: !!quota,
  });
  if (!view.summary || !periodic) setStatus("Loading…");
  try {
    const data = await apiGet<{ summary: UsageSummary; quota?: unknown[] }>(conn, path);
    if (seq !== summarySeq || conn !== connection) return;
    if (data?.quota) quota = data.quota;
    view.summary = data?.summary ?? null;
    dashboard().renderQuota(root, quota);
    dashboard().renderDashboard(root, view, actions);
    setStatus(summaryStatus(view.summary));
  } catch (error) {
    if (seq !== summarySeq || conn !== connection) return;
    setStatus(error instanceof Error ? error.message : String(error));
  }
}

async function refreshBreakdown(): Promise<void> {
  if (!pageVisible() || !connection || !find<HTMLDetailsElement>("usage-breakdown").open) return;
  const seq = ++breakdownSeq;
  const conn = connection;
  const agent = find<HTMLSelectElement>("usage-agent").value;
  const provider = find<HTMLSelectElement>("usage-provider").value;
  breakdownKey = breakdownScope();
  find("usage-clear-agent").hidden = !agent;
  find("usage-breakdown-status").textContent = "Scanning transcripts…";
  try {
    const data = await apiGet<{ tokens: UsageReport }>(conn, breakdownPath({ agent, provider }));
    if (seq !== breakdownSeq || conn !== connection) return;
    renderReport(data?.tokens ?? null);
    find("usage-breakdown-status").textContent = agent
      ? `Filtered to ${agent}`
      : `Updated ${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}`;
  } catch (error) {
    if (seq !== breakdownSeq || conn !== connection) return;
    breakdownKey = null;
    find("usage-breakdown-status").textContent = error instanceof Error ? error.message : String(error);
  }
}

function renderReport(next: UsageReport | null): void {
  if (!next) return;
  report = next;
  populateAgentSelect();
  dashboard().renderBreakdown(root, next, { expanded }, {
    ...actions,
    toggleSubagents(name) {
      if (expanded.has(name)) expanded.delete(name);
      else expanded.add(name);
      renderReport(next);
    },
  });
  disableGoneSubagentLinks(next);
}

// A subagent opens under its parent, so its links render disabled when the
// parent is no longer in the fleet: the subagent rows (each follows its
// agent's row, in report order) and anomalies that point at a subagent.
function disableGoneSubagentLinks(data: UsageReport): void {
  const disable = (button: HTMLButtonElement, agent: string) => {
    if (fleetKey(agent)) return;
    button.disabled = true;
    button.title = `${agent} is not in the fleet any more`;
  };
  const agents = data.agents ?? [];
  let index = -1;
  for (const row of root.querySelectorAll<HTMLElement>("#usage-agents tbody > tr")) {
    if (row.classList.contains("usage-agent-row")) index++;
    const button = row.querySelector<HTMLButtonElement>(".usage-subagent-btn");
    const agent = agents[index];
    if (button && agent) disable(button, agent.name);
  }
  const targets = root.querySelectorAll<HTMLButtonElement>("#usage-anomalies .usage-anomaly-target");
  (data.anomalies ?? []).forEach((item, position) => {
    if (item.subagentId && targets[position]) disable(targets[position], item.agent ?? "");
  });
}

function fleetKey(name: string): string | null {
  const conn = connection ? state.conns.get(connection) : undefined;
  return conn ? usageAgentKey(conn.conn.id, conn.rows, name) : null;
}

// Expands the detailed breakdown scoped to one agent ("" = all); fetches only when needed.
function openBreakdown(agentName: string): void {
  const select = find<HTMLSelectElement>("usage-agent");
  setSelect(select, agentName);
  find("usage-clear-agent").hidden = !select.value;
  const details = find<HTMLDetailsElement>("usage-breakdown");
  if (details.open) void refreshBreakdown();
  else details.open = true;
}

function openAgent(name: string): void {
  const key = fleetKey(name);
  if (key) selectAgent(key);
  else setStatus(`${name} is not in the fleet any more`);
}

function openSubagentOf(name: string, id: string, label: string, statusLabel: string): void {
  const key = fleetKey(name);
  if (key) openSubagent(key, id, label, statusLabel);
  else setStatus(`${name} is not in the fleet any more`);
}

const actions: UsageActions = {
  statusDot: dot,
  setRange(range) {
    if (range === view.range || ![1, 7, 30].includes(range)) return;
    view.range = prefs.range = range as UsageRange;
    savePrefs();
    void refreshSummary();
  },
  setUnit(unit) {
    const next: UsageUnit = unit === "tokens" ? "tokens" : "usd";
    if (next === view.unit) return;
    view.unit = prefs.unit = next;
    savePrefs();
    if (view.summary) dashboard().renderDashboard(root, view, actions);
  },
  changeSummaryFilter() {
    prefs.repo = find<HTMLSelectElement>("usage-repo").value;
    prefs.provider = find<HTMLSelectElement>("usage-summary-provider").value;
    savePrefs();
    void refreshSummary();
  },
  refreshSummary: () => void refreshSummary({ refresh: true }),
  breakdownToggled(open) {
    if (open && breakdownKey !== breakdownScope()) void refreshBreakdown();
  },
  changeBreakdownFilter() {
    prefs.breakdownProvider = find<HTMLSelectElement>("usage-provider").value;
    savePrefs();
    void refreshBreakdown();
  },
  refreshBreakdown: () => void refreshBreakdown(),
  openBreakdown,
  toggleAllAgents() {
    view.showAllAgents = !view.showAllAgents;
    if (view.summary) dashboard().renderTopAgents(root, view, actions);
  },
  openAgent,
  openSubagent: openSubagentOf,
  chartResized() {
    if (view.summary && pageVisible()) dashboard().renderChart(root, view);
  },
};

// A fresh dashboard: on start and whenever the connection changes, so nothing
// from another server stays on screen.
function buildRoot(): void {
  root.replaceChildren();
  dashboard().buildPage(root);
  dashboard().bindControls(root, actions);
  setSelect(find<HTMLSelectElement>("usage-repo"), prefs.repo);
  setSelect(find<HTMLSelectElement>("usage-summary-provider"), prefs.provider);
  find<HTMLSelectElement>("usage-provider").value = prefs.breakdownProvider;
  for (const button of find("usage-range").querySelectorAll<HTMLButtonElement>("button"))
    button.setAttribute("aria-pressed", String(Number(button.dataset.range) === view.range));
  for (const button of find("usage-unit").querySelectorAll<HTMLButtonElement>("button"))
    button.setAttribute("aria-pressed", String(button.dataset.unit === view.unit));
}

function setConnection(id: string | null): void {
  if (id === connection) return;
  const switching = connection !== null;
  connection = id;
  summarySeq++;
  breakdownSeq++;
  quota = null;
  report = null;
  breakdownKey = null;
  expanded.clear();
  view.summary = null;
  view.fetchedAt = 0;
  view.showAllAgents = false;
  // Repos belong to a server; a repo filter from another one would show nothing.
  if (switching) prefs.repo = "";
  if (id) prefs.connection = id;
  savePrefs();
  buildRoot();
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

// Opens the page; with an agent key, on that agent's server with the detailed
// breakdown scoped to it (the browser UI's "Breakdown →" from an agent).
export function showUsage(agentKey?: string): void {
  const scope = agentKey ? scopeForKey(agentKey) : null;
  const target = pickConnection([...state.conns.keys()], { requested: scope?.connection, openKey: state.selected, saved: prefs.connection });
  if (state.selected) selectAgent(null);
  showMainView("usage");
  setConnection(target);
  renderPicker();
  populateAgentSelect();
  void refreshSummary();
  if (scope?.agent) openBreakdown(scope.agent);
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
  page.id = "am-usage";
  page.hidden = true;
  page.setAttribute("aria-label", "Token usage");
  const head = h("header", "am-usage-head");
  const titles = h("div", "am-usage-titles");
  titles.append(h("h1", "", "Token usage"), h("p", "am-usage-sub", SUBTITLE));
  const label = h("label", "am-usage-conn");
  picker = h("select");
  picker.id = "am-usage-connection";
  label.append("Server", picker);
  label.hidden = true;
  picker.addEventListener("change", () => {
    setConnection(picker.value || null);
    populateAgentSelect();
    void refreshSummary();
  });
  head.append(titles, label);
  root = h("div");
  root.id = "usage-page";
  page.append(head, root);
  $("am-main").append(page);

  navButton = h("button", "am-nav-item");
  navButton.id = "am-nav-usage";
  navButton.type = "button";
  navButton.title = "Token usage (u)";
  navButton.append(h("span", "am-nav-icon", "◔"), h("span", "am-nav-label", "Usage"), h("kbd", "", "u"));
  navButton.addEventListener("click", () => showUsage());
  navStrip().append(navButton);

  onMainViewChange(() => {
    const shown = !page.hidden;
    if (shown) navButton.setAttribute("aria-current", "page");
    else {
      navButton.removeAttribute("aria-current");
      const tip = root.querySelector<HTMLElement>("#usage-tooltip");
      if (tip) tip.hidden = true;
    }
  });
}

export function initUsage(): void {
  buildPage();
  buildRoot();
  registerMainView({ id: "usage", element: page });
  registerShortcut({ keys: ["u"], run: () => showUsage() });
  subscribe("fleet", () => {
    if (!pageVisible()) return;
    if (connection === null || !state.conns.has(connection)) {
      const next = pickConnection([...state.conns.keys()], { saved: prefs.connection });
      setConnection(next);
      void refreshSummary();
    }
    renderPicker();
    populateAgentSelect();
  });
  // The browser UI's refresh piggybacks the summary on its 4 s tick, at most every 30 s.
  setInterval(() => void refreshSummary({ periodic: true }), 4000);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) void refreshSummary({ periodic: true });
  });
}
