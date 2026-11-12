import { describe, expect, test } from "bun:test";
import {
  agentsWaitingOnDecisions,
  blockingDecisions,
  decisionsLabel,
  decisionsName,
  decisionsTitle,
  decisionsWaiting,
  openDecisions,
  rowDecisionsLabel,
} from "../desktop/src/decisions";

const NOW = Date.parse("2026-03-01T12:00:00Z");
const ago = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();

describe("decision wording", () => {
  test("labels read like am ls", () => {
    expect(decisionsLabel(1, 0)).toBe("1 decision");
    expect(decisionsLabel(2, 0)).toBe("2 decisions");
    expect(decisionsLabel(1, 1)).toBe("1 decision (blocking)");
    expect(decisionsLabel(2, 2)).toBe("2 decisions (blocking)");
    expect(decisionsLabel(3, 1)).toBe("3 decisions (1 blocking)");
    expect(rowDecisionsLabel({ openDecisions: 2, blockingDecisions: 0 })).toBe("2 decisions");
    expect(rowDecisionsLabel({ openDecisions: 1, blockingDecisions: 1 })).toBe("1 decision (blocking)");
  });

  test("missing, zero or malformed counts are none, as on rows from an older or remote am", () => {
    for (const row of [{}, { openDecisions: 0, blockingDecisions: 0 }, { openDecisions: -2 }, { openDecisions: Number.NaN }, { openDecisions: "2" as unknown as number }]) {
      expect(openDecisions(row)).toBe(0);
      expect(rowDecisionsLabel(row)).toBe("");
      expect(decisionsWaiting(row)).toBe("");
      expect(decisionsName(row)).toBe("");
      expect(decisionsTitle(row, NOW)).toBe("");
    }
    expect(blockingDecisions({ openDecisions: 1, blockingDecisions: 4 })).toBe(1);
    expect(blockingDecisions({ openDecisions: 2 })).toBe(0);
  });

  test("the badge's accessible name and tooltip", () => {
    const row = { openDecisions: 2, blockingDecisions: 0, oldestDecisionAt: ago(40), firstDecision: "  Legend below or beside?  " };
    expect(decisionsWaiting(row)).toBe("2 decisions waiting on you");
    expect(decisionsWaiting({ openDecisions: 1 })).toBe("1 decision waiting on you");
    expect(decisionsName(row)).toBe("2 decisions waiting on you: Legend below or beside?");
    expect(decisionsName({ openDecisions: 1 })).toBe("1 decision waiting on you");
    expect(decisionsTitle(row, NOW)).toBe("2 decisions waiting on you\nLegend below or beside?\nasked 40m ago");
    expect(decisionsTitle({ openDecisions: 1, oldestDecisionAt: ago(0.2) }, NOW)).toBe("1 decision waiting on you\nasked just now");
    expect(decisionsTitle({ openDecisions: 1, oldestDecisionAt: ago(150) }, NOW)).toBe("1 decision waiting on you\nasked 2h ago");
    expect(decisionsTitle({ openDecisions: 1, oldestDecisionAt: "not a date" }, NOW)).toBe("1 decision waiting on you");
  });

  test("the overview counts agents, not decisions, and says nothing at zero", () => {
    expect(agentsWaitingOnDecisions([])).toBe("");
    expect(agentsWaitingOnDecisions([{ openDecisions: 0 }, {}])).toBe("");
    expect(agentsWaitingOnDecisions([{ openDecisions: 3 }, {}])).toBe("1 agent waiting on decisions");
    expect(agentsWaitingOnDecisions([{ openDecisions: 2 }, { openDecisions: 1, blockingDecisions: 1 }, { openDecisions: 0 }])).toBe("2 agents waiting on decisions");
  });
});
