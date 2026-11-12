// The chat pane: opening an agent, its header, the transcript with the outbox
// of pending and queued messages, the working indicator and jump-to-latest.
import { BUBBLE_LABEL, bubbles, reconcilePending, userTexts, type Bubble } from "./composer";
import { loadDetail } from "./data";
import { $, badge, composerInput, h } from "./dom";
import { showDraft, stashDraft } from "./drafts";
import { BUSY, parseAgentKey } from "./fleet";
import { duration, firstLine } from "./format";
import { agentComposer, agentSource, changed, composer, isConcierge, newDetailState, persist, state, subscribe, unread } from "./state";
import { mainView, registerMainView, showMainView } from "./views";

// Per-agent parts other modules add to the chat pane: actions in the header's
// title row and cards above the message box. Each renders for the open agent on
// every "agent" change and returns null to show nothing. The slot's element is
// created on first use, so with nothing registered the page is unchanged.
export type AgentPart = (key: string) => HTMLElement | null;
const headerActions: AgentPart[] = [];
const cards: AgentPart[] = [];
export function registerHeaderAction(part: AgentPart): void {
  headerActions.push(part);
}
export function registerCard(part: AgentPart): void {
  cards.push(part);
}
function fillSlot(parts: AgentPart[], id: string, place: (box: HTMLElement) => void, key: string): void {
  if (!parts.length) return;
  let box = document.getElementById(id);
  if (!box) {
    box = h("div");
    box.id = id;
    place(box);
  }
  box.replaceChildren(...parts.map((part) => part(key)).filter((node): node is HTMLElement => !!node));
}

export function selectAgent(key: string | null, focusTranscript = false): void {
  if (key !== state.selected) {
    stashDraft();
    state.selected = key;
    state.detail = key ? newDetailState(key) : null;
    state.taskExpanded = false;
    state.detailFetchedAt = 0;
    // Captured now, as the browser UI does, so reading this visit doesn't move the divider.
    state.readBoundary = key ? unread.boundary(key) : null;
    const view = $("transcript");
    view.replaceChildren();
    for (const field of ["content", "agent", "lastIndex", "updatedAt"]) delete view.dataset[field];
    persist();
    changed("seen");
  }
  if (!key) {
    showMainView("overview");
    markSelection();
    return;
  }
  showMainView("chat");
  markSelection();
  showDraft(key);
  changed("agent");
  if (!state.detail?.transcript) {
    const view = $("transcript");
    if (!view.childElementCount) view.append(h("p", "am-transcript-note", "Loading conversation…"));
  }
  void loadDetail();
  if (focusTranscript) $("transcript").focus({ preventScroll: true });
}

// The sidebar marks what the main area shows: the open subagent's row while
// the subagent view is up, else the open agent's rows.
export function markSelection(): void {
  for (const node of document.querySelectorAll<HTMLElement>("#am-tree [data-agent-key]"))
    node.setAttribute("aria-selected", String(!state.subagent && node.dataset.agentKey === state.selected));
  for (const node of document.querySelectorAll<HTMLElement>("#am-tree [data-subagent-key]"))
    node.setAttribute("aria-selected", String(node.dataset.subagentKey === state.subagent));
}

function metaItem(label: string, value: string | undefined, mono = false): HTMLElement | null {
  if (!value) return null;
  const node = h("span", `am-meta-item${mono ? " mono" : ""}`);
  node.title = `${label}: ${value}`;
  node.append(h("span", "", label), h("b", "", value));
  return node;
}

function renderHeader(): void {
  const key = state.selected;
  if (!key) return;
  const parsed = parseAgentKey(key);
  const source = agentSource(key);
  const conn = parsed ? state.conns.get(parsed.connection) : undefined;
  const name = source.name ?? parsed?.id.split(":").pop() ?? key;
  const concierge = isConcierge(key);
  $("am-agent-name").textContent = concierge ? "Concierge" : name;
  $("am-agent-name").classList.toggle("am-concierge-title", concierge);
  $("am-agent-name").title = parsed?.id ?? name;
  const status = source.status ?? "";
  $("am-agent-status").replaceChildren(...(status ? [badge(status)] : []));
  const flag = $("am-agent-flag");
  flag.hidden = !state.detail?.notFound;
  flag.textContent = "Not found on server";
  const host = source.host || conn?.local || "";
  const runtime = [source.provider, source.model, source.effort].filter(Boolean).join(" · ");
  const queued = (source.queued ?? 0) > 0 ? `${source.queued}` : undefined;
  $("am-agent-meta").replaceChildren(...[
    metaItem("Host", host + (conn && state.conns.size > 1 ? ` (${conn.conn.name})` : "")),
    metaItem("Runtime", runtime),
    metaItem("Branch", source.worktreeBranch, true),
    metaItem("Dir", source.dir, true),
    metaItem("Queued", queued),
  ].filter((node): node is HTMLElement => !!node));
  const reason = $("am-agent-reason");
  reason.hidden = !source.statusReason;
  reason.textContent = source.statusReason || "";
  const task = (source.task || "").trim();
  const taskBox = $("am-agent-task");
  taskBox.hidden = !task;
  const multi = task.includes("\n") || task.length > 120;
  taskBox.classList.toggle("expanded", state.taskExpanded);
  $("am-agent-task-text").textContent = state.taskExpanded ? task : firstLine(task);
  const toggle = $("am-agent-task-toggle");
  toggle.hidden = !multi;
  toggle.textContent = state.taskExpanded ? "Less" : "More";
  toggle.setAttribute("aria-expanded", String(state.taskExpanded));
  updateWorking(status, source.workingSince || source.statusChangedAt);
  fillSlot(headerActions, "am-agent-actions", (box) => $("am-agent-name").parentElement!.append(box), key);
  fillSlot(cards, "am-cards", (box) => $("am-composer").before(box), key);
}

// Entries re-render only when they change; the pending/queued bubbles after
// them re-render on their own fingerprint so a poll never rebuilds either for nothing.
export function renderTranscript(pin = false): void {
  const detailState = state.detail;
  const transcript = detailState?.transcript;
  if (!detailState || !transcript) return;
  const view = $("transcript");
  const entries = Array.isArray(transcript.entries) ? transcript.entries : [];
  const agent = agentComposer(detailState.key);
  agent.pending = reconcilePending(agent.pending, entries, Date.now());
  agent.userCount = userTexts(entries).length;
  const list = bubbles(agent.pending, detailState.detail?.queue);
  const fingerprint = JSON.stringify(entries);
  const bubbleFingerprint = JSON.stringify(list.map((bubble) => [bubble.key, bubble.state, bubble.cancelId && composer.cancelling.has(bubble.cancelId)]));
  const firstRender = view.dataset.agent !== detailState.key;
  const entriesChanged = firstRender || view.dataset.content !== fingerprint;
  const snapshot = () => {
    const last = entries.at(-1);
    if (last) view.dataset.lastIndex = String(last.index);
    else delete view.dataset.lastIndex;
    view.dataset.updatedAt = detailState.detail?.updatedAt ?? "";
  };
  if (!entriesChanged && view.dataset.bubbles === bubbleFingerprint) {
    if (pin) view.scrollTop = view.scrollHeight;
    snapshot();
    updateJump();
    return;
  }
  const restore = firstRender ? null : window.agentTranscript.preserveConversationScroll(view, 90);
  const focusedCancel = (document.activeElement as HTMLElement | null)?.dataset?.cancelMessage;
  if (entriesChanged) {
    view.replaceChildren();
    view.dataset.content = fingerprint;
    view.dataset.agent = detailState.key;
    if (!entries.length) view.append(h("p", "am-transcript-note", "No messages yet."));
    else window.agentTranscript.renderEntries(view, entries, { agentName: detailState.detail?.name ?? "", readBoundary: state.readBoundary });
  }
  snapshot();
  let box = view.querySelector<HTMLElement>(":scope > .am-outbox");
  if (!box) box = h("div", "am-outbox");
  box.replaceChildren(...list.map((bubble) => bubbleNode(bubble, detailState.detail?.name ?? "")));
  if (view.lastChild !== box) view.append(box);
  view.dataset.bubbles = bubbleFingerprint;
  if (focusedCancel) {
    const again = box.querySelector<HTMLElement>(`[data-cancel-message="${CSS.escape(focusedCancel)}"]`);
    if (again) again.focus({ preventScroll: true });
    else if (!composerInput().disabled) composerInput().focus({ preventScroll: true });
  }
  if (restore) restore();
  if (!restore || pin) view.scrollTop = view.scrollHeight;
  updateJump();
}

function bubbleNode(bubble: Bubble, agentName: string): HTMLElement {
  const turn = window.agentTranscript.chatTurn({ kind: "user", text: bubble.text, index: bubble.key }, agentName);
  turn.classList.add("queued", "pending");
  turn.dataset.messageState = bubble.state;
  const meta = h("div", "queued-meta", BUBBLE_LABEL[bubble.state]);
  if (bubble.cancelId) {
    const id = bubble.cancelId;
    const busy = composer.cancelling.has(id);
    const button = h("button", "text-button", busy ? "Cancelling…" : "Cancel");
    button.type = "button";
    button.dataset.cancelMessage = id;
    button.disabled = busy;
    button.setAttribute("aria-label", busy ? "Cancelling the queued message" : "Cancel this queued message");
    meta.append(button);
  }
  turn.append(meta);
  return turn;
}

// Whether the reader was at the bottom of the transcript before its box
// changed size (composer growth, an error line, the working indicator).
let transcriptPinned = true;
function trackTranscriptPin(): void {
  const view = $("transcript");
  view.addEventListener("scroll", () => {
    transcriptPinned = view.scrollHeight - view.scrollTop - view.clientHeight < 4;
  }, { passive: true });
  new ResizeObserver(() => {
    if (transcriptPinned && state.selected) view.scrollTop = view.scrollHeight;
  }).observe(view);
}

function updateJump(): void {
  const view = $("transcript");
  const atLatest = view.scrollHeight - view.scrollTop - view.clientHeight < 100;
  $("am-jump-latest").hidden = !state.selected || atLatest;
  if (atLatest) markSeen(view);
}

// Reading to the bottom of the conversation marks it seen ("New" badges) and
// read up to its last entry (the next visit's divider), as in the browser UI.
function markSeen(view: HTMLElement): void {
  const key = state.selected;
  if (!key || view.dataset.agent !== key || $("am-chat").hidden) return;
  if (view.dataset.lastIndex) unread.markRead(key, Number(view.dataset.lastIndex));
  if (unread.markSeen(key, view.dataset.updatedAt)) changed("seen");
}

function updateWorking(status: string, since: string | undefined): void {
  const box = $("am-working");
  const busy = BUSY.has(status);
  box.hidden = !busy;
  if (!busy) return;
  box.dataset.status = status;
  box.dataset.since = since || "";
  const label = { starting: "Starting", waiting: "Waiting on background tasks" }[status] || "Working";
  const announced = box.querySelector("[role=status]");
  if (announced && announced.textContent !== label) announced.textContent = label;
  tickWorking();
}

export function tickWorking(): void {
  const box = $("am-working");
  if (box.hidden) return;
  const label = { starting: "Starting", waiting: "Waiting on background tasks" }[box.dataset.status || ""] || "Working";
  const start = Date.parse(box.dataset.since || "");
  const text = box.querySelector(".working-text");
  if (text) text.textContent = label + (Number.isFinite(start) ? ` for ${duration(Date.now() - start)}` : "");
}

// While another main view covers the chat (a subagent's transcript), the
// chat keeps its agent, and its transcript waits to render until it shows
// again with the reader's scroll position put back.
let hiddenScroll: { key: string; top: number; pinned: boolean } | null = null;
let renderWhenShown = false;
function onChatHide(): void {
  const view = $("transcript");
  hiddenScroll = view.dataset.agent
    ? { key: view.dataset.agent, top: view.scrollTop, pinned: view.scrollHeight - view.scrollTop - view.clientHeight < 4 }
    : null;
}
function onChatShow(): void {
  const view = $("transcript");
  if (hiddenScroll && hiddenScroll.key === view.dataset.agent) {
    view.scrollTop = hiddenScroll.pinned ? view.scrollHeight : hiddenScroll.top;
    transcriptPinned = hiddenScroll.pinned;
  }
  hiddenScroll = null;
  if (renderWhenShown) {
    renderWhenShown = false;
    showTranscript();
  }
  updateJump();
}
function showTranscript(): void {
  if (mainView() !== "chat") {
    renderWhenShown = true;
    return;
  }
  if (state.detail?.notFound && !state.detail.transcript) {
    $("transcript").replaceChildren(h("p", "am-transcript-note", "This agent is not on the server any more."));
  } else renderTranscript();
}

export function initChat(): void {
  registerMainView({ id: "chat", element: $("am-chat"), onShow: onChatShow, onHide: onChatHide });
  subscribe("agent", renderHeader);
  subscribe("transcript", showTranscript);
  // The fleet stream updates rows sooner than the detail poll; keep the header's
  // status in step with the sidebar.
  subscribe("fleet", () => {
    if (state.selected) changed("agent");
  });
  trackTranscriptPin();
  $("am-agent-task-toggle").addEventListener("click", () => {
    state.taskExpanded = !state.taskExpanded;
    changed("agent");
  });
  const view = $("transcript");
  view.addEventListener("scroll", updateJump, { passive: true });
  $("am-jump-latest").addEventListener("click", () => {
    view.scrollTop = view.scrollHeight;
    updateJump();
    view.focus({ preventScroll: true });
  });
}
