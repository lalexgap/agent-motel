// Agent Motel desktop frontend: connections, live fleet sidebar, chat and the
// composer. All server traffic goes through the bridge.
import { call, isNative, on, startBridge } from "./bridge";
import {
  BUBBLE_LABEL,
  bubbles,
  cancelOutcome,
  capDrafts,
  FORCED_QUEUE_HINT,
  MODE_HINT,
  modeFor,
  notePending,
  parseDrafts,
  parseModePreference,
  putDraft,
  reconcilePending,
  rejectionOutcome,
  sendModeFor,
  sendOutcome,
  textAfterSend,
  userTexts,
  type Bubble,
  type Outcome,
  type PendingMessage,
  withoutMessage,
} from "./composer";
import {
  agentKey,
  agentPath,
  BUSY,
  buildTree,
  conciergeTarget,
  countStatuses,
  fleetRows,
  isConciergeKey,
  isPinnedConcierge,
  moveCursor,
  parseAgentKey,
  repoLabel,
  statusLabel,
  statusShort,
  STOPPED,
  type AgentItem,
  type ConnectionFleet,
  type GroupItem,
  type TreeItem,
  type TreeModel,
} from "./fleet";
import { duration, firstLine, relativeTime } from "./format";
import { checkMessageText, MESSAGE_EMPTY, normalizeServerUrl, type SendMode } from "./policy";
import { loadDraftsRaw, loadPrefs, loadSendModeRaw, saveDraftsRaw, savePrefs, saveSendModeRaw } from "./store";
import type {
  AgentDetail,
  AgentRow,
  AgentsResponse,
  AppInfo,
  BridgeEvents,
  Connection,
  HostsResponse,
  StreamState,
  Transcript,
  TranscriptEntry,
} from "./types";

interface AgentTranscriptApi {
  icon(name: string, className?: string): SVGElement;
  renderEntries(view: HTMLElement, entries: TranscriptEntry[], options: { agentName: string; readBoundary?: number | null }): void;
  chatTurn(entry: { kind: "user"; text: string; index: string }, agentName: string): HTMLElement;
  preserveConversationScroll(view: HTMLElement, threshold: number): (follow?: boolean) => void;
}
declare global {
  interface Window {
    agentTranscript: AgentTranscriptApi;
  }
}

const AGENTS_DEBOUNCE_MS = 150;
const DETAIL_POLL_MS = 4000;
const FLEET_POLL_MS = 5000;
const SIDEBAR_MIN = 200;
const DRAFT_SAVE_MS = 400;

class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

interface ConnState {
  conn: Connection;
  local: string;
  remoteHosts: string[];
  rows: AgentRow[];
  unreachable: string[];
  conciergeKey: string | null;
  loaded: boolean;
  stream: StreamState | null;
  everOpen: boolean;
  streamError: string | null;
  error: string | null;
  tokenRejected: boolean;
  agentsSeq: number;
  agentsApplied: number;
  agentsFetchedAt: number;
  debounce: ReturnType<typeof setTimeout> | null;
}

interface DetailState {
  key: string;
  detail: AgentDetail | null;
  transcript: Transcript | null;
  notFound: boolean;
}

// Per agent key. Survives switching agents; pending bubbles last for the session.
interface AgentComposer {
  pending: PendingMessage[];
  // User turns in the last transcript shown, the baseline for the next send.
  userCount: number;
  error: string | null;
  // The error came from a cancel, so a later successful cancel may clear it.
  cancelError?: boolean;
}

const prefs = loadPrefs();
const composer = {
  agents: new Map<string, AgentComposer>(),
  // In-flight sends, one per agent: the guard against double sends.
  sending: new Set<string>(),
  cancelling: new Set<string>(),
  drafts: parseDrafts(loadDraftsRaw()),
  preference: parseModePreference(loadSendModeRaw()),
  // Whose draft the textarea holds.
  shownKey: null as string | null,
  draftTimer: null as ReturnType<typeof setTimeout> | null,
};
const state = {
  conns: new Map<string, ConnState>(),
  info: null as AppInfo | null,
  filter: "",
  collapsed: new Set(prefs.collapsed),
  showStopped: prefs.showStopped,
  selected: prefs.selected,
  cursor: null as string | null,
  tree: { items: [], hiddenStopped: 0, shown: 0, total: 0 } as TreeModel,
  detail: null as DetailState | null,
  detailSeq: 0,
  detailApplied: 0,
  detailFetchedAt: 0,
  detailInFlight: false,
  taskExpanded: false,
  editing: null as string | null,
  formOpen: false,
  pendingRemove: null as string | null,
  ready: false,
};

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => {
  const node = document.getElementById(id);
  if (!node) throw new Error(`missing #${id}`);
  return node as T;
};
function h<K extends keyof HTMLElementTagNameMap>(tag: K, className = "", text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
const persist = () =>
  savePrefs({ selected: state.selected, sidebarWidth: sidebarWidth, collapsed: [...state.collapsed], showStopped: state.showStopped });

function dot(status: string): HTMLElement {
  const node = h("i", `dot ${["working", "idle", "needs-attention", "waiting", "dead", "exited", "starting"].includes(status) ? status : ""}`);
  node.setAttribute("aria-hidden", "true");
  // Re-renders replace the dot; phase the spin off a shared clock so it doesn't snap back.
  if (status === "working" || status === "waiting") node.style.animationDelay = `-${Math.round(performance.now() % 1600)}ms`;
  return node;
}
function badge(status: string): HTMLElement {
  const node = h("span", "badge");
  node.append(dot(status), document.createTextNode(statusLabel(status)));
  return node;
}

async function apiGet<T>(id: string, path: string): Promise<T> {
  const conn = state.conns.get(id);
  const response = await call("api.get", { connection: id, path });
  if (response.status === 401) {
    if (conn) conn.tokenRejected = true;
    throw new ApiError("Token rejected (401)", 401);
  }
  if (response.status < 200 || response.status >= 300) {
    const body = response.body as { error?: unknown } | null;
    throw new ApiError(typeof body?.error === "string" ? body.error : `HTTP ${response.status}`, response.status);
  }
  if (conn) conn.tokenRejected = false;
  return response.body as T;
}

function newConnState(conn: Connection): ConnState {
  return {
    conn, local: "", remoteHosts: [], rows: [], unreachable: [], conciergeKey: null, loaded: false, stream: null, everOpen: false,
    streamError: null, error: null, tokenRejected: false, agentsSeq: 0, agentsApplied: 0, agentsFetchedAt: 0, debounce: null,
  };
}

async function loadHosts(id: string): Promise<void> {
  try {
    const hosts = await apiGet<HostsResponse>(id, "/api/hosts");
    const conn = state.conns.get(id);
    if (!conn) return;
    conn.local = typeof hosts?.local === "string" ? hosts.local : "";
    conn.remoteHosts = Array.isArray(hosts?.hosts) ? hosts.hosts.map((host) => host.name).filter((name) => typeof name === "string") : [];
    renderFleet();
  } catch (error) {
    noteError(id, error);
  }
}

// Which agent is the concierge. A failure (an older server without the route)
// is not an error worth showing: the role fallback in fleet.ts covers it.
async function loadConcierge(id: string): Promise<void> {
  let key: string | null = null;
  try {
    const body = await apiGet<{ key?: unknown }>(id, "/api/concierge");
    if (typeof body?.key === "string" && body.key) key = body.key;
  } catch {}
  const conn = state.conns.get(id);
  if (!conn || conn.conciergeKey === key) return;
  conn.conciergeKey = key;
  renderFleet();
}

async function loadAgents(id: string): Promise<void> {
  const conn = state.conns.get(id);
  if (!conn) return;
  const seq = ++conn.agentsSeq;
  conn.agentsFetchedAt = Date.now();
  try {
    const data = await apiGet<AgentsResponse>(id, "/api/agents");
    const current = state.conns.get(id);
    // A late response must not overwrite a newer one (or a removed connection).
    if (current !== conn || seq <= conn.agentsApplied) return;
    conn.agentsApplied = seq;
    const selected = state.selected && parseAgentKey(state.selected)?.connection === id ? state.selected : null;
    const before = selected ? findRow(selected) : null;
    conn.rows = Array.isArray(data?.rows) ? data.rows.filter((row) => row && typeof row.name === "string") : [];
    conn.unreachable = Array.isArray(data?.unreachable) ? data.unreachable : [];
    conn.loaded = true;
    conn.error = null;
    renderFleet();
    // Without the stream, the fleet poll is the only sign the open agent moved on
    // (e.g. went idle after its final message, which the busy-only detail poll would miss).
    const after = selected ? findRow(selected) : null;
    if (conn.stream !== "open" && before && after && selected === state.selected &&
        (before.status !== after.status || before.updatedAt !== after.updatedAt)) void loadDetail();
  } catch (error) {
    noteError(id, error);
  }
}

function noteError(id: string, error: unknown): void {
  const conn = state.conns.get(id);
  if (!conn) return;
  conn.error = error instanceof Error ? error.message : String(error);
  // Before the first load the sidebar would otherwise say "Loading" forever.
  if (!conn.loaded) renderFleet();
  else renderStatusbar();
}

// Why nothing has loaded yet, when a connection that never loaded has failed.
function loadProblem(): string | null {
  const failed = [...state.conns.values()].find((conn) => !conn.loaded && (conn.tokenRejected || conn.error));
  if (!failed) return null;
  return failed.tokenRejected
    ? `${failed.conn.name} rejected the access token. Update it from Connections in the status bar.`
    : `Could not load agents from ${failed.conn.name}: ${failed.error}`;
}

function scheduleRefresh(id: string): void {
  const conn = state.conns.get(id);
  if (!conn) return;
  if (conn.debounce) clearTimeout(conn.debounce);
  conn.debounce = setTimeout(() => {
    conn.debounce = null;
    void loadAgents(id);
    if (state.selected && parseAgentKey(state.selected)?.connection === id) void loadDetail();
  }, AGENTS_DEBOUNCE_MS);
}

async function startConnection(conn: Connection): Promise<void> {
  const existing = state.conns.get(conn.id);
  if (existing) existing.conn = conn;
  else state.conns.set(conn.id, newConnState(conn));
  try {
    await call("events.start", { connection: conn.id });
  } catch (error) {
    noteError(conn.id, error);
  }
  void loadHosts(conn.id);
  void loadConcierge(conn.id);
  void loadAgents(conn.id);
}

async function reloadAll(): Promise<void> {
  for (const id of state.conns.keys()) {
    void loadHosts(id);
    void loadConcierge(id);
    void loadAgents(id);
  }
  if (state.selected) void loadDetail();
}

let sidebarWidth = prefs.sidebarWidth;
const sidebarMax = () => Math.max(SIDEBAR_MIN, Math.min(560, Math.round(window.innerWidth * 0.5)));
function applySidebarWidth(): void {
  const width = Math.max(SIDEBAR_MIN, Math.min(sidebarMax(), sidebarWidth));
  document.documentElement.style.setProperty("--am-sidebar-width", `${width}px`);
}

function fleets(): ConnectionFleet[] {
  return [...state.conns.values()].map((conn) => ({
    id: conn.conn.id,
    name: conn.conn.name,
    local: conn.local,
    rows: conn.rows,
    remoteHosts: conn.remoteHosts,
    unreachable: conn.unreachable,
    conciergeKey: conn.conciergeKey,
  }));
}
function allRows(): AgentRow[] {
  return fleets().flatMap(fleetRows);
}
const isConcierge = (key: string): boolean => isConciergeKey(fleets(), key);
function findRow(key: string): AgentRow | null {
  const parsed = parseAgentKey(key);
  const conn = parsed && state.conns.get(parsed.connection);
  return conn?.rows.find((row) => agentKey(conn.conn.id, row) === key) ?? null;
}

function groupNode(item: GroupItem): HTMLElement {
  const node = h("div", `am-row am-group tone-${item.tone ?? "repo"}`);
  node.setAttribute("role", "treeitem");
  node.setAttribute("aria-expanded", String(!item.collapsed));
  node.setAttribute("aria-level", String(item.depth + 1));
  node.tabIndex = -1;
  node.dataset.itemId = item.id;
  node.dataset.groupId = item.id;
  node.style.setProperty("--depth", String(item.depth));
  node.append(window.agentTranscript.icon("chevron", "icon am-chevron"), h("span", "am-group-label", item.label));
  if (item.marker) node.append(h("span", "am-group-marker", item.marker));
  node.append(h("span", "am-group-count", String(item.count)));
  node.title = `${item.label} · ${item.count} agent${item.count === 1 ? "" : "s"}${item.marker ? ` · ${item.marker}` : ""}`;
  return node;
}

function agentNode(item: AgentItem): HTMLElement {
  const { row } = item;
  const node = h("div", `am-row am-agent${STOPPED.has(row.status) ? " stopped" : ""}`);
  node.setAttribute("role", "treeitem");
  node.setAttribute("aria-level", String(item.depth + 1));
  node.setAttribute("aria-selected", String(item.key === state.selected));
  node.tabIndex = -1;
  node.dataset.itemId = item.id;
  node.dataset.agentKey = item.key;
  node.style.setProperty("--depth", String(item.depth));
  const text = h("div", "am-agent-text");
  const line = h("div", "am-agent-line");
  const time = h("span", "am-agent-time", relativeTime(row.statusChangedAt));
  time.dataset.since = row.statusChangedAt || "";
  time.title = `${statusLabel(row.status)} since ${new Date(row.statusChangedAt).toLocaleString()}`;
  line.append(h("span", "am-agent-name", row.name), time);
  const meta = h("div", "am-agent-meta");
  meta.append(h("span", "", row.provider));
  if (row.status !== "idle") meta.append(h("span", `am-status-text s-${row.status}`, statusShort(row.status)));
  if ((row.queued ?? 0) > 0) meta.append(h("span", "am-queued", `${row.queued} queued`));
  if (item.parent === "attention") meta.append(h("span", "am-agent-context", `${repoLabel(row)} · ${item.hostLabel}`));
  text.append(line, meta);
  node.append(dot(row.status), text);
  node.title = `${row.host ? `${row.host}:` : ""}${row.name} · ${statusLabel(row.status)}${row.statusReason ? ` — ${row.statusReason}` : ""}`;
  return node;
}

function conciergeNode(item: AgentItem): HTMLElement {
  const { row } = item;
  const stopped = STOPPED.has(row.status);
  const node = h("div", `am-row am-agent am-concierge${stopped ? " stopped" : ""}${row.status === "needs-attention" ? " attention" : ""}`);
  node.setAttribute("role", "treeitem");
  node.setAttribute("aria-level", "1");
  node.setAttribute("aria-selected", String(item.key === state.selected));
  node.tabIndex = -1;
  node.dataset.itemId = item.id;
  node.dataset.agentKey = item.key;
  node.dataset.concierge = "";
  const text = h("div", "am-agent-text");
  const line = h("div", "am-agent-line");
  const label = h("span", "am-agent-name am-concierge-name");
  label.append(h("span", "am-concierge-mark", "✳"), document.createTextNode("Concierge"));
  if (item.connectionName) label.append(h("span", "am-concierge-conn", item.connectionName));
  const time = h("span", "am-agent-time", relativeTime(row.statusChangedAt));
  time.dataset.since = row.statusChangedAt || "";
  time.title = `${statusLabel(row.status)} since ${new Date(row.statusChangedAt).toLocaleString()}`;
  line.append(label, time);
  const meta = h("div", "am-agent-meta");
  meta.append(h("span", "", row.provider));
  if (stopped) meta.append(h("span", "am-status-text s-stopped", `stopped · ${statusShort(row.status)}`));
  else if (row.status !== "idle") meta.append(h("span", `am-status-text s-${row.status}`, statusShort(row.status)));
  if ((row.queued ?? 0) > 0) meta.append(h("span", "am-queued", `${row.queued} queued`));
  text.append(line, meta);
  node.append(dot(row.status), text);
  const where = item.connectionName ? ` on ${item.connectionName}` : "";
  node.title = `Concierge${where} · ${statusLabel(row.status)}${row.statusReason ? ` — ${row.statusReason}` : ""} · press c to open`;
  return node;
}

function renderTree(): void {
  const tree = $("am-tree");
  const hadFocus = tree.contains(document.activeElement);
  state.tree = buildTree(fleets(), { filter: state.filter, showStopped: state.showStopped, collapsed: state.collapsed });
  const { items } = state.tree;
  if (state.cursor && !items.some((item) => item.id === state.cursor)) {
    // Keep the cursor on the same agent if it moved groups, else fall back.
    const key = state.cursor.split(">").pop();
    state.cursor = items.find((item) => item.kind === "agent" && item.key === key)?.id ?? null;
  }
  if (!state.cursor && state.selected) state.cursor = items.find((item) => item.kind === "agent" && item.key === state.selected)?.id ?? null;
  if (!state.cursor) state.cursor = items[0]?.id ?? null;
  const nodes: HTMLElement[] = [];
  let pinned: HTMLElement | null = null;
  for (const item of items) {
    const node = item.kind === "group" ? groupNode(item) : isPinnedConcierge(item) ? conciergeNode(item) : agentNode(item);
    if (item.id === state.cursor) node.tabIndex = 0;
    if (isPinnedConcierge(item)) {
      if (!pinned) {
        pinned = h("div", "am-pinned");
        pinned.setAttribute("role", "none");
        nodes.push(pinned);
      }
      pinned.append(node);
    } else nodes.push(node);
  }
  if (!items.some((item) => !isPinnedConcierge(item))) {
    const loading = [...state.conns.values()].some((conn) => !conn.loaded);
    const message = state.filter ? `No agents match “${state.filter}”.`
      : loading ? loadProblem() ?? "Loading agents…"
      : state.tree.hiddenStopped ? "Every agent is stopped. Turn on “Show stopped” to see them."
      : "No agents on this server yet. Start one with am new.";
    nodes.push(h("div", "am-tree-empty", message));
  }
  tree.replaceChildren(...nodes);
  // Background refreshes keep focus on the cursor row without yanking the scroll position.
  if (hadFocus) focusCursor(false);
  const summary = $("am-fleet-summary");
  const { shown, total, hiddenStopped } = state.tree;
  summary.textContent = state.filter ? `${shown} of ${total - hiddenStopped} match` : hiddenStopped ? `${hiddenStopped} stopped hidden` : `${total} agent${total === 1 ? "" : "s"}`;
  const toggle = $("am-show-stopped");
  toggle.setAttribute("aria-pressed", String(state.showStopped));
}

function focusCursor(scroll = true): void {
  const node = state.cursor ? document.querySelector<HTMLElement>(`#am-tree [data-item-id="${CSS.escape(state.cursor)}"]`) : null;
  if (!node) {
    $("am-tree").focus();
    return;
  }
  for (const other of $("am-tree").querySelectorAll<HTMLElement>("[tabindex='0']")) if (other !== node) other.tabIndex = -1;
  node.tabIndex = 0;
  node.focus({ preventScroll: !scroll });
  if (scroll) node.scrollIntoView({ block: "nearest" });
}

function setCursor(id: string | null): void {
  state.cursor = id;
  focusCursor();
}

function toggleGroup(id: string, collapse?: boolean): void {
  const next = collapse ?? !state.collapsed.has(id);
  if (next) state.collapsed.add(id);
  else state.collapsed.delete(id);
  persist();
  renderTree();
  focusCursor();
}

function renderFleet(): void {
  renderTree();
  renderStatusbar();
  if (!state.selected) renderEmpty();
  else syncHeaderFromRow();
}

function renderEmpty(): void {
  const rows = allRows();
  const counts = countStatuses(rows);
  const list = $("am-empty-counts");
  const loaded = [...state.conns.values()].every((conn) => conn.loaded);
  const problem = rows.length ? null : loadProblem();
  $("am-empty-title").textContent = rows.length ? `${rows.length} agent${rows.length === 1 ? "" : "s"} in the fleet`
    : loaded ? "No agents yet" : problem ? "Couldn't load the fleet" : "Loading the fleet…";
  $("am-empty-sub").textContent = rows.length ? "Pick an agent in the sidebar to read its conversation."
    : loaded ? "Agents you start with am new show up here." : problem ?? "";
  const entries: [string, string][] = [
    ["needs-attention", "Needs attention"], ["working", "Working"], ["waiting", "Waiting"], ["starting", "Starting"], ["idle", "Idle"], ["exited", "Exited"], ["dead", "Offline"],
  ];
  list.replaceChildren(...entries.filter(([status]) => counts[status as keyof typeof counts] > 0 || ["working", "idle", "needs-attention"].includes(status)).map(([status, label]) => {
    const item = h("li");
    item.append(dot(status), h("span", "", label), h("b", "", String(counts[status as keyof typeof counts])));
    return item;
  }));
}

function showChat(open: boolean): void {
  $("am-chat").hidden = !open;
  $("am-empty").hidden = open;
}

function selectAgent(key: string | null, focusTranscript = false): void {
  if (key !== state.selected) {
    stashDraft();
    state.selected = key;
    state.detail = key ? { key, detail: null, transcript: null, notFound: false } : null;
    state.taskExpanded = false;
    state.detailFetchedAt = 0;
    const view = $("transcript");
    view.replaceChildren();
    delete view.dataset.content;
    delete view.dataset.agent;
    persist();
  }
  for (const node of document.querySelectorAll<HTMLElement>("#am-tree [data-agent-key]"))
    node.setAttribute("aria-selected", String(node.dataset.agentKey === key));
  if (!key) {
    showChat(false);
    renderEmpty();
    return;
  }
  showChat(true);
  showDraft(key);
  renderHeader();
  if (!state.detail?.transcript) {
    const view = $("transcript");
    if (!view.childElementCount) view.append(h("p", "am-transcript-note", "Loading conversation…"));
  }
  void loadDetail();
  if (focusTranscript) $("transcript").focus({ preventScroll: true });
}

async function loadDetail(): Promise<void> {
  const key = state.selected;
  const parsed = key && parseAgentKey(key);
  if (!key || !parsed || !state.conns.has(parsed.connection)) return;
  const seq = ++state.detailSeq;
  state.detailFetchedAt = Date.now();
  state.detailInFlight = true;
  const base = agentPath(parsed.id);
  try {
    const [detail, transcript] = await Promise.all([
      apiGet<AgentDetail>(parsed.connection, base),
      apiGet<Transcript>(parsed.connection, base + "/transcript"),
    ]);
    // Out-of-order guard: drop responses for an agent no longer open, or older than one already shown.
    if (key !== state.selected || seq <= state.detailApplied || !state.detail) return;
    state.detailApplied = seq;
    state.detail.detail = detail;
    state.detail.transcript = transcript;
    state.detail.notFound = false;
    renderHeader();
    renderTranscript();
  } catch (error) {
    if (key !== state.selected || !state.detail) return;
    if (error instanceof ApiError && error.status === 404) {
      state.detail.notFound = true;
      renderHeader();
      if (!state.detail.transcript) {
        $("transcript").replaceChildren(h("p", "am-transcript-note", "This agent is not on the server any more."));
      }
      return;
    }
    noteError(parsed.connection, error);
  } finally {
    if (seq === state.detailSeq) state.detailInFlight = false;
  }
}

// The fleet stream updates rows sooner than the detail poll; keep the header's
// status in step with the sidebar.
function syncHeaderFromRow(): void {
  if (state.selected) renderHeader();
}

function metaItem(label: string, value: string | undefined, mono = false): HTMLElement | null {
  if (!value) return null;
  const node = h("span", `am-meta-item${mono ? " mono" : ""}`);
  node.title = `${label}: ${value}`;
  node.append(h("span", "", label), h("b", "", value));
  return node;
}

// Prefer the fresher of the fleet row and the detail for status.
function agentSource(key: string): Partial<AgentRow> {
  const row = findRow(key);
  const detail = state.detail?.key === key ? state.detail.detail : null;
  return { ...(detail ?? {}), ...(row && (!detail || Date.parse(row.updatedAt) >= Date.parse(detail.updatedAt)) ? row : {}) };
}

function renderHeader(): void {
  const key = state.selected;
  if (!key) return;
  const parsed = parseAgentKey(key);
  const source = agentSource(key);
  const conn = parsed ? state.conns.get(parsed.connection) : undefined;
  const name = source.name ?? parsed?.id.split(":").pop() ?? key;
  const concierge = isConcierge(key);
  $("am-agent-name").textContent = concierge ? "Concierge" : name;
  $("am-agent-name").classList.toggle("am-concierge-title", concierge);
  $("am-agent-name").title = parsed?.id ?? name;
  const status = source.status ?? "";
  $("am-agent-status").replaceChildren(...(status ? [badge(status)] : []));
  const flag = $("am-agent-flag");
  flag.hidden = !state.detail?.notFound;
  flag.textContent = "Not found on server";
  const host = source.host || conn?.local || "";
  const runtime = [source.provider, source.model, source.effort].filter(Boolean).join(" · ");
  const queued = (source.queued ?? 0) > 0 ? `${source.queued}` : undefined;
  $("am-agent-meta").replaceChildren(...[
    metaItem("Host", host + (conn && state.conns.size > 1 ? ` (${conn.conn.name})` : "")),
    metaItem("Runtime", runtime),
    metaItem("Branch", source.worktreeBranch, true),
    metaItem("Dir", source.dir, true),
    metaItem("Queued", queued),
  ].filter((node): node is HTMLElement => !!node));
  const reason = $("am-agent-reason");
  reason.hidden = !source.statusReason;
  reason.textContent = source.statusReason || "";
  const task = (source.task || "").trim();
  const taskBox = $("am-agent-task");
  taskBox.hidden = !task;
  const multi = task.includes("\n") || task.length > 120;
  taskBox.classList.toggle("expanded", state.taskExpanded);
  $("am-agent-task-text").textContent = state.taskExpanded ? task : firstLine(task);
  const toggle = $("am-agent-task-toggle");
  toggle.hidden = !multi;
  toggle.textContent = state.taskExpanded ? "Less" : "More";
  toggle.setAttribute("aria-expanded", String(state.taskExpanded));
  updateWorking(status, source.workingSince || source.statusChangedAt);
  renderComposer();
}

// Entries re-render only when they change; the pending/queued bubbles after
// them re-render on their own fingerprint so a poll never rebuilds either for nothing.
function renderTranscript(pin = false): void {
  const detailState = state.detail;
  const transcript = detailState?.transcript;
  if (!detailState || !transcript) return;
  const view = $("transcript");
  const entries = Array.isArray(transcript.entries) ? transcript.entries : [];
  const agent = agentComposer(detailState.key);
  agent.pending = reconcilePending(agent.pending, entries, Date.now());
  agent.userCount = userTexts(entries).length;
  const list = bubbles(agent.pending, detailState.detail?.queue);
  const fingerprint = JSON.stringify(entries);
  const bubbleFingerprint = JSON.stringify(list.map((bubble) => [bubble.key, bubble.state, bubble.cancelId && composer.cancelling.has(bubble.cancelId)]));
  const firstRender = view.dataset.agent !== detailState.key;
  const entriesChanged = firstRender || view.dataset.content !== fingerprint;
  if (!entriesChanged && view.dataset.bubbles === bubbleFingerprint) {
    if (pin) view.scrollTop = view.scrollHeight;
    return;
  }
  const restore = firstRender ? null : window.agentTranscript.preserveConversationScroll(view, 90);
  const focusedCancel = (document.activeElement as HTMLElement | null)?.dataset?.cancelMessage;
  if (entriesChanged) {
    view.replaceChildren();
    view.dataset.content = fingerprint;
    view.dataset.agent = detailState.key;
    if (!entries.length) view.append(h("p", "am-transcript-note", "No messages yet."));
    else window.agentTranscript.renderEntries(view, entries, { agentName: detailState.detail?.name ?? "", readBoundary: null });
  }
  let box = view.querySelector<HTMLElement>(":scope > .am-outbox");
  if (!box) box = h("div", "am-outbox");
  box.replaceChildren(...list.map((bubble) => bubbleNode(bubble, detailState.detail?.name ?? "")));
  if (view.lastChild !== box) view.append(box);
  view.dataset.bubbles = bubbleFingerprint;
  if (focusedCancel) {
    const again = box.querySelector<HTMLElement>(`[data-cancel-message="${CSS.escape(focusedCancel)}"]`);
    if (again) again.focus({ preventScroll: true });
    else if (!composerInput().disabled) composerInput().focus({ preventScroll: true });
  }
  if (restore) restore();
  if (!restore || pin) view.scrollTop = view.scrollHeight;
  updateJump();
}

function bubbleNode(bubble: Bubble, agentName: string): HTMLElement {
  const turn = window.agentTranscript.chatTurn({ kind: "user", text: bubble.text, index: bubble.key }, agentName);
  turn.classList.add("queued", "pending");
  turn.dataset.messageState = bubble.state;
  const meta = h("div", "queued-meta", BUBBLE_LABEL[bubble.state]);
  if (bubble.cancelId) {
    const id = bubble.cancelId;
    const busy = composer.cancelling.has(id);
    const button = h("button", "text-button", busy ? "Cancelling…" : "Cancel");
    button.type = "button";
    button.dataset.cancelMessage = id;
    button.disabled = busy;
    button.setAttribute("aria-label", busy ? "Cancelling the queued message" : "Cancel this queued message");
    meta.append(button);
  }
  turn.append(meta);
  return turn;
}

const composerInput = () => $<HTMLTextAreaElement>("composer-input");
const isMac = (): boolean => isNative() || /Mac|iPhone|iPad/.test(navigator.platform);

function agentComposer(key: string): AgentComposer {
  let agent = composer.agents.get(key);
  if (!agent) composer.agents.set(key, agent = { pending: [], userCount: 0, error: null });
  return agent;
}

function saveDrafts(): void {
  if (composer.draftTimer) clearTimeout(composer.draftTimer);
  composer.draftTimer = null;
  saveDraftsRaw(JSON.stringify(capDrafts(composer.drafts)));
}

// The textarea's text belongs to composer.shownKey; write it back before showing another agent's.
function stashDraft(): void {
  const key = composer.shownKey;
  if (!key) return;
  composer.drafts = putDraft(composer.drafts, key, composerInput().value, Date.now());
  saveDrafts();
}

function showDraft(key: string): void {
  if (composer.shownKey === key) return;
  composer.shownKey = key;
  const input = composerInput();
  input.value = composer.drafts[key]?.text ?? "";
  input.setSelectionRange(input.value.length, input.value.length);
  input.scrollTop = 0;
  autosize();
}

function onComposerInput(): void {
  const key = composer.shownKey;
  if (key) {
    composer.drafts = putDraft(composer.drafts, key, composerInput().value, Date.now());
    if (composer.draftTimer) clearTimeout(composer.draftTimer);
    composer.draftTimer = setTimeout(saveDrafts, DRAFT_SAVE_MS);
  }
  autosize();
}

// Grows with the text up to 40% of the chat pane, then scrolls. (The transcript
// shrinks to make room; its resize observer keeps it pinned.)
function autosize(): void {
  const input = composerInput();
  const scroll = input.scrollTop;
  const max = Math.max(72, Math.round($("am-chat").clientHeight * 0.4));
  input.style.height = "auto";
  const height = Math.min(input.scrollHeight, max);
  input.style.height = `${height}px`;
  input.style.overflowY = input.scrollHeight > max ? "auto" : "hidden";
  input.scrollTop = scroll;
}

// Whether the reader was at the bottom of the transcript before its box
// changed size (composer growth, an error line, the working indicator).
let transcriptPinned = true;
function trackTranscriptPin(): void {
  const view = $("transcript");
  view.addEventListener("scroll", () => {
    transcriptPinned = view.scrollHeight - view.scrollTop - view.clientHeight < 4;
  }, { passive: true });
  new ResizeObserver(() => {
    if (transcriptPinned && state.selected) view.scrollTop = view.scrollHeight;
  }).observe(view);
}

function modeChoice(key: string) {
  return modeFor(agentSource(key).provider, composer.preference);
}

// Why the selected agent cannot take a message, or null.
function blockedReason(key: string): string | null {
  if (state.detail?.key === key && state.detail.notFound) return "This agent is not on the server any more.";
  const source = agentSource(key);
  if (source.status && STOPPED.has(source.status)) {
    return `This agent is stopped. Resume it with am resume ${source.name ?? parseAgentKey(key)?.id ?? ""} or from the web UI to send.`;
  }
  return null;
}

function keyHint(label: string, keys: string[]): HTMLElement {
  const node = h("span", "am-key-hint");
  for (const key of keys) node.append(h("kbd", "", key));
  node.append(document.createTextNode(label));
  return node;
}

function renderComposer(): void {
  const key = state.selected;
  if (!key) return;
  const input = composerInput();
  const blocked = blockedReason(key);
  const known = !!agentSource(key).provider;
  const choice = modeChoice(key);
  const sending = composer.sending.has(key);
  const form = $("am-composer");
  form.classList.toggle("blocked", !!blocked);
  const note = $("am-composer-blocked");
  note.hidden = !blocked;
  if (note.textContent !== (blocked ?? "")) note.textContent = blocked ?? "";
  if (input.disabled !== !!blocked) input.disabled = !!blocked;
  const error = agentComposer(key).error;
  const errorLine = $("composer-error");
  errorLine.hidden = !error;
  if (errorLine.textContent !== (error ?? "")) errorLine.textContent = error ?? "";
  for (const button of document.querySelectorAll<HTMLButtonElement>("[data-send-mode]")) {
    const mode = button.dataset.sendMode as SendMode;
    button.setAttribute("aria-pressed", String(mode === choice.mode));
    button.disabled = !!blocked || (!choice.choosable && mode !== choice.mode);
    button.title = !choice.choosable && mode === "now" ? FORCED_QUEUE_HINT : MODE_HINT[mode];
  }
  $("am-composer").dataset.mode = choice.mode;
  $("composer-mode-hint").textContent = blocked ? "" : choice.choosable ? MODE_HINT[choice.mode] : FORCED_QUEUE_HINT;
  const send = $<HTMLButtonElement>("composer-send");
  send.disabled = !!blocked || sending || !known;
  const label = sending ? "Sending…" : choice.mode === "now" ? "Send now" : "Queue";
  if (send.textContent !== label) send.textContent = label;
  input.placeholder = blocked ? "" : isConcierge(key) ? "Ask the concierge"
    : choice.mode === "now" ? "Message the agent" : "Message the agent when it is free";
  const keysBox = $("am-composer-keys");
  const keysFor = `${choice.mode}/${choice.choosable}`;
  if (keysBox.dataset.for === keysFor) return;
  keysBox.dataset.for = keysFor;
  const alt = isMac() ? "⌥" : "Alt";
  const keys = [keyHint(choice.mode === "now" ? "send now" : "queue", ["Enter"]), keyHint("new line", ["Shift", "Enter"])];
  if (choice.choosable) keys.push(keyHint(choice.mode === "now" ? "queue instead, once" : "send now instead, once", [alt, "Enter"]));
  keys.push(keyHint("back to the list", ["Esc"]));
  keysBox.replaceChildren(...keys);
}

function setComposerError(key: string, error: string | null, fromCancel = false): void {
  const agent = agentComposer(key);
  agent.error = error;
  agent.cancelError = fromCancel;
  if (state.selected === key) renderComposer();
}

function applyOutcome(key: string, outcome: Outcome, fromCancel = false): void {
  if (outcome.tokenRejected) {
    const conn = state.conns.get(parseAgentKey(key)?.connection ?? "");
    if (conn) conn.tokenRejected = true;
    renderStatusbar();
  }
  // A cancel that worked leaves an unrelated error (say, an ambiguous send) in place.
  if (fromCancel && !outcome.error && !agentComposer(key).cancelError) return;
  setComposerError(key, outcome.error, fromCancel && !!outcome.error);
}

async function submitMessage(alternate: boolean): Promise<void> {
  const key = state.selected;
  const parsed = key ? parseAgentKey(key) : null;
  // One send per agent at a time: held Enter, Enter plus a click, or a second
  // submit while the first is in flight all stop here.
  if (!key || !parsed || composer.sending.has(key) || composer.shownKey !== key) return;
  const input = composerInput();
  if (input.disabled || blockedReason(key) || !agentSource(key).provider) return;
  const raw = input.value;
  const text = checkMessageText(raw);
  if (!text.ok) {
    if (text.error !== MESSAGE_EMPTY) setComposerError(key, text.error);
    return;
  }
  const mode = sendModeFor(modeChoice(key), alternate);
  const baseline = agentComposer(key).userCount;
  composer.sending.add(key);
  setComposerError(key, null);
  let outcome: Outcome;
  let id: string | undefined;
  try {
    const response = await call("messages.send", { connection: parsed.connection, agent: parsed.id, text: text.value, mode });
    outcome = sendOutcome(response);
    const body = response.body as { id?: unknown } | null;
    if (!outcome.error && typeof body?.id === "string") id = body.id;
  } catch (error) {
    outcome = rejectionOutcome(error, "send");
  } finally {
    composer.sending.delete(key);
  }
  applyOutcome(key, outcome);
  if (outcome.error) {
    // The text stays where it was; give the user the box back to fix or resend.
    if (state.selected === key && !input.disabled) input.focus({ preventScroll: true });
    return;
  }
  const agent = agentComposer(key);
  agent.pending = notePending(agent.pending, text.value, id, baseline, Date.now(), mode);
  if (state.selected === key && composer.shownKey === key) {
    const after = textAfterSend(input.value, raw);
    if (after.text !== input.value) {
      const start = Math.max(0, input.selectionStart - after.removed);
      const end = Math.max(0, input.selectionEnd - after.removed);
      input.value = after.text;
      input.setSelectionRange(start, end);
      autosize();
    }
    composer.drafts = putDraft(composer.drafts, key, input.value, Date.now());
  } else {
    const draft = composer.drafts[key]?.text ?? "";
    composer.drafts = putDraft(composer.drafts, key, textAfterSend(draft, raw).text, Date.now());
  }
  saveDrafts();
  if (state.selected !== key) return;
  renderComposer();
  renderTranscript(true);
  void loadDetail();
}

async function cancelQueued(key: string, id: string): Promise<void> {
  const parsed = parseAgentKey(key);
  if (!parsed || composer.cancelling.has(id)) return;
  composer.cancelling.add(id);
  if (state.selected === key) renderTranscript();
  let outcome: Outcome;
  try {
    outcome = cancelOutcome(await call("messages.cancel", { connection: parsed.connection, agent: parsed.id, id }));
  } catch (error) {
    outcome = rejectionOutcome(error, "cancel");
  } finally {
    composer.cancelling.delete(id);
  }
  const agent = agentComposer(key);
  if (outcome.gone) {
    // The server no longer knows the id; if it still lists the text, it shows without a Cancel until the refetch.
    agent.pending = agent.pending.filter((pending) => pending.id !== id);
  } else if (!outcome.error) {
    const detail = state.detail?.key === key ? state.detail.detail : null;
    const next = withoutMessage(agent.pending, detail?.queue, id);
    agent.pending = next.pending;
    if (detail) detail.queue = next.queue;
    // Drop detail responses already in flight; they predate the cancel.
    if (state.selected === key) state.detailApplied = state.detailSeq;
  }
  applyOutcome(key, outcome, true);
  if (state.selected !== key) return;
  renderTranscript();
  void loadDetail();
}

function wireComposer(): void {
  const input = composerInput();
  input.addEventListener("input", onComposerInput);
  input.addEventListener("keydown", (event) => {
    if (event.isComposing || event.keyCode === 229) return;
    if (event.key === "Escape") {
      event.preventDefault();
      stashDraft();
      focusCursor();
      return;
    }
    if (event.key !== "Enter" || (event.shiftKey && !event.metaKey && !event.ctrlKey && !event.altKey)) return;
    // Also stops ⌥Enter from typing a character on macOS keyboards.
    event.preventDefault();
    if (event.repeat) return;
    void submitMessage(event.altKey);
  });
  $("am-composer").addEventListener("submit", (event) => {
    event.preventDefault();
    void submitMessage(false);
  });
  for (const button of document.querySelectorAll<HTMLButtonElement>("[data-send-mode]")) {
    button.addEventListener("click", () => {
      const key = state.selected;
      if (!key || !modeChoice(key).choosable) return;
      composer.preference = button.dataset.sendMode as SendMode;
      saveSendModeRaw(composer.preference);
      renderComposer();
    });
  }
  $("transcript").addEventListener("click", (event) => {
    const button = (event.target as HTMLElement).closest<HTMLElement>("[data-cancel-message]");
    if (button?.dataset.cancelMessage && state.selected) void cancelQueued(state.selected, button.dataset.cancelMessage);
  });
  trackTranscriptPin();
  window.addEventListener("pagehide", stashDraft);
  window.addEventListener("resize", autosize);
}

function updateJump(): void {
  const view = $("transcript");
  $("am-jump-latest").hidden = !state.selected || view.scrollHeight - view.scrollTop - view.clientHeight < 100;
}

function updateWorking(status: string, since: string | undefined): void {
  const box = $("am-working");
  const busy = BUSY.has(status);
  box.hidden = !busy;
  if (!busy) return;
  box.dataset.status = status;
  box.dataset.since = since || "";
  const label = { starting: "Starting", waiting: "Waiting on background tasks" }[status] || "Working";
  const announced = box.querySelector("[role=status]");
  if (announced && announced.textContent !== label) announced.textContent = label;
  tickWorking();
}

function tickWorking(): void {
  const box = $("am-working");
  if (box.hidden) return;
  const label = { starting: "Starting", waiting: "Waiting on background tasks" }[box.dataset.status || ""] || "Working";
  const start = Date.parse(box.dataset.since || "");
  const text = box.querySelector(".working-text");
  if (text) text.textContent = label + (Number.isFinite(start) ? ` for ${duration(Date.now() - start)}` : "");
}

function streamLabel(conn: ConnState): { text: string; tone: string } {
  if (conn.stream === "open") return { text: "Live", tone: "open" };
  if (!conn.everOpen && conn.stream !== "closed") return { text: "Connecting", tone: "connecting" };
  return { text: "Reconnecting", tone: "reconnecting" };
}

function renderStatusbar(): void {
  const left = $("am-sb-left");
  const nodes: HTMLElement[] = [];
  for (const conn of state.conns.values()) {
    if (conn.tokenRejected) {
      const button = h("button", "am-sb-error", `${conn.conn.name}: token rejected — update`);
      button.type = "button";
      button.title = "The server refused the access token. Open the connection to paste a new one.";
      button.addEventListener("click", () => openSetup(conn.conn.id));
      nodes.push(button);
      continue;
    }
    const { text, tone } = streamLabel(conn);
    const item = h("span", "am-sb-item");
    item.append(h("i", `am-live ${tone}`), document.createTextNode(`${conn.conn.name} · ${text}`));
    item.title = conn.streamError ? `${text}: ${conn.streamError}` : `${conn.conn.url} — ${text === "Live" ? "receiving live fleet events" : text.toLowerCase()}`;
    nodes.push(item);
    if (conn.error) {
      const error = h("span", "am-sb-item am-sb-error", `⚠ ${conn.error}`);
      error.title = `Last request to ${conn.conn.name} failed: ${conn.error}`;
      nodes.push(error);
    }
    for (const host of conn.unreachable) {
      const item = h("span", "am-sb-item am-sb-warn", `⚠ ${host} unreachable`);
      item.title = `${host} did not answer the last fleet refresh`;
      nodes.push(item);
    }
  }
  if (!state.conns.size) nodes.push(h("span", "am-sb-item", "Not connected"));
  left.replaceChildren(...nodes);
  const counts = countStatuses(allRows());
  const parts: HTMLElement[] = [];
  for (const [status, label] of [["working", "working"], ["waiting", "waiting"], ["needs-attention", "need attention"], ["idle", "idle"]] as const) {
    const item = h("span");
    item.title = `${counts[status]} ${statusLabel(status).toLowerCase()}`;
    item.append(dot(status), document.createTextNode(String(counts[status])), h("span", "am-count-label", label));
    parts.push(item);
  }
  $("am-sb-counts").replaceChildren(...(state.conns.size ? parts : []));
  $("am-sb-version").textContent = state.info ? `v${state.info.version}${state.info.build && state.info.build !== state.info.version ? ` (${state.info.build})` : ""}` : "";
}

function setView(view: "setup" | "fleet"): void {
  document.body.dataset.view = view;
  $("am-setup").hidden = view !== "setup";
  $("am-shell").hidden = view !== "fleet";
}

function setResult(text: string, tone: "" | "ok" | "error" = ""): void {
  const node = $("am-conn-result");
  node.textContent = text;
  node.className = tone;
}

function openSetup(editId: string | null = null): void {
  state.pendingRemove = null;
  setView("setup");
  const hasConnections = state.conns.size > 0;
  state.formOpen = !hasConnections || editId !== null;
  state.editing = editId;
  renderSetup();
  if (state.formOpen) fillForm();
  const focus = state.formOpen ? (editId ? $("connection-token") : $("connection-name")) : $("am-conn-add");
  focus.focus();
}

function closeSetup(): void {
  if (!state.conns.size) return;
  setView("fleet");
  focusCursor(false);
}

function fillForm(): void {
  const conn = state.editing ? state.conns.get(state.editing)?.conn : null;
  ($("connection-name") as HTMLInputElement).value = conn?.name ?? "";
  ($("connection-url") as HTMLInputElement).value = conn?.url ?? "";
  ($("connection-token") as HTMLInputElement).value = "";
  updateTokenHint();
  $("am-conn-form-title").textContent = conn ? `Edit ${conn.name}` : state.conns.size ? "New connection" : "Server details";
  setResult("");
}

function updateTokenHint(): void {
  const conn = state.editing ? state.conns.get(state.editing)?.conn : null;
  const url = normalizeServerUrl(($("connection-url") as HTMLInputElement).value);
  const sameUrl = !!conn && url.ok && url.url === conn.url;
  ($("connection-token") as HTMLInputElement).placeholder = conn?.hasToken
    ? sameUrl ? "Leave empty to keep the saved token" : "Paste the token again for the new server URL"
    : "Paste the access token";
}

function renderSetup(): void {
  const first = state.conns.size === 0;
  $("am-setup-title").textContent = first ? "Connect to your am server" : "Connections";
  $("am-setup-intro").hidden = !first;
  $("am-setup-close").hidden = first;
  $("am-conn-add").hidden = first || state.formOpen;
  $("am-conn-form").hidden = !state.formOpen;
  $("am-conn-cancel").hidden = first;
  const list = $("am-conn-list");
  list.replaceChildren(...[...state.conns.values()].map(({ conn, tokenRejected }) => {
    const item = h("div", `am-conn-item${state.editing === conn.id && state.formOpen ? " editing" : ""}`);
    item.setAttribute("role", "listitem");
    const text = h("div", "am-conn-text");
    text.append(h("b", "", conn.name), h("span", "", conn.url + (tokenRejected ? " · token rejected" : conn.hasToken ? "" : " · no token")));
    const edit = h("button", "", "Edit");
    edit.type = "button";
    edit.addEventListener("click", () => openSetup(conn.id));
    const confirming = state.pendingRemove === conn.id;
    const remove = h("button", "am-danger", confirming ? "Confirm remove" : "Remove");
    remove.type = "button";
    remove.addEventListener("click", () => {
      if (!confirming) {
        state.pendingRemove = conn.id;
        renderSetup();
        list.querySelector<HTMLElement>(".am-danger")?.focus();
        return;
      }
      void removeConnection(conn.id);
    });
    item.append(text, edit, remove);
    return item;
  }));
}

function readForm(): { name: string; url: string; token: string } | null {
  const name = ($("connection-name") as HTMLInputElement).value.trim();
  const rawUrl = ($("connection-url") as HTMLInputElement).value;
  const token = ($("connection-token") as HTMLInputElement).value.trim();
  const url = normalizeServerUrl(rawUrl);
  if (!url.ok) {
    setResult(url.error, "error");
    $("connection-url").focus();
    return null;
  }
  return { name: name || new URL(url.url).hostname, url: url.url, token };
}

async function testConnection(): Promise<void> {
  const form = readForm();
  if (!form) return;
  const editing = state.editing ? state.conns.get(state.editing) : null;
  const button = $("am-conn-test") as HTMLButtonElement;
  button.disabled = true;
  setResult("Testing…");
  try {
    let result: { ok: boolean; status: number; error?: string };
    if (!form.token && editing && editing.conn.url === form.url && editing.conn.hasToken) {
      // Test the saved token without the page ever seeing it.
      try {
        const response = await call("api.get", { connection: editing.conn.id, path: "/api/health" });
        result = { ok: response.status === 200, status: response.status };
      } catch (error) {
        result = { ok: false, status: 0, error: error instanceof Error ? error.message : String(error) };
      }
    } else if (!form.token) {
      setResult("Paste the access token to test the connection.", "error");
      return;
    } else result = await call("connections.test", { url: form.url, token: form.token });
    if (result.ok) setResult(`Connected to ${form.url}.`, "ok");
    else if (result.status === 401) setResult("The server rejected this token. Run am token on the server and paste the output.", "error");
    else if (result.status === 0) setResult(`Could not reach ${form.url}${result.error ? `: ${result.error}` : ""}.`, "error");
    else setResult(`The server answered ${result.status}${result.error ? `: ${result.error}` : ""}. Is this an am server?`, "error");
  } catch (error) {
    setResult(error instanceof Error ? error.message : String(error), "error");
  } finally {
    button.disabled = false;
  }
}

async function saveConnection(): Promise<void> {
  const form = readForm();
  if (!form) return;
  const editing = state.editing ? state.conns.get(state.editing) : null;
  if (!form.token && (!editing || editing.conn.url !== form.url)) {
    setResult(editing ? "Enter the token again when changing the server URL." : "Paste the access token. Run am token on the server to print it.", "error");
    $("connection-token").focus();
    return;
  }
  const button = $("connection-save") as HTMLButtonElement;
  button.disabled = true;
  try {
    const saved = await call("connections.save", {
      ...(editing ? { id: editing.conn.id } : {}),
      name: form.name,
      url: form.url,
      ...(form.token ? { token: form.token } : {}),
    });
    ($("connection-token") as HTMLInputElement).value = "";
    if (editing) {
      // URL or token may have changed: restart the stream and refetch everything.
      await call("events.stop", { connection: saved.id }).catch(() => {});
      const conn = state.conns.get(saved.id);
      if (conn) Object.assign(conn, { stream: null, everOpen: false, streamError: null, error: null, tokenRejected: false, loaded: conn.conn.url === saved.url && conn.loaded });
      if (conn && conn.conn.url !== saved.url) Object.assign(conn, { rows: [], unreachable: [], remoteHosts: [], local: "" });
    }
    await startConnection(saved);
    state.formOpen = false;
    state.editing = null;
    setView("fleet");
    renderFleet();
    focusCursor(false);
  } catch (error) {
    setResult(error instanceof Error ? error.message : String(error), "error");
  } finally {
    button.disabled = false;
  }
}

async function removeConnection(id: string): Promise<void> {
  try {
    await call("connections.remove", { id });
  } catch (error) {
    setResult(error instanceof Error ? error.message : String(error), "error");
    return;
  }
  const conn = state.conns.get(id);
  if (conn?.debounce) clearTimeout(conn.debounce);
  state.conns.delete(id);
  state.pendingRemove = null;
  if (state.selected && parseAgentKey(state.selected)?.connection === id) selectAgent(null);
  renderFleet();
  if (!state.conns.size) openSetup();
  else renderSetup();
}

function onStreamState(payload: BridgeEvents["events.state"]): void {
  const conn = state.conns.get(payload.connection);
  if (!conn) return;
  const wasOpen = conn.stream === "open";
  conn.stream = payload.state;
  conn.streamError = payload.error ?? null;
  if (payload.error && /\b401\b|unauthori[sz]ed/i.test(payload.error)) conn.tokenRejected = true;
  if (payload.state === "open") {
    conn.everOpen = true;
    // Events may have been missed while disconnected.
    if (!wasOpen) {
      void loadHosts(conn.conn.id);
      scheduleRefresh(conn.conn.id);
    }
  }
  renderStatusbar();
}

function onStreamMessage(payload: BridgeEvents["events.message"]): void {
  const conn = state.conns.get(payload.connection);
  if (!conn) return;
  // A message proves the stream is up even if its state event was missed (page reload).
  if (conn.stream !== "open") {
    conn.stream = "open";
    conn.everOpen = true;
    conn.streamError = null;
    renderStatusbar();
  }
  scheduleRefresh(payload.connection);
}

function onMenu(payload: BridgeEvents["menu.command"]): void {
  if (payload.command === "connections") openSetup();
  else if (payload.command === "find") focusFilter();
  else if (payload.command === "reload") void reloadAll();
}

function focusFilter(): void {
  if (document.body.dataset.view !== "fleet") return;
  const filter = $("am-filter") as HTMLInputElement;
  filter.focus();
  filter.select();
}

const isTyping = (target: EventTarget | null): boolean =>
  target instanceof HTMLElement && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName));

function activateItem(item: TreeItem): void {
  if (item.kind === "group") toggleGroup(item.id);
  else selectAgent(item.key);
}

function openConcierge(): void {
  const key = conciergeTarget(fleets(), state.selected);
  if (!key) return;
  const item = state.tree.items.find((candidate) => isPinnedConcierge(candidate) && candidate.key === key);
  if (item) state.cursor = item.id;
  selectAgent(key);
  focusCursor();
  if (!composerInput().disabled) composerInput().focus();
}

function onKeydown(event: KeyboardEvent): void {
  if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
  const view = document.body.dataset.view;
  if (view === "setup") {
    if (event.key === "Escape" && state.conns.size) {
      event.preventDefault();
      closeSetup();
    }
    return;
  }
  const target = event.target;
  if (target === $("am-filter")) {
    if (event.key === "Escape") {
      event.preventDefault();
      const filter = target as HTMLInputElement;
      if (filter.value) {
        filter.value = "";
        state.filter = "";
        renderTree();
      }
      focusCursor();
    } else if (event.key === "ArrowDown" || event.key === "Enter") {
      event.preventDefault();
      // The pinned concierge always shows; Enter means the first match below it.
      const first = state.tree.items.find((item) => item.kind === "agent" && !item.concierge);
      if (event.key === "Enter" && first?.kind === "agent") selectAgent(first.key);
      setCursor(first?.id ?? state.cursor);
    }
    return;
  }
  if (isTyping(target)) return;
  if (event.key === "/") {
    event.preventDefault();
    focusFilter();
    return;
  }
  if (event.key === "Escape") {
    event.preventDefault();
    focusCursor();
    return;
  }
  if (event.key === "c") {
    // Before focus moves to the message box, or the c would be typed into it.
    event.preventDefault();
    openConcierge();
    return;
  }
  const tree = $("am-tree");
  const inTree = target instanceof Node && tree.contains(target);
  // Arrow keys belong to whatever has focus (the transcript scrolls with them);
  // the list takes them when it, or nothing in particular, is focused.
  if (!inTree && target !== document.body && target !== document.documentElement) return;
  const items = state.tree.items;
  const current = items.find((item) => item.id === state.cursor);
  switch (event.key) {
    case "ArrowDown":
    case "j":
      event.preventDefault();
      setCursor(moveCursor(items, state.cursor, 1));
      break;
    case "ArrowUp":
    case "k":
      event.preventDefault();
      setCursor(moveCursor(items, state.cursor, -1));
      break;
    case "Home":
      event.preventDefault();
      setCursor(items[0]?.id ?? null);
      break;
    case "End":
      event.preventDefault();
      setCursor(items[items.length - 1]?.id ?? null);
      break;
    case "Enter":
    case " ":
      if (!current) return;
      event.preventDefault();
      activateItem(current);
      // Enter opens the agent to write to it; Space only opens it.
      if (event.key === "Enter" && current.kind === "agent" && !composerInput().disabled) composerInput().focus();
      break;
    case "ArrowLeft":
      if (!current) return;
      event.preventDefault();
      if (current.kind === "group" && !current.collapsed) toggleGroup(current.id, true);
      else if (current.parent && items.some((item) => item.id === current.parent)) setCursor(current.parent);
      break;
    case "ArrowRight":
      if (!current) return;
      event.preventDefault();
      if (current.kind === "group" && current.collapsed) toggleGroup(current.id, false);
      else if (current.kind === "group") setCursor(moveCursor(items, current.id, 1));
      break;
  }
}

function wire(): void {
  document.addEventListener("keydown", onKeydown);
  wireComposer();
  const tree = $("am-tree");
  tree.addEventListener("click", (event) => {
    const node = (event.target as HTMLElement).closest<HTMLElement>("[data-item-id]");
    const item = node && state.tree.items.find((candidate) => candidate.id === node.dataset.itemId);
    if (!item) return;
    state.cursor = item.id;
    activateItem(item);
    focusCursor(false);
  });
  tree.addEventListener("focusin", (event) => {
    const node = (event.target as HTMLElement).closest<HTMLElement>("[data-item-id]");
    if (node?.dataset.itemId) state.cursor = node.dataset.itemId;
  });
  $("am-filter").addEventListener("input", (event) => {
    state.filter = (event.target as HTMLInputElement).value;
    state.cursor = null;
    renderTree();
  });
  $("am-show-stopped").addEventListener("click", () => {
    state.showStopped = !state.showStopped;
    persist();
    renderTree();
  });
  $("am-sb-connections").addEventListener("click", () => openSetup());
  $("am-setup-close").addEventListener("click", closeSetup);
  $("am-conn-add").addEventListener("click", () => {
    state.formOpen = true;
    state.editing = null;
    renderSetup();
    fillForm();
    $("connection-name").focus();
  });
  $("am-conn-cancel").addEventListener("click", () => {
    state.formOpen = false;
    state.editing = null;
    renderSetup();
    $("am-conn-add").focus();
  });
  $("am-conn-test").addEventListener("click", () => void testConnection());
  $("connection-url").addEventListener("input", updateTokenHint);
  $("am-conn-form").addEventListener("submit", (event) => {
    event.preventDefault();
    void saveConnection();
  });
  $("am-agent-task-toggle").addEventListener("click", () => {
    state.taskExpanded = !state.taskExpanded;
    renderHeader();
  });
  const view = $("transcript");
  view.addEventListener("scroll", updateJump, { passive: true });
  $("am-jump-latest").addEventListener("click", () => {
    view.scrollTop = view.scrollHeight;
    updateJump();
    view.focus({ preventScroll: true });
  });
  // Links in chat open in the user's browser, never inside the app's web view.
  document.addEventListener("click", (event) => {
    const link = (event.target as HTMLElement).closest?.("a[href]") as HTMLAnchorElement | null;
    if (!link || !/^https?:/i.test(link.href)) return;
    event.preventDefault();
    call("open.external", { url: link.href })
      .then(() => { if (!isNative()) window.open(link.href, "_blank", "noopener"); })
      .catch((error: unknown) => console.warn("open.external failed", error));
  });

  const divider = $("am-divider");
  divider.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    divider.setPointerCapture(event.pointerId);
    document.body.classList.add("am-resizing");
    const move = (moveEvent: PointerEvent) => {
      sidebarWidth = Math.max(SIDEBAR_MIN, Math.min(sidebarMax(), moveEvent.clientX));
      applySidebarWidth();
    };
    const up = () => {
      document.body.classList.remove("am-resizing");
      divider.removeEventListener("pointermove", move);
      divider.removeEventListener("pointerup", up);
      divider.removeEventListener("pointercancel", up);
      persist();
    };
    divider.addEventListener("pointermove", move);
    divider.addEventListener("pointerup", up);
    divider.addEventListener("pointercancel", up);
  });
  divider.addEventListener("keydown", (event) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    event.stopPropagation();
    sidebarWidth = Math.max(SIDEBAR_MIN, Math.min(sidebarMax(), sidebarWidth + (event.key === "ArrowRight" ? 16 : -16)));
    applySidebarWidth();
    persist();
  });
  window.addEventListener("resize", applySidebarWidth);
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
  for (const node of document.querySelectorAll<HTMLElement>("#am-tree [data-since]")) {
    const text = relativeTime(node.dataset.since, now);
    if (node.textContent !== text) node.textContent = text;
  }
  tickWorking();
  if (document.hidden) return;
  for (const conn of state.conns.values()) {
    if (conn.stream !== "open" && now - conn.agentsFetchedAt >= FLEET_POLL_MS) void loadAgents(conn.conn.id);
  }
  const row = state.selected ? findRow(state.selected) : null;
  const status = row?.status ?? state.detail?.detail?.status ?? "";
  // Pending and queued bubbles also need the poll: delivery need not change the agent's status.
  const outstanding = !!state.selected && (agentComposer(state.selected).pending.length > 0 || (state.detail?.detail?.queue?.length ?? 0) > 0);
  if (state.selected && (BUSY.has(status) || outstanding) && !state.detailInFlight && now - state.detailFetchedAt >= DETAIL_POLL_MS) void loadDetail();
}

async function start(): Promise<void> {
  applySidebarWidth();
  startBridge();
  wire();
  call("app.info", {})
    .then((info) => {
      state.info = info;
      renderStatusbar();
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
    setView("fleet");
    if (state.selected && !state.conns.has(parseAgentKey(state.selected)?.connection ?? "")) state.selected = null;
    const restored = state.selected;
    state.selected = null;
    renderFleet();
    if (restored) selectAgent(restored);
    else selectAgent(null);
    for (const conn of connections) void startConnection(conn);
  }
  renderStatusbar();
  setInterval(tick, 1000);
  document.body.dataset.ready = "true";
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", () => void start());
else void start();
