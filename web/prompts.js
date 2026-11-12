"use strict";
// Prompt and permission cards shared by the browser UI and the desktop app. The host
// does the network calls and refreshes through the callbacks in `actions`; needs
// window.agentTranscript (el, icon) and window.agentMarkdown.
//
// actions: answerPrompt(prompt, optionId, text?) and answerPermission(request, optionId)
// return promises that reject with an Error on failure; refresh() reloads the agent
// after an answer; retryLater() schedules a reload after a failed prompt answer;
// openTerminal() switches to the terminal; onError(message) reports a failed permission answer.
window.agentPrompts = (() => {
  const { el, icon } = window.agentTranscript;

  function terminalButton(actions) {
    const button = el("button", "text-button", "Open terminal");
    button.onclick = () => actions.openTerminal();
    return button;
  }
  function panePromptBox(prompt, actions) {
    const box = el("section", "permission question");
    box.setAttribute("aria-label", "Agent prompt");
    box.append(el("h3", "", prompt.kind === "permission" ? "Permission requested" : "Question from agent"));
    box.append(el("pre", "permission-call", prompt.kind === "permission" ? prompt.raw : prompt.title));
    const options = el("div", "question-options");
    const error = el("p", "question-note");
    error.setAttribute("role", "status");
    const submit = async (optionId, text) => {
      for (const control of box.querySelectorAll("button, input")) control.disabled = true;
      try {
        await actions.answerPrompt(prompt, optionId, text);
        error.textContent = "Answer sent. Waiting for the agent…";
        await actions.refresh();
      } catch (e) {
        error.textContent = e.message;
        // A failed request may have written some keys. Inspect before retrying.
        const terminal = box.querySelector(".text-button");
        if (terminal) terminal.disabled = false;
        actions.retryLater();
      }
    };
    for (const [index, option] of prompt.options.entries()) {
      if (option.other) {
        const form = el("form", "permission-actions prompt-other");
        const input = el("input");
        input.type = "text";
        input.placeholder = "Other — type your answer";
        input.setAttribute("aria-label", "Other answer");
        input.maxLength = 2000;
        input.required = true;
        const button = el("button", "", "Send answer");
        button.type = "submit";
        form.append(input, button);
        form.onsubmit = (event) => { event.preventDefault(); if (input.value.trim()) submit(option.id, input.value); };
        options.append(form);
      } else {
        const button = el("button", "question-option");
        const number = el("span", "question-index", String(index + 1));
        number.setAttribute("aria-hidden", "true");
        button.append(number, el("span", "question-label", option.label));
        if (option.description) button.append(el("span", "question-description", option.description));
        button.onclick = () => submit(option.id);
        options.append(button);
      }
    }
    box.append(options, error, terminalButton(actions));
    return box;
  }

  // AskUserQuestion arrives as a permission request; render its questions.
  function permissionBox(request, actions) {
    const asked = request.tool === "AskUserQuestion" && Array.isArray(request.input?.questions)
      ? request.input.questions.filter((q) => typeof q?.question === "string")
      : [];
    const questions = asked.length ? asked : null;
    const box = el("div", questions ? "permission question" : "permission");
    const answer = (option) => async () => {
      for (const other of box.querySelectorAll("button")) other.disabled = true;
      try {
        await actions.answerPermission(request, option.id);
        await actions.refresh();
      } catch (e) {
        actions.onError(e.message);
        for (const other of box.querySelectorAll("button")) other.disabled = false;
      }
    };
    if (!questions) {
      const title = el("h3", "", "Permission requested");
      title.prepend(icon("shield"));
      box.append(title);
      const call = el("pre", "permission-call");
      call.append(el("strong", "", request.tool), document.createTextNode(request.summary.startsWith(request.tool + ":") ? request.summary.slice(request.tool.length + 1) : ""));
      box.append(call);
      const buttons = el("div", "permission-actions");
      for (const option of request.options) {
        const button = el("button", option.kind === "allow" ? "primary" : "", option.label);
        button.onclick = answer(option);
        buttons.append(button);
      }
      box.append(buttons);
      return box;
    }
    const answers = new Map(request.options.filter((o) => o.id.startsWith("answer-")).map((o) => [o.label, o]));
    for (const question of questions) {
      if (question.header) box.append(el("span", "question-header", question.header));
      box.append(window.agentMarkdown.render(el("div", "turn-text question-text"), question.question));
      const list = el("div", "question-options");
      for (const [index, choice] of (Array.isArray(question.options) ? question.options : []).filter((c) => typeof c?.label === "string").entries()) {
        const option = answers.get(choice.label);
        const item = el(option ? "button" : "div", "question-option");
        const number = el("span", "question-index", String(index + 1));
        number.setAttribute("aria-hidden", "true");
        item.append(number, el("span", "question-label", choice.label));
        if (choice.description) item.append(el("span", "question-description", choice.description));
        if (option) item.onclick = answer(option);
        list.append(item);
      }
      box.append(list);
    }
    const footer = el("div", "permission-actions");
    footer.append(el("span", "question-note", answers.size ? "Or answer in the terminal." : "Answer in the terminal."));
    for (const option of request.options.filter((o) => !o.id.startsWith("answer-"))) {
      const button = el("button", "text-button", option.label);
      button.onclick = answer(option);
      footer.append(button);
    }
    footer.append(terminalButton(actions));
    box.append(footer);
    return box;
  }

  // Polling re-renders only when the prompt changes, so a typed Other answer or an open
  // raw-pane disclosure survives. `key` identifies the agent in that comparison.
  function renderPromptCards(container, { key, detail, permissions, ...actions }) {
    const content = JSON.stringify([key, detail.panePrompt, permissions.requests, detail.status]);
    if (container.dataset.content === content) {
      const rawPane = container.querySelector(".prompt-raw-pane");
      if (rawPane) rawPane.textContent = detail.pane || "No active terminal.";
      return;
    }
    container.dataset.content = content;
    container.replaceChildren();
    if (detail.panePrompt) {
      container.append(panePromptBox(detail.panePrompt, actions));
    } else {
      for (const request of permissions.requests) container.append(permissionBox(request, actions));
      if (detail.status === "needs-attention" && !permissions.requests.length) {
        const box = el("section", "permission");
        box.append(el("h3", "", "Agent needs attention"), el("p", "question-note", "This prompt could not be recognized. Answer it in the web terminal."));
        const raw = el("details");
        raw.append(el("summary", "", "Show raw pane"), el("pre", "permission-call prompt-raw-pane", detail.pane || "No active terminal."));
        box.append(raw, terminalButton(actions));
        container.append(box);
      }
    }
  }

  return { renderPromptCards, panePromptBox, permissionBox };
})();
