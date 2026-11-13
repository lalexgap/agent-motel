"use strict";
// The open-decisions card shown above an agent's conversation. It never fetches or
// reaches into app globals: the decisions and callbacks arrive as arguments, and
// writes happen only through host callbacks; this file never sees a token or
// capability URL. Drafts live here so host polling can safely rebuild cards.
// Decision text is written by agents, so it only ever goes in through textContent.
window.agentDecisions = (() => {
  const drafts = new Map();
  const submissions = new Map();

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

  const keyFor = (scope, agent, decision) => `${scope}\n${agent}\n${decision.id}`;

  function draftFor(scope, agent, decision) {
    const key = keyFor(scope, agent, decision);
    if (!drafts.has(key)) drafts.set(key, { choice: "", custom: "", reason: "", error: "", success: "" });
    return drafts.get(key);
  }

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
    const key = keyFor(opts.scope, opts.agent, decision);
    const draft = draftFor(opts.scope, opts.agent, decision);
    const choices = Array.isArray(decision.options) ? decision.options.filter((o) => typeof o === "string") : [];
    const form = el("div", "decision-form");
    const options = el("fieldset", "decision-options");
    const legend = el("legend", "decision-options-label", "Choose an answer");
    options.append(legend);
    const radioName = `decision-${opts.agent}-${decision.id}`;
    choices.forEach((option, index) => {
      const label = el("label", "decision-option");
      const radio = el("input");
      radio.type = "radio";
      radio.name = radioName;
      radio.value = option;
      radio.setAttribute("data-decision-focus", `${key}\noption-${index}`);
      radio.checked = draft.choice === option;
      radio.onchange = () => { if (radio.checked) { draft.choice = option; draft.error = draft.success = ""; } };
      label.append(radio, document.createTextNode(option));
      options.append(label);
    });
    const customLabel = el("label", "decision-option decision-option-custom");
    const customRadio = el("input");
    customRadio.type = "radio";
    customRadio.name = radioName;
    customRadio.value = "custom";
    customRadio.setAttribute("data-decision-focus", `${key}\noption-custom`);
    customRadio.checked = draft.choice === "custom";
    customRadio.onchange = () => { if (customRadio.checked) { draft.choice = "custom"; draft.error = draft.success = ""; custom.focus?.(); } };
    customLabel.append(customRadio, document.createTextNode("Other"));
    options.append(customLabel);
    const custom = el("textarea", "decision-custom");
    custom.rows = 2;
    custom.maxLength = 4000;
    custom.placeholder = "Write another answer";
    custom.setAttribute("data-decision-focus", `${key}\ncustom`);
    custom.value = draft.custom;
    custom.oninput = () => { draft.custom = custom.value; draft.choice = "custom"; customRadio.checked = true; draft.error = draft.success = ""; };
    form.append(options, custom);
    if (!choices.length) {
      draft.choice = "custom";
      customRadio.checked = true;
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
    if (typeof opts.onSubmit === "function") {
      const status = el("span", "decision-submit-status");
      status.setAttribute("role", "status");
      const submit = el("button", "decision-answer", "Submit answer");
      submit.type = "button";
      submit.setAttribute("data-decision-focus", `${key}\nsubmit`);
      const reason = el("input", "decision-withdraw-reason");
      reason.type = "text";
      reason.maxLength = 4000;
      reason.placeholder = "Reason (optional)";
      reason.setAttribute("data-decision-focus", `${key}\nreason`);
      reason.value = draft.reason;
      reason.oninput = () => { draft.reason = reason.value; draft.error = draft.success = ""; };
      const withdraw = el("button", "decision-withdraw", "No longer relevant");
      withdraw.type = "button";
      withdraw.setAttribute("data-decision-focus", `${key}\nwithdraw`);
      if (opts.unavailable) submit.title = withdraw.title = opts.unavailable;
      const show = () => {
        const pending = submissions.has(key);
        submit.disabled = withdraw.disabled = pending || !!opts.unavailable;
        custom.disabled = reason.disabled = pending || !!opts.unavailable;
        submit.toggleAttribute?.("aria-busy", pending);
        status.textContent = pending ? "Submitting…" : draft.error || draft.success;
        status.classList.toggle("decisions-error", !!draft.error);
      };
      const send = async (action) => {
        if (submissions.has(key)) return submissions.get(key);
        const text = action === "answer" ? (draft.choice === "custom" ? draft.custom.trim() : draft.choice) : draft.reason.trim();
        if (action === "answer" && !text) { draft.error = "Choose an option or write an answer."; draft.success = ""; show(); return; }
        draft.error = draft.success = "";
        const pending = Promise.resolve(opts.onSubmit(decision, opts.agent, action, text, opts.scope));
        submissions.set(key, pending);
        show();
        try {
          await pending;
          draft.success = action === "answer" ? "Answer submitted." : "Marked no longer relevant.";
          drafts.delete(key);
        } catch (error) {
          draft.error = error instanceof Error ? error.message : "Could not submit. Try again.";
        } finally {
          if (submissions.get(key) === pending) submissions.delete(key);
          show();
        }
      };
      submit.onclick = () => send("answer");
      withdraw.onclick = () => send("withdraw");
      show();
      footer.append(submit);
      const withdrawControls = el("div", "decision-withdraw-controls");
      withdrawControls.append(reason, withdraw);
      form.append(footer, withdrawControls, status);
    } else if (typeof opts.onOpenExternal === "function") {
      const button = el("button", "decision-answer", "Answer externally");
      button.type = "button";
      button.onclick = () => opts.onOpenExternal(decision, opts.agent);
      footer.append(button);
      form.append(footer);
    } else {
      form.append(footer);
    }
    item.append(form);
    return item;
  }

  function renderDecisionCard(decisions, opts = {}) {
    const open = Array.isArray(decisions) ? decisions.filter((d) => d && typeof d.question === "string") : [];
    if (!open.length) return null;
    const settings = { now: Date.now(), scope: "default", ...opts };
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
