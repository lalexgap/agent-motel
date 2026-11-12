// App state: one object per concern, the derived lookups every view needs, and
// the change channels views subscribe to so they re-render their own region.
import { parseDrafts, parseModePreference, type PendingMessage } from "./composer";
import { agentKey, fleetRows, isConciergeKey, parseAgentKey, type ConnectionFleet, type TreeModel } from "./fleet";
import { loadDraftsRaw, loadPrefs, loadSendModeRaw, savePrefs } from "./store";
import type { AgentDetail, AgentRow, AppInfo, Connection, StreamState, SubagentRecord, Transcript } from "./types";
import { Unread } from "./unread";

export interface ConnState {
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

export interface DetailState {
  key: string;
  detail: AgentDetail | null;
  transcript: Transcript | null;
  notFound: boolean;
  // Built-in subagent records, once fetched; the last fetch's error, if it failed.
  subagents: SubagentRecord[] | null;
  subagentsError: string | null;
}

export const newDetailState = (key: string): DetailState =>
  ({ key, detail: null, transcript: null, notFound: false, subagents: null, subagentsError: null });

// Per agent key. Survives switching agents; pending bubbles last for the session.
export interface AgentComposer {
  pending: PendingMessage[];
  // User turns in the last transcript shown, the baseline for the next send.
  userCount: number;
  error: string | null;
  // The error came from a cancel, so a later successful cancel may clear it.
  cancelError?: boolean;
}

const prefs = loadPrefs();
export const composer = {
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
export const state = {
  conns: new Map<string, ConnState>(),
  info: null as AppInfo | null,
  filter: "",
  collapsed: new Set(prefs.collapsed),
  showStopped: prefs.showStopped,
  sidebarGroup: prefs.sidebarGroup,
  sidebarSort: prefs.sidebarSort,
  sidebarReverse: prefs.sidebarReverse,
  overviewFilter: prefs.overviewFilter,
  overviewSort: prefs.overviewSort,
  overviewReverse: prefs.overviewReverse,
  overviewQuery: "",
  selected: prefs.selected,
  // The last entry read in the open agent when it was opened: where "New since your last visit" goes.
  readBoundary: null as number | null,
  sidebarWidth: prefs.sidebarWidth,
  cursor: null as string | null,
  tree: { items: [], hiddenStopped: 0, shown: 0, total: 0 } as TreeModel,
  detail: null as DetailState | null,
  detailSeq: 0,
  detailApplied: 0,
  detailFetchedAt: 0,
  detailInFlight: false,
  subagentsSeq: 0,
  // The subagent the subagent view shows (`<agent key>#<id>`); its parent stays `selected`.
  subagent: null as string | null,
  taskExpanded: false,
  editing: null as string | null,
  formOpen: false,
  pendingRemove: null as string | null,
  ready: false,
};

export const unread = new Unread();

export const persist = () =>
  savePrefs({
    selected: state.selected, sidebarWidth: state.sidebarWidth, collapsed: [...state.collapsed], showStopped: state.showStopped,
    sidebarGroup: state.sidebarGroup, sidebarSort: state.sidebarSort, sidebarReverse: state.sidebarReverse,
    overviewFilter: state.overviewFilter, overviewSort: state.overviewSort, overviewReverse: state.overviewReverse,
  });

// What changed, so the views that show it re-render. Listeners run in the
// order they subscribed, synchronously.
//   fleet       connections, rows, hosts or the concierge changed
//   status      only connection health (stream state, errors, token, app info)
//   agent       the open agent's header data: selection, detail, a fresher row,
//               its subagent records
//   transcript  the open agent's transcript was fetched (or found missing)
//   seen        the selection or what has been read changed ("New" badges)
export type Change = "fleet" | "status" | "agent" | "transcript" | "seen";
const listeners: Record<Change, (() => void)[]> = { fleet: [], status: [], agent: [], transcript: [], seen: [] };
export function subscribe(change: Change, listener: () => void): void {
  listeners[change].push(listener);
}
export function changed(change: Change): void {
  for (const listener of listeners[change]) listener();
}

export function newConnState(conn: Connection): ConnState {
  return {
    conn, local: "", remoteHosts: [], rows: [], unreachable: [], conciergeKey: null, loaded: false, stream: null, everOpen: false,
    streamError: null, error: null, tokenRejected: false, agentsSeq: 0, agentsApplied: 0, agentsFetchedAt: 0, debounce: null,
  };
}

export function fleets(): ConnectionFleet[] {
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
export function allRows(): AgentRow[] {
  return fleets().flatMap(fleetRows);
}
export const isConcierge = (key: string): boolean => isConciergeKey(fleets(), key);
export function findRow(key: string): AgentRow | null {
  const parsed = parseAgentKey(key);
  const conn = parsed && state.conns.get(parsed.connection);
  return conn?.rows.find((row) => agentKey(conn.conn.id, row) === key) ?? null;
}

// Prefer the fresher of the fleet row and the detail for status.
export function agentSource(key: string): Partial<AgentRow> {
  const row = findRow(key);
  const detail = state.detail?.key === key ? state.detail.detail : null;
  return { ...(detail ?? {}), ...(row && (!detail || Date.parse(row.updatedAt) >= Date.parse(detail.updatedAt)) ? row : {}) };
}

export function agentComposer(key: string): AgentComposer {
  let agent = composer.agents.get(key);
  if (!agent) composer.agents.set(key, agent = { pending: [], userCount: 0, error: null });
  return agent;
}

// Why nothing has loaded yet, when a connection that never loaded has failed.
export function loadProblem(): string | null {
  const failed = [...state.conns.values()].find((conn) => !conn.loaded && (conn.tokenRejected || conn.error));
  if (!failed) return null;
  return failed.tokenRejected
    ? `${failed.conn.name} rejected the access token. Update it from Connections in the status bar.`
    : `Could not load agents from ${failed.conn.name}: ${failed.error}`;
}
