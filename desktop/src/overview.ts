import { selectAgent } from "./chat";
import { $, composerInput, dot, h } from "./dom";
import { agentId, agentKey, conciergeRow, fleetRows, statusLabel, type ConnectionFleet } from "./fleet";
import { registerShortcut } from "./keyboard";
import {
  compareOverview,
  elapsed,
  matchesOverviewFilter,
  matchesOverviewQuery,
  OVERVIEW_FILTERS,
  OVERVIEW_SORTS,
  overviewCounts,
  parentId,
  repoName,
  repoPath,
  runtimeMs,
  statusGroup,
  type OverviewSort,
} from "./ordering";
import { fillOptions, openConcierge } from "./sidebar";
import { fleets, loadProblem, persist, state, subscribe, unread } from "./state";
import { parseSubagentKey, runningOf, subagentKey, subagentLabel } from "./subagents";
import { openSubagent } from "./subagentView";
import type { AgentRow } from "./types";
import { mainView, onMainViewChange, registerMainView } from "./views";

interface Entry {
  fleet: ConnectionFleet;
  row: AgentRow;
  key: string;
}

// The card that takes Tab into the grid (roving tabindex), by agent key.
let cardCursor: string | null = null;

const showing = (): boolean => mainView() === "overview";

function conciergeNode(fleet: ConnectionFleet, row: AgentRow, multi: boolean): HTMLElement {
  const key = agentKey(fleet.id, row);
  const node = h("button", `am-ask-concierge${row.status === "needs-attention" ? " attention" : ""}`);
  node.type = "button";
  node.dataset.conciergeKey = key;
  const title = h("span", "am-ask-title");
  title.append(h("span", "am-concierge-mark", "✳"), document.createTextNode("Ask the concierge"));
  if (multi) title.append(h("span", "am-ask-conn", fleet.name));
  const where = h("span", "am-ask-status");
  where.append(dot(row.status), document.createTextNode(`${row.host || fleet.local || "This server"} · ${statusLabel(row.status)}`));
  if (unread.isNew(key, row.updatedAt, state.selected)) where.append(h("span", "unread-badge am-new", "New"));
  const hint = h("span", "am-ask-hint");
  hint.append(h("span", "agent-tag", row.provider || "codex"), h("kbd", "", "c"));
  node.append(title, where, hint);
  node.setAttribute("aria-label", `Ask the concierge${multi ? ` on ${fleet.name}` : ""}, ${statusLabel(row.status)}`);
  node.addEventListener("click", () => openConcierge(key));
  return node;
}

function cardNode(entry: Entry, all: readonly AgentRow[], multi: boolean, now: number): HTMLElement {
  const { row, fleet, key } = entry;
  const card = h("button", "agent-card");
  card.type = "button";
  card.tabIndex = -1;
  card.dataset.cardKey = key;
  const identity = h("div", "agent-identity");
  identity.append(h("h3", "", row.name));
  if (unread.isNew(key, row.updatedAt, state.selected)) identity.append(h("span", "unread-badge am-new", "New"));
  identity.append(h("p", "", row.task || "No task"));
  if (row.spawnedBy) identity.append(h("small", "parent-label", "↳ " + row.spawnedBy));
  const id = agentId(row);
  const children = all.filter((child) => parentId(child) === id).length;
  if (children) identity.append(h("small", "child-count", `${children} child agent${children === 1 ? "" : "s"}`));
  if (multi) identity.append(h("small", "am-card-conn", fleet.name));
  const status = dot(row.status);
  status.title = statusLabel(row.status);
  const repo = h("span", "agent-repo", repoName(row));
  repo.title = [repoPath(row), row.host || fleet.local || "local", row.queued ? `${row.queued} queued` : "", multi ? fleet.name : ""].filter(Boolean).join(" · ");
  const runtime = h("span", "agent-runtime", elapsed(runtimeMs(row, now)));
  runtime.title = "Elapsed time in the current working state";
  runtime.dataset.status = row.status;
  runtime.dataset.since = row.statusChangedAt || "";
  card.setAttribute("aria-label", `${row.name}, ${statusLabel(row.status)}, ${repoName(row)}${multi ? `, ${fleet.name}` : ""}`);
  card.append(status, identity, h("span", "agent-tag", row.provider || "codex"), repo, runtime);
  return card;
}

// Built-in subagents running inside the agent, listed under its card; each
// opens its transcript. Arrow keys reach them from the card above.
function subagentNodes(key: string, row: AgentRow): HTMLElement[] {
  return runningOf(row).map((sub) => {
    const label = subagentLabel(sub);
    const node = h("button", "subagent-row");
    node.type = "button";
    node.tabIndex = -1;
    node.dataset.subagentKey = subagentKey(key, sub.id);
    node.dataset.label = label;
    node.title = `${label} · read the transcript`;
    node.append(h("span"), h("span", "", `↳ ${label} · built-in`), h("span"), h("span"), h("span"));
    node.setAttribute("aria-label", `Subagent ${label} of ${row.name}, running`);
    return node;
  });
}

function openSubagentNode(node: HTMLElement): void {
  const parsed = parseSubagentKey(node.dataset.subagentKey ?? "");
  if (!parsed) return;
  openSubagent(parsed.agentKey, parsed.id, node.dataset.label);
  $("am-sub-transcript").focus({ preventScroll: true });
}

function renderOverview(): void {
  const now = Date.now();
  const all = fleets();
  const multi = all.length > 1;
  const entries: Entry[] = all.flatMap((fleet) => fleetRows(fleet).map((row) => ({ fleet, row, key: agentKey(fleet.id, row) })));
  const rows = entries.map((entry) => entry.row);

  const concierges = all.flatMap((fleet) => {
    const row = conciergeRow(fleet);
    return row ? [conciergeNode(fleet, row, multi)] : [];
  });
  const conciergeBox = $("am-overview-concierge");
  const focusedConcierge = conciergeBox.contains(document.activeElement) ? (document.activeElement as HTMLElement).dataset.conciergeKey : undefined;
  conciergeBox.replaceChildren(...concierges);
  if (focusedConcierge) concierges.find((node) => node.dataset.conciergeKey === focusedConcierge)?.focus({ preventScroll: true });

  const counts = overviewCounts(rows);
  const filters = $("am-overview-filters");
  if (!filters.childElementCount) {
    for (const { id, label } of OVERVIEW_FILTERS) {
      const button = h("button", "", label);
      button.type = "button";
      button.dataset.overviewFilter = id;
      button.append(h("span"));
      filters.append(button);
    }
  }
  for (const button of filters.querySelectorAll<HTMLButtonElement>("[data-overview-filter]")) {
    const id = button.dataset.overviewFilter as keyof typeof counts;
    const selected = id === state.overviewFilter;
    button.classList.toggle("selected", selected);
    button.setAttribute("aria-pressed", String(selected));
    button.querySelector("span")!.textContent = String(counts[id]);
  }
  $<HTMLSelectElement>("am-overview-sort").value = state.overviewSort;
  const direction = $("am-overview-direction");
  direction.textContent = state.overviewReverse ? "↓" : "↑";
  direction.setAttribute("aria-pressed", String(state.overviewReverse));

  const loaded = [...state.conns.values()].every((conn) => conn.loaded);
  const problem = rows.length ? null : loadProblem();
  $("am-overview-sub").textContent = rows.length ? `${rows.length} agent${rows.length === 1 ? "" : "s"}${multi ? ` on ${all.length} connections` : ""}`
    : problem ?? (loaded ? "" : "Loading the fleet…");

  const visible = entries.filter(({ row, fleet }) =>
    matchesOverviewFilter(row, state.overviewFilter) &&
    matchesOverviewQuery(row, state.overviewQuery, [row.host ? "" : fleet.local, multi ? fleet.name : ""]));
  const order = { sort: state.overviewSort, reverse: state.overviewReverse, now };
  visible.sort((a, b) => compareOverview(a.row, b.row, order));

  const grid = $("am-agent-grid");
  const active = grid.contains(document.activeElement) ? document.activeElement as HTMLElement : null;
  const focusedKey = active?.dataset.cardKey ?? null;
  const focusedSubagent = active?.dataset.subagentKey ?? null;
  const nodes: HTMLElement[] = [];
  if (!visible.length) {
    nodes.push(h("div", "empty", rows.length ? "No agents match this view."
      : loaded ? "No agents. Start one with am new or ask the concierge." : problem ?? "Loading the fleet…"));
  }
  const grouped = state.overviewSort === "status";
  let group: string | null = null;
  for (const entry of visible) {
    const name = statusGroup(entry.row.status);
    if (grouped && name !== group) {
      group = name;
      const header = h("div", "status-group");
      header.setAttribute("role", "heading");
      header.setAttribute("aria-level", "2");
      header.append(dot(entry.row.status), document.createTextNode(name + " "),
        h("span", "", String(visible.filter((other) => statusGroup(other.row.status) === name).length)));
      nodes.push(header);
    }
    nodes.push(cardNode(entry, entry.fleet.rows, multi, now), ...subagentNodes(entry.key, entry.row));
  }
  grid.replaceChildren(...nodes);
  const cards = cardList();
  if (!cards.some((card) => card.dataset.cardKey === cardCursor)) cardCursor = cards[0]?.dataset.cardKey ?? null;
  for (const card of cards) card.tabIndex = card.dataset.cardKey === cardCursor ? 0 : -1;
  if (focusedKey) cards.find((card) => card.dataset.cardKey === focusedKey)?.focus({ preventScroll: true });
  else if (focusedSubagent) grid.querySelector<HTMLElement>(`[data-subagent-key="${CSS.escape(focusedSubagent)}"]`)?.focus({ preventScroll: true });
}

const cardList = (): HTMLElement[] => [...$("am-agent-grid").querySelectorAll<HTMLElement>("[data-card-key]")];

function focusCard(card: HTMLElement | undefined): void {
  if (!card) return;
  cardCursor = card.dataset.cardKey ?? null;
  for (const other of cardList()) other.tabIndex = other === card ? 0 : -1;
  card.focus();
  card.scrollIntoView({ block: "nearest" });
}

// Opening from the overview is opening from the sidebar: the sidebar's cursor follows.
function openAgent(key: string, write: boolean): void {
  const item = state.tree.items.find((candidate) => candidate.kind === "agent" && candidate.key === key && !candidate.concierge);
  if (item) state.cursor = item.id;
  cardCursor = key;
  selectAgent(key);
  if (write && !composerInput().disabled) composerInput().focus();
}

export function showOverview(focus = false): void {
  selectAgent(null);
  if (!focus) return;
  const cards = cardList();
  focusCard(cards.find((card) => card.dataset.cardKey === cardCursor) ?? cards[0]);
}

export function tickOverview(now: number): void {
  if (!showing()) return;
  for (const node of document.querySelectorAll<HTMLElement>("#am-agent-grid .agent-runtime")) {
    const text = elapsed(runtimeMs({ status: node.dataset.status as AgentRow["status"], statusChangedAt: node.dataset.since || "" }, now));
    if (node.textContent !== text) node.textContent = text;
  }
}

function navControl(): HTMLElement {
  let nav = document.getElementById("am-nav");
  if (!nav) {
    nav = h("nav");
    nav.id = "am-nav";
    nav.setAttribute("aria-label", "Pages");
    $("am-sidebar").prepend(nav);
  }
  const button = h("button", "am-nav-item");
  button.id = "am-overview-nav";
  button.type = "button";
  button.title = "Fleet overview (o)";
  button.append(h("span", "am-nav-icon", "▦"), h("span", "am-nav-label", "Overview"), h("span", "am-nav-count"), h("kbd", "", "o"));
  button.addEventListener("click", () => showOverview());
  nav.append(button);
  return button;
}

function updateNav(button: HTMLElement): void {
  if (showing()) button.setAttribute("aria-current", "page");
  else button.removeAttribute("aria-current");
  const attention = fleets().flatMap(fleetRows).filter((row) => row.status === "needs-attention").length;
  const count = button.querySelector<HTMLElement>(".am-nav-count")!;
  count.textContent = attention ? String(attention) : "";
  count.hidden = !attention;
  count.title = `${attention} need${attention === 1 ? "s" : ""} attention`;
}

export function initOverview(): void {
  const nav = navControl();
  registerMainView({ id: "overview", element: $("am-overview"), onShow: renderOverview });
  onMainViewChange(() => updateNav(nav));
  subscribe("fleet", () => {
    updateNav(nav);
    if (showing()) renderOverview();
  });
  subscribe("seen", () => {
    updateNav(nav);
    if (showing()) renderOverview();
  });

  fillOptions($("am-overview-sort"), OVERVIEW_SORTS);
  $("am-overview-filters").addEventListener("click", (event) => {
    const button = (event.target as HTMLElement).closest<HTMLElement>("[data-overview-filter]");
    if (!button) return;
    state.overviewFilter = button.dataset.overviewFilter as typeof state.overviewFilter;
    persist();
    renderOverview();
  });
  const search = $<HTMLInputElement>("am-overview-search");
  search.addEventListener("input", () => {
    state.overviewQuery = search.value;
    renderOverview();
  });
  $("am-overview-sort").addEventListener("change", (event) => {
    state.overviewSort = (event.target as HTMLSelectElement).value as OverviewSort;
    persist();
    renderOverview();
  });
  $("am-overview-direction").addEventListener("click", () => {
    state.overviewReverse = !state.overviewReverse;
    persist();
    renderOverview();
  });

  const grid = $("am-agent-grid");
  grid.addEventListener("click", (event) => {
    const sub = (event.target as HTMLElement).closest<HTMLElement>("[data-subagent-key]");
    if (sub) {
      openSubagentNode(sub);
      return;
    }
    const card = (event.target as HTMLElement).closest<HTMLElement>("[data-card-key]");
    if (card?.dataset.cardKey) openAgent(card.dataset.cardKey, false);
  });
  grid.addEventListener("focusin", (event) => {
    const key = (event.target as HTMLElement).dataset?.cardKey;
    if (key) cardCursor = key;
  });
  // Arrow keys walk the cards and the subagents under them; Enter opens the
  // agent to write to it, like the sidebar, or the subagent to read it.
  grid.addEventListener("keydown", (event) => {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    const items = [...grid.querySelectorAll<HTMLElement>("[data-card-key], [data-subagent-key]")];
    const index = items.indexOf(event.target as HTMLElement);
    if (index < 0) return;
    const focusItem = (node: HTMLElement | undefined) => {
      if (!node || node.dataset.cardKey) return focusCard(node);
      node.focus();
      node.scrollIntoView({ block: "nearest" });
    };
    const move: Record<string, number> = { ArrowDown: 1, j: 1, ArrowUp: -1, k: -1 };
    const current = items[index]!;
    if (event.key in move) focusItem(items[Math.max(0, Math.min(items.length - 1, index + move[event.key]!))]);
    else if (event.key === "Home") focusItem(items[0]);
    else if (event.key === "End") focusItem(items[items.length - 1]);
    else if (event.key === "Enter" && current.dataset.subagentKey) openSubagentNode(current);
    else if (event.key === "Enter") openAgent(current.dataset.cardKey!, true);
    else return;
    event.preventDefault();
  });

  registerShortcut({ keys: ["o"], run: () => showOverview(true) });
  registerShortcut({
    keys: ["Escape"], whileTyping: true, when: (event) => event.target === search, run: () => {
      if (search.value) {
        search.value = "";
        state.overviewQuery = "";
        renderOverview();
      } else focusCard(cardList().find((card) => card.tabIndex === 0));
    },
  });
}
