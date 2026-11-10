// UI preferences in localStorage. Storage can be missing or throw (private
// mode, a custom-scheme origin without storage), so every access is guarded.

export interface UiPrefs {
  selected: string | null;
  sidebarWidth: number;
  collapsed: string[];
  showStopped: boolean;
}

const KEY = "am.desktop.ui.v1";
export const DEFAULT_PREFS: UiPrefs = { selected: null, sidebarWidth: 280, collapsed: [], showStopped: false };

export function parsePrefs(raw: string | null): UiPrefs {
  if (!raw) return { ...DEFAULT_PREFS, collapsed: [] };
  try {
    const data = JSON.parse(raw) as Partial<UiPrefs>;
    return {
      selected: typeof data.selected === "string" ? data.selected : null,
      sidebarWidth: typeof data.sidebarWidth === "number" && Number.isFinite(data.sidebarWidth) ? data.sidebarWidth : DEFAULT_PREFS.sidebarWidth,
      collapsed: Array.isArray(data.collapsed) ? data.collapsed.filter((id): id is string => typeof id === "string").slice(0, 500) : [],
      showStopped: data.showStopped === true,
    };
  } catch {
    return { ...DEFAULT_PREFS, collapsed: [] };
  }
}

export function loadPrefs(): UiPrefs {
  try {
    return parsePrefs(globalThis.localStorage?.getItem(KEY) ?? null);
  } catch {
    return parsePrefs(null);
  }
}

export function savePrefs(prefs: UiPrefs): void {
  try {
    globalThis.localStorage?.setItem(KEY, JSON.stringify(prefs));
  } catch {
    // Preferences are a convenience; losing them is fine.
  }
}
