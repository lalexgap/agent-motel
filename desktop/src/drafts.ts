// The message box's text: one draft per agent, kept in localStorage, and the
// box's height.
import { capDrafts, putDraft } from "./composer";
import { $, composerInput } from "./dom";
import { saveDraftsRaw } from "./store";
import { composer } from "./state";

const DRAFT_SAVE_MS = 400;
let maxHeight = 72;
let composerWidth = 0;
let sizingObserver: ResizeObserver | null = null;
let autosizeTimer: ReturnType<typeof setTimeout> | null = null;

export function initDraftSizing(): void {
  if (sizingObserver) return;
  const chat = $("am-chat");
  const input = composerInput();
  const box = input.parentElement!;
  const sizer = $<HTMLTextAreaElement>("composer-sizer");
  maxHeight = Math.max(72, Math.round(chat.clientHeight * 0.4));
  composerWidth = box.clientWidth;
  sizer.style.width = `${composerWidth}px`;
  sizingObserver = new ResizeObserver((entries) => {
    let changed = false;
    for (const entry of entries) {
      if (entry.target === chat) {
        const next = Math.max(72, Math.round(entry.contentRect.height * 0.4));
        if (next !== maxHeight) {
          maxHeight = next;
          changed = true;
        }
      } else if (entry.target === box && entry.contentRect.width !== composerWidth) {
        composerWidth = entry.contentRect.width;
        sizer.style.width = `${composerWidth}px`;
        changed = true;
      }
    }
    if (changed) autosize();
  });
  sizingObserver.observe(chat);
  sizingObserver.observe(box);
}

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
  if (autosizeTimer) return;
  autosizeTimer = setTimeout(() => {
    autosizeTimer = null;
    measureDraft();
  }, 0);
}

// Grows with the text up to 40% of the chat pane, then scrolls. (The transcript
// shrinks to make room; its resize observer keeps it pinned.)
export function autosize(): void {
  if (autosizeTimer) clearTimeout(autosizeTimer);
  autosizeTimer = null;
  measureDraft();
}

function measureDraft(): void {
  const input = composerInput();
  const sizer = $<HTMLTextAreaElement>("composer-sizer");
  sizer.value = input.value;
  const measured = sizer.scrollHeight;
  const height = Math.min(measured, maxHeight);
  const overflow = measured > maxHeight ? "auto" : "hidden";
  const nextHeight = `${height}px`;
  if (input.style.height === nextHeight && input.style.overflowY === overflow) return;
  const scroll = input.scrollTop;
  input.style.height = nextHeight;
  input.style.overflowY = overflow;
  input.scrollTop = scroll;
}
