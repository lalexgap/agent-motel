// The status bar: each connection's stream and errors, fleet counts, version.
import { openSetup } from "./connections";
import { $, dot, h } from "./dom";
import { countStatuses, statusLabel } from "./fleet";
import { allRows, state, subscribe, type ConnState } from "./state";

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

export function initStatusbar(): void {
  subscribe("fleet", renderStatusbar);
  subscribe("status", renderStatusbar);
  $("am-sb-connections").addEventListener("click", () => openSetup());
}
