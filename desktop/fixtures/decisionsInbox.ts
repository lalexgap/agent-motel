import type { DecisionsReport, InboxDecision } from "../src/decisionsInbox";

const decision = (id: string, question: string, blocking: boolean, minutes: number): InboxDecision => ({
  id, question, blocking,
  options: ["Ship the smaller change", "Include the follow-up"],
  recommendation: "Ship the smaller change",
  why: "The smaller change is ready for review.",
  link: "https://example.test/review", prs: [],
  asked_at: new Date(Date.now() - minutes * 60000).toISOString(),
});

export function decisionsInboxFixture(): DecisionsReport {
  return {
    enabled: true,
    remoteHosts: ["annex", "lantern"],
    groups: [
      { agent: "anchor-watch", decisions: [decision("d-1", "Which release should include the new sidebar?", true, 95)] },
      { agent: "chart-table", decisions: [decision("d-1", "Keep the legend below the chart?", false, 60), decision("d-2", "Use <img onerror=alert(1)> as literal test text?", false, 30)] },
      { agent: "archived-design", decisions: [decision("d-1", "Keep the old mockup as a reference?", false, 20)] },
    ],
  };
}
