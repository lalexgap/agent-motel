// A built-in subagent's transcript, read-only, in the main area: a breadcrumb
// back to its parent, its status, tokens and final message, and the transcript
// polled while it runs. The parent stays the selected agent underneath, so Esc
// or the breadcrumb returns to the parent's chat where the reader left it.
import { ApiError, apiGet } from "./api";
import { markSelection, selectAgent } from "./chat";
import { $, composerInput, dot, h } from "./dom";
import { agentPath, parseAgentKey } from "./fleet";
import { duration, relativeTime } from "./format";
import { closeOverlay, inspectorToggle, renderInspector } from "./inspector";
import { registerShortcut } from "./keyboard";
import { findRow, isConcierge, state, subscribe } from "./state";
import {
  NOT_AVAILABLE,
  resolveState,
  shouldPoll,
  stateFromLabel,
  SUBAGENT_ID_RE,
  SUBAGENT_STATUS,
  subagentKey,
  subagentLabel,
  subagentTranscriptPath,
  tokenText,
  type SubagentState,
} from "./subagents";
import type { SubagentRecord, Transcript, TranscriptEntry } from "./types";
import { mainView, registerMainView, showMainView } from "./views";

const POLL_MS = 3000;

interface OpenSubagent {
  key: string;
  agentKey: string;
  connection: string;
  agentId: string;
  id: string;
  label: string;
  // What the opener said about its status (the usage page knows it).
  hint: SubagentState | null;
}

let open: OpenSubagent | null = null;
let seq = 0;
let inFlight = false;
let fetchedAt = 0;
let transcript: Transcript | null = null;
let failure: { status: number; message: string } | null = null;
// The entries on screen, so a poll re-renders only on change.
let shown: { key: string; fingerprint: string } | null = null;
let lastState: SubagentState | null = null;

let page: HTMLElement;
let output: HTMLElement;

const recordOf = (current: OpenSubagent): SubagentRecord | null =>
  state.detail?.key === current.agentKey ? state.detail.subagents?.find((record) => record.id === current.id) ?? null : null;

function currentState(current: OpenSubagent): SubagentState | null {
  return resolveState({
    record: recordOf(current), row: findRow(current.agentKey), id: current.id, hint: current.hint, transcriptStatus: transcript?.status ?? null,
  });
}

const parentName = (agentKey: string): string =>
  isConcierge(agentKey) ? "Concierge" : findRow(agentKey)?.name ?? parseAgentKey(agentKey)?.id ?? agentKey;

// Opens a subagent of `agentKey` (a fleet agent key) in the main area. The
// parent becomes the open agent if it is not already.
export function openSubagent(agentKey: string, subagentId: string, label?: string, statusLabel?: string): void {
  const parsed = parseAgentKey(agentKey);
  if (!parsed || !SUBAGENT_ID_RE.test(subagentId)) return;
  closeOverlay();
  if (state.selected !== agentKey) selectAgent(agentKey);
  const key = subagentKey(agentKey, subagentId);
  if (open?.key !== key) {
    // A response for the previous subagent must not land here.
    seq++;
    inFlight = false;
    transcript = null;
    failure = null;
    shown = null;
    lastState = null;
    open = { key, agentKey, connection: parsed.connection, agentId: parsed.id, id: subagentId, label: label || subagentId, hint: stateFromLabel(statusLabel) };
    output.replaceChildren(h("p", "am-transcript-note", "Loading output…"));
    $("am-sub-error").hidden = true;
  } else if (label) open.label = label;
  state.subagent = key;
  showMainView("subagent");
  markSelection();
  renderHeader();
  renderInspector();
  void load();
}

// Back to the parent's chat, scrolled where it was.
export function closeSubagent(focus: "transcript" | "composer" = "transcript"): void {
  const parent = open?.agentKey ?? state.selected;
  if (!parent) return;
  selectAgent(parent);
  if (focus === "composer" && !composerInput().disabled) composerInput().focus({ preventScroll: true });
  else $("transcript").focus({ preventScroll: true });
}

async function load(): Promise<void> {
  const current = open;
  if (!current) return;
  const mine = ++seq;
  inFlight = true;
  fetchedAt = Date.now();
  try {
    const body = await apiGet<Transcript>(current.connection, subagentTranscriptPath(agentPath(current.agentId), current.id));
    if (open !== current || mine !== seq) return;
    transcript = body && typeof body === "object" ? body : null;
    failure = null;
  } catch (error) {
    if (open !== current || mine !== seq) return;
    failure = { status: error instanceof ApiError ? error.status : 0, message: error instanceof Error ? error.message : String(error) };
  } finally {
    if (mine === seq) inFlight = false;
  }
  renderHeader();
  renderOutput();
}

function note(text: string, detail?: string): HTMLElement[] {
  const nodes: HTMLElement[] = [h("p", "am-transcript-note", text)];
  if (detail) nodes.push(h("p", "am-transcript-note am-sub-detail", detail));
  return nodes;
}

function renderOutput(): void {
  const current = open;
  if (!current) return;
  const errorBar = $("am-sub-error");
  const entries: TranscriptEntry[] | null = Array.isArray(transcript?.entries) ? transcript!.entries : null;
  if (failure) {
    // What is on screen stays; the bar says why it is not current.
    if (shown?.key === current.key) {
      errorBar.textContent = `Couldn't refresh: ${failure.message}`;
      errorBar.hidden = false;
      return;
    }
    errorBar.hidden = true;
    const record = recordOf(current);
    // 409: am has no output for it yet (or a remote am too old to serve it).
    output.replaceChildren(...(failure.status === 409
      ? note(record?.message || NOT_AVAILABLE, failure.message)
      : note(`Couldn't load this subagent's transcript.`, failure.message)));
    return;
  }
  errorBar.hidden = true;
  if (!entries) return;
  const fingerprint = JSON.stringify(entries);
  if (shown?.key === current.key && shown.fingerprint === fingerprint) return;
  const first = shown?.key !== current.key;
  const restore = first ? null : window.agentTranscript.preserveConversationScroll(output, 90);
  output.replaceChildren();
  if (!entries.length) output.append(...note("No output recorded yet."));
  else window.agentTranscript.renderEntries(output, entries, { agentName: current.label, readBoundary: null });
  shown = { key: current.key, fingerprint };
  if (restore) restore();
  else output.scrollTop = output.scrollHeight;
}

const DOT: Record<SubagentState, string> = { running: "working", finished: "exited", stale: "dead" };

function renderHeader(): void {
  const current = open;
  if (!current) return;
  const record = recordOf(current);
  if (record) current.label = subagentLabel(record);
  const subState = currentState(current);
  // Once it stops, fetch the transcript one last time for its final turns.
  if (lastState === "running" && subState && subState !== "running" && !inFlight) void load();
  lastState = subState;
  const name = parentName(current.agentKey);
  const crumb = $("am-sub-parent");
  crumb.textContent = name;
  crumb.title = `Back to ${name} (Esc)`;
  crumb.classList.toggle("am-concierge-title", isConcierge(current.agentKey));
  $("am-sub-title-text").textContent = current.label;
  $("am-sub-title").title = `${current.label} · ${current.id}`;
  const meta: HTMLElement[] = [];
  if (subState) {
    const badge = h("span", `badge am-sub-state s-${subState}`);
    badge.append(dot(DOT[subState]), document.createTextNode(SUBAGENT_STATUS[subState]));
    meta.push(badge);
  }
  const kind = h("span", "am-meta-item");
  kind.append(h("span", "", "Built-in"), h("b", "", record?.type ?? findRow(current.agentKey)?.subagents?.running?.find((item) => item.id === current.id)?.type ?? "subagent"));
  meta.push(kind);
  const tokens = tokenText(record?.tokens);
  if (tokens) {
    const item = h("span", "am-meta-item");
    item.title = "New input, cache writes and output";
    item.append(h("span", "", "Tokens"), h("b", "", tokens));
    meta.push(item);
  }
  const started = record?.startedAt ?? findRow(current.agentKey)?.subagents?.running?.find((item) => item.id === current.id)?.startedAt;
  const ended = record?.endedAt ? Date.parse(record.endedAt) : NaN;
  const since = started ? relativeTime(started) : "";
  const when = Number.isFinite(ended) && started ? `ran ${duration(ended - Date.parse(started))}` : since === "now" ? "just now" : since ? `${since} ago` : "";
  if (started && when) {
    const item = h("span", "am-meta-item");
    const text = when;
    item.title = `Started ${new Date(started).toLocaleString()}${record?.endedAt ? ` · ended ${new Date(record.endedAt).toLocaleString()}` : ""}`;
    item.append(h("span", "", "Started"), h("b", "", text));
    meta.push(item);
  }
  const id = h("span", "am-meta-item mono");
  id.append(h("span", "", "Id"), h("b", "", current.id));
  meta.push(id);
  $("am-sub-meta").replaceChildren(...meta);
  const message = $("am-sub-message");
  const text = record?.message?.trim() ?? "";
  message.hidden = !text;
  $("am-sub-message-text").textContent = text;
  $("am-sub-readonly-parent").textContent = name;
  const actions = $("am-sub-actions");
  if (!actions.firstChild) actions.append(inspectorToggle());
}

// The app clock: poll while the subagent runs (or nothing says it stopped).
export function tickSubagent(now: number): void {
  const current = open;
  if (!current || mainView() !== "subagent" || inFlight || now - fetchedAt < POLL_MS) return;
  if (shouldPoll(currentState(current))) void load();
}

function build(): void {
  page = h("section");
  page.id = "am-subagent";
  page.hidden = true;
  page.setAttribute("aria-label", "Subagent transcript");
  const header = h("header");
  header.id = "am-sub-header";
  const title = h("div", "am-chat-title");
  const crumbs = h("nav", "am-crumbs");
  crumbs.setAttribute("aria-label", "Breadcrumb");
  const parent = h("button", "am-crumb");
  parent.id = "am-sub-parent";
  parent.type = "button";
  parent.addEventListener("click", () => closeSubagent());
  const sep = h("span", "am-crumb-sep", "›");
  sep.setAttribute("aria-hidden", "true");
  const heading = h("h1");
  heading.id = "am-sub-title";
  heading.setAttribute("aria-current", "page");
  const text = h("span");
  text.id = "am-sub-title-text";
  heading.append(h("span", "am-subagent-mark", "↳ "), text);
  crumbs.append(parent, sep, heading);
  const actions = h("div");
  actions.id = "am-sub-actions";
  title.append(crumbs, actions);
  const meta = h("div", "am-chat-meta");
  meta.id = "am-sub-meta";
  const message = h("div", "am-sub-message");
  message.id = "am-sub-message";
  message.hidden = true;
  const messageText = h("p");
  messageText.id = "am-sub-message-text";
  message.append(h("span", "am-sub-message-label", "Final message"), messageText);
  header.append(title, meta, message);
  const body = h("div");
  body.id = "am-sub-body";
  output = h("div");
  output.id = "am-sub-transcript";
  output.tabIndex = 0;
  output.setAttribute("aria-label", "Subagent transcript");
  body.append(output);
  const error = h("div");
  error.id = "am-sub-error";
  error.setAttribute("role", "status");
  error.hidden = true;
  const readonly = h("p");
  readonly.id = "am-sub-readonly";
  const link = h("button", "text-button");
  link.id = "am-sub-readonly-parent";
  link.type = "button";
  link.title = "Open the parent's chat to message it";
  link.addEventListener("click", () => closeSubagent("composer"));
  readonly.append(h("span", "am-sub-lock", "Read-only"), document.createTextNode("Subagents are read-only. Send instructions through "), link, document.createTextNode("."));
  page.append(header, body, error, readonly);
  $("am-main").append(page);
}

export function initSubagentView(): void {
  build();
  registerMainView({
    id: "subagent",
    element: page,
    onHide: () => {
      open = null;
      seq++;
      inFlight = false;
      state.subagent = null;
      markSelection();
    },
  });
  subscribe("agent", () => {
    if (mainView() === "subagent") renderHeader();
  });
  registerShortcut({ keys: ["Escape"], when: () => mainView() === "subagent", run: () => closeSubagent() });
}
