"use strict";
let conversationSearch = null, conversationRequest = 0;
function clearConversationSearch() { conversationSearch = null; conversationRequest++; }
async function runConversationSearch() {
  const query = $("advanced-query").value.trim();
  if ($("advanced-mode").value !== "conversations") { renderAdvancedSearch(); return; }
  if (query.length < 2 || query.length > 256) { $("advanced-summary").textContent = "Enter 2–256 characters to search conversations."; return; }
  const request = ++conversationRequest, epoch = state.sessionEpoch;
  conversationSearch = { query, pending: true, matches: new Map() };
  renderAdvancedSearch();
  try {
    const result = await api("/api/search", { query });
    if (request !== conversationRequest || epoch !== state.sessionEpoch || !state.authenticated) return;
    conversationSearch = { query, matches: new Map(result.matches.map(match => [(match.host ? match.host + ":" : "") + match.name, match.snippets])), partial: result.partial, unavailable: result.unavailable || [] };
  } catch (error) {
    if (request !== conversationRequest || epoch !== state.sessionEpoch || !state.authenticated) return;
    conversationSearch = { query, matches: new Map(), error: error.message };
  }
  if (!$("search-page").hidden) renderAdvancedSearch();
}

function showSearch() {
  saveDraft();
  agentTerminal.close();
  state.selected = null;
  state.detailVersion++;
  connectEvents();
  $("overview").hidden = true;
  $("detail").hidden = true;
  $("search-page").hidden = false;
  document.querySelector(".page-heading").hidden = false;
  $("new-agent").hidden = false;
  $("page-title").textContent = "Search";
  $("page-title").classList.remove("agent-title");
  $("breadcrumb").textContent = "Search";
  $("page-subtitle").textContent = "";
  document.querySelectorAll(".nav").forEach(button => button.classList.toggle("active", button.id === "search-nav"));
  renderAdvancedSearch();
  $("advanced-query").focus();
}
function searchOptions(id, values, label) {
  const select = $(id), previous = select.value;
  const entries = [...new Set(values)].sort();
  if (previous && !entries.includes(previous)) entries.push(previous);
  const signature = JSON.stringify(entries);
  if (select.dataset.options === signature) return;
  select.replaceChildren(new Option(label, ""), ...entries.map(value => new Option(value, value)));
  select.value = previous;
  select.dataset.options = signature;
}
function searchExcerpt(text, terms, length = 220) {
  const flat = String(text || "").replace(/\*\*|`|(^|\s)#{1,6}(?=\s)/g, "$1").replace(/\s+/g, " ").trim();
  const lower = flat.toLowerCase();
  const hits = terms.map(term => lower.indexOf(term)).filter(index => index >= 0);
  const first = hits.length ? Math.min(...hits) : 0;
  const start = flat.length <= length || first < length / 3 ? 0 : Math.min(first - Math.floor(length / 3), flat.length - length);
  const end = Math.min(flat.length, start + length);
  return (start > 0 ? "…" : "") + flat.slice(start, end).trim() + (end < flat.length ? "…" : "");
}
function highlightInto(node, text, terms) {
  const pattern = terms.length ? new RegExp(terms.map(term => term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"), "gi") : null;
  let offset = 0;
  for (const match of pattern ? text.matchAll(pattern) : []) {
    if (!match[0]) continue;
    node.append(document.createTextNode(text.slice(offset, match.index)), Object.assign(document.createElement("mark"), { textContent: match[0] }));
    offset = match.index + match[0].length;
  }
  node.append(document.createTextNode(text.slice(offset)));
  return node;
}
function renderAdvancedSearch() {
  searchOptions("advanced-repo", state.rows.map(repoPath).filter(Boolean), "All repositories");
  searchOptions("advanced-host", state.rows.map(row => row.host || "local"), "All hosts");
  const terms = $("advanced-query").value.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const repository = $("advanced-repo").value, host = $("advanced-host").value;
  const provider = $("advanced-provider").value, status = $("advanced-status").value;
  const conversations = $("advanced-mode").value === "conversations";
  const search = conversations && conversationSearch?.query === $("advanced-query").value.trim() ? conversationSearch : null;
  const rows = state.rows.filter(row => {
    const finished = ["dead", "exited"].includes(row.status);
    const text = [row.name, row.task, row.dir, repoPath(row), row.worktreeBranch, row.spawnedBy, row.provider, row.host || "local"].join(" ").toLowerCase();
    return (terms.every(term => text.includes(term)) || search?.matches.has(key(row))) && (!repository || repoPath(row) === repository) &&
      (!host || (row.host || "local") === host) && (!provider || row.provider === provider) &&
      (!status || (status === "live" ? !finished : status === "finished" ? finished : row.status === status));
  });
  const sort = $("advanced-sort").value;
  rows.sort((a, b) => {
    let order = 0;
    if (sort === "recent") order = Date.parse(b.updatedAt || b.createdAt || 0) - Date.parse(a.updatedAt || a.createdAt || 0);
    else if (sort === "runtime") order = runtime(b) - runtime(a);
    else if (sort === "repo") order = repoPath(a).localeCompare(repoPath(b));
    else if (sort === "status") order = String(a.status).localeCompare(String(b.status));
    return order || a.name.localeCompare(b.name);
  });
  $("advanced-summary").textContent = `${rows.length} of ${state.rows.length} agents · includes child and finished agents`;
  if (conversations) {
    const hint = search?.pending ? "Searching conversations…" : search?.error ? search.error : !search ? "Press Search or Enter to include conversations." : search.partial ? "Partial results: search reached a limit or some transcripts were unavailable." : "Conversation search complete · up to 3 snippets per agent";
    $("advanced-summary").append(document.createTextNode(" · " + hint + (search?.unavailable?.length ? " Unavailable hosts: " + search.unavailable.join(", ") : "")));
  }
  const results = $("advanced-results");
  results.replaceChildren();
  if (!rows.length) results.append(el("p", "empty", "No matches. Try fewer words or clear a filter."));
  for (const row of rows) {
    const button = el("button", "search-result");
    const title = el("div", "search-result-title");
    title.append(el("strong", "", row.name), badge(row.status), el("span", "side-agent-provider", row.provider || "Unknown"));
    const meta = [repoPath(row), row.host || "local", elapsed(runtime(row)), row.spawnedBy ? "Child of " + row.spawnedBy : ""].filter(Boolean).join(" · ");
    const task = highlightInto(el("p", "search-task"), searchExcerpt(row.task || "No task", terms), terms);
    button.append(title, task, el("small", "", meta));
    const snippetTerms = search ? search.query.toLowerCase().split(/\s+/).filter(Boolean) : terms;
    for (const snippet of search?.matches.get(key(row)) || []) {
      const block = el("p", "search-snippet");
      block.append(el("span", "search-snippet-kind", snippet.kind === "user" ? "You" : snippet.kind === "assistant" ? "Agent" : snippet.kind));
      highlightInto(block, searchExcerpt(snippet.text, snippetTerms, 180), snippetTerms);
      button.append(block);
    }
    button.onclick = () => selectAgent(key(row), search?.matches.has(key(row)) ? "chat" : undefined);
    results.append(button);
  }
}
document.getElementById("search-nav").onclick = showSearch;
document.getElementById("advanced-search-form").onsubmit = event => { event.preventDefault(); runConversationSearch(); };
document.getElementById("advanced-query").oninput = () => { clearConversationSearch(); renderAdvancedSearch(); };
document.getElementById("advanced-mode").onchange = () => { clearConversationSearch(); renderAdvancedSearch(); };
for (const id of ["advanced-repo", "advanced-status", "advanced-provider", "advanced-host", "advanced-sort"]) document.getElementById(id).onchange = renderAdvancedSearch;
document.getElementById("advanced-reset").onclick = () => { document.getElementById("advanced-search-form").reset(); clearConversationSearch(); renderAdvancedSearch(); document.getElementById("advanced-query").focus(); };
