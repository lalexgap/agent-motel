"use strict";

// Vanilla SPA — no build step, matching the repo's zero-dependency style.
// Auth: a bearer token in localStorage, attached to every /api call. The
// network gate (tailnet/Caddy) is deployment's job; this is defense-in-depth.

const TOKEN_KEY = "am_token";
const view = document.getElementById("view");
const metaEl = document.getElementById("meta");
let token = localStorage.getItem(TOKEN_KEY) || "";
let route = { name: "list" };
let timer = null;

// --- api -------------------------------------------------------------------

async function api(path, opts = {}) {
  const res = await fetch("/api" + path, {
    ...opts,
    headers: {
      Authorization: "Bearer " + token,
      ...(opts.body ? { "content-type": "application/json" } : {}),
      ...(opts.headers || {}),
    },
  });
  if (res.status === 401) {
    localStorage.removeItem(TOKEN_KEY);
    token = "";
    renderGate();
    throw new Error("unauthorized");
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

// --- helpers ---------------------------------------------------------------

function ago(iso) {
  if (!iso) return "";
  const s = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return s + "s ago";
  if (s < 3600) return Math.floor(s / 60) + "m ago";
  if (s < 86400) return Math.floor(s / 3600) + "h ago";
  return Math.floor(s / 86400) + "d ago";
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

function el(html) {
  const t = document.createElement("template");
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}

let toastTimer = null;
function toast(msg, isErr) {
  let t = document.querySelector(".toast");
  if (!t) {
    t = el('<div class="toast"></div>');
    document.body.appendChild(t);
  }
  t.textContent = msg;
  t.className = "toast show" + (isErr ? " err" : "");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.className = "toast"), 2600);
}

function stopPolling() {
  if (timer) clearInterval(timer);
  timer = null;
}

function keyOf(row) {
  return row.host ? row.host + ":" + row.name : row.name;
}

// --- token gate ------------------------------------------------------------

function renderGate() {
  stopPolling();
  metaEl.textContent = "";
  view.innerHTML = "";
  const box = el(`
    <div class="gate">
      <h2>Connect to am</h2>
      <p>Paste the token from <code>am token</code> on the server.</p>
      <input class="field" id="tok" type="text" inputmode="text" autocomplete="off"
        autocapitalize="none" autocorrect="off" spellcheck="false" placeholder="paste bearer token" />
      <button class="primary" id="go" style="width:100%">Connect</button>
    </div>`);
  view.appendChild(box);
  const input = box.querySelector("#tok");
  const submit = async () => {
    token = input.value.trim();
    if (!token) return;
    try {
      await api("/health");
      localStorage.setItem(TOKEN_KEY, token);
      go({ name: "list" });
    } catch {
      toast("Invalid token", true);
    }
  };
  box.querySelector("#go").onclick = submit;
  input.onkeydown = (e) => e.key === "Enter" && submit();
  input.focus();
}

// --- fleet list ------------------------------------------------------------

function statusLabel(row) {
  return row.queued > 0 ? row.status + " · " + row.queued + "q" : row.status;
}

function fleetCard(row) {
  const card = el(`
    <div class="card">
      <span class="dot ${esc(row.status)}"></span>
      <div class="body">
        <div class="name">${esc(row.name)}
          ${row.host ? `<span class="badge host">${esc(row.host.split(".")[0])}</span>` : ""}
          <span class="badge">${esc(row.provider)}</span>
        </div>
        <div class="sub">${esc(statusLabel(row))} · ${esc(row.dir || "")} · ${esc(ago(row.updatedAt))}</div>
      </div>
      ${row.queued > 0 ? `<span class="qbadge">${row.queued}</span>` : ""}
    </div>`);
  card.onclick = () => go({ name: "detail", key: keyOf(row), host: row.host || null, agentName: row.name });
  return card;
}

async function renderList() {
  let data;
  try {
    data = await api("/agents");
  } catch (e) {
    if (e.message !== "unauthorized") toast(e.message, true);
    return;
  }
  if (route.name !== "list") return;
  const rows = data.rows.slice().sort((a, b) => keyOf(a).localeCompare(keyOf(b)));
  metaEl.textContent = rows.length + " agent" + (rows.length === 1 ? "" : "s");
  view.innerHTML = "";
  if (data.unreachable?.length) {
    view.appendChild(el(`<div class="warn">unreachable: ${esc(data.unreachable.join(", "))}</div>`));
  }
  if (!rows.length) {
    view.appendChild(el('<div class="empty">No agents yet. Tap + to spawn one.</div>'));
  }
  for (const row of rows) view.appendChild(fleetCard(row));

  const fab = el('<button class="fab" title="New agent">+</button>');
  fab.onclick = spawnPrompt;
  view.appendChild(fab);
}

async function spawnPrompt() {
  const name = prompt("New agent name:");
  if (!name) return;
  const task = prompt("Task (optional):") || undefined;
  try {
    await api("/agents", { method: "POST", body: JSON.stringify({ name: name.trim(), task }) });
    toast("Spawned " + name);
    renderList();
  } catch (e) {
    toast(e.message, true);
  }
}

// --- detail ----------------------------------------------------------------

async function renderDetail() {
  const { key, host, agentName } = route;

  if (host) {
    // The API is local-only for now; remote agents are view-only here.
    metaEl.textContent = "";
    view.innerHTML = "";
    view.appendChild(el('<button class="back">‹ fleet</button>')).onclick = () => go({ name: "list" });
    view.appendChild(el(`
      <div class="detail">
        <h2>${esc(agentName)} <span class="badge host">${esc(host.split(".")[0])}</span></h2>
        <p class="muted">Remote agent. Drive it from the host (<code>ssh ${esc(host)} am j ${esc(agentName)}</code>)
        or the Claude app — remote actions over the API are a future step.</p>
      </div>`));
    return;
  }

  let d;
  try {
    d = await api("/agents/" + encodeURIComponent(agentName));
  } catch (e) {
    if (e.message !== "unauthorized") {
      toast(e.message, true);
      go({ name: "list" });
    }
    return;
  }
  if (route.name !== "detail" || route.key !== key) return;

  view.innerHTML = "";
  metaEl.textContent = d.status + (d.queue.length ? " · " + d.queue.length + "q" : "");

  const back = el('<button class="back">‹ fleet</button>');
  back.onclick = () => go({ name: "list" });
  view.appendChild(back);

  view.appendChild(el(`
    <div class="detail">
      <h2><span class="dot ${esc(d.status)}"></span> ${esc(d.name)} <span class="badge">${esc(d.provider)}</span></h2>
      <dl class="kv">
        <dt>status</dt><dd>${esc(d.status)}</dd>
        <dt>dir</dt><dd>${esc(d.dir)}</dd>
        ${d.task ? `<dt>task</dt><dd>${esc(d.task)}</dd>` : ""}
        ${d.worktreeBranch ? `<dt>worktree</dt><dd>${esc(d.worktreeBranch)}</dd>` : ""}
        <dt>updated</dt><dd>${esc(ago(d.updatedAt))}</dd>
      </dl>
    </div>`));

  if (d.queue.length) {
    view.appendChild(el(`<div class="queued"><b>${d.queue.length} queued</b>: ${esc(d.queue.map((q) => q.message).join(" • "))}</div>`));
  }

  view.appendChild(el(`<pre class="pane">${esc(d.pane || "(no live session)")}</pre>`));

  // composer
  const composer = el(`
    <div class="composer">
      <textarea id="msg" placeholder="Message ${esc(d.name)}…"></textarea>
      <div class="row">
        <button class="primary" data-mode="queue">Queue</button>
        <button data-mode="now">Send now</button>
        <button data-mode="interrupt">Interrupt</button>
      </div>
      <div class="row">
        <button data-act="stop">Stop</button>
        <button data-act="resume">Resume</button>
        <button class="danger" data-act="delete">Remove</button>
      </div>
    </div>`);
  const msg = composer.querySelector("#msg");
  composer.querySelectorAll("[data-mode]").forEach((b) => {
    b.onclick = async () => {
      const text = msg.value.trim();
      if (!text) return toast("Type a message first", true);
      try {
        await api("/agents/" + encodeURIComponent(d.name) + "/messages", {
          method: "POST",
          body: JSON.stringify({ text, mode: b.dataset.mode }),
        });
        msg.value = "";
        toast(b.dataset.mode === "queue" ? "Queued" : "Sent");
        renderDetail();
      } catch (e) {
        toast(e.message, true);
      }
    };
  });
  composer.querySelectorAll("[data-act]").forEach((b) => {
    b.onclick = async () => {
      const act = b.dataset.act;
      if (act === "delete" && !confirm("Remove " + d.name + "?")) return;
      try {
        if (act === "delete") {
          await api("/agents/" + encodeURIComponent(d.name), { method: "DELETE" });
          toast("Removed " + d.name);
          return go({ name: "list" });
        }
        await api("/agents/" + encodeURIComponent(d.name) + "/" + act, { method: "POST" });
        toast(act + "ped " + d.name);
        renderDetail();
      } catch (e) {
        toast(e.message, true);
      }
    };
  });
  view.appendChild(composer);
}

// --- router ----------------------------------------------------------------

function go(next) {
  route = next;
  stopPolling();
  if (!token) return renderGate();
  if (route.name === "list") {
    renderList();
    timer = setInterval(renderList, 3000);
  } else if (route.name === "detail") {
    renderDetail();
    if (!route.host) timer = setInterval(renderDetail, 2500);
  }
}

document.getElementById("refresh").onclick = () => (route.name === "detail" ? renderDetail() : renderList());

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js").catch(() => {});
}

// URL bootstrap: visiting /?token=… stores the token and strips it from the
// visible URL — lets you skip the paste field entirely on iOS.
const urlToken = new URLSearchParams(location.search).get("token");
if (urlToken) {
  token = urlToken.trim();
  localStorage.setItem(TOKEN_KEY, token);
  history.replaceState({}, "", location.pathname);
}

go({ name: "list" }); // renders the token gate first when no token is stored
