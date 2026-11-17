// Whether the window is in front of the user. A visible window that is not
// focused (the user is in another app) still updates, only less often; its
// animations stop, since each running one wakes the renderer every frame.
export interface Activity {
  hidden: boolean;
  focused: boolean;
}

export const isActive = (activity: Activity): boolean => !activity.hidden && activity.focused;

// How often the polls run. Hidden windows do not poll at all: they reload
// everything when shown again.
export function pollIntervals(activity: Activity): { fleetMs: number; detailMs: number } | null {
  if (activity.hidden) return null;
  return isActive(activity) ? { fleetMs: 5000, detailMs: 4000 } : { fleetMs: 15_000, detailMs: 15_000 };
}

export const currentActivity = (): Activity => ({ hidden: document.hidden, focused: document.hasFocus() });

// Marks the root element `data-inactive` while the window is hidden or
// unfocused (the stylesheet pauses animations on it) and calls `onActive` each
// time the window comes back, so the data it shows is fresh.
export function initActivity(onActive: () => void): void {
  let active = isActive(currentActivity());
  const update = () => {
    const next = isActive(currentActivity());
    document.documentElement.toggleAttribute("data-inactive", !next);
    if (next && !active) onActive();
    active = next;
  };
  window.addEventListener("focus", update);
  window.addEventListener("blur", update);
  document.addEventListener("visibilitychange", update);
  update();
}
