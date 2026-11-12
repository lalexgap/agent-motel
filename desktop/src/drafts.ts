// The message box's text: one draft per agent, kept in localStorage, and the
// box's height.
import { capDrafts, putDraft } from "./composer";
import { $, composerInput } from "./dom";
import { saveDraftsRaw } from "./store";
import { composer } from "./state";

const DRAFT_SAVE_MS = 400;

export function saveDrafts(): void {
  if (composer.draftTimer) clearTimeout(composer.draftTimer);
  composer.draftTimer = null;
  saveDraftsRaw(JSON.stringify(capDrafts(composer.drafts)));
}

// The textarea's text belongs to composer.shownKey; write it back before showing another agent's.
export function stashDraft(): void {
  const key = composer.shownKey;
  if (!key) return;
  composer.drafts = putDraft(composer.drafts, key, composerInput().value, Date.now());
  saveDrafts();
}

export function showDraft(key: string): void {
  if (composer.shownKey === key) return;
  composer.shownKey = key;
  const input = composerInput();
  input.value = composer.drafts[key]?.text ?? "";
  input.setSelectionRange(input.value.length, input.value.length);
  input.scrollTop = 0;
  autosize();
}

export function onComposerInput(): void {
  const key = composer.shownKey;
  if (key) {
    composer.drafts = putDraft(composer.drafts, key, composerInput().value, Date.now());
    if (composer.draftTimer) clearTimeout(composer.draftTimer);
    composer.draftTimer = setTimeout(saveDrafts, DRAFT_SAVE_MS);
  }
  autosize();
}

// Grows with the text up to 40% of the chat pane, then scrolls. (The transcript
// shrinks to make room; its resize observer keeps it pinned.)
export function autosize(): void {
  const input = composerInput();
  const scroll = input.scrollTop;
  const max = Math.max(72, Math.round($("am-chat").clientHeight * 0.4));
  input.style.height = "auto";
  const height = Math.min(input.scrollHeight, max);
  input.style.height = `${height}px`;
  input.style.overflowY = input.scrollHeight > max ? "auto" : "hidden";
  input.scrollTop = scroll;
}
