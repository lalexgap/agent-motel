export interface InboxDecision {
  id: string;
  question: string;
  blocking: boolean;
  options: string[];
  recommendation: string | null;
  why: string | null;
  link: string | null;
  prs: string[];
  asked_at: string | null;
}
export interface DecisionsReport {
  groups: { agent: string; decisions: InboxDecision[] }[];
  remoteHosts: string[];
  enabled: boolean;
  complete: boolean;
}

export function parseDecisionsReport(value: unknown): DecisionsReport {
  const report = value as DecisionsReport | null;
  if (!report || typeof report.enabled !== "boolean" || typeof report.complete !== "boolean" || !Array.isArray(report.remoteHosts)
    || !report.remoteHosts.every((host) => typeof host === "string") || !Array.isArray(report.groups)
    || !report.groups.every((group) => group && typeof group.agent === "string" && Array.isArray(group.decisions)
      && group.decisions.every((d) => d && typeof d.id === "string" && typeof d.question === "string"))) {
    throw new Error("The server returned an invalid decisions list.");
  }
  return report;
}

export class DecisionsInbox {
  connection: string | null = null;
  report: DecisionsReport | null = null;
  error: string | null = null;
  loading = false;
  fetchedAt = 0;
  private sequence = 0;
  private identity: unknown;

  constructor(private fetchReport: (connection: string, latest: boolean) => Promise<unknown>, private changed: () => void) {}

  select(connection: string | null, identity: unknown = connection): void {
    if (connection === this.connection && identity === this.identity) return;
    this.connection = connection;
    this.identity = identity;
    this.sequence++;
    this.report = null;
    this.error = null;
    this.loading = false;
    this.fetchedAt = 0;
  }

  async refresh(latest = false): Promise<void> {
    const connection = this.connection;
    if (!connection || this.loading) return;
    const sequence = ++this.sequence;
    this.loading = true;
    this.fetchedAt = Date.now();
    this.changed();
    try {
      const data = await this.fetchReport(connection, latest);
      if (sequence !== this.sequence) return;
      this.report = parseDecisionsReport(data);
      this.error = null;
    } catch (error) {
      if (sequence !== this.sequence) return;
      this.error = error instanceof Error ? error.message : "Could not load decisions.";
    } finally {
      if (sequence === this.sequence) {
        this.loading = false;
        this.changed();
      }
    }
  }

  // A mutation must not let an older periodic read put the closed item back.
  async refreshLatest(): Promise<void> {
    if (this.loading) {
      this.sequence++;
      this.loading = false;
    }
    await this.refresh(true);
  }
}
