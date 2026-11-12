"use strict";
// Read-only decisions inbox shared by the web and native hosts. It owns no data
// fetching or navigation; hosts supply both through actions.
window.agentDecisionsPage = (() => {
  const views = new WeakMap();
  const find = (root, id) => root.querySelector("#" + id);
  const el = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = String(text);
    return node;
  };

  function buildPage(root) {
    const toolbar = el("div", "decisions-toolbar");
    const label = el("label", "decisions-query", "Filter decisions");
    const input = el("input");
    input.id = "decisions-query";
    input.type = "search";
    input.placeholder = "Agent, question, option…";
    input.autocomplete = "off";
    label.append(input);
    const blocking = el("label", "decisions-blocking");
    const checkbox = el("input");
    checkbox.id = "decisions-blocking";
    checkbox.type = "checkbox";
    blocking.append(checkbox, document.createTextNode(" Blocking only"));
    const refresh = el("button", "", "Refresh");
    refresh.id = "decisions-refresh";
    refresh.type = "button";
    const status = el("span", "muted");
    status.id = "decisions-status";
    status.setAttribute("role", "status");
    toolbar.append(label, blocking, refresh, status);
    const coverage = el("p", "decisions-coverage");
    coverage.id = "decisions-coverage";
    coverage.hidden = true;
    const list = el("div", "decisions-inbox-list");
    list.id = "decisions-inbox-list";
    root.append(toolbar, coverage, list);
    return root;
  }

  function viewFor(root) {
    if (!views.has(root)) views.set(root, { data: {}, actions: {}, signature: null });
    return views.get(root);
  }

  function searchable(agent, decision) {
    return [agent, decision.id, decision.question, decision.recommendation, decision.why, decision.link, ...(decision.options || [])]
      .filter((value) => typeof value === "string").join("\n").toLowerCase();
  }

  function visibleGroups(groups, query, blockingOnly) {
    const needle = String(query || "").trim().toLowerCase();
    return (groups || []).map((group) => ({
      agent: group.agent,
      decisions: (group.decisions || []).filter((decision) =>
        (!blockingOnly || decision.blocking) && (!needle || searchable(group.agent, decision).includes(needle))),
    })).filter((group) => group.decisions.length);
  }

  function bind(root, view) {
    find(root, "decisions-query").oninput = (event) => view.actions.setQuery(event.target.value);
    find(root, "decisions-blocking").onchange = (event) => view.actions.setBlockingOnly(event.target.checked);
    find(root, "decisions-refresh").onclick = () => view.actions.refresh();
  }

  function render(root, data, actions) {
    const view = viewFor(root);
    view.data = data || {};
    view.actions = actions || {};
    bind(root, view);
    const report = view.data.report;
    const query = String(view.data.query || "");
    const blockingOnly = !!view.data.blockingOnly;
    const input = find(root, "decisions-query");
    if (input.value !== query) input.value = query;
    find(root, "decisions-blocking").checked = blockingOnly;
    find(root, "decisions-refresh").disabled = !!view.data.loading;
    const status = find(root, "decisions-status");
    status.textContent = view.data.loading && !report ? "Loading…" : view.data.error
      ? (report ? `Couldn't refresh (${view.data.error}). Showing earlier results.` : `Couldn't load decisions: ${view.data.error}`)
      : String(view.data.notice || "");
    status.classList.toggle("decisions-error", !!view.data.error);
    const coverage = find(root, "decisions-coverage");
    coverage.textContent = report?.remoteHosts?.length
      ? `Not included from configured remote hosts: ${report.remoteHosts.join(", ")}. Connect to those servers directly to see their decisions.` : "";
    coverage.hidden = !coverage.textContent;
    const list = find(root, "decisions-inbox-list");
    if (!report) {
      const signature = JSON.stringify(["missing", !!view.data.loading, view.data.error || ""]);
      if (view.signature !== signature) list.replaceChildren(el("p", "empty", view.data.error ? "The decisions inbox is unavailable." : "Loading decisions…"));
      view.signature = signature;
      return;
    }
    if (!report.enabled) {
      if (view.signature !== "disabled") list.replaceChildren(el("p", "empty", "Decisions are disabled on this server."));
      view.signature = "disabled";
      return;
    }
    const groups = visibleGroups(report.groups, query, blockingOnly);
    const signature = JSON.stringify([groups, query, blockingOnly]);
    if (view.signature === signature) return;
    view.signature = signature;
    if (!groups.length) {
      list.replaceChildren(el("p", "empty", report.groups?.length ? "No decisions match these filters." : "No open decisions on this server."));
      return;
    }
    const nodes = [];
    for (const group of groups) {
      const section = el("section", "decisions-inbox-group");
      const heading = el("div", "decisions-inbox-heading");
      heading.append(el("h2", "", group.agent));
      const open = el("button", "decisions-open-agent", "Open agent");
      open.type = "button";
      open.onclick = () => view.actions.openAgent(group.agent);
      heading.append(open);
      const card = window.agentDecisions.renderDecisionCard(group.decisions, { agent: group.agent, showAnswer: false });
      section.append(heading);
      if (card) section.append(card);
      nodes.push(section);
    }
    list.replaceChildren(...nodes);
  }

  return { buildPage, render, visibleGroups };
})();
