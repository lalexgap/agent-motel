// The message box: send mode, sending and cancelling queued messages, errors,
// and why an agent cannot take a message.
import { call, isNative } from "./bridge";
import { renderTranscript } from "./chat";
import {
  cancelOutcome,
  FORCED_QUEUE_HINT,
  MODE_HINT,
  modeFor,
  notePending,
  putDraft,
  rejectionOutcome,
  sendModeFor,
  sendOutcome,
  textAfterSend,
  type Outcome,
  withoutMessage,
} from "./composer";
import { loadDetail } from "./data";
import { $, composerInput, h } from "./dom";
import { autosize, onComposerInput, saveDrafts, stashDraft } from "./drafts";
import { parseAgentKey, STOPPED } from "./fleet";
import { checkMessageText, MESSAGE_EMPTY, type SendMode } from "./policy";
import { focusCursor } from "./sidebar";
import { agentComposer, agentSource, changed, composer, isConcierge, state, subscribe } from "./state";
import { saveSendModeRaw } from "./store";

const isMac = (): boolean => isNative() || /Mac|iPhone|iPad/.test(navigator.platform);

function modeChoice(key: string) {
  return modeFor(agentSource(key).provider, composer.preference);
}

// Why the selected agent cannot take a message, or null.
function blockedReason(key: string): string | null {
  if (state.detail?.key === key && state.detail.notFound) return "This agent is not on the server any more.";
  const source = agentSource(key);
  if (source.status && STOPPED.has(source.status)) {
    return `This agent is stopped. Resume it with am resume ${source.name ?? parseAgentKey(key)?.id ?? ""} or from the web UI to send.`;
  }
  return null;
}

function keyHint(label: string, keys: string[]): HTMLElement {
  const node = h("span", "am-key-hint");
  for (const key of keys) node.append(h("kbd", "", key));
  node.append(document.createTextNode(label));
  return node;
}

function renderComposer(): void {
  const key = state.selected;
  if (!key) return;
  const input = composerInput();
  const blocked = blockedReason(key);
  const known = !!agentSource(key).provider;
  const choice = modeChoice(key);
  const sending = composer.sending.has(key);
  const form = $("am-composer");
  form.classList.toggle("blocked", !!blocked);
  const note = $("am-composer-blocked");
  note.hidden = !blocked;
  if (note.textContent !== (blocked ?? "")) note.textContent = blocked ?? "";
  if (input.disabled !== !!blocked) input.disabled = !!blocked;
  const error = agentComposer(key).error;
  const errorLine = $("composer-error");
  errorLine.hidden = !error;
  if (errorLine.textContent !== (error ?? "")) errorLine.textContent = error ?? "";
  for (const button of document.querySelectorAll<HTMLButtonElement>("[data-send-mode]")) {
    const mode = button.dataset.sendMode as SendMode;
    button.setAttribute("aria-pressed", String(mode === choice.mode));
    button.disabled = !!blocked || (!choice.choosable && mode !== choice.mode);
    button.title = !choice.choosable && mode === "now" ? FORCED_QUEUE_HINT : MODE_HINT[mode];
  }
  $("am-composer").dataset.mode = choice.mode;
  $("composer-mode-hint").textContent = blocked ? "" : choice.choosable ? MODE_HINT[choice.mode] : FORCED_QUEUE_HINT;
  const send = $<HTMLButtonElement>("composer-send");
  send.disabled = !!blocked || sending || !known;
  const label = sending ? "Sending…" : choice.mode === "now" ? "Send now" : "Queue";
  if (send.textContent !== label) send.textContent = label;
  input.placeholder = blocked ? "" : isConcierge(key) ? "Ask the concierge"
    : choice.mode === "now" ? "Message the agent" : "Message the agent when it is free";
  const keysBox = $("am-composer-keys");
  const keysFor = `${choice.mode}/${choice.choosable}`;
  if (keysBox.dataset.for === keysFor) return;
  keysBox.dataset.for = keysFor;
  const alt = isMac() ? "⌥" : "Alt";
  const keys = [keyHint(choice.mode === "now" ? "send now" : "queue", ["Enter"]), keyHint("new line", ["Shift", "Enter"])];
  if (choice.choosable) keys.push(keyHint(choice.mode === "now" ? "queue instead, once" : "send now instead, once", [alt, "Enter"]));
  keys.push(keyHint("back to the list", ["Esc"]));
  keysBox.replaceChildren(...keys);
}

function setComposerError(key: string, error: string | null, fromCancel = false): void {
  const agent = agentComposer(key);
  agent.error = error;
  agent.cancelError = fromCancel;
  if (state.selected === key) renderComposer();
}

function applyOutcome(key: string, outcome: Outcome, fromCancel = false): void {
  if (outcome.tokenRejected) {
    const conn = state.conns.get(parseAgentKey(key)?.connection ?? "");
    if (conn) conn.tokenRejected = true;
    changed("status");
  }
  // A cancel that worked leaves an unrelated error (say, an ambiguous send) in place.
  if (fromCancel && !outcome.error && !agentComposer(key).cancelError) return;
  setComposerError(key, outcome.error, fromCancel && !!outcome.error);
}

async function submitMessage(alternate: boolean): Promise<void> {
  const key = state.selected;
  const parsed = key ? parseAgentKey(key) : null;
  // One send per agent at a time: held Enter, Enter plus a click, or a second
  // submit while the first is in flight all stop here.
  if (!key || !parsed || composer.sending.has(key) || composer.shownKey !== key) return;
  const input = composerInput();
  if (input.disabled || blockedReason(key) || !agentSource(key).provider) return;
  const raw = input.value;
  const text = checkMessageText(raw);
  if (!text.ok) {
    if (text.error !== MESSAGE_EMPTY) setComposerError(key, text.error);
    return;
  }
  const mode = sendModeFor(modeChoice(key), alternate);
  const baseline = agentComposer(key).userCount;
  composer.sending.add(key);
  setComposerError(key, null);
  let outcome: Outcome;
  let id: string | undefined;
  try {
    const response = await call("messages.send", { connection: parsed.connection, agent: parsed.id, text: text.value, mode });
    outcome = sendOutcome(response);
    const body = response.body as { id?: unknown } | null;
    if (!outcome.error && typeof body?.id === "string") id = body.id;
  } catch (error) {
    outcome = rejectionOutcome(error, "send");
  } finally {
    composer.sending.delete(key);
  }
  applyOutcome(key, outcome);
  if (outcome.error) {
    // The text stays where it was; give the user the box back to fix or resend.
    if (state.selected === key && !input.disabled) input.focus({ preventScroll: true });
    return;
  }
  const agent = agentComposer(key);
  agent.pending = notePending(agent.pending, text.value, id, baseline, Date.now(), mode);
  if (state.selected === key && composer.shownKey === key) {
    const after = textAfterSend(input.value, raw);
    if (after.text !== input.value) {
      const start = Math.max(0, input.selectionStart - after.removed);
      const end = Math.max(0, input.selectionEnd - after.removed);
      input.value = after.text;
      input.setSelectionRange(start, end);
      autosize();
    }
    composer.drafts = putDraft(composer.drafts, key, input.value, Date.now());
  } else {
    const draft = composer.drafts[key]?.text ?? "";
    composer.drafts = putDraft(composer.drafts, key, textAfterSend(draft, raw).text, Date.now());
  }
  saveDrafts();
  if (state.selected !== key) return;
  renderComposer();
  renderTranscript(true);
  void loadDetail();
}

async function cancelQueued(key: string, id: string): Promise<void> {
  const parsed = parseAgentKey(key);
  if (!parsed || composer.cancelling.has(id)) return;
  composer.cancelling.add(id);
  if (state.selected === key) renderTranscript();
  let outcome: Outcome;
  try {
    outcome = cancelOutcome(await call("messages.cancel", { connection: parsed.connection, agent: parsed.id, id }));
  } catch (error) {
    outcome = rejectionOutcome(error, "cancel");
  } finally {
    composer.cancelling.delete(id);
  }
  const agent = agentComposer(key);
  if (outcome.gone) {
    // The server no longer knows the id; if it still lists the text, it shows without a Cancel until the refetch.
    agent.pending = agent.pending.filter((pending) => pending.id !== id);
  } else if (!outcome.error) {
    const detail = state.detail?.key === key ? state.detail.detail : null;
    const next = withoutMessage(agent.pending, detail?.queue, id);
    agent.pending = next.pending;
    if (detail) detail.queue = next.queue;
    // Drop detail responses already in flight; they predate the cancel.
    if (state.selected === key) state.detailApplied = state.detailSeq;
  }
  applyOutcome(key, outcome, true);
  if (state.selected !== key) return;
  renderTranscript();
  void loadDetail();
}

export function initComposer(): void {
  subscribe("agent", renderComposer);
  const input = composerInput();
  input.addEventListener("input", onComposerInput);
  input.addEventListener("keydown", (event) => {
    if (event.isComposing || event.keyCode === 229) return;
    if (event.key === "Escape") {
      event.preventDefault();
      stashDraft();
      focusCursor();
      return;
    }
    if (event.key !== "Enter" || (event.shiftKey && !event.metaKey && !event.ctrlKey && !event.altKey)) return;
    // Also stops ⌥Enter from typing a character on macOS keyboards.
    event.preventDefault();
    if (event.repeat) return;
    void submitMessage(event.altKey);
  });
  $("am-composer").addEventListener("submit", (event) => {
    event.preventDefault();
    void submitMessage(false);
  });
  for (const button of document.querySelectorAll<HTMLButtonElement>("[data-send-mode]")) {
    button.addEventListener("click", () => {
      const key = state.selected;
      if (!key || !modeChoice(key).choosable) return;
      composer.preference = button.dataset.sendMode as SendMode;
      saveSendModeRaw(composer.preference);
      renderComposer();
    });
  }
  $("transcript").addEventListener("click", (event) => {
    const button = (event.target as HTMLElement).closest<HTMLElement>("[data-cancel-message]");
    if (button?.dataset.cancelMessage && state.selected) void cancelQueued(state.selected, button.dataset.cancelMessage);
  });
  window.addEventListener("pagehide", stashDraft);
  window.addEventListener("resize", autosize);
}
