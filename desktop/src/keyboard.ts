// Window-wide keyboard shortcuts. Modules register theirs; one keydown handler
// applies the shared rules: no modifier keys, nothing a field already handled,
// and nothing while typing in a field unless the shortcut asks for it. The first
// matching shortcut wins and its default action is prevented.
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

const shortcuts: Shortcut[] = [];

export function registerShortcut(shortcut: Shortcut): void {
  shortcuts.push(shortcut);
}

function onKeydown(event: KeyboardEvent): void {
  if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
  const current = screen();
  const typing = isTyping(event.target);
  for (const shortcut of shortcuts) {
    if (!shortcut.keys.includes(event.key) || (shortcut.screen ?? "fleet") !== current) continue;
    if (typing && !shortcut.whileTyping) continue;
    if (shortcut.when && !shortcut.when(event)) continue;
    event.preventDefault();
    shortcut.run(event);
    return;
  }
}

export function initKeyboard(): void {
  document.addEventListener("keydown", onKeydown);
}
