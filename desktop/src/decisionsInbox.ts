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

  constructor(private fetchReport: (connection: string) => Promise<unknown>, private changed: () => void) {}

  select(connection: string | null): void {
    if (connection === this.connection) return;
    this.connection = connection;
    this.sequence++;
    this.report = null;
    this.error = null;
    this.loading = false;
    this.fetchedAt = 0;
  }

  async refresh(): Promise<void> {
    const connection = this.connection;
    if (!connection || this.loading) return;
    const sequence = ++this.sequence;
    this.loading = true;
    this.fetchedAt = Date.now();
    this.changed();
    try {
      const data = await this.fetchReport(connection);
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
}
