// Conversation search runs on submit only, never per keystroke. Query, filters and
// results live in this module, so leaving for an agent and coming back keeps them.
import { call } from "./bridge";
import { selectAgent } from "./chat";
import { $, badge, composerInput, h } from "./dom";
import { agentKey } from "./fleet";
import { registerShortcut } from "./keyboard";
import {
  applyResult,
  beginSearch,
  DEFAULT_FILTERS,
  elapsed,
  failure,
  filterRows,
  highlightInto,
  hostOf,
  NO_MATCHES,
  optionValues,
  QUERY_HINT,
  queryTerms,
  readResponse,
  repoPath,
  runtime,
  searchExcerpt,
  snippetLabel,
  snippetsFor,
  sortRows,
  summaryText,
  validConversationQuery,
  type ConversationSearch,
  type SearchFilters,
  type SearchMode,
  type SearchRow,
  type SortKey,
} from "./search";
import { focusCursor } from "./sidebar";
import { state, subscribe } from "./state";
import { mainView, onMainViewChange, registerMainView, screen, showMainView } from "./views";

const VIEW = "search";
let search: ConversationSearch | null = null;
let requestSeq = 0;
let searchedConnections = "";

interface Controls {
  section: HTMLElement;
  form: HTMLFormElement;
  query: HTMLInputElement;
  mode: HTMLSelectElement;
  repo: HTMLSelectElement;
  status: HTMLSelectElement;
  provider: HTMLSelectElement;
  host: HTMLSelectElement;
  sort: HTMLSelectElement;
  summary: HTMLElement;
  results: HTMLElement;
  nav: HTMLButtonElement;
}
let ui: Controls;

function select(id: string, options: [string, string][]): HTMLSelectElement {
  const node = h("select");
  node.id = id;
  node.append(...options.map(([value, label]) => new Option(label, value)));
  return node;
}
function field(className: string, label: string, control: HTMLElement): HTMLLabelElement {
  const node = h("label", className);
  node.append(document.createTextNode(label), control);
  return node;
}

function build(): Controls {
  const section = h("section", "am-search");
  section.id = "am-search";
  section.hidden = true;
  section.setAttribute("aria-label", "Search agents");
  const heading = h("h1", "am-search-title", "Search");

  const form = h("form", "advanced-search-form");
  form.id = "advanced-search-form";
  form.noValidate = true;
  form.autocomplete = "off";
  const query = h("input");
  query.id = "advanced-query";
  query.type = "search";
  query.placeholder = "Name, task, repository, branch, or parent…";
  query.autocomplete = "off";
  query.spellcheck = false;
  const mode = select("advanced-mode", [["agents", "Agent details"], ["conversations", "Details + conversations"]]);
  const repo = select("advanced-repo", [["", "All repositories"]]);
  const status = select("advanced-status", [
    ["", "All statuses"], ["live", "Live"], ["finished", "Finished"],
    ...["working", "idle", "waiting", "needs-attention", "starting", "exited", "dead"].map((value): [string, string] => [value, value]),
  ]);
  const provider = select("advanced-provider", [["", "All providers"], ["codex", "Codex"], ["claude", "Claude"], ["antigravity", "Antigravity"]]);
  const host = select("advanced-host", [["", "All hosts"]]);
  const sort = select("advanced-sort", [["recent", "Recent activity"], ["runtime", "Time running"], ["repo", "Repository"], ["status", "Status"], ["name", "Name"]]);
  const submit = h("button", "primary", "Search");
  submit.type = "submit";
  const reset = h("button", "", "Clear filters");
  reset.type = "button";
  reset.id = "advanced-reset";
  const filters = h("div", "search-filters");
  filters.append(
    field("", "Search in", mode), field("", "Repository", repo), field("", "Status", status), field("", "Provider", provider),
    field("", "Host", host), field("", "Sort", sort), submit, reset,
  );
  form.append(field("search-query", "Search agents", query), filters);

  const summary = h("p");
  summary.id = "advanced-summary";
  summary.setAttribute("role", "status");
  const results = h("div", "advanced-results");
  results.id = "advanced-results";
  results.setAttribute("aria-label", "Results");
  section.append(heading, form, summary, results);
  $("am-main").append(section);

  // Other pages add their own controls to this strip.
  let strip = document.getElementById("am-nav");
  if (!strip) {
    strip = h("nav");
    strip.id = "am-nav";
    strip.setAttribute("aria-label", "Pages");
    $("am-sidebar").prepend(strip);
  }
  const nav = h("button", "am-nav-item");
  nav.type = "button";
  nav.id = "am-nav-search";
  nav.title = "Search agents and conversations (s)";
  nav.append(h("span", "am-nav-icon", "⌕"), h("span", "am-nav-label", "Search"), h("kbd", "", "s"));
  strip.append(nav);

  reset.addEventListener("click", () => {
    form.reset();
    clearConversationSearch();
    render();
    query.focus();
  });
  return { section, form, query, mode, repo, status, provider, host, sort, summary, results, nav };
}

function currentFilters(): SearchFilters {
  return {
    repository: ui.repo.value,
    host: ui.host.value,
    provider: ui.provider.value,
    status: ui.status.value,
    sort: (ui.sort.value || DEFAULT_FILTERS.sort) as SortKey,
  };
}
const currentMode = (): SearchMode => (ui.mode.value === "conversations" ? "conversations" : "agents");

function searchRows(): SearchRow[] {
  return [...state.conns.values()].flatMap((conn) =>
    conn.rows.map((row) => ({ key: agentKey(conn.conn.id, row), connection: conn.conn.id, connectionName: conn.conn.name, row })));
}

// Rebuilds a select only when its values change, so an open or focused one is left alone.
function fillOptions(node: HTMLSelectElement, values: string[], label: string): void {
  const previous = node.value;
  const entries = optionValues(values, previous);
  const signature = JSON.stringify(entries);
  if (node.dataset.options === signature) return;
  node.replaceChildren(new Option(label, ""), ...entries.map((value) => new Option(value, value)));
  node.value = previous;
  node.dataset.options = signature;
}

function resultNode(entry: SearchRow, terms: string[], snippetTerms: string[], snippets: { kind: string; text: string }[] | undefined, multi: boolean): HTMLElement {
  const { row } = entry;
  const button = h("button", "search-result");
  button.type = "button";
  button.dataset.agentKey = entry.key;
  const title = h("div", "search-result-title");
  title.append(h("strong", "", row.name), badge(row.status), h("span", "side-agent-provider", row.provider || "Unknown"));
  if (multi) title.append(h("span", "am-search-conn", entry.connectionName));
  const meta = [repoPath(row), hostOf(row), elapsed(runtime(row)), row.spawnedBy ? "Child of " + row.spawnedBy : ""].filter(Boolean).join(" · ");
  const task = highlightInto(h("p", "search-task"), searchExcerpt(row.task || "No task", terms), terms);
  button.append(title, task, h("small", "", meta));
  for (const snippet of snippets ?? []) {
    const block = h("p", "search-snippet");
    block.append(h("span", "search-snippet-kind", snippetLabel(snippet.kind)));
    highlightInto(block, searchExcerpt(snippet.text, snippetTerms, 180), snippetTerms);
    button.append(block);
  }
  return button;
}

export function render(): void {
  const rows = searchRows();
  fillOptions(ui.repo, rows.map(({ row }) => repoPath(row)).filter(Boolean), "All repositories");
  fillOptions(ui.host, rows.map(({ row }) => hostOf(row)), "All hosts");
  const terms = queryTerms(ui.query.value);
  const mode = currentMode();
  const shownSearch = mode === "conversations" && search?.query === ui.query.value.trim() ? search : null;
  const filters = currentFilters();
  const found = sortRows(filterRows(rows, terms, filters, (key) => !!snippetsFor(shownSearch, key)), filters.sort);
  ui.summary.textContent = summaryText(found.length, rows.length, mode, shownSearch);

  const focused = (document.activeElement as HTMLElement | null)?.closest?.<HTMLElement>("#advanced-results [data-agent-key]")?.dataset.agentKey;
  const snippetTerms = shownSearch ? shownSearch.query.toLowerCase().split(/\s+/).filter(Boolean) : terms;
  const multi = state.conns.size > 1;
  const nodes = found.map((entry) => resultNode(entry, terms, snippetTerms, snippetsFor(shownSearch, entry.key), multi));
  ui.results.replaceChildren(...(nodes.length ? nodes : [h("p", "empty", NO_MATCHES)]));
  if (focused) ui.results.querySelector<HTMLElement>(`[data-agent-key="${CSS.escape(focused)}"]`)?.focus({ preventScroll: true });
}

const connectionSignature = (): string => JSON.stringify([...state.conns.values()].map(({ conn }) => [conn.id, conn.url]));

function clearConversationSearch(): void {
  search = null;
  requestSeq++;
}

async function runConversationSearch(): Promise<void> {
  const query = ui.query.value.trim();
  if (currentMode() !== "conversations") {
    render();
    return;
  }
  if (!validConversationQuery(query)) {
    ui.summary.textContent = QUERY_HINT;
    return;
  }
  const seq = ++requestSeq;
  const connections = [...state.conns.values()].map(({ conn }) => ({ id: conn.id, name: conn.name }));
  search = beginSearch(query, seq, connections);
  searchedConnections = connectionSignature();
  render();
  await Promise.all(connections.map(async ({ id, name }) => {
    let result;
    try {
      result = readResponse(id, name, await call("search.query", { connection: id, query }));
    } catch (error) {
      result = failure(id, name, error);
    }
    if (applyResult(search, seq, result) && mainView() === VIEW) render();
  }));
}

export function showSearch(): void {
  if (screen() !== "fleet") return;
  if (state.selected) selectAgent(null);
  showMainView(VIEW);
  ui.query.focus();
}

function openResult(key: string, fromKeyboard: boolean): void {
  selectAgent(key);
  if (fromKeyboard && !composerInput().disabled) composerInput().focus();
}

const resultButtons = (): HTMLElement[] => [...ui.results.querySelectorAll<HTMLElement>("[data-agent-key]")];

function registerShortcuts(): void {
  registerShortcut({ keys: ["s"], run: showSearch });
  const inQuery = (event: KeyboardEvent) => event.target === ui.query;
  // Like the sidebar filter: Esc empties the box and goes back to the list.
  registerShortcut({
    keys: ["Escape"], whileTyping: true, when: inQuery, run: () => {
      if (ui.query.value) {
        ui.query.value = "";
        clearConversationSearch();
        render();
      }
      focusCursor();
    },
  });
  registerShortcut({ keys: ["ArrowDown"], whileTyping: true, when: inQuery, run: () => resultButtons()[0]?.focus() });
  const onResult = (event: KeyboardEvent) => event.target instanceof HTMLElement && ui.results.contains(event.target) && !!event.target.dataset.agentKey;
  registerShortcut({
    keys: ["ArrowDown", "ArrowUp"], when: onResult, run: (event) => {
      const buttons = resultButtons();
      const index = buttons.indexOf(event.target as HTMLElement) + (event.key === "ArrowDown" ? 1 : -1);
      if (index < 0) ui.query.focus();
      else buttons[Math.min(index, buttons.length - 1)]?.focus();
    },
  });
}

export function initSearch(): void {
  ui = build();
  registerMainView({ id: VIEW, element: ui.section, onShow: render });
  registerShortcuts();
  ui.nav.addEventListener("click", showSearch);
  ui.form.addEventListener("submit", (event) => {
    event.preventDefault();
    void runConversationSearch();
  });
  ui.query.addEventListener("input", () => {
    clearConversationSearch();
    render();
  });
  ui.mode.addEventListener("change", () => {
    clearConversationSearch();
    render();
  });
  for (const node of [ui.repo, ui.status, ui.provider, ui.host, ui.sort]) node.addEventListener("change", render);
  ui.results.addEventListener("click", (event) => {
    const node = (event.target as HTMLElement).closest<HTMLElement>("[data-agent-key]");
    // A click with no pointer behind it is Enter or Space on the focused result.
    if (node?.dataset.agentKey) openResult(node.dataset.agentKey, event.detail === 0);
  });
  onMainViewChange(() => {
    if (ui.section.hidden) ui.nav.removeAttribute("aria-current");
    else ui.nav.setAttribute("aria-current", "page");
  });
  subscribe("fleet", () => {
    if (search && searchedConnections !== connectionSignature()) clearConversationSearch();
    if (mainView() === VIEW) render();
  });
}
