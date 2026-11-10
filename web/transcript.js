"use strict";
// Chat transcript rendering shared by the browser UI and the desktop app. Builds DOM
// nodes only, so agent text cannot inject markup; needs window.agentMarkdown and window.agentLinks.
window.agentTranscript = (() => {
  const el = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) {
      if (className === "turn-text") window.agentMarkdown.render(node, text);
      else if (tag === "pre") window.agentLinks.render(node, text);
      else node.textContent = text;
    }
    return node;
  };
  const ICONS = {
    command: ["m4 17 6-6-6-6", "M12 19h8"],
    read: ["M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z", "M14 2v4a2 2 0 0 0 2 2h4", "M16 13H8", "M16 17H8"],
    edit: ["M12 20h9", "M16.4 3.6a2.1 2.1 0 1 1 3 3L7 19l-4 1 1-4Z"],
    search: ["M3 11a8 8 0 1 0 16 0a8 8 0 1 0-16 0", "m21 21-4.3-4.3"],
    other: ["M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.8-3.8a6 6 0 0 1-7.9 7.9l-6.9 6.9a2.1 2.1 0 0 1-3-3l6.9-6.9a6 6 0 0 1 7.9-7.9z"],
    chevron: ["m9 18 6-6-6-6"],
    shield: ["M20 13c0 5-3.5 7.5-7.7 9a1 1 0 0 1-.6 0C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.2-2.7a1.2 1.2 0 0 1 1.6 0C14.5 3.8 17 5 19 5a1 1 0 0 1 1 1z", "M12 8v4", "M12 16h.01"],
  };
  function icon(name, className = "icon") {
    const ns = "http://www.w3.org/2000/svg", svg = document.createElementNS(ns, "svg");
    for (const [attr, value] of Object.entries({
      class: className, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor",
      "stroke-width": "2", "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true",
    })) svg.setAttribute(attr, value);
    for (const d of ICONS[name]) {
      const path = document.createElementNS(ns, "path");
      path.setAttribute("d", d);
      svg.append(path);
    }
    return svg;
  }
  // Claude names its tools; Codex runs commands as `exec` code cells, `shell` or
  // `exec_command`; Antigravity uses snake_case tool names (`run_command`, `read_file`, `edit_file`, etc.).
  function toolKind(entry) {
    const name = entry.name || "";
    if (/^(Bash|BashOutput|KillShell|shell|local_shell|exec_command|unified_exec|write_stdin|run_command|manage_task)$/.test(name)) return "command";
    if (name === "exec") return /apply_patch/.test(entry.input || "") && !/exec_command/.test(entry.input || "") ? "edit" : "command";
    if (/^(Read|NotebookRead|view_image|read_file|read_resource)$/.test(name)) return "read";
    if (/^(Edit|Write|MultiEdit|NotebookEdit|apply_patch|write_file|edit_file)$/.test(name)) return "edit";
    if (/^(Grep|Glob|LS|WebSearch|web_search|search_web|grep_files|grep_search|find_by_name|list_dir|list_resources|tool_search|ToolSearch)$/.test(name)) return "search";
    return "other";
  }
  function toolLabel(entry, kind) {
    const raw = entry.input || "";
    let input = null;
    try { input = JSON.parse(raw); } catch {}
    const pick = (...keys) => {
      for (const key of keys) {
        const value = input?.[key];
        if (typeof value === "string" && value) return value;
        if (Array.isArray(value) && value.every((part) => typeof part === "string")) return value.join(" ");
      }
      return "";
    };
    const firstLine = (text) => text.split("\n").find((line) => line.trim())?.trim() || "";
    let detail = "";
    if (kind === "command") {
      detail = pick("command", "cmd", "CommandLine", "toolSummary", "chars");
      if (!detail && entry.name === "exec") {
        const cmds = [...raw.matchAll(/\bcmd\s*:\s*"((?:[^"\\]|\\.)*)"/g)].map((match) => {
          try { return JSON.parse(`"${match[1]}"`); } catch { return match[1]; }
        });
        const calls = [...raw.matchAll(/\btools\.(\w+)\s*\(/g)].map((match) => match[1]);
        detail = cmds.length ? cmds.join(" ; ") : calls.length ? [...new Set(calls)].join(", ") : firstLine(raw);
      }
    } else if (kind === "read" || kind === "edit") {
      detail = pick("file_path", "notebook_path", "path", "Path", "Uri");
      if (!detail) detail = [...raw.matchAll(/\*\*\* (?:Update|Add|Delete) File: (.+)/g)].map((match) => match[1].trim()).join(", ");
    } else if (kind === "search") detail = [pick("pattern", "Pattern", "query", "Query"), pick("path", "Path", "SearchPath", "glob")].filter(Boolean).join(" in ");
    else detail = pick("description", "summary", "toolSummary", "query", "Query", "url", "prompt", "Prompt", "Role", "ToolName", "action", "Action", "skill");
    if (!detail && kind !== "other") detail = firstLine(raw);
    if (kind === "other") return detail ? `${entry.name} · ${firstLine(detail)}` : entry.name;
    return firstLine(detail) || entry.name;
  }
  const TOOL_SUMMARY = {
    command: ["Ran", "command", "commands"],
    read: ["Read", "file", "files"],
    edit: ["Edited", "file", "files"],
    search: ["Searched", "time", "times"],
    other: ["Used", "tool", "tools"],
  };
  function toolGroup(entry) {
    const group = el("details", "work-group"), summary = el("summary", "work-row work-header");
    const glyph = el("span", "work-icon"), label = el("span", "work-label"), list = el("div", "work-list");
    group.dataset.scrollKey = "group:" + entry.index;
    list.dataset.scrollKey = "list:" + entry.index;
    summary.append(glyph, label, icon("chevron", "icon work-chevron"));
    group.append(summary, list);
    const counts = new Map();
    return Object.assign(group, {
      add(entry) {
        const kind = toolKind(entry);
        counts.set(kind, (counts.get(kind) || 0) + 1);
        if (counts.size === 1 && counts.get(kind) === 1) glyph.append(icon(kind));
        label.textContent = [...counts].map(([kind, count], index) => {
          const [verb, one, many] = TOOL_SUMMARY[kind];
          const text = `${verb} ${count} ${count === 1 ? one : many}`;
          return index ? text[0].toLowerCase() + text.slice(1) : text;
        }).join(", ");
        const call = el("details", "work-entry"), row = el("summary", "work-row");
        call.dataset.scrollKey = "tool:" + entry.index;
        const text = toolLabel(entry, kind), slash = text.lastIndexOf("/");
        let name;
        // File rows lead with the file name; the directory trails, muted, and truncates first.
        if ((kind === "read" || kind === "edit") && slash > 0 && slash < text.length - 1 && !/[,\s]/.test(text)) {
          name = el("span", "work-label mono");
          name.append(el("span", "work-file", text.slice(slash + 1)), el("span", "work-dir", " " + text.slice(0, slash + 1)));
        } else name = el("span", "work-label" + (kind === "other" ? "" : " mono"), text);
        row.title = text;
        const iconBox = el("span", "work-icon");
        iconBox.append(icon(kind));
        row.append(iconBox, name);
        const outputText = [entry.input, entry.output].filter(Boolean).join("\n\n");
        const size = `${outputText.split("\n").length} lines · ${outputText.length.toLocaleString()} characters`;
        row.append(el("span", "tool-size", size));
        const output = el("pre", "work-detail", outputText);
        output.dataset.scrollKey = "output:" + entry.index;
        call.append(row, output);
        list.append(call);
      },
    });
  }
  // Speaker names are for screen readers; the layout already shows who said what.
  function collapsibleMessage(entry) {
    if (entry.kind !== "user") return null;
    const text = entry.text?.trim() || "";
    const bounded = (value, max = 140) => {
      const clean = String(value || "").slice(0, 131072).replace(/\s+/g, " ").trim();
      return clean.length > max ? clean.slice(0, max) + "…" : clean;
    };
    const wrapped = (tag) => text.startsWith(`<${tag}>`) &&
      text.indexOf(`</${tag}>`, tag.length + 2) === text.length - tag.length - 3;
    const notice = (label, preview = "", subject = "context") => ({ label, preview: bounded(preview), subject });
    const peer = /^\[am · from ([^\]\r\n]{1,160})\](?:[ \t]*\r?\n|[ \t]+|$)/u.exec(text);
    // Sender labels are display hints only; transcript text cannot establish provenance.
    if (peer) return { peer: peer[1], body: text.slice(peer[0].length) };
    const pr = /^\[am\] PR #([1-9]\d{0,9}) (merged(?: at [a-f0-9]{7,64} on [^\r\n]{1,80})?|closed without merging|reopened)(?:\r?\n|$)/.exec(text);
    if (pr) {
      const status = pr[2].startsWith("merged") ? "merged" : pr[2] === "reopened" ? "reopened" : "closed";
      const lines = text.slice(0, 1024).split(/\r?\n/);
      const repository = /^Repository: ([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)$/.exec(lines[1] || "")?.[1];
      const info = notice(`↗ PR #${pr[1]} · ${status}`, repository || "", "PR update");
      const url = repository && `https://github.com/${repository}/pull/${pr[1]}`;
      if (url && lines[2] === url) info.link = url;
      return info;
    }
    if (wrapped("send_user_message_question_reply")) {
      const info = notice("Question answered", "", "question reply");
      if (text.length > 131072) return info;
      try {
        const tag = "send_user_message_question_reply";
        const replies = JSON.parse(text.slice(tag.length + 2, -tag.length - 3));
        if (Array.isArray(replies) && replies.length && replies.every(reply =>
          reply && typeof reply.question === "string" && typeof reply.answer === "string")) {
          info.label = replies.length === 1 ? "Question answered" : `${replies.length} questions answered`;
          info.result = replies.slice(0, 3).map(reply =>
            `Q: ${bounded(reply.question, 240)}\nA: ${bounded(reply.answer, 1200)}`).join("\n\n");
          if (replies.length > 3) info.preview = `${replies.length - 3} more in details`;
        }
      } catch {}
      return info;
    }
    if (wrapped("task-notification")) {
      const info = notice("⤷ Task notification", "", "notification");
      if (text.length > 131072) return info;
      // Scan top-level fields so tags quoted inside a result cannot become metadata.
      const fields = (body) => {
        const values = {};
        let offset = 0;
        for (let i = 0; i < 32; i++) {
          while (/\s/.test(body[offset] || "") && offset < body.length) offset++;
          const start = /^<([a-z_-]{1,40})>/.exec(body.slice(offset, offset + 43));
          if (!start) break;
          const end = body.indexOf(`</${start[1]}>`, offset + start[0].length);
          if (end < 0) break;
          values[start[1]] = body.slice(offset + start[0].length, end).trim();
          offset = end + start[1].length + 3;
        }
        return values;
      };
      const data = fields(text.slice(19, -20));
      const summary = bounded(data.summary);
      const named = /^(?:Agent|Task) "([^"\n]{1,120})"/.exec(summary);
      const title = named ? named[1] : summary || "Task notification";
      const status = bounded(data.status, 30);
      const usage = fields(data.usage || "");
      const parts = ["⤷ " + title, status];
      if (/^\d{1,12}$/.test(usage.duration_ms || "")) parts.push(Math.round(Number(usage.duration_ms) / 1000) + "s");
      if (/^\d{1,9}$/.test(usage.tool_uses || "")) parts.push(usage.tool_uses + " tools");
      info.label = parts.filter(Boolean).join(" · ");
      info.result = bounded(data.result, 1200);
      info.preview = bounded(data.note, 240);
      return info;
    }
    if (wrapped("subagent_notification")) {
      const info = notice("Subagent notification", "", "notification");
      if (text.length > 131072) return info;
      const body = text.slice(23, -24).trim();
      try {
        const data = JSON.parse(body);
        const status = data?.status;
        const key = ["completed", "errored", "failed", "running", "spawned"].find(key => typeof status?.[key] === "string");
        if (key) {
          info.label = "⤷ " + bounded(data.agent_nickname || data.agent_path || data.agent_id || "Subagent", 100) + " · " + key;
          info.result = bounded(status[key], 1200);
          return info;
        }
      } catch {}
      info.preview = bounded(body);
      return info;
    }
    if (/^# AGENTS\.md instructions(?: for [^\n]+)?(?:\r?\n|$)/.test(text))
      return notice("AGENTS.md instructions", "Repository guidance", "instructions");
    if (/^You are running as a managed agent named "[^"\r\n]{1,160}" in a tmux session controlled by the `am` CLI \(Agent Motel\), alongside other managed agents\.(?:\r?\n|$)/.test(text))
      return notice("Managed agent setup", "Agent Motel bootstrap and role instructions", "instructions");
    const contextTags = ["environment_context", "user_instructions", "turn_context", "permissions", "system-reminder", "hook", "hook-output"];
    let rest = text, firstTag = "";
    for (let i = 0; i < 32 && rest; i++) {
      const tag = contextTags.find(tag => rest.startsWith(`<${tag}>`));
      if (!tag) break;
      const end = rest.indexOf(`</${tag}>`, tag.length + 2);
      if (end < 0) break;
      firstTag ||= tag;
      rest = rest.slice(end + tag.length + 3).trimStart();
    }
    if (!rest && firstTag) {
      const hook = ["system-reminder", "hook", "hook-output"].includes(firstTag);
      return notice(hook ? "System / hook notice" : "Session context", "", hook ? "notice" : "context");
    }
    const inbox = (value) => /^\[am inbox\] (?:Before you finish: you have \d+ messages? to handle first |You have \d+ messages? \()/.test(value) &&
      value.includes("\n[am message data begin]\n") && value.includes("\n[am message data end]");
    if (inbox(text)) return notice("AM inbox", "Messages delivered while the agent was busy", "messages");
    if (text.startsWith("{") && text.length <= 131072) {
      try {
        const data = JSON.parse(text);
        if (data.decision === "block" && typeof data.reason === "string" && inbox(data.reason))
          return notice("AM stop inbox", "Messages to handle before finishing", "messages");
      } catch {}
    }
    return null;
  }
  function chatTurn(entry, agentName) {
    const user = entry.kind === "user";
    const disclosure = collapsibleMessage(entry);
    const peer = disclosure?.peer;
    const turn = el("article", `turn ${peer ? "peer" : disclosure ? "notice" : user ? "user" : "assistant"}`);
    turn.dataset.scrollKey = "turn:" + entry.index;
    const turnText = (text, suffix = "") => {
      const body = el("div", "turn-text");
      window.agentMarkdown.render(body, text, `turn:${entry.index}${suffix}`);
      return body;
    };
    const label = peer || disclosure?.label || (user ? "You" : agentName);
    turn.append(el("span", disclosure ? "turn-label notice-label" : "turn-label sr-only", label));
    if (!disclosure || peer) turn.append(turnText(peer ? disclosure.body : entry.text));
    else {
      if (disclosure.result) turn.append(el("div", "notice-result", disclosure.result));
      if (disclosure.preview) turn.append(el("div", "notice-preview", disclosure.preview));
      if (disclosure.link) turn.append(turnText(`[Open pull request](${disclosure.link})`, ":link"));
      const notice = el("details", "message-disclosure");
      notice.dataset.scrollKey = "notice:" + entry.index;
      const summary = el("summary", "message-disclosure-summary", "Details · " + disclosure.subject);
      summary.dataset.scrollKey = "notice-summary:" + entry.index;
      const body = turnText(entry.text, ":notice");
      body.dataset.scrollKey = "notice-body:" + entry.index;
      notice.append(summary, body);
      turn.append(notice);
    }
    return turn;
  }
  // Consecutive tool calls share one collapsible group; the unread marker also breaks a group.
  function renderEntries(view, entries, { agentName, readBoundary = null } = {}) {
    let tools = null, markedUnread = false;
    for (const entry of entries) {
      if (!markedUnread && typeof readBoundary === "number" && entry.index > readBoundary) {
        view.append(el("div", "unread-marker", "New since your last visit"));
        markedUnread = true;
        tools = null;
      }
      if (entry.kind === "tool") {
        if (!tools) view.append(tools = toolGroup(entry));
        tools.add(entry);
      } else {
        tools = null;
        view.append(chatTurn(entry, agentName));
      }
    }
  }
  // Anchor visible content as well as scrollTop: tool output and the dock's
  // sliding message window can change the height above the reader.
  function preserveConversationScroll(view, threshold) {
    const scroll = view.scrollTop;
    const atBottom = view.scrollHeight - scroll - view.clientHeight < threshold;
    const top = view.getBoundingClientRect().top;
    const nodes = [...view.querySelectorAll("[data-scroll-key]")];
    const wrapStates = new Map([...view.querySelectorAll("[data-wrap-key]")]
      .map(node => [node.dataset.wrapKey, node.dataset.wrapped === "true"]));
    const focused = nodes.find(node => node === view.ownerDocument?.activeElement)?.dataset.scrollKey;
    const open = new Set(nodes.filter(node => node.open).map(node => node.dataset.scrollKey));
    const positions = new Map(nodes.map(node => [node.dataset.scrollKey, { top: node.scrollTop, left: node.scrollLeft }]));
    const visible = nodes.filter(node => {
      const rect = node.getBoundingClientRect();
      return rect.height && rect.bottom > top && rect.top < top + view.clientHeight;
    });
    const anchors = visible.filter(node => !visible.some(other => other !== node && node.contains(other)))
      .map(node => ({ key: node.dataset.scrollKey, offset: node.getBoundingClientRect().top - top }));
    return (follow = true) => {
      const updated = [...view.querySelectorAll("[data-scroll-key]")];
      for (const node of view.querySelectorAll("[data-wrap-key]")) {
        const wrapped = wrapStates.get(node.dataset.wrapKey);
        if (wrapped !== undefined && wrapped !== (node.dataset.wrapped === "true"))
          node.querySelector('[aria-label="Wrap code lines"]')?.click();
      }
      for (const node of updated)
        if (node.tagName === "DETAILS") node.open = open.has(node.dataset.scrollKey);
      for (const node of updated) {
        const position = positions.get(node.dataset.scrollKey);
        if (position) { node.scrollTop = position.top; node.scrollLeft = position.left; }
      }
      if (focused) updated.find(node => node.dataset.scrollKey === focused)?.focus({ preventScroll: true });
      if (atBottom && follow) { view.scrollTop = view.scrollHeight; return; }
      const anchor = anchors.find(anchor => updated.some(node => node.dataset.scrollKey === anchor.key));
      const node = anchor && updated.find(node => node.dataset.scrollKey === anchor.key);
      view.scrollTop = node ? view.scrollTop + node.getBoundingClientRect().top - view.getBoundingClientRect().top - anchor.offset : scroll;
    };
  }
  return { el, icon, toolKind, toolLabel, toolGroup, collapsibleMessage, chatTurn, renderEntries, preserveConversationScroll };
})();
