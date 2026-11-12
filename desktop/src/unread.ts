// Unread bookkeeping, in memory for the session as in the browser UI: an agent
// is new when its updatedAt moved past the version you last saw at the bottom
// of its conversation. Agents you have not opened this session are never new.

const later = (a: string, b: string): boolean => {
  const left = Date.parse(a), right = Date.parse(b);
  return Number.isFinite(left) && Number.isFinite(right) ? left > right : a > b;
};

export class Unread {
  private seen = new Map<string, string>();
  private read = new Map<string, number>();

  // Returns whether anything changed, so callers re-render only then. Moves forward only.
  markSeen(key: string, updatedAt: string | undefined): boolean {
    if (!updatedAt) return false;
    const previous = this.seen.get(key);
    if (previous && !later(updatedAt, previous)) return false;
    this.seen.set(key, updatedAt);
    return true;
  }

  markRead(key: string, lastIndex: number): void {
    if (Number.isFinite(lastIndex)) this.read.set(key, lastIndex);
  }

  isNew(key: string, updatedAt: string | undefined, selected: string | null): boolean {
    const seen = this.seen.get(key);
    return !!seen && !!updatedAt && key !== selected && later(updatedAt, seen);
  }

  // The last entry index read, for the "New since your last visit" divider.
  boundary(key: string): number | null {
    return this.read.get(key) ?? null;
  }
}
