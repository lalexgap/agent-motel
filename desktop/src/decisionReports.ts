import { parseDecisionsReport, type DecisionsReport } from "./decisionsInbox";

export function countOpenDecisions(report: DecisionsReport): number {
  return report.groups.reduce((total, group) => total + group.decisions.length, 0);
}

export class DecisionReports {
  private active = new Map<string, { source: unknown; url: string; generation: object }>();
  private counts = new Map<string, number>();
  private fetched = new Map<string, number>();
  private sequences = new Map<string, number>();
  private requests = new Map<string, { sequence: number; promise: Promise<DecisionsReport> }>();

  constructor(private fetchReport: (connection: string) => Promise<unknown>, private changed: () => void) {}

  setConnections(connections: Iterable<string | readonly [string, { conn: { url: string } }]>): void {
    const next = new Map<string, { source: unknown; url: string; generation: object }>();
    for (const entry of connections) {
      const [id, source, url] = typeof entry === "string" ? [entry, entry, ""] : [entry[0], entry[1], entry[1].conn.url];
      const previous = this.active.get(id);
      next.set(id, previous?.source === source && previous.url === url ? previous : { source, url, generation: {} });
    }
    let changed = false;
    for (const [connection, identity] of this.active) {
      if (next.get(connection) === identity) continue;
      this.sequences.set(connection, (this.sequences.get(connection) ?? 0) + 1);
      changed = this.counts.delete(connection) || changed;
      this.fetched.delete(connection);
      this.requests.delete(connection);
    }
    const previous = this.active;
    this.active = next;
    for (const [connection, identity] of next) {
      if (previous.get(connection) === identity) continue;
      this.sequences.set(connection, (this.sequences.get(connection) ?? 0) + 1);
      void this.refresh(connection);
    }
    if (changed) this.changed();
  }

  identity(connection: string | null): object | undefined {
    return connection ? this.active.get(connection)?.generation : undefined;
  }

  async fetch(connection: string, latest = false): Promise<DecisionsReport> {
    if (!this.active.has(connection)) throw new Error("This server connection is no longer available.");
    const current = this.requests.get(connection);
    if (current && !latest) return current.promise;
    const sequence = (this.sequences.get(connection) ?? 0) + 1;
    this.sequences.set(connection, sequence);
    this.fetched.set(connection, Date.now());
    const promise = (async () => {
      const report = parseDecisionsReport(await this.fetchReport(connection));
      if (this.active.has(connection) && this.sequences.get(connection) === sequence) {
        const count = countOpenDecisions(report);
        const before = this.counts.get(connection);
        this.counts.set(connection, count);
        if (before !== count) this.changed();
      }
      return report;
    })();
    this.requests.set(connection, { sequence, promise });
    try {
      return await promise;
    } finally {
      if (this.requests.get(connection)?.sequence === sequence) this.requests.delete(connection);
    }
  }

  async refresh(connection: string, latest = false): Promise<void> {
    try { await this.fetch(connection, latest); } catch {}
  }

  refreshStale(now: number, maxAge: number): void {
    for (const connection of this.active.keys()) {
      if (now - (this.fetched.get(connection) ?? 0) >= maxAge) void this.refresh(connection);
    }
  }

  count(): number {
    let total = 0;
    for (const count of this.counts.values()) total += count;
    return Math.min(total, 100_000);
  }
}
