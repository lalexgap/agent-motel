"use strict";
// The open-decisions card shown above an agent's conversation. It never fetches or
// reaches into app globals: the decisions and callbacks arrive as arguments, and
// answering happens on the decisions page, which the host opens through onAnswer;
// this file never sees that page's URL.
// Decision text is written by agents, so it only ever goes in through textContent.
window.agentDecisions = (() => {
  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
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

  // Only http(s) links become anchors; anything else (javascript:, data:) stays text.
  function safeLink(value) {
    if (typeof value !== "string") return null;
    try {
      const url = new URL(value);
      return url.protocol === "https:" || url.protocol === "http:" ? url.href : null;
    } catch {
      return null;
    }
  }

  function countLabel(decisions) {
    const n = decisions.length;
    return `${n} decision${n === 1 ? "" : "s"} waiting on you`;
  }

  // opts: { agent, now, unavailable, onAnswer(decision, agent) }. onAnswer may return a
  // promise (no payload) to keep the button busy until it settles.
  function decisionItem(decision, opts) {
    const item = el("li", "decision-item" + (decision.blocking ? " blocking" : ""));
    const head = el("div", "decision-head");
    head.append(el("span", "decision-id", decision.id));
    if (decision.blocking) head.append(el("span", "decision-blocking", "Blocking"));
    const age = relativeTime(decision.asked_at, opts.now);
    if (age) {
      const time = el("span", "decision-age", `asked ${age} ago`);
      time.title = decision.asked_at;
      head.append(time);
    }
    item.append(head, el("p", "decision-question", decision.question));
    if (decision.why) {
      const why = el("p", "decision-why");
      why.append(el("span", "decision-label", "Why "), document.createTextNode(decision.why));
      item.append(why);
    }
    if (decision.recommendation) {
      const rec = el("p", "decision-recommendation");
      rec.append(el("span", "decision-label", "Recommends "), document.createTextNode(decision.recommendation));
      item.append(rec);
    }
    const options = Array.isArray(decision.options) ? decision.options.filter((o) => typeof o === "string") : [];
    if (options.length) {
      const list = el("ul", "decision-options");
      list.setAttribute("aria-label", "Options");
      for (const option of options) list.append(el("li", "decision-option", option));
      item.append(list);
    }
    const footer = el("div", "decision-actions");
    const href = safeLink(decision.link);
    if (href) {
      const link = el("a", "decision-link", "Context ↗");
      link.href = href;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.title = href;
      footer.append(link);
    } else if (decision.link) {
      footer.append(el("span", "decision-link-text", decision.link));
    }
    if (typeof opts.onAnswer === "function") {
      const button = el("button", "decision-answer", "Answer on the decisions page");
      button.type = "button";
      if (opts.unavailable) {
        button.disabled = true;
        button.title = opts.unavailable;
      }
      let busy = false;
      button.onclick = async () => {
        if (busy) return;
        busy = true;
        button.disabled = true;
        button.setAttribute("aria-busy", "true");
        try {
          await opts.onAnswer(decision, opts.agent);
        } catch {
          // the host reports its own failures
        } finally {
          busy = false;
          button.removeAttribute("aria-busy");
          button.disabled = !!opts.unavailable;
        }
      };
      footer.append(button);
    }
    item.append(footer);
    return item;
  }

  function renderDecisionCard(decisions, opts = {}) {
    const open = Array.isArray(decisions) ? decisions.filter((d) => d && typeof d.question === "string") : [];
    if (!open.length) return null;
    const settings = { now: Date.now(), ...opts };
    const card = el("section", "decisions-card" + (open.some((d) => d.blocking) ? " blocking" : ""));
    card.setAttribute("aria-label", countLabel(open));
    card.append(el("h3", "decisions-title", countLabel(open)));
    const list = el("ol", "decision-list");
    for (const decision of open) list.append(decisionItem(decision, settings));
    card.append(list);
    if (settings.unavailable) card.append(el("p", "decisions-unavailable", settings.unavailable));
    return card;
  }

  return { renderDecisionCard, relativeTime, safeLink, countLabel };
})();
