"use strict";
const $ = (id) => document.getElementById(id);
const state = {
  rows: [],
  selected: null,
  filter: "all",
  authenticated: false,
  refreshing: false,
  catalogs: [],
  detailVersion: 0,
  drafts: new Map(),
};
const key = (row) => (row.host ? `${row.host}:${row.name}` : row.name);
const attention = (row) => ["needs-attention", "waiting"].includes(row.status);
const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};
const dot = (status) =>
  el(
    "i",
    `dot ${["working", "idle", "needs-attention", "waiting", "dead", "exited"].includes(status) ? status : ""}`,
  );
const statusName = (status) =>
  ({
    working: "Working",
    idle: "Available",
    "needs-attention": "Needs attention",
    waiting: "Waiting",
    dead: "Offline",
    exited: "Stopped",
  })[status] || status;
function badge(status) {
  const node = el("span", "badge");
  node.append(dot(status), document.createTextNode(statusName(status)));
  return node;
}
function notice(text) {
  $("notice").textContent = text;
  $("notice").hidden = !text;
}
async function api(path, body, method) {
  const response = await fetch(path, {
    method: method || (body === undefined ? "GET" : "POST"),
    credentials: "same-origin",
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json();
  if (response.status === 401 && !path.startsWith("/auth/")) lock();
  if (!response.ok)
    throw new Error(data.error || `Request failed (${response.status})`);
  return data;
}
function lock() {
  state.authenticated = false;
  state.detailVersion++;
  state.rows = [];
  state.selected = null;
  state.drafts.clear();
  $("app").hidden = true;
  $("login").hidden = false;
  for (const id of [
    "agent-grid",
    "agent-nav",
    "transcript",
    "permissions",
    "queue",
    "room-details",
  ])
    $(id).replaceChildren();
  $("pane").textContent = "";
  $("message").value = "";
}
async function unlock() {
  await api("/api/health");
  state.authenticated = true;
  $("login").hidden = true;
  $("app").hidden = false;
  await refresh();
}
$("login-form").onsubmit = async (event) => {
  event.preventDefault();
  const button = event.submitter;
  button.disabled = true;
  $("login-error").textContent = "";
  try {
    await api("/auth/login", { token: $("access-key").value });
    $("access-key").value = "";
    await unlock();
  } catch (error) {
    $("login-error").textContent = error.message;
  } finally {
    button.disabled = false;
  }
};
$("logout").onclick = async () => {
  try {
    await api("/auth/logout", {});
    lock();
  } catch (error) {
    notice(error.message);
  }
};
function showOverview(filter = "all") {
  saveDraft();
  state.selected = null;
  state.detailVersion++;
  state.filter = filter;
  $("detail").hidden = true;
  $("overview").hidden = false;
  $("page-title").textContent =
    filter === "attention"
      ? "A little attention goes a long way."
      : "Room for great work.";
  $("page-subtitle").textContent =
    "Your fleet, in focus. Keep things moving from here.";
  $("breadcrumb").textContent =
    filter === "attention" ? "Needs attention" : "Overview";
  $("overview-nav").classList.toggle("active", filter !== "attention");
  $("attention-nav").classList.toggle("active", filter === "attention");
  $("concierge-nav").classList.remove("active");
  renderFleet();
}
$("overview-nav").onclick = () => showOverview();
$("attention-nav").onclick = () => showOverview("attention");
document
  .querySelectorAll("[data-filter]")
  .forEach(
    (button) => (button.onclick = () => showOverview(button.dataset.filter)),
  );
$("search").oninput = renderFleet;
function renderFleet() {
  const rows = state.rows.filter((row) => row.name !== "concierge");
  $("stat-all").textContent = rows.length;
  $("stat-working").textContent = rows.filter(
    (r) => r.status === "working",
  ).length;
  $("stat-attention").textContent = rows.filter(attention).length;
  $("attention-count").textContent = rows.filter(attention).length;
  $("stat-idle").textContent = rows.filter((r) => r.status === "idle").length;
  const nav = $("agent-nav");
  nav.replaceChildren();
  for (const row of rows) {
    const button = el("button", "side-agent");
    button.append(dot(row.status), el("span", "", row.name));
    button.onclick = () => selectAgent(key(row));
    nav.append(button);
  }
  const query = $("search").value.toLowerCase();
  const visible = rows.filter(
    (row) =>
      (state.filter === "all" ||
        (state.filter === "attention"
          ? attention(row)
          : state.filter === "exited"
            ? ["exited", "dead"].includes(row.status)
            : row.status === state.filter)) &&
      `${row.name} ${row.task || ""} ${row.host || ""} ${row.dir || ""}`
        .toLowerCase()
        .includes(query),
  );
  visible.sort(
    (a, b) =>
      Number(attention(b)) - Number(attention(a)) ||
      Number(b.status === "working") - Number(a.status === "working") ||
      a.name.localeCompare(b.name),
  );
  $("list-count").textContent = visible.length;
  document
    .querySelectorAll(".filters button")
    .forEach((b) =>
      b.classList.toggle("selected", b.dataset.filter === state.filter),
    );
  const grid = $("agent-grid");
  grid.replaceChildren();
  if (!visible.length)
    grid.append(
      el(
        "div",
        "empty",
        rows.length
          ? "No agents match this view."
          : "Your next great idea deserves a room. Start with the concierge, or create an agent.",
      ),
    );
  for (const row of visible) {
    const card = el("button", "agent-card");
    const top = el("div", "card-top");
    top.append(
      el("span", "avatar", row.name.slice(0, 1).toUpperCase()),
      badge(row.status),
    );
    const footer = el("div", "card-footer");
    footer.append(
      el("span", "", `${row.provider || "codex"} · ${row.host || "local"}`),
      el("span", "", row.queued ? `${row.queued} queued` : "Open room ↗"),
    );
    card.append(
      top,
      el("h3", "", row.name),
      el("p", "", row.task || row.dir || "Ready for a new direction."),
      footer,
    );
    card.onclick = () => selectAgent(key(row));
    grid.append(card);
  }
}
function saveDraft() {
  if (state.selected) state.drafts.set(state.selected, $("message").value);
}
async function selectAgent(name) {
  saveDraft();
  state.selected = name;
  state.detailVersion++;
  $("overview").hidden = true;
  $("detail").hidden = false;
  $("page-title").textContent = name.endsWith("concierge")
    ? "Your concierge."
    : name;
  $("page-subtitle").textContent = name.endsWith("concierge")
    ? "A conversation is all it takes to get things moving."
    : "One thread. Everything you need to keep moving.";
  $("breadcrumb").textContent = name;
  $("message").value = state.drafts.get(name) || "";
  $("message-status").textContent = "";
  delete $("transcript").dataset.content;
  $("transcript").replaceChildren(el("p", "", "Loading conversation…"));
  $("permissions").replaceChildren();
  $("queue").replaceChildren();
  $("pane").textContent = "";
  $("room-details").replaceChildren();
  document
    .querySelectorAll(".nav")
    .forEach((b) => b.classList.remove("active"));
  $("concierge-nav").classList.toggle("active", name.endsWith("concierge"));
  try {
    await refreshDetail();
  } catch (error) {
    notice(error.message);
  }
}
async function openConcierge(question) {
  try {
    notice("Opening the front desk…");
    const result = await api("/api/concierge", {});
    notice("");
    await selectAgent(result.key);
    if (question) {
      $("message").value = question;
      $("message").focus();
    }
  } catch (error) {
    notice(error.message);
  }
}
$("concierge-nav").onclick = () => openConcierge();
$("banner-chat").onclick = () => openConcierge();
document
  .querySelectorAll("[data-ask]")
  .forEach((b) => (b.onclick = () => openConcierge(b.dataset.ask)));
async function refreshDetail() {
  const name = state.selected,
    version = state.detailVersion;
  if (!name) return;
  const base = "/api/agents/" + encodeURIComponent(name);
  const [detail, transcript, permissions] = await Promise.all([
    api(base),
    api(base + "/transcript"),
    api(base + "/permissions"),
  ]);
  if (
    name !== state.selected ||
    version !== state.detailVersion ||
    !state.authenticated
  )
    return;
  $("detail-status").replaceWith(
    Object.assign(badge(detail.status), { id: "detail-status" }),
  );
  $("detail-meta").textContent = detail.statusReason || detail.task || "";
  const room = $("room-details");
  room.replaceChildren();
  for (const [title, value] of [
    ["Provider", detail.provider],
    ["Model", detail.model || "Provider default"],
    ["Reasoning", detail.effort || "Default"],
    ["Role", detail.role?.name || detail.role || "None"],
    ["Directory", detail.dir],
    ["Branch", detail.worktreeBranch || "—"],
  ]) {
    room.append(el("dt", "", title), el("dd", "", String(value)));
  }
  $("pane").textContent = detail.pane || "No active terminal.";
  const queue = $("queue");
  queue.replaceChildren();
  if (!detail.queue?.length) queue.append(el("p", "", "Nothing waiting."));
  for (const item of detail.queue || []) {
    const line = el(
      "div",
      "queue-item",
      item.text || item.message || "Queued message",
    );
    if (item.msgId) {
      const cancel = el("button", "", "Cancel");
      cancel.onclick = async () => {
        try {
          await api(
            base + "/messages/" + encodeURIComponent(item.msgId),
            undefined,
            "DELETE",
          );
          await refreshDetail();
        } catch (e) {
          notice(e.message);
        }
      };
      line.append(cancel);
    }
    queue.append(line);
  }
  const pending = $("permissions");
  pending.replaceChildren();
  for (const request of permissions.requests) {
    const box = el("div", "permission");
    box.append(
      el("h3", "", `Permission requested · ${request.tool}`),
      el("p", "", request.summary),
    );
    for (const option of request.options) {
      const button = el("button", "", option.label);
      button.onclick = async () => {
        button.disabled = true;
        try {
          await api(base + "/permissions/" + encodeURIComponent(request.id), {
            optionId: option.id,
          });
          await refreshDetail();
        } catch (e) {
          notice(e.message);
          button.disabled = false;
        }
      };
      box.append(button);
    }
    pending.append(box);
  }
  const view = $("transcript"),
    atBottom = view.scrollHeight - view.scrollTop - view.clientHeight < 90;
  const fingerprint = JSON.stringify(transcript.entries);
  if (view.dataset.content !== fingerprint) {
    view.dataset.content = fingerprint;
    const scroll = view.scrollTop;
    view.replaceChildren();
    if (!transcript.entries.length)
      view.append(
        el("p", "", "The conversation starts here. Send a message below."),
      );
    for (const entry of transcript.entries) {
      if (entry.kind === "tool") {
        const tool = el("details", "tool");
        tool.append(
          el("summary", "", entry.name),
          el(
            "pre",
            "",
            [entry.input, entry.output].filter(Boolean).join("\n\n"),
          ),
        );
        view.append(tool);
      } else {
        const turn = el(
          "article",
          `turn ${entry.kind === "user" ? "user" : "assistant"}`,
        );
        turn.append(
          el("div", "turn-label", entry.kind === "user" ? "You" : detail.name),
          el("div", "turn-text", entry.text),
        );
        view.append(turn);
      }
    }
    view.scrollTop = atBottom ? view.scrollHeight : scroll;
  }
}
$("message-form").onsubmit = async (event) => {
  event.preventDefault();
  const name = state.selected,
    text = $("message").value.trim();
  if (!name || !text) return;
  const button = event.submitter || $("message-form").querySelector("button");
  button.disabled = true;
  try {
    const sent = await api(
      "/api/agents/" + encodeURIComponent(name) + "/messages",
      { text, mode: $("message-mode").value },
    );
    state.drafts.delete(name);
    if (state.selected === name) {
      $("message").value = "";
      $("message-status").textContent = sent.id ? "Message accepted" : "Sent";
      await refreshDetail();
    }
  } catch (error) {
    notice(error.message);
  } finally {
    button.disabled = false;
  }
};
$("message").onkeydown = (event) => {
  if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
    event.preventDefault();
    $("message-form").requestSubmit();
  }
};
document.querySelectorAll("[data-action]").forEach(
  (button) =>
    (button.onclick = async () => {
      const name = state.selected,
        action = button.dataset.action;
      if (!name) return;
      if (
        action !== "resume" &&
        !confirm(
          `${action[0].toUpperCase() + action.slice(1)} ${name}? ${action === "delete" ? "Its session will stop and the agent will be removed. The worktree is kept." : action === "restart" ? "This interrupts its current turn and reopens the conversation." : "This interrupts its current work."}`,
        )
      )
        return;
      button.disabled = true;
      try {
        await api(
          "/api/agents/" +
            encodeURIComponent(name) +
            (action === "delete" ? "" : "/" + action),
          action === "delete" ? undefined : {},
          action === "delete" ? "DELETE" : "POST",
        );
        if (action === "delete") showOverview();
        await refresh();
      } catch (error) {
        notice(error.message);
      } finally {
        button.disabled = false;
      }
    }),
);
async function refresh() {
  if (!state.authenticated || state.refreshing) return;
  state.refreshing = true;
  try {
    const fleet = await api("/api/agents");
    if (!state.authenticated) return;
    state.rows = fleet.rows;
    renderFleet();
    $("connection").textContent = "● Connected · updated just now";
    if (fleet.unreachable.length)
      notice("Unreachable hosts: " + fleet.unreachable.join(", "));
    await refreshDetail();
  } catch (error) {
    $("connection").textContent = "○ Connection interrupted · retrying";
    notice(error.message);
  } finally {
    state.refreshing = false;
  }
}
async function loadModels() {
  const host = $("create-host").value,
    provider = $("create-provider").value;
  try {
    const data = await api(
      "/api/models" + (host ? "?host=" + encodeURIComponent(host) : ""),
    );
    if (
      host !== $("create-host").value ||
      provider !== $("create-provider").value
    )
      return;
    state.catalogs = Array.isArray(data) ? data : data.catalogs || [];
    const catalog = state.catalogs.find((c) => c.provider === provider);
    $("create-model").replaceChildren(new Option("Provider default", ""));
    for (const model of catalog?.models || [])
      $("create-model").add(new Option(model.label || model.id, model.id));
    loadEfforts();
  } catch (e) {
    $("create-error").textContent = e.message;
  }
}
function loadEfforts() {
  const catalog = state.catalogs.find(
    (c) => c.provider === $("create-provider").value,
  );
  const model = catalog?.models.find((m) => m.id === $("create-model").value);
  $("create-effort").replaceChildren(new Option("Default", ""));
  for (const effort of model?.efforts || catalog?.efforts || [])
    $("create-effort").add(new Option(effort, effort));
}
async function createDialog() {
  $("create-error").textContent = "";
  $("create-dialog").showModal();
  try {
    const [hosts, roles] = await Promise.all([
      api("/api/hosts"),
      api("/api/roles"),
    ]);
    $("create-host").replaceChildren(
      new Option(hosts.local + " (this server)", ""),
    );
    for (const host of hosts.hosts)
      $("create-host").add(
        new Option(
          host.name + (host.reachable ? "" : " · unreachable"),
          host.name,
        ),
      );
    $("create-role").replaceChildren(new Option("No preset", ""));
    for (const role of roles.roles.filter((r) => r.name !== "concierge"))
      $("create-role").add(new Option(role.name, role.name));
    await loadModels();
  } catch (e) {
    $("create-error").textContent = e.message;
  }
}
$("new-agent").onclick = createDialog;
$("side-new").onclick = createDialog;
$("close-create").onclick = () => $("create-dialog").close();
$("create-provider").onchange = loadModels;
$("create-host").onchange = loadModels;
$("create-model").onchange = loadEfforts;
$("create-form").onsubmit = async (event) => {
  event.preventDefault();
  const body = Object.fromEntries(new FormData(event.target));
  for (const field of Object.keys(body)) if (!body[field]) delete body[field];
  $("create-submit").disabled = true;
  $("create-error").textContent = "";
  try {
    const result = await api("/api/agents", body);
    $("create-dialog").close();
    event.target.reset();
    await selectAgent(
      result.host ? `${result.host}:${result.name}` : result.name,
    );
    await refresh();
  } catch (e) {
    $("create-error").textContent = e.message;
  } finally {
    $("create-submit").disabled = false;
  }
};
document.addEventListener("keydown", (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key === "k") {
    event.preventDefault();
    showOverview();
    $("search").focus();
  }
});
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) refresh();
});
setInterval(() => {
  if (!document.hidden) refresh();
}, 4000);
unlock().catch(() => {});
