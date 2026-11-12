"use strict";
// The PRs page: pure helpers plus DOM rendering for the /api/prs report. Shared with the
// desktop app, so it never fetches or reaches into app globals; everything arrives as arguments.
window.agentPrs = (() => {
  const STATES = ["needs-decision", "merge-ready", "conflict", "ci-failing", "shepherding", "waiting", "merged", "closed"];
  const STATE_LABELS = {
    "needs-decision": "Needs decision",
    "merge-ready": "Merge-ready",
    conflict: "Conflict",
    "ci-failing": "CI failing",
    shepherding: "Shepherding",
    waiting: "Waiting",
    merged: "Merged",
    closed: "Closed",
  };
  const PR_URL = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+$/;

  function stateLabel(state) {
    return STATE_LABELS[state] || String(state || "Unknown");
  }

  function relativeTime(iso, now = Date.now()) {
    const at = Date.parse(iso || "");
    if (!Number.isFinite(at)) return "";
    const minutes = Math.floor(Math.max(0, now - at) / 60000);
    if (minutes < 1) return "<1m";
    if (minutes < 60) return `${minutes}m`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h`;
    return `${Math.floor(hours / 24)}d`;
  }

  function reasonLine(pr, now = Date.now()) {
    const since = relativeTime(pr.since, now);
    return since ? `${pr.reason} · ${since}` : String(pr.reason || "");
  }

  function countsLine(counts) {
    if (!counts) return "";
    const parts = [`${counts.open || 0} open`];
    if (counts.needsMe) parts.push(`${counts.needsMe} ${counts.needsMe === 1 ? "needs" : "need"} you`);
    if (counts["merge-ready"]) parts.push(`${counts["merge-ready"]} merge-ready`);
    return parts.join(" · ");
  }

  function safePrUrl(url) {
    return typeof url === "string" && PR_URL.test(url) ? url : null;
  }

  function safeLink(url) {
    if (typeof url !== "string") return null;
    try {
      return new URL(url).protocol === "https:" ? url : null;
    } catch {
      return null;
    }
  }

  function repoOptions(prs) {
    return [...new Set((prs || []).map((pr) => pr.repository).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  }

  function filterPrs(prs, filters = {}) {
    const repo = (filters.repo || "").toLowerCase();
    return (prs || []).filter((pr) =>
      (!repo || String(pr.repository).toLowerCase() === repo) &&
      (!filters.state || pr.state === filters.state) &&
      (!filters.needsMe || pr.needsMe));
  }

  function nudgeText(pr) {
    const reason = String(pr.reason || "").trim();
    return `PR #${pr.number} (${pr.url}) is ${pr.state}: ${reason}${/[.?!]$/.test(reason) ? "" : "."} What is its status, and what do you need to move it forward?`;
  }

  function agentLabel(pr) {
    const name = pr.agentName || pr.agent;
    return pr.host ? `${name} on ${pr.host}` : name;
  }

  function stackLabel(pr) {
    return pr.stack ? `${pr.stack.position}/${pr.stack.size}` : "";
  }

  function stackTitle(pr) {
    if (!pr.stack) return "";
    const parts = [`Stack position ${pr.stack.position} of ${pr.stack.size}`];
    if (pr.stack.parent) parts.push(`based on #${pr.stack.parent}`);
    const children = pr.stack.children || [];
    if (children.length) parts.push(`${children.map((n) => "#" + n).join(", ")} ${children.length === 1 ? "builds" : "build"} on it`);
    return parts.join(" · ");
  }

  // Adjacent rows that are parent and child in one repository read as a chain; rows keep their order.
  function stackChains(prs) {
    const linked = (a, b) => !!a && !!b && a.repository === b.repository &&
      (b.stack?.parent === a.number || a.stack?.parent === b.number);
    return (prs || []).map((pr, i) => ({ up: linked(prs[i - 1], pr), down: linked(pr, prs[i + 1]) }));
  }

  function notes(pr) {
    const out = [];
    if (pr.readyMark?.note) out.push(pr.readyMark.note);
    if (pr.draft) out.push("draft");
    if (pr.alsoTrackedBy?.length) out.push(`also tracked by ${pr.alsoTrackedBy.join(", ")}`);
    const more = pr.decision?.more || 0;
    if (more > 0) out.push(`+${more} more decision${more === 1 ? "" : "s"}`);
    return out;
  }

  function noticeLine(report) {
    const parts = [];
    if (report?.stale?.length) parts.push(`GitHub lookups are failing for ${report.stale.join(", ")}; their rows may be out of date.`);
    if (report?.unreachable?.length) parts.push(`Unreachable hosts: ${report.unreachable.join(", ")}.`);
    return parts.join(" ");
  }

  // --- DOM -------------------------------------------------------------------
  // data:    { report, loading, error, includeOlder, now? }
  // actions: openAgent(key), openUrl(url), nudge(key, text), refresh(), setIncludeOlder(bool)
  const views = new WeakMap();
  const find = (root, id) => root.querySelector("#" + id);

  const el = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };

  // Mirrors index.html's #prs-page so a host without that page gets the same markup.
  function buildPage(root) {
    const h = (tag, attrs, ...children) => {
      const node = document.createElement(tag);
      for (const [name, value] of Object.entries(attrs || {})) node.setAttribute(name, value);
      node.append(...children);
      return node;
    };
    root.append(
      h("div", { class: "usage-toolbar" },
        h("div", { class: "usage-filters" },
          h("label", null, "Repo", h("select", { id: "prs-repo" }, h("option", { value: "" }, "All"))),
          h("label", null, "State", h("select", { id: "prs-state" }, h("option", { value: "" }, "All"),
            ...STATES.map((state) => h("option", { value: state }, STATE_LABELS[state])))),
          h("button", { id: "prs-needs-me", class: "prs-toggle", type: "button", "aria-pressed": "false" }, "Needs me"),
          h("button", { id: "prs-older", class: "prs-toggle", type: "button", "aria-pressed": "false" }, "Include older merged/closed"),
          h("button", { id: "prs-refresh", type: "button" }, "Refresh")),
        h("span", { id: "prs-status", class: "muted", role: "status" })),
      h("p", { id: "prs-summary", class: "prs-summary" }),
      h("p", { id: "prs-notice", class: "prs-notice", hidden: "" }),
      h("div", { id: "prs-list", class: "prs-list" }),
    );
    return root;
  }

  function viewFor(root) {
    if (!views.has(root)) views.set(root, { repo: "", state: "", needsMe: false, expanded: new Set(), data: null, actions: null });
    return views.get(root);
  }

  function bind(root, view) {
    find(root, "prs-repo").onchange = (event) => { view.repo = event.target.value; renderList(root); };
    find(root, "prs-state").onchange = (event) => { view.state = event.target.value; renderList(root); };
    find(root, "prs-needs-me").onclick = () => { view.needsMe = !view.needsMe; renderList(root); };
    find(root, "prs-older").onclick = () => view.actions?.setIncludeOlder(!view.data?.includeOlder);
    find(root, "prs-refresh").onclick = () => view.actions?.refresh();
  }

  function populateRepos(select, repos, current) {
    const list = [...repos];
    if (current && !list.includes(current)) list.unshift(current);
    const sig = JSON.stringify(list);
    if (select.dataset.options !== sig) {
      select.replaceChildren(new Option("All", ""), ...list.map((repo) => new Option(repo, repo)));
      select.dataset.options = sig;
    }
    select.value = current;
  }

  function render(root, data, actions) {
    const view = viewFor(root);
    view.data = data || {};
    view.actions = actions || {};
    bind(root, view);
    renderList(root);
  }

  function renderList(root) {
    const view = viewFor(root);
    const { report, loading, error, includeOlder } = view.data || {};
    const now = view.data?.now ?? Date.now();
    find(root, "prs-older").setAttribute("aria-pressed", String(!!includeOlder));
    find(root, "prs-needs-me").setAttribute("aria-pressed", String(view.needsMe));
    find(root, "prs-state").value = view.state;
    populateRepos(find(root, "prs-repo"), repoOptions(report?.prs), view.repo);

    const status = find(root, "prs-status");
    status.textContent = loading && !report ? "Loading…" : "";
    if (error && report) status.textContent = `Couldn't refresh (${error}). Showing data from ${relativeTime(report.generatedAt, now) || "earlier"} ago.`;
    status.classList.toggle("prs-error", !!error);

    find(root, "prs-summary").textContent = countsLine(report?.counts);
    const notice = find(root, "prs-notice");
    notice.textContent = noticeLine(report);
    notice.hidden = !notice.textContent;

    const list = find(root, "prs-list");
    if (!report) {
      list.replaceChildren(el("p", "empty", error ? `Couldn't load pull requests: ${error}` : "Loading pull requests…"));
      return;
    }
    if (!report.prs?.length) {
      const empty = el("p", "empty", "No tracked PRs — agents register theirs with ");
      empty.append(el("code", "", "am pr <agent> <url>"));
      list.replaceChildren(empty);
      return;
    }
    const filters = { repo: view.repo, state: view.state, needsMe: view.needsMe };
    const rows = filterPrs(report.prs, filters);
    if (!rows.length) {
      const empty = el("div", "empty");
      const clear = el("button", "", "Clear filters");
      clear.type = "button";
      clear.onclick = () => { view.repo = view.state = ""; view.needsMe = false; renderList(root); };
      empty.append(el("p", "", "No PRs match these filters."), clear);
      list.replaceChildren(empty);
      return;
    }
    const table = el("table", "usage-table prs-table");
    const head = el("tr");
    for (const [label, cls] of [["Pull request", "prs-col-pr"], ["Status", "prs-col-status"], ["Agent", "prs-col-agent"],
      ["Activity", "prs-col-activity"], ["Stack", "prs-col-stack"], ["Actions", "prs-col-actions actions-col"]]) head.append(el("th", cls, label));
    const thead = el("thead");
    thead.append(head);
    const tbody = el("tbody");
    const chains = stackChains(rows);
    rows.forEach((pr, i) => {
      tbody.append(prRow(root, view, pr, chains[i], now));
      if (pr.decision && view.expanded.has(pr.key)) tbody.append(decisionRow(pr, view.actions));
    });
    table.append(thead, tbody);
    list.replaceChildren(table);
  }

  // A plain click goes through actions.openUrl; modified clicks keep the browser's own handling.
  function externalLink(text, url, actions) {
    const link = el("a", "", text);
    link.href = url;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.onclick = (event) => {
      if (event.button || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      actions.openUrl?.(url);
    };
    return link;
  }

  function prRow(root, view, pr, chain, now) {
    const actions = view.actions;
    const tr = el("tr", "prs-row");
    tr.classList.toggle("prs-chain-up", chain.up);
    tr.classList.toggle("prs-chain-down", chain.down);
    tr.classList.toggle("prs-needs-me", !!pr.needsMe);
    const url = safePrUrl(pr.url);

    const prCell = el("td", "prs-col-pr");
    prCell.append(el("div", "prs-repo", pr.repository));
    const titleLine = el("div", "prs-title");
    const label = `#${pr.number} ${pr.title || ""}`.trim();
    if (url) titleLine.append(externalLink(label, url, actions));
    else titleLine.append(el("span", "", label));
    prCell.append(titleLine);

    const statusCell = el("td", "prs-col-status");
    const chips = el("div", "prs-chips");
    chips.append(el("span", `prs-chip state-${STATES.includes(pr.state) ? pr.state : "unknown"}`, stateLabel(pr.state)));
    if (pr.needsMe) chips.append(el("span", "prs-chip needs-you", "Needs you"));
    statusCell.append(chips, el("div", "prs-reason", reasonLine(pr, now)));
    const extra = notes(pr);
    if (extra.length) statusCell.append(el("div", "prs-notes", extra.join(" · ")));

    const agentCell = el("td", "prs-col-agent");
    const agentButton = el("button", "prs-agent", pr.agentName || pr.agent);
    agentButton.type = "button";
    agentButton.title = `Go to ${agentLabel(pr)}`;
    agentButton.onclick = () => actions.openAgent?.(pr.agent);
    agentCell.append(agentButton);
    const agentMeta = [pr.host, pr.agentStatus].filter(Boolean).join(" · ");
    if (agentMeta) agentCell.append(el("div", "prs-agent-meta", agentMeta));

    const activity = relativeTime(pr.lastActivity, now);
    const activityCell = el("td", "prs-col-activity", activity ? `${activity} ago` : "—");
    activityCell.title = pr.lastActivity || "";

    const stackCell = el("td", "prs-col-stack");
    if (pr.stack) {
      const stack = el("span", "prs-stack", stackLabel(pr));
      stack.title = stackTitle(pr);
      stack.setAttribute("aria-label", stackTitle(pr));
      stackCell.append(stack);
    }

    const actionCell = el("td", "prs-col-actions actions-col");
    const buttons = el("div", "prs-actions");
    const button = (text, aria, onclick) => {
      const node = el("button", "", text);
      node.type = "button";
      node.setAttribute("aria-label", aria);
      node.onclick = onclick;
      buttons.append(node);
      return node;
    };
    if (url) button("Open PR", `Open PR #${pr.number} on GitHub`, () => actions.openUrl?.(url));
    button("Go to agent", `Go to ${agentLabel(pr)}`, () => actions.openAgent?.(pr.agent));
    button("Nudge", `Nudge ${agentLabel(pr)} about PR #${pr.number}`, () => actions.nudge?.(pr.agent, nudgeText(pr)));
    if (pr.decision) {
      const open = view.expanded.has(pr.key);
      const toggle = button("Decision", `Decision for PR #${pr.number}`, () => {
        if (view.expanded.has(pr.key)) view.expanded.delete(pr.key);
        else view.expanded.add(pr.key);
        renderList(root);
        [...find(root, "prs-list").querySelectorAll("button[data-decision-for]")].find((node) => node.dataset.decisionFor === pr.key)?.focus();
      });
      toggle.setAttribute("aria-expanded", String(open));
      toggle.dataset.decisionFor = pr.key;
    }
    actionCell.append(buttons);

    tr.append(prCell, statusCell, agentCell, activityCell, stackCell, actionCell);
    return tr;
  }

  function decisionRow(pr, actions) {
    const tr = el("tr", "prs-decision-row");
    const td = el("td", "prs-decision");
    td.colSpan = 6;
    td.append(el("strong", "", pr.decision.blocking ? "Blocking decision" : "Decision"), el("p", "", pr.decision.question));
    if (pr.decision.link) {
      const link = safeLink(pr.decision.link);
      if (link) {
        td.append(externalLink("Open the discussion", link, actions));
      } else td.append(el("p", "prs-notes", pr.decision.link));
    }
    tr.append(td);
    return tr;
  }

  return {
    STATES,
    stateLabel,
    relativeTime,
    reasonLine,
    countsLine,
    safePrUrl,
    safeLink,
    repoOptions,
    filterPrs,
    nudgeText,
    agentLabel,
    stackLabel,
    stackTitle,
    stackChains,
    notes,
    noticeLine,
    buildPage,
    render,
  };
})();
