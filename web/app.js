"use strict";
const $ = (id) => document.getElementById(id);
const { el, icon, chatTurn, collapsibleMessage, renderEntries, preserveConversationScroll } = window.agentTranscript;
const state = {
  rows: [],
  lastSeen: new Map(),
  lastRead: new Map(),
  readBoundary: null,
  selected: null,
  filter: "live",
  sort: "status",
  reverse: false,
  conciergeKey: null,
  dockBusy: false,
  subagent: null,
  authenticated: false,
  sessionEpoch: 0,
  refreshing: false,
  catalogs: [],
  detailVersion: 0,
  drafts: new Map(),
  draftRevisions: new Map(),
  sending: new Map(),
  attachments: new Map(), // agent key -> [{ label, preview, status, path, error }]
  dockRevision: 0,
  noticeSource: null,
  detailMode: "terminal",
  refreshPending: false,
};
const agentTerminal = createAgentTerminal({
  screen: $("terminal-screen"),
  status: $("terminal-status"),
  onUnauthorized: lock,
});
let eventStream = null, eventKey = null, eventRefreshTimer = null;
function stopEvents() {
  eventStream?.close();
  eventStream = eventKey = null;
  clearTimeout(eventRefreshTimer);
  eventRefreshTimer = null;
}
function scheduleRefresh() {
  if (!state.authenticated || document.hidden) return;
  if (eventRefreshTimer) return;
  eventRefreshTimer = setTimeout(() => {
    eventRefreshTimer = null;
    refresh();
  }, 100);
}
function connectEvents() {
  if (!state.authenticated) return;
  const params = new URLSearchParams();
  const agent = state.subagent?.parent || state.selected;
  if (agent) params.set("agent", agent);
  if (state.subagent) params.set("subagent", state.subagent.id);
  const next = params.toString();
  if (eventStream && eventKey === next) return;
  stopEvents();
  eventKey = next;
  eventStream = new EventSource("/api/web-events?" + next);
  eventStream.addEventListener("ready", scheduleRefresh);
  eventStream.addEventListener("changed", scheduleRefresh);
  eventStream.onerror = scheduleRefresh;
}
function updateAgentView() {
  const terminal = state.detailMode === "terminal";
  $("terminal-tab").setAttribute("aria-pressed", String(terminal));
  $("chat-tab").setAttribute("aria-pressed", String(!terminal));
  $("terminal-panel").hidden = !terminal;
  $("chat-panel").hidden = terminal;
  if (terminal && state.selected) {
    const row = state.rows.find((row) => key(row) === state.selected);
    agentTerminal.open(state.selected, row?.status);
    markDisplayedDetailSeen(false);
  } else agentTerminal.close();
}
// The Terminal/Chat choice is one global preference that persists across agents and reloads.
// A mode passed to selectAgent (a conversation search hit) applies to that visit only.
let preferredMode = "terminal";
try {
  const saved = localStorage.getItem("am.detailMode");
  if (saved === "terminal" || saved === "chat") preferredMode = saved;
} catch {}
function setDetailMode(mode) {
  state.detailMode = preferredMode = mode;
  try { localStorage.setItem("am.detailMode", mode); } catch {}
}
$("terminal-tab").onclick = () => { setDetailMode("terminal"); updateAgentView(); };
$("chat-tab").onclick = () => {
  if (state.detailMode === "chat") return;
  setDetailMode("chat");
  updateAgentView();
  // A hidden transcript can't scroll, so open the chat at its latest message.
  $("transcript").scrollTop = $("transcript").scrollHeight;
  updateLatestButton();
};
$("terminal-reconnect").onclick = () => agentTerminal.reconnect();
new MutationObserver(() => {
  $("terminal-reconnect").hidden = $("terminal-status").textContent.startsWith("●");
}).observe($("terminal-status"), { childList: true, characterData: true, subtree: true });
$("terminal-focus").onclick = () => agentTerminal.focus();
const terminalKeys = { escape: "\x1b", tab: "\t", interrupt: "\x03", up: "\x1b[A", down: "\x1b[B", enter: "\r" };
document.querySelectorAll("[data-terminal-key]").forEach(button => {
  button.onclick = () => { agentTerminal.input(terminalKeys[button.dataset.terminalKey]); agentTerminal.focus(); };
});
const sidebarDivider = $("sidebar-divider");
let sidebarWidth = null, sidebarPointer = null;
try {
  const saved = Number(localStorage.getItem("am.sidebarWidth"));
  if (Number.isFinite(saved) && saved >= 175 && saved <= 520) sidebarWidth = saved;
} catch {}
const maxSidebarWidth = () => Math.min(520, Math.max(175, innerWidth - 560));
function applySidebarWidth() {
  if (sidebarWidth === null) document.documentElement.style.removeProperty("--sidebar-width");
  else document.documentElement.style.setProperty("--sidebar-width", Math.min(maxSidebarWidth(), Math.max(175, sidebarWidth)) + "px");
  sidebarDivider.setAttribute("aria-valuemin", "175");
  sidebarDivider.setAttribute("aria-valuemax", String(maxSidebarWidth()));
  sidebarDivider.setAttribute("aria-valuenow", String(Math.round(document.querySelector(".sidebar").getBoundingClientRect().width)));
}
function saveSidebarWidth() {
  try {
    if (sidebarWidth === null) localStorage.removeItem("am.sidebarWidth");
    else localStorage.setItem("am.sidebarWidth", String(sidebarWidth));
  } catch {}
}
sidebarDivider.onpointerdown = event => {
  if (event.button !== 0 || innerWidth <= 700) return;
  event.preventDefault();
  sidebarPointer = event.pointerId;
  sidebarDivider.setPointerCapture(event.pointerId);
  document.body.classList.add("resizing-sidebar");
};
sidebarDivider.onpointermove = event => {
  if (sidebarPointer !== event.pointerId) return;
  sidebarWidth = Math.min(maxSidebarWidth(), Math.max(175, event.clientX));
  applySidebarWidth();
};
const endSidebarResize = event => {
  if (sidebarPointer !== event.pointerId) return;
  sidebarPointer = null;
  document.body.classList.remove("resizing-sidebar");
  saveSidebarWidth();
};
sidebarDivider.onpointerup = endSidebarResize;
sidebarDivider.onpointercancel = endSidebarResize;
sidebarDivider.onlostpointercapture = endSidebarResize;
sidebarDivider.ondblclick = () => { sidebarWidth = null; applySidebarWidth(); saveSidebarWidth(); };
sidebarDivider.onkeydown = event => {
  if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
  event.preventDefault();
  const current = document.querySelector(".sidebar").getBoundingClientRect().width;
  sidebarWidth = event.key === "Home" ? 175 : event.key === "End" ? maxSidebarWidth() :
    Math.min(maxSidebarWidth(), Math.max(175, current + (event.key === "ArrowRight" ? 1 : -1) * (event.shiftKey ? 50 : 10)));
  applySidebarWidth(); saveSidebarWidth();
};
window.addEventListener("resize", applySidebarWidth);
applySidebarWidth();
const key = (row) => (row.host ? `${row.host}:${row.name}` : row.name);
// Waiting means the agent is still busy on its own background tasks, not on you.
const attention = (row) => row.status === "needs-attention";
const dot = (status) => {
  const node = el(
    "i",
    `dot ${["working", "idle", "needs-attention", "waiting", "dead", "exited", "starting"].includes(status) ? status : ""}`,
  );
  node.setAttribute("aria-hidden", "true");
  // Re-renders replace the dot; phase the spin off a shared clock so it doesn't snap back.
  if (status === "working" || status === "waiting") node.style.animationDelay = `-${Math.round(performance.now() % 1600)}ms`;
  return node;
};
const statusName = (status) =>
  ({
    working: "Working",
    idle: "Idle",
    "needs-attention": "Needs attention",
    waiting: "Waiting on background tasks",
    dead: "Offline",
    exited: "Exited",
    starting: "Starting",
  })[status] || status;
function badge(status) {
  const node = el("span", "badge");
  node.append(dot(status), document.createTextNode(statusName(status)));
  return node;
}
function notice(text, source = "action") {
  state.noticeSource = text ? source : null;
  $("notice").textContent = text;
  $("notice").hidden = !text;
}
async function api(path, body, method) {
  const epoch = state.sessionEpoch;
  const response = await fetch(path, {
    method: method || (body === undefined ? "GET" : "POST"),
    credentials: "same-origin",
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json();
  if (
    response.status === 401 &&
    !path.startsWith("/auth/") &&
    epoch === state.sessionEpoch
  )
    lock();
  if (!response.ok)
    throw new Error(data.error || `Request failed (${response.status})`);
  return data;
}
function lock() {
  agentTerminal.close();
  closeAgentMenu();
  stopEvents();
  state.refreshPending = false;
  state.sessionEpoch++;
  state.authenticated = false;
  state.detailVersion++;
  state.rows = [];
  state.lastSeen.clear();
  state.lastRead.clear();
  $("command-dialog").close();
  clearConversationSearch();
  $("advanced-results").replaceChildren();
  $("advanced-search-form").reset();
  $("advanced-summary").textContent = "";
  state.selected = null;
  state.drafts.clear();
  state.draftRevisions.clear();
  state.sending.clear();
  state.attachments.clear();
  state.detailCapabilities = null;
  $("message-attachments").replaceChildren();
  $("message-attachments").hidden = true;
  pendingSent.clear();
  lastUserTexts.clear();
  state.dockRevision++;
  state.conciergeKey = null;
  renderDockIdentity();
  $("dock-status").textContent = "";
  state.subagent = null;
  $("subagent-dialog").close();
  $("create-dialog").close();
  $("handover-dialog").close();
  handoverSource = null;
  closeModelDialog();
  manageAgent = null;
  diffRequest = null;
  $("workspace-diff-dialog").close();
  $("manage-agent-dialog").close();
  state.related = null;
  $("related-agents").replaceChildren();
  $("subagent-output").replaceChildren();
  $("dock-transcript").replaceChildren();
  $("dock-message").value = "";
  delete $("dock-transcript").dataset.content;
  $("chat-working").hidden = $("dock-working").hidden = true;
  $("app").hidden = true;
  $("login").hidden = false;
  for (const id of [
    "agent-grid",
    "agent-nav",
    "transcript",
    "permissions",
    "queue",
    "room-details",
    "workspace-prs",
    "workspace-files",
    "detail-name",
    "detail-status",
    "detail-meta",
    "usage-quota",
    "usage-kpis",
    "usage-roles",
    "usage-agents",
    "usage-workflows",
    "usage-tools",
    "usage-anomalies",
  ])
    $(id)?.replaceChildren();
  if ($("usage-page")) $("usage-page").hidden = true;
  $("pane").textContent = "";
  $("workspace-count").textContent = "";
  $("workspace-summary").textContent = "";
  $("message").value = "";
}
async function unlock() {
  await api("/api/health");
  state.authenticated = true;
  $("login").hidden = true;
  $("app").hidden = false;
  showOverview();
  notice("");
  state.conciergeKey = (await api("/api/concierge")).key;
  connectEvents();
  await refresh();
  await refreshDock();
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
$("mobile-logout").onclick = () => $("logout").click();
function showOverview(filter = "live") {
  closeModelDialog();
  $("search-page").hidden = true;
  $("search-nav").classList.remove("active");
  if ($("usage-page")) $("usage-page").hidden = true;
  $("usage-nav")?.classList.remove("active");
  saveDraft();
  agentTerminal.close();
  state.selected = null;
  connectEvents();
  state.detailVersion++;
  state.filter = filter;
  $("detail").hidden = true;
  $("overview").hidden = false;
  document.querySelector(".page-heading").hidden = false;
  $("new-agent").hidden = false;
  $("page-title").textContent =
    filter === "attention" ? "Needs attention" : "Fleet monitor";
  $("page-title").classList.remove("agent-title");
  $("page-subtitle").textContent = "";
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
$("sidebar-search").oninput = renderFleet;
$("show-stopped-agents").onchange = renderFleet;
$("sort").onchange = () => {
  state.sort = $("sort").value;
  renderFleet();
};
$("sort-direction").onclick = () => {
  state.reverse = !state.reverse;
  $("sort-direction").textContent = state.reverse ? "↓" : "↑";
  renderFleet();
};
function repoPath(row) {
  return row.repoRoot || row.dir || "";
}
function repoName(row) {
  return repoPath(row).replace(/\/$/, "").split("/").pop() || "—";
}
function runtime(row) {
  if (row.status !== "working" && row.status !== "waiting") return -1;
  const start = Date.parse(row.statusChangedAt || "");
  return Number.isFinite(start) ? Math.max(0, Date.now() - start) : -1;
}
function elapsed(ms) {
  if (ms < 0) return "—";
  const minutes = Math.floor(ms / 60000);
  if (minutes < 1) return "<1m";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return hours < 24
    ? `${hours}h ${minutes % 60}m`
    : `${Math.floor(hours / 24)}d ${hours % 24}h`;
}
function compareRows(a, b) {
  const ranks = {
    "needs-attention": 0,
    working: 2,
    waiting: 2,
    idle: 3,
    exited: 4,
    dead: 5,
  };
  let order = 0;
  if (state.sort === "repo")
    order =
      repoName(a).localeCompare(repoName(b)) ||
      repoPath(a).localeCompare(repoPath(b));
  else if (state.sort === "runtime") order = runtime(b) - runtime(a);
  else if (state.sort === "recent")
    order = (Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0);
  else if (state.sort === "name") order = a.name.localeCompare(b.name);
  else order = (ranks[a.status] ?? 6) - (ranks[b.status] ?? 6);
  return (order || a.name.localeCompare(b.name)) * (state.reverse ? -1 : 1);
}
function renderFleet() {
  renderDockIdentity();
  if (!$("search-page").hidden) renderAdvancedSearch();
  const rows = state.rows.filter((row) => row.name !== "concierge");
  const stopped = (row) => ["exited", "dead"].includes(row.status);
  const matchesFilter = (row, filter) =>
    filter === "all" ||
    (filter === "live" ? !stopped(row) :
      filter === "attention" ? attention(row) :
        filter === "exited" ? stopped(row) : row.status === filter);
  document.querySelectorAll("[data-count]").forEach((count) => {
    count.textContent = rows.filter((row) => matchesFilter(row, count.dataset.count)).length;
  });
  $("attention-count").textContent = rows.filter(attention).length;
  $("attention-count").hidden = !rows.some(attention);
  const nav = $("agent-nav");
  nav.replaceChildren();
  const sidebarQuery = $("sidebar-search").value.trim().toLowerCase();
  const sidebarRank = { "needs-attention": 0, waiting: 1, working: 1, starting: 2, idle: 3 };
  const grouping = $("sidebar-group").value;
  let sidebarGroup = null;
  const groupName = row => grouping === "repo" ? repoName(row) : row.host || "This server";
  const sidebarRows = [...rows].sort((a, b) =>
    (grouping ? groupName(a).localeCompare(groupName(b)) : 0) ||
    (sidebarRank[a.status] ?? 4) - (sidebarRank[b.status] ?? 4) || a.name.localeCompare(b.name));
  for (const row of sidebarRows) {
    if (
      !$("show-stopped-agents").checked &&
      ["exited", "dead"].includes(row.status)
    )
      continue;
    if (!`${row.name} ${row.task || ""} ${row.host || ""} ${row.dir || ""}`
      .toLowerCase().includes(sidebarQuery)) continue;
    if (grouping && sidebarGroup !== groupName(row)) {
      sidebarGroup = groupName(row);
      nav.append(el("h3", "sidebar-group-title", sidebarGroup));
    }
    const button = el("button", "side-agent");
    const provider = row.provider === "codex" ? "Codex" : row.provider === "claude" ? "Claude" : row.provider === "antigravity" ? "Antigravity" : "Unknown";
    const label = el("span", "side-agent-provider", provider);
    label.dataset.provider = provider.toLowerCase();
    const time = runtime(row) >= 0 ? ` · ${elapsed(runtime(row))}` : "";
    button.title = `${row.name} · ${statusName(row.status)}${time} · ${provider}`;
    const heading = el("span", "side-agent-heading");
    heading.append(dot(row.status), el("span", "side-agent-name", row.name), label);
    const age = Date.parse(row.updatedAt || "");
    const reason = row.statusDetail || row.statusReason;
    button.setAttribute("aria-label", [row.name, statusName(row.status), reason, provider].filter(Boolean).join(", "));
    const meta = [statusName(row.status), reason, row.queued ? `${row.queued} queued` : "",
      Number.isFinite(age) ? `${elapsed(Math.max(0, Date.now() - age))} ago` : ""].filter(Boolean);
    const prs = row.prMonitor?.pullRequests || [];
    if (prs.length) meta.push(prs.map(pr => `PR #${pr.number} · ${pr.state.toLowerCase()}`).join(", "));
    const seen = state.lastSeen.get(key(row));
    if (seen && row.updatedAt > seen && state.selected !== key(row)) heading.append(el("span", "unread-badge", "New"));
    const metadata = el("span", "side-agent-meta", meta.join(" · "));
    metadata.title = meta.join(" · ");
    button.append(heading, metadata);
    button.classList.toggle("selected", key(row) === state.selected);
    if (key(row) === state.selected) button.setAttribute("aria-current", "page");
    button.dataset.agentKey = key(row);
    button.setAttribute("aria-haspopup", "menu");
    button.oncontextmenu = event => openAgentMenu(event, key(row), button);
    button.onkeydown = event => {
      if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) openAgentMenu(event, key(row), button);
    };
    button.onclick = () => selectAgent(key(row));
    nav.append(button);
  }
  if (!nav.childNodes.length)
    nav.append(el("p", "sidebar-empty", sidebarQuery ? "No matching agents." :
      $("show-stopped-agents").checked ? "No agents." : "No live agents."));
  const query = $("search").value.toLowerCase();
  const visible = rows.filter(
    (row) =>
      matchesFilter(row, state.filter) &&
      `${row.name} ${row.task || ""} ${row.host || ""} ${row.dir || ""}`
        .toLowerCase()
        .includes(query),
  );
  visible.sort(compareRows);
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
          : "No agents. Create one or ask the concierge.",
      ),
    );
  const grouped = state.sort === "status";
  let group = null;
  for (const row of visible) {
    if (grouped && statusGroup(row.status) !== group) {
      group = statusGroup(row.status);
      const header = el("div", "status-group");
      header.append(dot(row.status), document.createTextNode(group + " "),
        el("span", "", String(visible.filter((other) => statusGroup(other.status) === group).length)));
      grid.append(header);
    }
    const card = el("button", "agent-card");
    const identity = el("div", "agent-identity");
    identity.append(el("h3", "", row.name), el("p", "", row.task || "No task"));
    if (row.spawnedBy)
      identity.append(el("small", "parent-label", "↳ " + row.spawnedBy));
    const children = state.rows.filter(
      (child) => parentKey(child) === key(row),
    );
    if (children.length)
      identity.append(
        el(
          "small",
          "child-count",
          `${children.length} child agent${children.length === 1 ? "" : "s"}`,
        ),
      );
    identity.append(el("small", "mobile-agent-context", [repoName(row), row.host || "This server", row.provider, row.queued ? `${row.queued} queued` : ""].filter(Boolean).join(" · ")));
    const status = dot(row.status);
    status.title = statusName(row.status);
    const tag = el("span", "agent-tag", row.provider || "codex");
    const repo = el("span", "agent-repo", repoName(row));
    repo.title = [repoPath(row), row.host || "local", row.queued ? `${row.queued} queued` : ""].filter(Boolean).join(" · ");
    const duration = el("span", "agent-runtime", elapsed(runtime(row)));
    duration.title = "Elapsed time in the current working state";
    card.setAttribute("aria-label", `${row.name}, ${statusName(row.status)}, ${repoName(row)}`);
    card.append(status, identity, tag, repo, duration);
    card.onclick = () => selectAgent(key(row));
    grid.append(card);
    for (const sub of row.subagents?.running || []) {
      const child = el("button", "subagent-row");
      child.append(
        el("span"),
        el("span", "", "↳ " + (sub.description || sub.type) + " · built-in"),
        el("span"),
        el("span"),
        el("span"),
      );
      child.onclick = () =>
        openSubagent(key(row), sub.id, sub.description || sub.type);
      grid.append(child);
    }
  }
}
function statusGroup(status) {
  return attention({ status }) ? "Needs attention" : ["exited", "dead"].includes(status) ? "Stopped" : status === "waiting" ? statusName("working") : statusName(status);
}
function saveDraft() {
  if (state.selected) state.drafts.set(state.selected, $("message").value);
}
async function selectAgent(name, mode) {
  if (modelDialog && modelDialog.name !== name) closeModelDialog();
  $("search-page").hidden = true;
  if ($("usage-page")) $("usage-page").hidden = true;
  saveDraft();
  agentTerminal.close();
  state.selected = name;
  state.readBoundary = state.lastRead.get(name) ?? null;
  renderFleet();
  state.detailMode = mode || preferredMode;
  state.detailVersion++;
  $("workspace-pr-count").textContent = "";
  $("workspace-prs").replaceChildren(el("p", "workspace-note", "Loading pull requests…"));
  $("workspace-files").replaceChildren();
  $("workspace-count").textContent = "";
  $("workspace-summary").textContent = "Loading changes…";
  refreshWorkspace();
  $("overview").hidden = true;
  $("detail").hidden = false;
  updateAgentView();
  connectEvents();
  $("new-agent").hidden = true;
  $("detail-meta").textContent = "";
  $("detail-meta").classList.remove("expanded");
  updateDetailMetaToggle();
  $("page-title").textContent = name.endsWith("concierge") ? "Concierge" : name;
  $("detail-name").textContent = name.endsWith("concierge") ? "Concierge" : name;
  document.querySelector(".page-heading").hidden = true;
  $("page-title").classList.toggle("agent-title", !name.endsWith("concierge"));
  $("page-subtitle").textContent = name.endsWith("concierge") ? "" : "";
  $("breadcrumb").textContent = name;
  $("message").value = state.drafts.get(name) || "";
  $("message-status").textContent = "";
  renderAttachments();
  for (const field of ["content", "lastIndex", "agent", "detailVersion", "updatedAt"])
    delete $("transcript").dataset[field];
  $("transcript").replaceChildren(el("p", "", "Loading conversation…"));
  $("chat-working").hidden = true;
  $("permissions").replaceChildren();
  delete $("permissions").dataset.content;
  $("queue").replaceChildren();
  $("related-agents").replaceChildren();
  state.related = null;
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
function updateDetailMetaToggle() {
  const meta = $("detail-meta"), expanded = meta.classList.contains("expanded");
  $("detail-meta-toggle").hidden = !expanded && meta.scrollHeight <= meta.clientHeight + 1;
  $("detail-meta-toggle").textContent = expanded ? "Show less" : "Show full task";
  $("detail-meta-toggle").setAttribute("aria-expanded", String(expanded));
}
$("detail-meta-toggle").onclick = () => {
  $("detail-meta").classList.toggle("expanded");
  updateDetailMetaToggle();
};
window.addEventListener("resize", updateDetailMetaToggle);
const moreActions = document.querySelector(".more-actions");
moreActions.addEventListener("click", (event) => {
  if (event.target.closest(".more-menu button")) moreActions.open = false;
});
document.addEventListener("pointerdown", (event) => {
  if (moreActions.open && !moreActions.contains(event.target)) moreActions.open = false;
});
moreActions.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && moreActions.open) {
    moreActions.open = false;
    moreActions.querySelector("summary").focus();
  }
});
async function openConcierge(question) {
  try {
    notice("Opening the front desk…");
    const result = await api("/api/concierge", {});
    notice("");
    await selectAgent(result.key, question ? "chat" : undefined);
    if (question) {
      $("message").value = question;
      $("message").focus();
    }
  } catch (error) {
    notice(error.message);
  }
}
$("concierge-nav").onclick = () => openConcierge();
$("expand-concierge").onclick = () => openConcierge();
document
  .querySelectorAll("[data-ask]")
  .forEach((b) => (b.onclick = () => openConcierge(b.dataset.ask)));
function runtimeLabel(detail, field) {
  const value = detail.runtime?.[field] || detail[field];
  if (!value) return "Unknown";
  const source = detail.runtime?.[field + "Source"];
  return value + (source === "session" ? " (last turn)" : " (configured)");
}
let diffRequest = null;
$("close-workspace-diff").onclick = () => $("workspace-diff-dialog").close();
async function openWorkspaceDiff(name, path) {
  const request = diffRequest = { name, path, epoch: state.sessionEpoch };
  $("workspace-diff-title").textContent = path;
  $("workspace-diff-meta").textContent = name + " · Loading diff…";
  $("workspace-diff-output").replaceChildren();
  $("workspace-diff-dialog").showModal();
  try {
    const result = await api("/api/agents/" + encodeURIComponent(name) + "/diff?path=" + encodeURIComponent(path));
    if (diffRequest !== request || !state.authenticated || request.epoch !== state.sessionEpoch || !$("workspace-diff-dialog").open) return;
    if (typeof result.diff !== "string") throw new Error("Invalid diff response");
    const lines = result.diff.slice(0, 256 * 1024).split("\n", 2001);
    const truncated = result.truncated || result.diff.length > 256 * 1024 || lines.length > 2000;
    $("workspace-diff-meta").textContent = name + (result.binary ? " · Binary file" : " · Unified diff") + (truncated ? " · Preview truncated" : "");
    for (const line of lines.slice(0, 2000)) {
      const kind = line.startsWith("+++") || line.startsWith("---") || line.startsWith("diff ") ? "header" : line.startsWith("+") ? "added" : line.startsWith("-") ? "removed" : line.startsWith("@@") ? "hunk" : "context";
      $("workspace-diff-output").append(el("span", "diff-line " + kind, line || " "));
    }
    if (!result.diff) $("workspace-diff-meta").textContent = "No content difference. The change may be a file mode or staged-only change.";
  } catch (error) {
    if (diffRequest === request && request.epoch === state.sessionEpoch) $("workspace-diff-meta").textContent = error.message;
  }
}
let workspaceRequest = null;
async function refreshWorkspace() {
  const name = state.selected, version = state.detailVersion;
  if (!name || !state.authenticated) return;
  if (workspaceRequest?.name === name && workspaceRequest.version === version &&
      (workspaceRequest.pending || Date.now() - workspaceRequest.at < 15000)) return;
  const request = workspaceRequest = { name, version, at: Date.now(), pending: true };
  try {
    const workspace = await api("/api/agents/" + encodeURIComponent(name) + "/workspace");
    if (!state.authenticated || name !== state.selected || version !== state.detailVersion) return;
    const prs = $("workspace-prs");
    prs.replaceChildren();
    for (const pr of (Array.isArray(workspace.pullRequests) ? workspace.pullRequests.slice(0, 10) : [])) {
      // Remote hosts supply metadata; only allow canonical GitHub PR URLs.
      if (!/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/[1-9][0-9]*$/.test(pr.url)) continue;
      const link = el("a", "workspace-pr");
      link.href = pr.url;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      const label = pr.state === "MERGED" ? "Merged" : pr.state === "CLOSED" ? "Closed" : pr.isDraft ? "Draft" : "Open";
      link.append(el("span", "", `#${pr.number} · ${label} ↗`), el("strong", "", pr.title));
      prs.append(link);
    }
    $("workspace-pr-count").textContent = prs.childNodes.length ? `(${prs.childNodes.length})` : "";
    if (!prs.childNodes.length) prs.append(el("p", "workspace-note", workspace.pullRequestsError ||
      (!workspace.available ? "No Git workspace." : !workspace.repository ? "No GitHub origin configured." :
        !workspace.branch ? "Detached HEAD — no branch PR lookup." : "No pull requests for this branch.")));
    $("workspace-count").textContent = workspace.available ? `(${workspace.total})` : "";
    const scope = workspace.base === "HEAD" ? "Uncommitted changes" : `Changes vs ${workspace.base || "base"}`;
    $("workspace-summary").textContent = workspace.error || `${workspace.branch || "Detached HEAD"} · ${scope}`;
    const files = $("workspace-files");
    files.replaceChildren();
    for (const file of (Array.isArray(workspace.files) ? workspace.files.slice(0, 200) : [])) {
      const row = el("button", "workspace-file");
      row.type = "button";
      row.setAttribute("aria-label", "View diff for " + file.path);
      row.onclick = () => openWorkspaceDiff(name, file.path);
      const code = el("span", "workspace-file-status", file.status === "??" ? "U" : file.status);
      code.title = file.working ? "Uncommitted" : "Committed on this branch";
      const path = el("span", "workspace-file-path", file.path);
      path.title = file.path;
      row.append(code, path);
      if (file.additions !== null && file.deletions !== null) {
        const counts = el("span", "workspace-file-counts");
        counts.append(el("span", "added", `+${file.additions}`), el("span", "removed", `−${file.deletions}`));
        row.append(counts);
      }
      files.append(row);
    }
    if (workspace.available && !workspace.error && !workspace.total) files.append(el("p", "workspace-note", "No changed files."));
    if (workspace.total > (workspace.files || []).length) files.append(el("p", "workspace-note", `Showing ${workspace.files.length} of ${workspace.total} files.`));
  } catch (error) {
    if (state.authenticated && name === state.selected && version === state.detailVersion) {
      $("workspace-pr-count").textContent = "";
      $("workspace-prs").replaceChildren(el("p", "workspace-note", "Workspace unavailable."));
      $("workspace-summary").textContent = error.message;
    }
  } finally { request.pending = false; }
}

function duration(ms) {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours}h ${minutes % 60}m` : `${Math.floor(hours / 24)}d ${hours % 24}h`;
}
function workingLabel(status) {
  return { starting: "Starting", waiting: "Waiting on background tasks" }[status] || "Working";
}
function tickWorking(box) {
  const start = Number(box.dataset.since);
  box.querySelector(".working-text").textContent = workingLabel(box.dataset.status) +
    (Number.isFinite(start) && box.dataset.since !== "" ? " for " + duration(Math.max(0, Date.now() - start)) : "");
}
function showWorking(id, status, since) {
  const box = $(id), busy = ["working", "starting", "waiting"].includes(status);
  box.hidden = !busy;
  if (!busy) return;
  const start = Date.parse(since || "");
  box.dataset.status = status;
  box.dataset.since = Number.isFinite(start) ? String(start) : "";
  // The ticking text is hidden from screen readers; only a status change is announced.
  const announced = box.querySelector("[role=status]");
  if (announced.textContent !== workingLabel(status)) announced.textContent = workingLabel(status);
  tickWorking(box);
}
setInterval(() => {
  for (const box of document.querySelectorAll(".working-indicator:not([hidden])")) tickWorking(box);
}, 1000);
const transcriptQueue = el("div", "transcript-queue");
function updateLatestButton() {
  const view = $("transcript");
  $("jump-latest").hidden = view.scrollHeight - view.scrollTop - view.clientHeight < 100;
  if ($("jump-latest").hidden && state.selected && state.detailMode === "chat") {
    markDisplayedDetailSeen(true);
  }
}
$("transcript").addEventListener("scroll", updateLatestButton);
$("jump-latest").onclick = () => { $("transcript").scrollTop = $("transcript").scrollHeight; updateLatestButton(); };
$("sidebar-group").onchange = renderFleet;

// A message sent mid-turn is held by the agent's TUI until it reads it, so keep
// showing it until a user turn logged after the send matches it.
const pendingSent = new Map(), lastUserTexts = new Map();
const normalizeMessage = (text) =>
  String(text || "").replace(/<\/?pasted_content id="[^"]*">/g, "").replace(/\s+/g, " ").trim();
function notePending(name, text, id) {
  const list = pendingSent.get(name) || [];
  // Before the first transcript load the baseline is unknown; any matching turn then counts.
  list.push({ text: normalizeMessage(text), shown: text, id, at: Date.now(), baseline: lastUserTexts.get(name)?.length ?? 0 });
  pendingSent.set(name, list);
}
function pendingFor(name, entries) {
  const users = entries.filter((entry) => entry.kind === "user").map((entry) => normalizeMessage(entry.text));
  lastUserTexts.set(name, users);
  const claimed = new Set();
  const list = (pendingSent.get(name) || []).filter((pending) => {
    if (Date.now() - pending.at >= 30 * 60000) return false;
    if (users.length && users.length < pending.baseline) pending.baseline = 0; // new session
    const index = users.findIndex((text, i) => i >= pending.baseline && !claimed.has(i) &&
      (text === pending.text || text.startsWith(pending.text)));
    if (index < 0) return true;
    claimed.add(index);
    return false;
  });
  pendingSent.set(name, list);
  return list;
}
function queuedMessageKey(scope, id, text) {
  if (id) return `${scope}:${id}`;
  let hash = 2166136261;
  for (const character of String(text || "")) {
    hash ^= character.codePointAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return `${scope}:text-${(hash >>> 0).toString(36)}`;
}
function pendingBubble(text, label, scrollKey, cancel) {
  const turn = chatTurn({ kind: "user", text, index: scrollKey }, "Agent");
  turn.className += " queued";
  const meta = el("div", "queued-meta", label);
  if (cancel) {
    const button = el("button", "text-button", "Cancel");
    button.onclick = cancel;
    meta.append(button);
  }
  turn.append(meta);
  return turn;
}
function queueAsideItem(item, cancel) {
  const text = item.text || item.message || "Queued message";
  const disclosure = collapsibleMessage({ kind: "user", text });
  const line = el("div", "queue-item");
  if (disclosure?.peer) {
    line.append(el("span", "queue-sender", disclosure.peer));
    if (disclosure.body) line.append(el("span", "queue-body", disclosure.body));
  } else if (disclosure) {
    line.append(el("span", "queue-sender", disclosure.label));
    if (disclosure.result) line.append(el("span", "queue-body", disclosure.result));
  } else {
    line.append(el("span", "queue-body", text));
  }
  if (cancel) {
    const button = el("button", "", "Cancel");
    button.onclick = cancel;
    line.append(button);
  }
  return line;
}
function markDetailSeen(name, updatedAt, chatAtLatest) {
  if (!updatedAt || (state.detailMode !== "terminal" && !chatAtLatest)) return;
  const previous = state.lastSeen.get(name);
  if (!previous || updatedAt > previous) state.lastSeen.set(name, updatedAt);
}
function markDisplayedDetailSeen(chatAtLatest) {
  const snapshot = $("transcript").dataset;
  if (snapshot.agent !== state.selected || snapshot.detailVersion !== String(state.detailVersion)) return;
  if (chatAtLatest && state.detailMode === "chat") {
    const index = Number(snapshot.lastIndex);
    if (Number.isFinite(index)) state.lastRead.set(state.selected, index);
  }
  markDetailSeen(snapshot.agent, snapshot.updatedAt, chatAtLatest);
}
async function refreshDetail() {
  const name = state.selected,
    version = state.detailVersion;
  if (!name) return;
  const base = "/api/agents/" + encodeURIComponent(name);
  const detail = await api(base);
  const [transcript, permissions, subagents, tokenUsage] = await Promise.all([
    api(base + "/transcript"),
    capabilityAvailable(detail, "approvalRelay") ? api(base + "/permissions") : { requests: [] },
    capabilityAvailable(detail, "subagents") ? api(base + "/subagents").catch((error) => ({ records: [], error: error.message })) : { records: [] },
    !name.includes(":") ? api(base + "/usage").catch(() => null) : null,
  ]);
  if (
    name !== state.selected ||
    version !== state.detailVersion ||
    !state.authenticated
  )
    return;
  state.detailCapabilities = { name, detail };
  const view = $("transcript"), restoreScroll = preserveConversationScroll(view, 90);
  $("detail-status").replaceWith(
    Object.assign(badge(detail.status), { id: "detail-status" }),
  );
  if (state.detailMode === "terminal") agentTerminal.open(name, detail.status);
  updateAgentActions(detail, document.querySelector(".actions"), name);
  $("change-model-agent").hidden = !actionAvailable(detail, "model");
  $("change-model-agent").disabled = pendingActions.has(name);
  $("handover-agent").hidden = !actionAvailable(detail, "handover");
  moreActions.hidden = [...moreActions.querySelectorAll(".more-menu button")].every((button) => button.hidden);
  $("detail-meta").textContent = detail.statusReason || detail.task || "";
  updateDetailMetaToggle();
  const room = $("room-details");
  room.replaceChildren();
  for (const [title, value] of [
    ["Provider", detail.provider],
    ["Model", runtimeLabel(detail, "model")],
    ["Reasoning", runtimeLabel(detail, "effort")],
    ["Role", detail.role?.name || detail.role],
    ["Directory", detail.dir],
    ["Branch", detail.worktreeBranch],
  ]) {
    if (!value || value === "Unknown") continue;
    const dd = el("dd");
    String(value).split("/").forEach((part, index) => {
      if (index) dd.append("/", el("wbr"));
      dd.append(part);
    });
    room.append(el("dt", "", title), dd);
  }
  if (tokenUsage?.combined?.totalTokens > 0) {
    const subShare = tokenUsage.combined.budgetTokens > 0
      ? Math.round((tokenUsage.subagentTotals.budgetTokens / tokenUsage.combined.budgetTokens) * 100)
      : 0;
    const dd = el("dd", "room-tokens");
    dd.append(
      el("span", "", `${formatCompactTokens(tokenUsage.combined.activeTokens)} active · ${formatCompactTokens(tokenUsage.combined.cacheReadTokens)} cache` + (tokenUsage.subagents?.length ? ` · ${subShare}% subagents` : "")),
    );
    const link = el("button", "text-button room-tokens-link", "Breakdown →");
    link.type = "button";
    link.onclick = () => showUsage(detail.name);
    dd.append(link);
    room.append(el("dt", "", "Token usage"), dd);
  }
  window.agentLinks.render($("pane"), detail.pane || "No active terminal.");
  const effectiveSubagents =
    (!subagents.records || subagents.records.length === 0) && tokenUsage?.subagents?.length
      ? {
          records: tokenUsage.subagents.map((s) => ({
            id: s.id,
            type: s.type,
            description: s.label,
            startedAt: s.startedAt,
            endedAt: s.endedAt,
            stale: s.status === "stale",
            tokens: s.tokens,
          })),
        }
      : subagents;
  renderRelated(name, effectiveSubagents);

  const cancelQueued = (item) => async () => {
    try {
      await api(base + "/messages/" + encodeURIComponent(item.msgId), undefined, "DELETE");
      await refreshDetail();
    } catch (e) {
      notice(e.message);
    }
  };
  const queue = $("queue");
  queue.replaceChildren();
  if (!detail.queue?.length) queue.append(el("p", "", "Nothing waiting."));
  for (const item of detail.queue || []) {
    queue.append(queueAsideItem(item, item.msgId ? cancelQueued(item) : null));
  }
  const pending = $("permissions");
  window.agentPrompts.renderPromptCards(pending, {
    key: base, detail, permissions,
    answerPrompt: (prompt, optionId, text) => api(base + "/prompt", { id: prompt.id, optionId, ...(text !== undefined ? { text } : {}) }),
    answerPermission: (request, optionId) => api(base + "/permissions/" + encodeURIComponent(request.id), { optionId }),
    refresh: refreshDetail,
    retryLater: scheduleRefresh,
    openTerminal: () => { setDetailMode("terminal"); updateAgentView(); },
    onError: notice,
  });
  showWorking("chat-working", detail.status, detail.statusChangedAt);
  const fingerprint = JSON.stringify(transcript.entries),
    rerender = view.dataset.content !== fingerprint;
  if (rerender) {
    view.dataset.content = fingerprint;
    view.replaceChildren();
    if (!transcript.entries.length)
      view.append(
        el("p", "", "The conversation starts here. Send a message below."),
      );
    renderEntries(view, transcript.entries, { agentName: detail.name, readBoundary: state.readBoundary });
  }
  // Queued messages are not in the transcript until delivered, so show them at the end of the chat.
  transcriptQueue.replaceChildren();
  const queuedIds = new Set((detail.queue || []).map((item) => item.msgId).filter(Boolean));
  for (const pending of pendingFor(name, transcript.entries))
    if (!queuedIds.has(pending.id)) transcriptQueue.append(pendingBubble(
      pending.shown,
      "Sent · waiting for the agent to read it",
      queuedMessageKey("pending", pending.id || pending.at, pending.shown),
    ));
  for (const item of detail.queue || []) {
    const text = item.text || item.message || "Queued message";
    transcriptQueue.append(pendingBubble(
      text,
      "Queued · sends when the agent is free",
      queuedMessageKey("queue", item.msgId, text),
      item.msgId ? cancelQueued(item) : null,
    ));
  }
  if (view.lastChild !== transcriptQueue) view.append(transcriptQueue);
  restoreScroll(rerender || transcriptQueue.dataset.shown !== String(transcriptQueue.childElementCount));
  transcriptQueue.dataset.shown = String(transcriptQueue.childElementCount);
  const lastEntry = transcript.entries.at(-1);
  if (lastEntry) view.dataset.lastIndex = lastEntry.index;
  else delete view.dataset.lastIndex;
  view.dataset.agent = name;
  view.dataset.detailVersion = String(version);
  view.dataset.updatedAt = detail.updatedAt || "";
  updateLatestButton();
  markDisplayedDetailSeen(false);
  const mode = messageSendMode(name);
  $("message-mode").textContent = mode === "now" ? "Send to agent · read at its next input boundary" : "Queue · delivered when the agent is free";

}
function messageSendMode(name) {
  const row = state.rows.find((row) => key(row) === name);
  const detail = state.detailCapabilities?.name === name ? state.detailCapabilities.detail : null;
  if (row?.provider === "antigravity" || detail?.provider === "antigravity") return "queue";
  const provider = detail?.provider || row?.provider;
  return provider === "claude" || provider === "codex" ? "now" : "queue";
}
const pointerSubmitButtons = new WeakSet();
function trackPointerSubmit(button) {
  button.addEventListener("click", (event) => {
    if (event.detail > 0) pointerSubmitButtons.add(button);
    else pointerSubmitButtons.delete(button);
  });
}
function takePointerSubmit(button) {
  const tracked = pointerSubmitButtons.has(button);
  pointerSubmitButtons.delete(button);
  return tracked;
}
function restoreComposerFocus(restore, composer, button, current) {
  if (!restore || !current || document.querySelector("dialog[open]")) return;
  const active = document.activeElement;
  if (active === composer) return;
  if (active === document.body || active === button) composer.focus({ preventScroll: true });
}
const messageSubmitButton = $("message-send");
trackPointerSubmit(messageSubmitButton);
$("message").oninput = () => {
  if (state.selected)
    state.draftRevisions.set(
      state.selected,
      (state.draftRevisions.get(state.selected) || 0) + 1,
    );
};
$("message-form").onsubmit = async (event) => {
  event.preventDefault();
  const name = state.selected;
  if (!name || state.sending.has(name) || uploadsPending(name) || !state.authenticated) return;
  const restoreFocus = takePointerSubmit(messageSubmitButton);
  const images = agentAttachments(name).filter((item) => item.status === "ready");
  const text = [$("message").value.trim(), ...images.map((item) => `[image: ${item.path}]`)]
    .filter(Boolean)
    .join("\n");
  if (!text) return;
  const epoch = state.sessionEpoch;
  const revision = state.draftRevisions.get(name) || 0;
  const request = Symbol();
  state.sending.set(name, request);
  restoreComposerFocus(restoreFocus, $("message"), messageSubmitButton, true);
  messageSubmitButton.disabled = true;
  try {
    const sent = await api(
      "/api/agents/" + encodeURIComponent(name) + "/messages",
      { text, mode: messageSendMode(name) },
    );
    if (!state.authenticated || epoch !== state.sessionEpoch) return;
    notePending(name, text, sent.id);
    if (images.length) state.attachments.set(name, agentAttachments(name).filter((item) => !images.includes(item)));
    const unchanged = (state.draftRevisions.get(name) || 0) === revision;
    if (unchanged) state.drafts.delete(name);
    if (state.selected === name) {
      if (unchanged) $("message").value = "";
      $("message-status").textContent = sent.id ? "Message accepted" : "Sent";
      await refreshDetail();
    }
  } catch (error) {
    notice(error.message);
  } finally {
    if (state.sending.get(name) === request) state.sending.delete(name);
    if (state.selected === name) renderAttachments();
  }
};

const IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];
const IMAGE_MAX_BYTES = 10 * 1024 * 1024;
function agentAttachments(name) {
  return state.attachments.get(name) || [];
}
function uploadsPending(name) {
  return agentAttachments(name).some((item) => item.status === "uploading");
}
function renderAttachments() {
  const name = state.selected;
  const list = name ? agentAttachments(name) : [];
  const strip = $("message-attachments");
  strip.hidden = !list.length;
  strip.replaceChildren(
    ...list.map((item) => {
      const chip = el("div", "attachment " + item.status);
      const thumb = el(item.preview ? "img" : "span", "attachment-thumb");
      if (item.preview) {
        thumb.alt = "";
        thumb.src = item.preview;
      }
      const label = el(
        "span",
        "attachment-label",
        item.status === "uploading" ? "Uploading…" : item.status === "error" ? item.error : item.label,
      );
      chip.title = item.status === "ready" ? item.path : item.status === "error" ? item.error : item.label;
      const remove = el("button", "attachment-remove", "×");
      remove.type = "button";
      remove.setAttribute("aria-label", "Remove " + item.label);
      remove.onclick = () => {
        state.attachments.set(name, agentAttachments(name).filter((other) => other !== item));
        renderAttachments();
        $("message").focus();
      };
      if (item.status === "error") chip.append(label, remove);
      else chip.append(thumb, label, remove);
      return chip;
    }),
  );
  $("message").required = !list.some((item) => item.status === "ready");
  $("message-send").disabled = !!name && (state.sending.has(name) || uploadsPending(name));
}
function attachImages(files) {
  const name = state.selected;
  if (!name || !state.authenticated) return;
  const detail = state.detailCapabilities?.name === name ? state.detailCapabilities.detail : state.rows.find(row => key(row) === name);
  if (!capabilityAvailable(detail, "attachments")) { notice("Image attachments are unavailable for this provider."); return; }
  const epoch = state.sessionEpoch;
  for (const file of files) {
    const item = { label: file.name || "Pasted image", preview: "", status: "uploading" };
    if (!IMAGE_TYPES.includes(file.type)) Object.assign(item, { status: "error", error: "Use PNG, JPEG, GIF or WebP" });
    else if (file.size > IMAGE_MAX_BYTES) Object.assign(item, { status: "error", error: "Larger than 10 MB" });
    state.attachments.set(name, [...agentAttachments(name), item]);
    if (item.status !== "uploading") continue;
    const reader = new FileReader();
    reader.onload = () => {
      item.preview = reader.result;
      if (state.selected === name) renderAttachments();
    };
    reader.readAsDataURL(file);
    uploadAttachment(name, file, item, epoch);
  }
  renderAttachments();
}
async function uploadAttachment(name, file, item, epoch) {
  try {
    const response = await fetch("/api/agents/" + encodeURIComponent(name) + "/files", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": file.type },
      body: file,
    });
    const data = await response.json().catch(() => ({}));
    if (epoch !== state.sessionEpoch) return;
    if (response.status === 401) return lock();
    if (!response.ok || typeof data.path !== "string")
      throw new Error(data.error || `Upload failed (${response.status})`);
    Object.assign(item, { status: "ready", path: data.path });
  } catch (error) {
    if (epoch !== state.sessionEpoch) return;
    Object.assign(item, { status: "error", error: error.message });
  }
  if (state.selected === name) renderAttachments();
}
const droppedImages = (data) => [...(data?.files || [])].filter((file) => file.type.startsWith("image/"));
$("message").addEventListener("paste", (event) => {
  const files = droppedImages(event.clipboardData);
  if (!files.length) return;
  // Some apps copy text alongside the image; let that paste through.
  if (!event.clipboardData.getData("text/plain")) event.preventDefault();
  attachImages(files);
});
$("message-form").addEventListener("dragover", (event) => {
  if (!event.dataTransfer?.types.includes("Files")) return;
  event.preventDefault();
  $("message-form").classList.add("dragging");
});
$("message-form").addEventListener("dragleave", (event) => {
  if (!$("message-form").contains(event.relatedTarget)) $("message-form").classList.remove("dragging");
});
$("message-form").addEventListener("drop", (event) => {
  $("message-form").classList.remove("dragging");
  const files = droppedImages(event.dataTransfer);
  if (!files.length) return;
  event.preventDefault();
  attachImages(files);
});
$("message").onkeydown = (event) => {
  if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
    event.preventDefault();
    $("message-form").requestSubmit();
  }
};
let contextAgent = null;
function closeAgentMenu(restoreFocus = false) {
  const target = contextAgent;
  $("agent-context-menu").hidden = true;
  contextAgent = null;
  if (restoreFocus && target) [...document.querySelectorAll(".side-agent")].find(button => button.dataset.agentKey === target)?.focus();
}
function openAgentMenu(event, name, button) {
  event.preventDefault();
  if (!state.authenticated) return;
  contextAgent = name;
  const menu = $("agent-context-menu"), rect = button.getBoundingClientRect();
  updateAgentActions(state.rows.find(row => key(row) === name), menu);
  menu.hidden = false;
  const x = event.clientX || rect.left, y = event.clientY || rect.bottom;
  menu.style.left = Math.max(8, Math.min(x, innerWidth - menu.offsetWidth - 8)) + "px";
  menu.style.top = Math.max(8, Math.min(y, innerHeight - menu.offsetHeight - 8)) + "px";
  menu.querySelector('[data-agent-menu="handover"]').disabled = handoverPending;
  menu.querySelector("button").focus();
}
$("agent-context-menu").onclick = event => {
  const button = event.target.closest("[data-agent-menu]");
  if (!button || button.disabled || !contextAgent) return;
  const name = contextAgent, action = button.dataset.agentMenu;
  closeAgentMenu(true);
  if (!state.authenticated) return;
  if (action === "handover") openHandover(name);
  else if (["rename", "move"].includes(action)) openManageAgent(name, action);
  else if (["resume", "restart", "interrupt", "stop", "delete"].includes(action)) runAgentAction(name, action);
  else {
    if (action !== "open") setDetailMode(action);
    selectAgent(name);
  }
};
$("agent-context-menu").onkeydown = event => {
  if (event.key === "Escape" || event.key === "Tab") {
    event.preventDefault(); closeAgentMenu(true); return;
  }
  if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
  event.preventDefault();
  const buttons = [...$("agent-context-menu").querySelectorAll("button:not(:disabled):not([hidden])")];
  const index = buttons.indexOf(document.activeElement);
  const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : (index + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length;
  buttons[next]?.focus();
};
document.addEventListener("pointerdown", event => { if (!$("agent-context-menu").contains(event.target)) closeAgentMenu(); });
document.addEventListener("scroll", () => closeAgentMenu(), true);
window.addEventListener("resize", () => closeAgentMenu());

let handoverSource = null, handoverPending = false;
function openHandover(name) {
  if (!name || handoverPending || !state.authenticated) return;
  const sourceRow = state.rows.find(row => key(row) === name);
  if (sourceRow?.provider === "antigravity") { notice("Antigravity handoff is unsupported."); return; }
  handoverSource = name;
  const row = state.rows.find(row => key(row) === handoverSource);
  $("handover-form").reset();
  $("handover-source").textContent = "From: " + handoverSource;
  $("handover-provider").value = row?.provider === "codex" ? "claude" : "codex";
  $("handover-error").textContent = "";
  $("handover-dialog").showModal();
}
$("handover-agent").onclick = () => openHandover(state.selected);
$("close-handover").onclick = () => $("handover-dialog").close();
$("handover-form").onsubmit = async event => {
  event.preventDefault();
  if (!handoverSource || handoverPending || !state.authenticated) return;
  const source = handoverSource, epoch = state.sessionEpoch, version = state.detailVersion, selection = state.selected;
  const body = { to: $("handover-provider").value, full: $("handover-full").checked };
  const name = $("handover-name").value.trim();
  if (name) body.newName = name;
  handoverPending = true;
  $("handover-submit").disabled = true;
  $("handover-agent").disabled = true;
  $("handover-submit").textContent = "Creating agent…";
  $("handover-error").textContent = "";
  try {
    const result = await api("/api/agents/" + encodeURIComponent(source) + "/handoff", body);
    if (!state.authenticated || epoch !== state.sessionEpoch) return;
    $("handover-dialog").close();
    await refresh();
    if (state.selected === selection && version === state.detailVersion) await selectAgent(result.key);
    else notice(`Handover created: ${result.key}`);
  } catch (error) {
    if (state.authenticated && epoch === state.sessionEpoch) {
      const message = error.message + " Check the agent list before retrying if the request was interrupted.";
      if ($("handover-dialog").open) $("handover-error").textContent = message;
      else notice(message);
    }
  } finally {
    handoverPending = false;
    $("handover-submit").disabled = false;
    $("handover-agent").disabled = false;
    $("handover-submit").textContent = "Create handover agent";
  }
};

const pendingActions = new Set();
function capabilityAvailable(row, capability) {
  if (row?.capabilities?.[capability] === false) return false;
  return row?.provider !== "antigravity" || !["remoteControl", "quota", "approvalRelay", "interruptByReceipt", "handoff", "move", "rename", "subagents", "attachments"].includes(capability);
}
function actionAvailable(row, action) {
  if (!row) return false;
  const capability = { handover: "handoff", interrupt: "interruptByReceipt", model: "restart" }[action] || action;
  if (!capabilityAvailable(row, capability)) return false;
  const stopped = ["dead", "exited"].includes(row.status);
  if (action === "resume") return stopped;
  if (["stop", "restart", "model", "terminal"].includes(action)) return !stopped;
  if (action === "interrupt") return ["working", "waiting", "needs-attention"].includes(row.status);
  if (action === "rename") return row.name !== "concierge";
  if (action === "handover") return row.provider !== "antigravity" && row.capabilities?.handoff !== false && (row.role?.name || row.role) !== "concierge" && row.name !== "concierge";
  return true;
}
function updateAgentActions(row, container = document.querySelector(".actions"), agentKey = row ? key(row) : null) {
  for (const button of container.querySelectorAll("[data-action], [data-agent-menu]")) {
    const action = button.dataset.action || button.dataset.agentMenu;
    button.hidden = !actionAvailable(row, action);
    button.disabled = !!agentKey && pendingActions.has(agentKey);
  }
}
async function runAgentAction(name, action) {
  if (!state.authenticated || pendingActions.has(name)) return;
  const row = state.rows.find(row => key(row) === name);
  if (!actionAvailable(row, action)) { notice("Agent status changed. Refresh and try again."); return; }
  const label = action === "delete" ? "Remove" : action[0].toUpperCase() + action.slice(1);
  if (action !== "resume" && !confirm(`${label} ${name}? ${action === "delete" ? "Its session will stop and the agent will be removed. The worktree is kept." : action === "restart" ? "This interrupts its current turn and reopens the conversation." : "This interrupts its current work."}`)) return;
  const epoch = state.sessionEpoch;
  pendingActions.add(name);
  if (state.selected === name) updateAgentActions(row);
  try {
    await api("/api/agents/" + encodeURIComponent(name) + (action === "delete" ? "" : "/" + action), action === "delete" ? undefined : {}, action === "delete" ? "DELETE" : "POST");
    if (!state.authenticated || epoch !== state.sessionEpoch) return;
    if (action === "delete" && state.selected === name) showOverview();
    await refresh();
  } catch (error) { if (epoch === state.sessionEpoch) notice(error.message); }
  finally {
    pendingActions.delete(name);
    if (state.selected === name) updateAgentActions(state.rows.find(row => key(row) === name));
  }
}
document.querySelectorAll("[data-action]").forEach(button => { button.onclick = () => runAgentAction(state.selected, button.dataset.action); });

let modelDialog = null;
function modelChoices(catalog, current) {
  const choices = [{ value: "", label: "Provider default" }];
  for (const model of catalog?.models || []) choices.push({ value: model.id, label: model.label || model.id });
  if (current && !choices.some(choice => choice.value === current) && catalog?.modelsExhaustive === false)
    choices.push({ value: current, label: current + " (configured)" });
  return choices;
}
function effortChoices(catalog, modelId, current) {
  const model = catalog?.models?.find(model => model.id === modelId);
  const efforts = model?.efforts?.length ? model.efforts : catalog?.efforts || [];
  const choices = [{ value: "", label: "Provider default" }, ...efforts.map(value => ({ value, label: value }))];
  if (current && !choices.some(choice => choice.value === current) && catalog?.effortsExhaustive === false)
    choices.push({ value: current, label: current + " (configured)" });
  return choices;
}
function replaceOptions(select, choices, selected) {
  select.replaceChildren(...choices.map(choice => new Option(choice.label, choice.value)));
  select.value = choices.some(choice => choice.value === selected) ? selected : "";
}
function loadModelDialogEfforts(context, selected = $("model-effort").value) {
  if (modelDialog !== context) return;
  replaceOptions($("model-effort"), effortChoices(context.catalog, $("model-select").value, selected), selected);
}
function closeModelDialog() {
  modelDialog = null;
  if ($("model-dialog").open) $("model-dialog").close();
}
$("close-model-dialog").onclick = closeModelDialog;
$("model-dialog").onclose = () => { modelDialog = null; };
async function openModelDialog(name) {
  if (!name || !state.authenticated || pendingActions.has(name)) return;
  const detail = state.detailCapabilities?.name === name ? state.detailCapabilities.detail : null;
  if (!detail?.provider) { notice("Agent details are still loading. Try again shortly."); return; }
  const context = {
    name, provider: detail.provider, epoch: state.sessionEpoch,
    model: detail.model ?? null, effort: detail.effort ?? null,
    createdAt: detail.createdAt, status: detail.status,
    catalog: null, pending: false,
  };
  modelDialog = context;
  $("model-form").reset();
  $("model-agent-name").textContent = name + " · " + detail.provider;
  $("model-error").textContent = "";
  $("model-submit").textContent = "Restart with model";
  replaceOptions($("model-select"), [{ value: "", label: "Loading models…" }], "");
  replaceOptions($("model-effort"), [{ value: "", label: "Loading efforts…" }], "");
  $("model-select").disabled = $("model-effort").disabled = $("model-submit").disabled = true;
  $("model-dialog").showModal();
  const host = name.includes(":") ? name.split(":", 1)[0] : "";
  try {
    const catalogs = await api("/api/models" + (host ? "?host=" + encodeURIComponent(host) : ""));
    if (modelDialog !== context || !state.authenticated || context.epoch !== state.sessionEpoch || state.selected !== name || !$("model-dialog").open) return;
    context.catalog = (Array.isArray(catalogs) ? catalogs : catalogs.catalogs || []).find(catalog => catalog.provider === context.provider);
    if (!context.catalog) throw new Error(`No ${context.provider} model catalog is available on ${host || "this server"}.`);
    replaceOptions($("model-select"), modelChoices(context.catalog, context.model), context.model || "");
    loadModelDialogEfforts(context, context.effort || "");
    $("model-select").disabled = $("model-effort").disabled = $("model-submit").disabled = false;
  } catch (error) {
    if (modelDialog === context && context.epoch === state.sessionEpoch && $("model-dialog").open)
      $("model-error").textContent = "Models could not be loaded: " + error.message;
  }
}
$("change-model-agent").onclick = () => openModelDialog(state.selected);
$("model-select").onchange = () => {
  $("model-error").textContent = "";
  if (modelDialog) loadModelDialogEfforts(modelDialog);
};
$("model-effort").onchange = () => { $("model-error").textContent = ""; };
$("model-form").onsubmit = async event => {
  event.preventDefault();
  const context = modelDialog;
  if (!context?.catalog || context.pending || !state.authenticated || context.epoch !== state.sessionEpoch) return;
  context.pending = true;
  pendingActions.add(context.name);
  $("model-submit").disabled = true;
  $("model-submit").textContent = "Restarting…";
  $("model-error").textContent = "";
  try {
    await api("/api/agents/" + encodeURIComponent(context.name) + "/model", {
      model: $("model-select").value || null,
      effort: $("model-effort").value || null,
      createdAt: context.createdAt,
      status: context.status,
    });
    if (modelDialog !== context || !state.authenticated || context.epoch !== state.sessionEpoch) return;
    closeModelDialog();
    await refresh();
  } catch (error) {
    if (modelDialog === context && context.epoch === state.sessionEpoch)
      $("model-error").textContent = error.message + " Refresh and check the agent's configured model before retrying.";
  } finally {
    pendingActions.delete(context.name);
    context.pending = false;
    if (modelDialog === context) {
      $("model-submit").disabled = !context.catalog;
      $("model-submit").textContent = "Restart with model";
    }
  }
};
let manageAgent = null;
$("close-manage-agent").onclick = () => $("manage-agent-dialog").close();
async function openManageAgent(name, action) {
  if (!state.authenticated || pendingActions.has(name)) return;
  const context = { name, action, epoch: state.sessionEpoch };
  manageAgent = context;
  $("manage-agent-title").textContent = action === "rename" ? "Rename agent" : "Move agent";
  $("manage-agent-source").textContent = name;
  $("manage-agent-error").textContent = "";
  $("rename-agent-field").hidden = action !== "rename";
  $("rename-agent-name").required = action === "rename";
  $("rename-agent-name").value = name.split(":").at(-1);
  $("move-agent-fields").hidden = action !== "move";
  $("move-agent-dir").value = "";
  $("manage-agent-submit").textContent = action === "rename" ? "Rename" : "Move agent";
  $("manage-agent-submit").disabled = action === "move";
  $("manage-agent-dialog").showModal();
  if (action === "move") try {
    const hosts = await api("/api/hosts");
    if (manageAgent !== context || context.epoch !== state.sessionEpoch) return;
    const remote = name.includes(":");
    $("move-agent-host").replaceChildren();
    if (remote) $("move-agent-host").add(new Option(hosts.local + " (this server)", "local"));
    else for (const host of hosts.hosts) $("move-agent-host").add(new Option(host.name, host.name));
    $("manage-agent-submit").disabled = !$("move-agent-host").options.length;
    if (!$("move-agent-host").options.length) $("manage-agent-error").textContent = "No remote hosts configured.";
  } catch (error) { if (manageAgent === context) $("manage-agent-error").textContent = error.message; }
}
$("manage-agent-form").onsubmit = async event => {
  event.preventDefault();
  const context = manageAgent;
  if (!context || !state.authenticated || pendingActions.has(context.name)) return;
  const { name, action, epoch } = context, version = state.detailVersion, selected = state.selected;
  const body = action === "rename" ? { name: $("rename-agent-name").value.trim() } : { host: $("move-agent-host").value, ...($("move-agent-dir").value.trim() ? { dir: $("move-agent-dir").value.trim() } : {}) };
  if (action === "move" && !confirm(`Move ${name} to ${body.host}? The source will stop; workspace files are not copied.`)) return;
  pendingActions.add(name);
  $("manage-agent-submit").disabled = true;
  $("manage-agent-submit").textContent = action === "move" ? "Moving…" : "Renaming…";
  $("manage-agent-error").textContent = "";
  try {
    const result = await api("/api/agents/" + encodeURIComponent(name) + "/" + action, body);
    if (!state.authenticated || epoch !== state.sessionEpoch) return;
    if (manageAgent === context) $("manage-agent-dialog").close();
    await refresh();
    if (state.selected === selected && state.detailVersion === version) await selectAgent(result.key || result.name);
  } catch (error) {
    if (epoch === state.sessionEpoch) {
      const message = error.message + " Check the agent list before retrying if the connection was interrupted.";
      if (manageAgent === context && $("manage-agent-dialog").open) $("manage-agent-error").textContent = message;
      else notice(message);
    }
  } finally {
    pendingActions.delete(name);
    if (manageAgent === context) { $("manage-agent-submit").disabled = false; $("manage-agent-submit").textContent = action === "move" ? "Move agent" : "Rename"; }
  }
};
async function refresh() {
  refreshWorkspace();
  if (!state.authenticated) return;
  if (state.refreshing) { state.refreshPending = true; return; }
  state.refreshing = true;
  state.refreshPending = false;
  try {
    const detailResults = Promise.allSettled([
      refreshDetail(),
      refreshDock(),
      refreshSubagent(),
      !$("usage-page")?.hidden ? refreshUsageSummary({ periodic: true }) : Promise.resolve(),
    ]);
    const fleet = await api("/api/agents");
    if (!state.authenticated) return;
    state.rows = fleet.rows;

    renderFleet();
    $("connection").textContent = "● Connected · updated just now";
    if (fleet.unreachable.length)
      notice("Unreachable hosts: " + fleet.unreachable.join(", "), "refresh");
    else if (state.noticeSource === "refresh") notice("");
    const failed = (await detailResults).find((result) => result.status === "rejected");
    if (failed && state.authenticated) notice(failed.reason.message, "refresh");
  } catch (error) {
    $("connection").textContent = "○ Connection interrupted · retrying";
    notice(error.message, "refresh");
  } finally {
    state.refreshing = false;
    if (state.refreshPending) scheduleRefresh();
  }
}
async function loadModels() {
  const host = $("create-host").value,
    provider = $("create-provider").value;
  $("create-provider-note").hidden = provider !== "antigravity";
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
function updateCreateGuidance() {
  const host = $("create-host");
  $("create-host-note").textContent = `Directory on ${host.selectedOptions[0]?.textContent || "this server"}. Git repositories use isolated worktrees when enabled in host settings; otherwise they run in place. Non-Git directories run in place.`;
}
function loadEfforts() {
  const catalog = state.catalogs.find(
    (c) => c.provider === $("create-provider").value,
  );
  const model = catalog?.models.find((m) => m.id === $("create-model").value);
  $("create-effort").replaceChildren(new Option("Default", ""));
  for (const effort of (model?.efforts?.length
    ? model.efforts
    : catalog?.efforts) || [])
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
    updateCreateGuidance();
    await loadModels();
  } catch (e) {
    $("create-error").textContent = e.message;
  }
}
$("new-agent").onclick = createDialog;
$("side-new").onclick = createDialog;
$("close-create").onclick = () => $("create-dialog").close();
$("create-provider").onchange = loadModels;
$("create-host").onchange = () => { updateCreateGuidance(); loadModels(); };
$("create-model").onchange = loadEfforts;
$("create-form").onsubmit = async (event) => {
  event.preventDefault();
  const body = Object.fromEntries(new FormData(event.target));
  if (body.host && body.dir) {
    body.remoteDir = body.dir;
    delete body.dir;
  }
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
function renderCommands() {
  const query = $("command-query").value.trim().toLowerCase();
  const list = $("command-results");
  list.replaceChildren();
  const commands = [
    ["Overview", () => showOverview()],
    ["Needs attention", () => showOverview("attention")],
    ["Search conversations", () => $("search-nav").click()],
    ["Token usage", () => $("usage-nav").click()],
    ["Concierge", () => $("concierge-nav").click()],
    ["New agent…", createDialog],
    ...(state.selected ? [["View chat", () => $("chat-tab").click()],
      ["View terminal", () => $("terminal-tab").click()]] : []),
    ...state.rows.map(row => [`${row.name} · ${repoName(row)} · ${row.host || "This server"} · ${statusName(row.status)}`, () => selectAgent(key(row))]),
  ];
  for (const [label, action] of commands.filter(([label]) => label.toLowerCase().includes(query))) {
    const button = el("button", "command-result", label);
    button.type = "button";
    button.onclick = () => { $("command-dialog").close(); action(); };
    list.append(button);
  }
  if (!list.childNodes.length) list.append(el("p", "", "No matching commands or agents."));
}
function openCommands() {
  if (!state.authenticated) return;
  $("command-query").value = "";
  renderCommands();
  if (!$("command-dialog").open) $("command-dialog").showModal();
  $("command-query").focus();
}
$("command-open").onclick = openCommands;
$("command-close").onclick = () => $("command-dialog").close();
$("command-query").oninput = renderCommands;
$("command-dialog").onkeydown = event => {
  const buttons = [...$("command-results").querySelectorAll("button")];
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    const index = buttons.indexOf(document.activeElement);
    buttons[(index + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length]?.focus();
  } else if (event.key === "Enter" && event.target === $("command-query")) {
    event.preventDefault(); buttons[0]?.click();
  }
};
const modifier = /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘" : "Ctrl";
$("command-open").replaceChildren(document.createTextNode("Commands"), el("span", "keyboard-hint", ` · ${modifier} K`));
for (const hint of document.querySelectorAll(".composer-shortcut")) hint.textContent = `Enter / Shift+Enter: new line · ${modifier}+Enter: send`;
$("message-send").title = `Send (${modifier}+Enter)`;
document.addEventListener("keydown", event => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
    event.preventDefault(); openCommands();
  }
});
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) refresh();
});
setInterval(() => {
  if (!document.hidden) refresh();
}, 4000);
unlock().catch(() => {});

function renderDockIdentity() {
  const name = state.conciergeKey;
  const row = state.rows.find((row) => key(row) === name);
  const providers = { claude: "Claude", codex: "Codex", antigravity: "Antigravity" };
  $("dock-provider").textContent = providers[row?.provider] || "Unknown provider";
  const host = row?.host || (name?.includes(":") ? name.slice(0, name.lastIndexOf(":")) : "This server");
  $("dock-location").textContent = `${host} · ${row ? statusName(row.status) : "Unavailable"}`;
}

async function refreshDock() {
  renderDockIdentity();
  const name = state.conciergeKey;
  if (!state.rows.some((row) => key(row) === name)) $("dock-working").hidden = true;
  if (
    !name ||
    state.selected ||
    !state.authenticated ||
    !state.rows.some((row) => key(row) === name)
  )
    return;
  const version = state.detailVersion;
  const transcript = await api(
    "/api/agents/" + encodeURIComponent(name) + "/transcript",
  );
  if (
    !state.authenticated ||
    state.conciergeKey !== name ||
    version !== state.detailVersion
  )
    return;
  const row = state.rows.find((row) => key(row) === name);
  showWorking("dock-working", row?.status, row?.statusChangedAt);
  const view = $("dock-transcript");
  const entries = transcript.entries
    .filter((entry) => entry.kind !== "tool")
    .slice(-20);
  const pending = pendingFor(name, transcript.entries);
  const fingerprint = JSON.stringify([entries, pending.map((item) => item.text)]);
  if (view.dataset.content === fingerprint) return;
  const restoreScroll = preserveConversationScroll(view, 60);
  view.dataset.content = fingerprint;
  view.replaceChildren();
  for (const entry of entries) view.append(chatTurn(entry, "Concierge"));
  for (const item of pending) view.append(pendingBubble(
    item.shown,
    "Sent · waiting for the concierge to read it",
    queuedMessageKey("dock-pending", item.id || item.at, item.shown),
  ));
  if (!entries.length && !pending.length)
    view.append(el("p", "", "Send a task or ask about your fleet."));
  restoreScroll();
}
const dockSubmitButton = $("dock-form").querySelector("button");
trackPointerSubmit(dockSubmitButton);
$("dock-form").onsubmit = async (event) => {
  event.preventDefault();
  if (state.dockBusy || !state.authenticated) return;
  const restoreFocus = takePointerSubmit(dockSubmitButton);
  const text = $("dock-message").value.trim();
  if (!text) return;
  const epoch = state.sessionEpoch;
  const revision = state.dockRevision;
  state.dockBusy = true;
  restoreComposerFocus(restoreFocus, $("dock-message"), dockSubmitButton, true);
  dockSubmitButton.disabled = true;
  try {
    const target = (await api("/api/concierge", {})).key;
    if (!state.authenticated || epoch !== state.sessionEpoch) return;
    state.conciergeKey = target;
    const sent = await api(
      "/api/agents/" + encodeURIComponent(state.conciergeKey) + "/messages",
      { text, mode: messageSendMode(state.conciergeKey) },
    );
    if (!state.authenticated || epoch !== state.sessionEpoch) return;
    notePending(state.conciergeKey, text, sent.id);
    if (state.dockRevision === revision) $("dock-message").value = "";
    $("dock-status").textContent = "Message accepted";
    await refreshDock();
  } catch (error) {
    $("dock-status").textContent = error.message;
  } finally {
    state.dockBusy = false;
    dockSubmitButton.disabled = false;
  }
};
$("dock-message").oninput = () => {
  state.dockRevision++;
};
$("dock-message").onkeydown = (event) => {
  if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
    event.preventDefault();
    $("dock-form").requestSubmit();
  }
};

function parentKey(row) {
  if (!row.spawnedBy) return null;
  return row.spawnedBy.includes(":") || !row.host
    ? row.spawnedBy
    : `${row.host}:${row.spawnedBy}`;
}
$("show-finished-subagents").onchange = () => {
  const snapshot = state.related;
  if (snapshot?.name === state.selected) renderRelated(snapshot.name, snapshot.subagents);
};
function renderRelated(name, subagents) {
  state.related = { name, subagents };
  const showFinished = $("show-finished-subagents").checked;
  const view = $("related-agents");
  view.replaceChildren();
  const row = state.rows.find((row) => key(row) === name);
  const parent = row && parentKey(row);
  if (parent) {
    const link = el("button", "related-link", "↑ Parent: " + parent);
    link.onclick = () => selectAgent(parent);
    view.append(link);
  }
  for (const child of state.rows.filter((row) => parentKey(row) === name && (showFinished || !["exited", "dead"].includes(row.status)))) {
    const link = el(
      "button",
      "related-link",
      `↳ ${child.name} · AM · ${statusName(child.status)}`,
    );
    link.onclick = () => selectAgent(key(child));
    view.append(link);
  }
  const records = [...(subagents.records || [])].sort(
    (a, b) =>
      Number(!!a.endedAt || !!a.stale) - Number(!!b.endedAt || !!b.stale) ||
      Date.parse(b.startedAt) - Date.parse(a.startedAt),
  );
  for (const sub of records) {
    if (!showFinished && (sub.endedAt || sub.stale)) continue;
    const label = sub.description || sub.type;
    const status = sub.stale
      ? "Session ended"
      : sub.endedAt
        ? "Finished"
        : "Running";
    const tokActive = sub.tokens
      ? (sub.tokens.inputTokens || 0) + (sub.tokens.cacheCreationTokens || 0) + (sub.tokens.outputTokens || 0)
      : 0;
    const tokSuffix = tokActive > 0 ? ` · ${formatCompactTokens(tokActive)} tok` : "";
    const link = el(
      "button",
      "related-link",
      `↳ ${label} · built-in${tokSuffix} · ${status}`,
    );
    link.onclick = () => openSubagent(name, sub.id, label, sub.message, status);
    view.append(link);
  }
  if (subagents.error) view.append(el("p", "", subagents.error));
  if (!view.childNodes.length)
    view.append(el("p", "", showFinished ? "No subagents recorded." : "No active subagents."));
}
async function openSubagent(parent, id, label, message, status = "Running") {
  state.subagent = { parent, id, label, message, status };
  connectEvents();
  $("subagent-title").textContent = label;
  $("subagent-meta").textContent = `${parent} / ${id} · ${status}`;
  $("subagent-output").replaceChildren(el("p", "", "Loading output…"));
  delete $("subagent-output").dataset.content;
  if (!$("subagent-dialog").open) $("subagent-dialog").showModal();
  await refreshSubagent();
}
$("close-subagent").onclick = () => $("subagent-dialog").close();
$("subagent-dialog").onclose = () => {
  state.subagent = null;
  connectEvents();
};
async function refreshSubagent() {
  const current = state.subagent;
  if (!current || !state.authenticated) return;
  try {
    const result = await api(
      "/api/agents/" +
        encodeURIComponent(current.parent) +
        "/transcript?subagent=" +
        encodeURIComponent(current.id),
    );
    if (state.subagent !== current || !state.authenticated) return;
    const view = $("subagent-output"),
      fingerprint = JSON.stringify(result.entries);
    if (view.dataset.content === fingerprint) return;
    view.dataset.content = fingerprint;
    view.replaceChildren();
    for (const entry of result.entries) {
      const block = el("article", "turn");
      block.append(
        el(
          "div",
          "turn-label",
          entry.kind === "tool" ? entry.name : entry.kind,
        ),
        entry.kind === "tool"
          ? el("pre", "turn-output", [entry.input, entry.output].filter(Boolean).join("\n\n"))
          : el("div", "turn-text", entry.text),
      );
      view.append(block);
    }
    if (!result.entries.length)
      view.append(el("p", "", current.message || "No output recorded yet."));
  } catch (error) {
    if (state.subagent !== current || !state.authenticated) return;
    delete $("subagent-output").dataset.content;
    $("subagent-output").replaceChildren(
      el(
        "p",
        "",
        current.message ||
          "Output is not available yet. Running Codex subagents may publish their transcript only when they finish.",
      ),
      el("small", "", error.message),
    );
  }
}

// --- Token Usage Page --------------------------------------------------------

let usageRequestSeq = 0;
let usageSummarySeq = 0;
let lastUsageQuota = null;
let usageBreakdownKey = null;
const expandedUsageAgents = new Set();
const usageView = { range: 7, unit: "usd", summary: null, fetchedAt: 0, showAllAgents: false };
const USAGE_SUMMARY_INTERVAL_MS = 30_000;
const usageRoot = $("usage-page");

function formatCompactTokens(n) {
  return window.usageDashboard.compactTokens(n);
}

function populateUsageAgentSelect(reportAgents = []) {
  const fleet = state.rows.filter((row) => !row.host && row.name !== "concierge").map((row) => row.name);
  window.usageDashboard.populateAgentSelect(usageRoot, fleet, reportAgents);
}

function showUsage(agentName) {
  saveDraft();
  agentTerminal.close();
  state.selected = null;
  state.detailVersion++;
  connectEvents();
  $("overview").hidden = true;
  $("detail").hidden = true;
  $("search-page").hidden = true;
  $("usage-page").hidden = false;
  document.querySelector(".page-heading").hidden = false;
  $("new-agent").hidden = false;
  $("page-title").textContent = "Token usage";
  $("page-title").classList.remove("agent-title");
  $("page-subtitle").textContent =
    "What the fleet costs, who is spending it, and whether caching is paying off. Dollars are API-equivalent list prices, not a bill.";
  $("breadcrumb").textContent = "Token usage";
  document
    .querySelectorAll(".nav")
    .forEach((button) => button.classList.toggle("active", button.id === "usage-nav"));
  populateUsageAgentSelect();
  renderFleet();
  refreshUsageSummary();
  if (typeof agentName === "string") openUsageBreakdown(agentName);
}

function usageBreakdownScope() {
  return `${$("usage-agent").value}\u0000${$("usage-provider").value}`;
}

// Expands the detailed breakdown scoped to one agent ("" = all); fetches only when needed.
function openUsageBreakdown(agentName) {
  const select = $("usage-agent");
  if (agentName && ![...select.options].some((o) => o.value === agentName)) {
    select.add(new Option(agentName, agentName));
  }
  select.value = agentName;
  $("usage-clear-agent").hidden = !select.value;
  const details = $("usage-breakdown");
  if (details.open) refreshUsage();
  else details.open = true;
}

async function refreshUsage() {
  if (!state.authenticated || $("usage-page")?.hidden || !$("usage-breakdown").open) return;
  const reqId = ++usageRequestSeq;
  const epoch = state.sessionEpoch;
  const agent = $("usage-agent").value;
  const provider = $("usage-provider").value;
  usageBreakdownKey = usageBreakdownScope();
  $("usage-clear-agent").hidden = !agent;
  $("usage-breakdown-status").textContent = "Scanning transcripts…";
  const params = new URLSearchParams({ quota: "0" });
  if (agent) params.set("agent", agent);
  if (provider) params.set("provider", provider);
  try {
    const data = await api("/api/usage?" + params.toString());
    if (!state.authenticated || epoch !== state.sessionEpoch || reqId !== usageRequestSeq) return;
    renderUsage(data.tokens);
    $("usage-breakdown-status").textContent = agent
      ? `Filtered to ${agent}`
      : `Updated ${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}`;
  } catch (error) {
    if (!state.authenticated || epoch !== state.sessionEpoch || reqId !== usageRequestSeq) return;
    usageBreakdownKey = null;
    $("usage-breakdown-status").textContent = error.message;
  }
}

// The summary is cheap (stored ledger); the periodic fleet refresh calls it at most every 30s.
async function refreshUsageSummary({ periodic = false, refresh = false } = {}) {
  if (!state.authenticated || $("usage-page")?.hidden) return;
  if (periodic && Date.now() - usageView.fetchedAt < USAGE_SUMMARY_INTERVAL_MS) return;
  usageView.fetchedAt = Date.now();
  const reqId = ++usageSummarySeq;
  const epoch = state.sessionEpoch;
  const params = new URLSearchParams({ range: String(usageView.range) });
  if ($("usage-repo").value) params.set("repo", $("usage-repo").value);
  if ($("usage-summary-provider").value) params.set("provider", $("usage-summary-provider").value);
  if (refresh) params.set("refresh", "1");
  else if (lastUsageQuota) params.set("quota", "0");
  if (!usageView.summary || !periodic) $("usage-status").textContent = "Loading…";
  try {
    const data = await api("/api/usage/summary?" + params.toString());
    if (!state.authenticated || epoch !== state.sessionEpoch || reqId !== usageSummarySeq) return;
    if (data.quota) lastUsageQuota = data.quota;
    usageView.summary = data.summary;
    renderUsageQuota(lastUsageQuota);
    renderUsageDashboard();
    const pending = data.summary?.indexing?.pendingFiles || 0;
    const at = new Date(data.summary?.generatedAt || Date.now());
    $("usage-status").textContent = pending > 0
      ? `Indexing history… ${pending} file${pending === 1 ? "" : "s"} left`
      : `Updated ${at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
  } catch (error) {
    if (!state.authenticated || epoch !== state.sessionEpoch || reqId !== usageSummarySeq) return;
    $("usage-status").textContent = error.message;
  }
}

const usageActions = {
  statusDot: dot,
  setRange(range) {
    if (range === usageView.range) return;
    usageView.range = range;
    refreshUsageSummary();
  },
  setUnit(unit) {
    if (unit === usageView.unit) return;
    usageView.unit = unit;
    renderUsageDashboard();
  },
  changeSummaryFilter: () => refreshUsageSummary(),
  refreshSummary: () => refreshUsageSummary({ refresh: true }),
  breakdownToggled(open) {
    if (open && usageBreakdownKey !== usageBreakdownScope()) refreshUsage();
  },
  changeBreakdownFilter: () => refreshUsage(),
  refreshBreakdown: () => refreshUsage(),
  openBreakdown: openUsageBreakdown,
  toggleAllAgents() {
    usageView.showAllAgents = !usageView.showAllAgents;
    renderUsageTopAgents();
  },
  openAgent: (name) => selectAgent(name),
  openSubagent: (agentName, id, label, statusLabel) => openSubagent(agentName, id, label, "", statusLabel),
  chartResized() {
    if (usageView.summary) renderUsageChart();
  },
};

function renderUsageQuota(quotaList) {
  window.usageDashboard.renderQuota(usageRoot, quotaList);
}

function renderUsageDashboard() {
  window.usageDashboard.renderDashboard(usageRoot, usageView, usageActions);
}

function renderUsageChart() {
  window.usageDashboard.renderChart(usageRoot, usageView);
}

function renderUsageTopAgents() {
  window.usageDashboard.renderTopAgents(usageRoot, usageView, usageActions);
}

function renderUsage(report) {
  if (!report) return;
  populateUsageAgentSelect(report.agents || []);
  window.usageDashboard.renderBreakdown(usageRoot, report, { expanded: expandedUsageAgents }, {
    ...usageActions,
    toggleSubagents(name) {
      if (expandedUsageAgents.has(name)) expandedUsageAgents.delete(name);
      else expandedUsageAgents.add(name);
      renderUsage(report);
    },
  });
}

$("usage-nav").onclick = () => showUsage();
window.usageDashboard.bindControls(usageRoot, usageActions);
