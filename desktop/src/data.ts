// Loading and refreshing fleet and agent data: the initial loads, the fleet
// stream's events, and the polls that cover what the stream does not.
import { ApiError, apiGet } from "./api";
import { call } from "./bridge";
import { agentPath, BUSY, parseAgentKey } from "./fleet";
import { agentComposer, changed, findRow, newConnState, state } from "./state";
import { parseRecords, subagentsAvailable } from "./subagents";
import type { AgentDetail, AgentsResponse, BridgeEvents, Connection, HostsResponse, Transcript } from "./types";

const AGENTS_DEBOUNCE_MS = 150;
const DETAIL_POLL_MS = 4000;
const FLEET_POLL_MS = 5000;

async function loadHosts(id: string): Promise<void> {
  try {
    const hosts = await apiGet<HostsResponse>(id, "/api/hosts");
    const conn = state.conns.get(id);
    if (!conn) return;
    conn.local = typeof hosts?.local === "string" ? hosts.local : "";
    conn.remoteHosts = Array.isArray(hosts?.hosts) ? hosts.hosts.map((host) => host.name).filter((name) => typeof name === "string") : [];
    changed("fleet");
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
  changed("fleet");
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
    changed("fleet");
    // Without the stream, the fleet poll is the only sign the open agent moved on
    // (e.g. went idle after its final message, which the busy-only detail poll would miss).
    const after = selected ? findRow(selected) : null;
    if (conn.stream !== "open" && before && after && selected === state.selected &&
        (before.status !== after.status || before.updatedAt !== after.updatedAt)) void loadDetail();
  } catch (error) {
    noteError(id, error);
  }
}

export function noteError(id: string, error: unknown): void {
  const conn = state.conns.get(id);
  if (!conn) return;
  conn.error = error instanceof Error ? error.message : String(error);
  // Before the first load the sidebar would otherwise say "Loading" forever.
  if (!conn.loaded) changed("fleet");
  else changed("status");
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

export async function startConnection(conn: Connection): Promise<void> {
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

export async function reloadAll(): Promise<void> {
  for (const id of state.conns.keys()) {
    void loadHosts(id);
    void loadConcierge(id);
    void loadAgents(id);
  }
  if (state.selected) void loadDetail();
}

export async function loadDetail(): Promise<void> {
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
    if (subagentsAvailable(detail)) void loadSubagents(key, parsed.connection, base);
    else {
      state.detail.subagents = [];
      state.detail.subagentsError = null;
    }
    changed("agent");
    changed("transcript");
  } catch (error) {
    if (key !== state.selected || !state.detail) return;
    if (error instanceof ApiError && error.status === 404) {
      state.detail.notFound = true;
      changed("agent");
      // With nothing shown yet, the transcript says the agent is gone.
      if (!state.detail.transcript) changed("transcript");
      return;
    }
    noteError(parsed.connection, error);
  } finally {
    if (seq === state.detailSeq) state.detailInFlight = false;
  }
}

// The open agent's built-in subagents, refreshed with the rest of its data. A
// failure keeps the last records and shows its error, as the browser UI does.
async function loadSubagents(key: string, connection: string, base: string): Promise<void> {
  const seq = ++state.subagentsSeq;
  let records: ReturnType<typeof parseRecords> | null = null;
  let error: string | null = null;
  try {
    records = parseRecords(await apiGet<unknown>(connection, base + "/subagents"));
  } catch (failure) {
    error = failure instanceof Error ? failure.message : String(failure);
  }
  if (key !== state.selected || seq !== state.subagentsSeq || state.detail?.key !== key) return;
  if (records || !state.detail.subagents) state.detail.subagents = records ?? [];
  state.detail.subagentsError = error;
  changed("agent");
}

export function onStreamState(payload: BridgeEvents["events.state"]): void {
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
  changed("status");
}

export function onStreamMessage(payload: BridgeEvents["events.message"]): void {
  const conn = state.conns.get(payload.connection);
  if (!conn) return;
  // A message proves the stream is up even if its state event was missed (page reload).
  if (conn.stream !== "open") {
    conn.stream = "open";
    conn.everOpen = true;
    conn.streamError = null;
    changed("status");
  }
  scheduleRefresh(payload.connection);
}

// The polls behind the stream: the fleet while the stream is down, and the open
// agent while it is busy or has messages outstanding.
export function poll(now: number): void {
  for (const conn of state.conns.values()) {
    if (conn.stream !== "open" && now - conn.agentsFetchedAt >= FLEET_POLL_MS) void loadAgents(conn.conn.id);
  }
  const row = state.selected ? findRow(state.selected) : null;
  const status = row?.status ?? state.detail?.detail?.status ?? "";
  // Pending and queued bubbles also need the poll: delivery need not change the agent's status.
  const outstanding = !!state.selected && (agentComposer(state.selected).pending.length > 0 || (state.detail?.detail?.queue?.length ?? 0) > 0);
  if (state.selected && (BUSY.has(status) || outstanding) && !state.detailInFlight && now - state.detailFetchedAt >= DETAIL_POLL_MS) void loadDetail();
}
