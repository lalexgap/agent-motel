// Pure parts of the inspector panel: its saved preferences and whether it fits
// beside the transcript or has to open as an overlay.

export interface InspectorPrefs {
  // Docked open, when the window is wide enough.
  open: boolean;
  width: number;
  // The "Agents & subagents" section's "Show finished".
  showFinished: boolean;
}
export const DEFAULT_INSPECTOR_PREFS: InspectorPrefs = { open: true, width: 300, showFinished: false };

export const INSPECTOR_MIN = 240;
const INSPECTOR_CAP = 520;
export const inspectorMax = (windowWidth: number): number => Math.max(INSPECTOR_MIN, Math.min(INSPECTOR_CAP, Math.round(windowWidth * 0.4)));
export const clampInspectorWidth = (width: number, windowWidth: number): number =>
  Math.max(INSPECTOR_MIN, Math.min(inspectorMax(windowWidth), Math.round(width)));

// Narrowest the transcript may get with the inspector docked beside it; any
// narrower and the inspector only opens as an overlay.
export const TRANSCRIPT_MIN = 480;
// The sidebar's and the inspector's dividers.
const DIVIDERS = 10;
export function inspectorDocks(options: { windowWidth: number; sidebarWidth: number; inspectorWidth: number }): boolean {
  const width = clampInspectorWidth(options.inspectorWidth, options.windowWidth);
  return options.windowWidth - options.sidebarWidth - DIVIDERS - width >= TRANSCRIPT_MIN;
}

export function parseInspectorPrefs(raw: string | null): InspectorPrefs {
  if (!raw) return { ...DEFAULT_INSPECTOR_PREFS };
  try {
    const data = JSON.parse(raw) as Partial<Record<keyof InspectorPrefs, unknown>> | null;
    if (!data || typeof data !== "object") return { ...DEFAULT_INSPECTOR_PREFS };
    return {
      open: typeof data.open === "boolean" ? data.open : DEFAULT_INSPECTOR_PREFS.open,
      width: typeof data.width === "number" && Number.isFinite(data.width)
        ? Math.max(INSPECTOR_MIN, Math.min(INSPECTOR_CAP, Math.round(data.width)))
        : DEFAULT_INSPECTOR_PREFS.width,
      showFinished: data.showFinished === true,
    };
  } catch {
    return { ...DEFAULT_INSPECTOR_PREFS };
  }
}
export const serializeInspectorPrefs = (prefs: InspectorPrefs): string => JSON.stringify(prefs);
