// UI preferences in localStorage. Storage can be missing or throw (private
// mode, a custom-scheme origin without storage), so every access is guarded.
import {
  OVERVIEW_FILTERS,
  OVERVIEW_SORTS,
  SIDEBAR_GROUPS,
  SIDEBAR_SORTS,
  type OverviewFilter,
  type OverviewSort,
  type SidebarGroup,
  type SidebarSort,
} from "./ordering";

export interface UiPrefs {
  selected: string | null;
  sidebarWidth: number;
  collapsed: string[];
  showStopped: boolean;
  sidebarGroup: SidebarGroup;
  sidebarSort: SidebarSort;
  sidebarReverse: boolean;
  overviewFilter: OverviewFilter;
  overviewSort: OverviewSort;
  overviewReverse: boolean;
}

const KEY = "am.desktop.ui.v1";
export const DEFAULT_PREFS: UiPrefs = {
  selected: null, sidebarWidth: 280, collapsed: [], showStopped: false,
  sidebarGroup: "tree", sidebarSort: "status", sidebarReverse: false,
  overviewFilter: "live", overviewSort: "status", overviewReverse: false,
};

function oneOf<T extends string>(value: unknown, options: readonly { id: T }[], fallback: T): T {
  return options.find((option) => option.id === value)?.id ?? fallback;
}

export function parsePrefs(raw: string | null): UiPrefs {
  if (!raw) return { ...DEFAULT_PREFS, collapsed: [] };
  try {
    const data = JSON.parse(raw) as Partial<UiPrefs>;
    return {
      selected: typeof data.selected === "string" ? data.selected : null,
      sidebarWidth: typeof data.sidebarWidth === "number" && Number.isFinite(data.sidebarWidth) ? data.sidebarWidth : DEFAULT_PREFS.sidebarWidth,
      collapsed: Array.isArray(data.collapsed) ? data.collapsed.filter((id): id is string => typeof id === "string").slice(0, 500) : [],
      showStopped: data.showStopped === true,
      sidebarGroup: oneOf(data.sidebarGroup, SIDEBAR_GROUPS, DEFAULT_PREFS.sidebarGroup),
      sidebarSort: oneOf(data.sidebarSort, SIDEBAR_SORTS, DEFAULT_PREFS.sidebarSort),
      sidebarReverse: data.sidebarReverse === true,
      overviewFilter: oneOf(data.overviewFilter, OVERVIEW_FILTERS, DEFAULT_PREFS.overviewFilter),
      overviewSort: oneOf(data.overviewSort, OVERVIEW_SORTS, DEFAULT_PREFS.overviewSort),
      overviewReverse: data.overviewReverse === true,
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

function read(key: string): string | null {
  try {
    return globalThis.localStorage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}
function write(key: string, value: string): void {
  try {
    globalThis.localStorage?.setItem(key, value);
  } catch {
    // Full or unavailable storage only costs the convenience.
  }
}

const DRAFTS_KEY = "am.desktop.drafts.v1";
const SEND_MODE_KEY = "am.desktop.sendMode.v1";
export const loadDraftsRaw = (): string | null => read(DRAFTS_KEY);
export const saveDraftsRaw = (raw: string): void => write(DRAFTS_KEY, raw);
export const loadSendModeRaw = (): string | null => read(SEND_MODE_KEY);
export const saveSendModeRaw = (mode: string): void => write(SEND_MODE_KEY, mode);

const USAGE_KEY = "am.desktop.usage.v1";
export const loadUsagePrefsRaw = (): string | null => read(USAGE_KEY);
export const saveUsagePrefsRaw = (raw: string): void => write(USAGE_KEY, raw);
