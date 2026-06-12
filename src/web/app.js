"use strict";

// Vanilla SPA — no build step, matching the repo's zero-dependency style.
// Auth: a bearer token in localStorage, attached to every /api call. The
// network gate (tailnet/Caddy) is deployment's job; this is defense-in-depth.
//
// Rendering model: each screen mounts its DOM once; polling calls an update()
// that patches only what changed (status, pane, queue, timestamps) so it never
// destroys the message draft, keyboard focus, or scroll position.

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
    mountGate();
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

function shortDir(dir) {
  return String(dir || "").replace(/^\/(home|Users)\/[^/]+/, "~");
}

const STATUS = {
  working: "working",
  idle: "idle",
  waiting: "waiting",
  "needs-attention": "needs input",
  starting: "starting",
  exited: "exited",
  dead: "offline",
};
const LIVE = new Set(["working", "starting", "needs-attention"]);
function statusLabel(s) {
  return STATUS[s] || s;
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

function el(html) {
  const t = document.createElement("template");
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}

function pillHtml(status) {
  return `<span class="pill st-${esc(status)} ${LIVE.has(status) ? "live" : ""}"><span class="dot"></span>${esc(statusLabel(status))}</span>`;
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
  toastTimer = setTimeout(() => (t.className = "toast" + (isErr ? " err" : "")), 2600);
}

function stopPolling() {
  if (timer) clearInterval(timer);
  timer = null;
}

function keyOf(row) {
  return row.host ? row.host + ":" + row.name : row.name;
}

// --- bottom sheet ----------------------------------------------------------

function sheet(buildContent) {
  const scrim = el('<div class="scrim"><div class="sheet"><div class="grab"></div></div></div>');
  const body = scrim.querySelector(".sheet");
  const close = () => {
    scrim.classList.remove("show");
    setTimeout(() => scrim.remove(), 220);
  };
  scrim.onclick = (e) => e.target === scrim && close();
  buildContent(body, close);
  document.body.appendChild(scrim);
  requestAnimationFrame(() => scrim.classList.add("show"));
  return close;
}

function confirmSheet(title, danger, onYes) {
  sheet((body, close) => {
    body.appendChild(el(`<h3>${esc(title)}</h3>`));
    const actions = el('<div class="actions"></div>');
    const cancel = el("<button>Cancel</button>");
    const yes = el(`<button class="${danger ? "danger" : "primary"}">${danger ? "Remove" : "Confirm"}</button>`);
    cancel.onclick = close;
    yes.onclick = () => { close(); onYes(); };
    actions.append(cancel, yes);
    body.appendChild(actions);
  });
}

// --- token gate ------------------------------------------------------------

function mountGate() {
  stopPolling();
  metaEl.textContent = "";
  view.innerHTML = "";
  const box = el(`
    <div class="gate">
      <img class="logo" src="/icon.svg" alt="" />
      <h2>Connect to am</h2>
      <p>Paste the token from <code>am token</code> on the server, or open the link with <code>?token=…</code>.</p>
      <input id="tok" type="text" inputmode="text" autocomplete="off"
        autocapitalize="none" autocorrect="off" spellcheck="false" placeholder="paste bearer token" />
      <button class="primary" id="go">Connect</button>
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
}

// --- fleet list ------------------------------------------------------------

function mountList() {
  view.innerHTML = "";
  const warn = el('<div class="warn" hidden></div>');
  const fleet = el('<div class="fleet"></div>');
  const empty = el('<div class="empty" hidden><b>No agents yet.</b><br>Tap + to spawn one.</div>');
  const fab = el('<button class="fab" aria-label="New agent">+</button>');
  fab.onclick = openSpawn;
  view.append(warn, fleet, empty, fab);

  const cards = new Map();

  function cardFor(row) {
    const card = el(`
      <div class="card">
        <div class="line1">
          <span class="name"></span>
          <span class="badge host" hidden></span>
          <span class="badge prov"></span>
          <span class="pillslot" style="margin-left:auto"></span>
        </div>
        <div class="line2"></div>
        <span class="chev">›</span>
      </div>`);
    card.onclick = () => go({ name: "detail", key: keyOf(row), host: row.host || null, agentName: row.name });
    return card;
  }

  function paint(card, row) {
    card.style.setProperty("--st", `var(--${row.status === "needs-attention" ? "attn" : row.status === "working" || row.status === "starting" ? "work" : row.status === "waiting" ? "wait" : row.status === "exited" ? "exit" : row.status === "dead" ? "dead" : "idle"})`);
    card.querySelector(".name").textContent = row.name;
    const host = card.querySelector(".host");
    if (row.host) { host.hidden = false; host.textContent = row.host.split(".")[0]; } else host.hidden = true;
    card.querySelector(".prov").textContent = row.provider;
    card.querySelector(".pillslot").innerHTML = pillHtml(row.status);
    const bits = [shortDir(row.dir), ago(row.updatedAt)].filter(Boolean).map(esc).join('<span class="sep">·</span>');
    const q = row.queued > 0 ? ` <span class="qchip">${row.queued} queued</span>` : "";
    card.querySelector(".line2").innerHTML = bits + q;
  }

  async function refresh() {
    let data;
    try { data = await api("/agents"); } catch (e) { if (e.message !== "unauthorized") toast(e.message, true); return; }
    if (route.name !== "list") return;
    const rows = data.rows.slice().sort((a, b) => keyOf(a).localeCompare(keyOf(b)));
    metaEl.textContent = rows.length + (rows.length === 1 ? " agent" : " agents");
    warn.hidden = !data.unreachable?.length;
    if (data.unreachable?.length) warn.textContent = "unreachable: " + data.unreachable.join(", ");
    empty.hidden = rows.length > 0;

    const seen = new Set();
    rows.forEach((row, i) => {
      const k = keyOf(row);
      seen.add(k);
      let card = cards.get(k);
      if (!card) { card = cardFor(row); cards.set(k, card); }
      paint(card, row);
      if (fleet.children[i] !== card) fleet.insertBefore(card, fleet.children[i] || null);
    });
    for (const [k, card] of cards) if (!seen.has(k)) { card.remove(); cards.delete(k); }
  }

  refresh();
  timer = setInterval(refresh, 3000);
}

function openSpawn() {
  sheet((body, close) => {
    let provider = "claude";
    body.appendChild(el("<h3>New agent</h3>"));
    body.appendChild(el('<label>Name</label>'));
    const name = el('<input type="text" autocapitalize="none" autocorrect="off" spellcheck="false" placeholder="api-refactor" />');
    body.appendChild(name);
    body.appendChild(el('<label>Task (optional)</label>'));
    const task = el('<input type="text" placeholder="refactor the api layer" />');
    body.appendChild(task);
    body.appendChild(el('<label>Provider</label>'));
    const toggle = el('<div class="toggle"><button class="on" data-p="claude">Claude</button><button data-p="codex">Codex</button></div>');
    toggle.querySelectorAll("button").forEach((b) => b.onclick = () => {
      provider = b.dataset.p;
      toggle.querySelectorAll("button").forEach((x) => x.classList.toggle("on", x === b));
    });
    body.appendChild(toggle);

    const actions = el('<div class="actions"></div>');
    const cancel = el("<button>Cancel</button>");
    const create = el('<button class="primary">Spawn</button>');
    cancel.onclick = close;
    create.onclick = async () => {
      const n = name.value.trim();
      if (!n) return toast("Name required", true);
      create.disabled = true;
      try {
        await api("/agents", { method: "POST", body: JSON.stringify({ name: n, task: task.value.trim() || undefined, codex: provider === "codex" }) });
        close();
        toast("Spawned " + n);
      } catch (e) { create.disabled = false; toast(e.message, true); }
    };
    actions.append(cancel, create);
    body.appendChild(actions);
    setTimeout(() => name.focus(), 250);
  });
}

// --- detail ----------------------------------------------------------------

function mountDetail() {
  const { host, agentName } = route;
  view.innerHTML = "";

  const back = el('<button class="back">‹ Fleet</button>');
  back.onclick = () => go({ name: "list" });
  view.appendChild(back);

  if (host) {
    metaEl.textContent = "remote";
    view.appendChild(el(`
      <div class="dhead"><h2 class="name">${esc(agentName)}</h2><span class="badge host">${esc(host.split(".")[0])}</span></div>
      <div class="meta"><p style="grid-column:1/3;margin:0;color:var(--muted);line-height:1.6">
        Remote agent on <b>${esc(host)}</b>. Drive it from the host
        (<code>ssh ${esc(host)} am j ${esc(agentName)}</code>) or the Claude app —
        remote actions over the API are a future step.</p></div>`));
    return;
  }

  // static chrome, built once
  const head = el(`<div class="dhead"><h2 class="name">${esc(agentName)}</h2><span class="badge prov"></span><span class="pillslot"></span><button class="more" aria-label="Actions">⋯</button></div>`);
  const meta = el('<dl class="meta"></dl>');
  const queued = el('<div class="queued" hidden></div>');
  const term = el('<div class="term"><div class="term-bar">live screen<span class="pillslot"></span></div><pre></pre></div>');
  const composer = el(`
    <div class="composer">
      <textarea id="msg" placeholder="Message ${esc(agentName)}…" rows="2"></textarea>
      <div class="seg">
        <button class="primary" data-mode="queue">Queue</button>
        <button data-mode="now">Send now</button>
        <button class="sub" data-mode="interrupt">Interrupt</button>
      </div>
    </div>`);
  view.append(head, meta, queued, term, composer);

  const msg = composer.querySelector("#msg");
  msg.addEventListener("input", () => { msg.style.height = "auto"; msg.style.height = Math.min(msg.scrollHeight, 140) + "px"; });

  composer.querySelectorAll("[data-mode]").forEach((b) => b.onclick = async () => {
    const text = msg.value.trim();
    if (!text) return toast("Type a message first", true);
    b.disabled = true;
    try {
      await api("/agents/" + encodeURIComponent(agentName) + "/messages", { method: "POST", body: JSON.stringify({ text, mode: b.dataset.mode }) });
      msg.value = ""; msg.style.height = "auto";
      toast(b.dataset.mode === "queue" ? "Queued" : b.dataset.mode === "now" ? "Sent" : "Interrupted");
      refresh();
    } catch (e) { toast(e.message, true); }
    finally { b.disabled = false; }
  });

  head.querySelector(".more").onclick = () => openActions(agentName);

  function refresh() {
    api("/agents/" + encodeURIComponent(agentName)).then((d) => {
      if (route.name !== "detail" || route.agentName !== agentName) return;
      metaEl.textContent = statusLabel(d.status) + (d.queue.length ? " · " + d.queue.length + "q" : "");
      head.querySelector(".prov").textContent = d.provider;
      head.querySelector(".pillslot").innerHTML = pillHtml(d.status);
      meta.innerHTML =
        `<dt>dir</dt><dd class="mono">${esc(shortDir(d.dir))}</dd>` +
        (d.task ? `<dt>task</dt><dd>${esc(d.task)}</dd>` : "") +
        (d.worktreeBranch ? `<dt>branch</dt><dd class="mono">${esc(d.worktreeBranch)}</dd>` : "") +
        `<dt>updated</dt><dd>${esc(ago(d.updatedAt))}</dd>`;
      queued.hidden = !d.queue.length;
      if (d.queue.length) queued.innerHTML = `<span class="qchip">${d.queue.length}</span><div class="qlist"><b>queued:</b> ${esc(d.queue.map((q) => q.message).join(" • "))}</div>`;
      const pre = term.querySelector("pre");
      const atBottom = pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 8;
      pre.textContent = d.pane || "(no live session)";
      pre.classList.toggle("empty-pane", !d.pane);
      term.querySelector(".term-bar .pillslot").innerHTML = pillHtml(d.status);
      if (atBottom) pre.scrollTop = pre.scrollHeight;
    }).catch((e) => {
      if (e.message !== "unauthorized") { toast(e.message, true); go({ name: "list" }); }
    });
  }

  refresh();
  timer = setInterval(refresh, 2500);
}

function openActions(name) {
  sheet((body, close) => {
    body.appendChild(el(`<h3>${esc(name)}</h3>`));
    const mk = (ico, label, cls, fn) => {
      const b = el(`<button class="actbtn ${cls || ""}"><span class="ico">${ico}</span>${label}</button>`);
      b.onclick = fn;
      body.appendChild(b);
      return b;
    };
    const act = async (verb, past) => {
      try { await api("/agents/" + encodeURIComponent(name) + "/" + verb, { method: "POST" }); toast(past + " " + name); }
      catch (e) { toast(e.message, true); }
    };
    mk("■", "Stop", "", () => { close(); act("stop", "Stopped"); });
    mk("▸", "Resume", "", () => { close(); act("resume", "Resumed"); });
    mk("🗑", "Remove", "danger", () => {
      close();
      confirmSheet("Remove " + name + "?", true, async () => {
        try { await api("/agents/" + encodeURIComponent(name), { method: "DELETE" }); toast("Removed " + name); go({ name: "list" }); }
        catch (e) { toast(e.message, true); }
      });
    });
  });
}

// --- router ----------------------------------------------------------------

function go(next) {
  route = next;
  stopPolling();
  if (!token) return mountGate();
  if (route.name === "list") mountList();
  else if (route.name === "detail") mountDetail();
}

document.getElementById("refresh").onclick = () => go(route);

if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});

// URL bootstrap: visiting /?token=… stores the token and strips it from the
// visible URL — lets you skip the paste field entirely on iOS.
const urlToken = new URLSearchParams(location.search).get("token");
if (urlToken) {
  token = urlToken.trim();
  localStorage.setItem(TOKEN_KEY, token);
  history.replaceState({}, "", location.pathname);
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
