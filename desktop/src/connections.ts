// The connections screen: first-run setup, and adding, editing, testing and
// removing server connections.
import { call } from "./bridge";
import { selectAgent } from "./chat";
import { startConnection } from "./data";
import { $, h } from "./dom";
import { parseAgentKey } from "./fleet";
import { registerShortcut } from "./keyboard";
import { normalizeServerUrl } from "./policy";
import { focusCursor } from "./sidebar";
import { changed, state } from "./state";
import { setScreen } from "./views";

function setResult(text: string, tone: "" | "ok" | "error" = ""): void {
  const node = $("am-conn-result");
  node.textContent = text;
  node.className = tone;
}

export function openSetup(editId: string | null = null): void {
  state.pendingRemove = null;
  setScreen("setup");
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
  setScreen("fleet");
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
    setScreen("fleet");
    changed("fleet");
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
  changed("fleet");
  if (!state.conns.size) openSetup();
  else renderSetup();
}

export function initConnections(): void {
  registerShortcut({ keys: ["Escape"], screen: "setup", whileTyping: true, when: () => state.conns.size > 0, run: closeSetup });
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
}
