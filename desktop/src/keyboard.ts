// Window-wide keyboard shortcuts. Modules register theirs; one keydown handler
// applies the shared rules: no modifier keys, nothing a field already handled,
// and nothing while typing in a field unless the shortcut asks for it. The first
// matching shortcut wins and its default action is prevented.
//
// Inside a data-keyboard-isolated element (the terminal) no shortcut runs, even
// one that works while typing. Chords still run first, in the capture phase.
import { isTyping } from "./dom";
import { screen, type Screen } from "./views";

export interface Shortcut {
  // KeyboardEvent.key values.
  keys: string[];
  // Which screen it works on; default "fleet".
  screen?: Screen;
  // Also when focus is in a text field (the event target is that field).
  whileTyping?: boolean;
  // Further conditions; when it returns false the key is left alone.
  when?: (event: KeyboardEvent) => boolean;
  run: (event: KeyboardEvent) => void;
}

export interface Chord {
  matches: (event: KeyboardEvent) => boolean;
  // Returns false to leave the key alone.
  run: (event: KeyboardEvent) => boolean;
}

const shortcuts: Shortcut[] = [];
const chords: Chord[] = [];

export function registerShortcut(shortcut: Shortcut): void {
  shortcuts.push(shortcut);
}
export function registerChord(chord: Chord): void {
  chords.push(chord);
}

export const isIsolated = (target: EventTarget | null): boolean =>
  typeof Element !== "undefined" && target instanceof Element && !!target.closest("[data-keyboard-isolated]");

export interface KeyContext {
  screen: Screen;
  typing: boolean;
  isolated: boolean;
}
type KeyFacts = Pick<KeyboardEvent, "key" | "defaultPrevented" | "metaKey" | "ctrlKey" | "altKey">;

export function shortcutFor<E extends KeyFacts>(list: readonly Shortcut[], event: E, context: KeyContext): Shortcut | null {
  if (context.isolated || event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return null;
  for (const shortcut of list) {
    if (!shortcut.keys.includes(event.key) || (shortcut.screen ?? "fleet") !== context.screen) continue;
    if (context.typing && !shortcut.whileTyping) continue;
    if (shortcut.when && !shortcut.when(event as unknown as KeyboardEvent)) continue;
    return shortcut;
  }
  return null;
}

function onKeydown(event: KeyboardEvent): void {
  const shortcut = shortcutFor(shortcuts, event, { screen: screen(), typing: isTyping(event.target), isolated: isIsolated(event.target) });
  if (!shortcut) return;
  event.preventDefault();
  shortcut.run(event);
}

function onChordKeydown(event: KeyboardEvent): void {
  for (const chord of chords) {
    if (!chord.matches(event) || !chord.run(event)) continue;
    event.preventDefault();
    event.stopImmediatePropagation();
    return;
  }
}

export function initKeyboard(): void {
  window.addEventListener("keydown", onChordKeydown, true);
  document.addEventListener("keydown", onKeydown);
}
