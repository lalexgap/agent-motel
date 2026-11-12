import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  decisionFreshnessMessage,
  runDecisionFreshness,
  scanDecisionFreshness,
} from "../src/decisionFreshness";
import { decisionStoreFile, decisionsHome, readDecisionStoreTexts, type Decision } from "../src/decisions";
import type { AgentState } from "../src/state";

let home: string;
let now: Date;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "am-decision-freshness-"));
  process.env.AGENTMGR_HOME = join(home, "am");
  process.env.DECISIONS_HOME = join(home, "decisions");
  mkdirSync(decisionsHome(), { recursive: true });
  now = new Date(2026, 10, 12, 5, 0, 0, 0);
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  delete process.env.AGENTMGR_HOME;
  delete process.env.DECISIONS_HOME;
});

function agent(name: string, status: AgentState["status"] = "idle"): AgentState {
  return {
    name,
    status,
    dir: "/tmp",
    tmuxSession: `agentmgr-${name}`,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  };
}

function decision(id: string, extra: Partial<Decision> = {}): Decision {
  return {
    id,
    status: "open",
    question: `question ${id}?`,
    asked_at: new Date(now.getTime() - 60 * 60 * 1000).toISOString(),
    ...extra,
  };
}

function writeStore(name: string, decisions: Decision[]): void {
  writeFileSync(decisionStoreFile(name), JSON.stringify({ version: 1, agent: name, decisions }));
}

describe("decision freshness scan", () => {
  test("reads local stores when no store map is supplied", () => {
    writeStore("gone", [decision("young")]);
    expect(scanDecisionFreshness(now, [agent("gone", "exited")])).toEqual({
      staleDecisions: 0,
      exitedAgents: 1,
      attentionDecisions: 1,
      affectedAgents: 1,
    });
  });

  test("uses a strict greater-than 48h boundary", () => {
    writeStore("boundary", [
      decision("exactly", { asked_at: new Date(now.getTime() - 48 * 60 * 60 * 1000).toISOString() }),
      decision("older", { asked_at: new Date(now.getTime() - 48 * 60 * 60 * 1000 - 1).toISOString() }),
    ]);

    expect(scanDecisionFreshness(now, [agent("boundary")], readDecisionStoreTexts())).toEqual({
      staleDecisions: 1,
      exitedAgents: 0,
      attentionDecisions: 1,
      affectedAgents: 1,
    });
  });

  test("includes young open decisions for exited agents without double-counting overlap", () => {
    writeStore("gone", [
      decision("young"),
      decision("old", { asked_at: new Date(now.getTime() - 72 * 60 * 60 * 1000).toISOString() }),
    ]);

    const summary = scanDecisionFreshness(now, [agent("gone", "exited")], readDecisionStoreTexts());
    expect(summary).toEqual({ staleDecisions: 1, exitedAgents: 1, attentionDecisions: 2, affectedAgents: 1 });
    expect(decisionFreshnessMessage(summary)).toBe("2 open decisions need attention across 1 agent (1 over 48h; 1 exited agent with open decisions) — run am summary");
  });

  test("excludes resolved decisions and treats invalid dates as non-stale", () => {
    writeStore("worker", [
      decision("resolved", { status: "decided", asked_at: new Date(now.getTime() - 96 * 60 * 60 * 1000).toISOString() }),
      decision("invalid", { asked_at: "not a date" }),
    ]);
    expect(scanDecisionFreshness(now, [agent("worker")], readDecisionStoreTexts())).toEqual({
      staleDecisions: 0,
      exitedAgents: 0,
      attentionDecisions: 0,
      affectedAgents: 0,
    });
  });

  test("ignores malformed stores and names that do not own their slugged filename", () => {
    writeFileSync(decisionStoreFile("broken"), "{not json");
    writeStore("foreign", [decision("old", { asked_at: new Date(now.getTime() - 72 * 60 * 60 * 1000).toISOString() })]);
    expect(scanDecisionFreshness(now, [agent("broken"), agent("foreign-")], readDecisionStoreTexts())).toEqual({
      staleDecisions: 0,
      exitedAgents: 0,
      attentionDecisions: 0,
      affectedAgents: 0,
    });
  });
});

describe("nightly decision freshness run", () => {
  const config = { decisions: true, gcAutoHour: 4 };

  test("the decisions off switch prevents scanning, state writes and notifications", () => {
    const stateFile = join(home, "freshness.json");
    let notified = false;
    const result = runDecisionFreshness({
      now,
      config: { ...config, decisions: false },
      agents: [agent("gone", "exited")],
      stores: new Map([["gone", "not json"]]),
      stateFile,
      notify: () => { notified = true; },
    });
    expect(result).toEqual({ status: "disabled" });
    expect(notified).toBe(false);
    expect(existsSync(stateFile)).toBe(false);
  });

  test("persistent local-day bookkeeping deduplicates a catch-up run after restart", () => {
    writeStore("gone", [decision("young")]);
    const stateFile = join(home, "freshness.json");
    const messages: string[] = [];
    const options = {
      now,
      config,
      agents: [agent("gone", "exited")],
      stores: readDecisionStoreTexts(),
      stateFile,
      notify: (_title: string, message: string) => messages.push(message),
    };

    expect(runDecisionFreshness(options).status).toBe("ran");
    expect(runDecisionFreshness(options)).toEqual({ status: "not-due" });
    expect(messages).toHaveLength(1);
  });

  test("does not mark the day complete when the store directory is unavailable", () => {
    const stateFile = join(home, "freshness.json");
    const result = runDecisionFreshness({ now, config, stores: null, stateFile, notify: () => {} });

    expect(result).toEqual({ status: "not-due" });
    expect(existsSync(stateFile)).toBe(false);
  });

  test("does not mark the day complete after a partial store read", () => {
    const stateFile = join(home, "freshness.json");
    const result = runDecisionFreshness({ now, config, stores: new Map(), storesComplete: false, stateFile, notify: () => {} });

    expect(result).toEqual({ status: "not-due" });
    expect(existsSync(stateFile)).toBe(false);
  });

  test("waits until the configured hour and runs again on the next local day", () => {
    writeStore("gone", [decision("young")]);
    const stateFile = join(home, "freshness.json");
    const messages: string[] = [];
    const options = {
      config,
      agents: [agent("gone", "exited")],
      stores: readDecisionStoreTexts(),
      stateFile,
      notify: (_title: string, message: string) => messages.push(message),
    };

    expect(runDecisionFreshness({ ...options, now: new Date(2026, 10, 12, 3, 59) })).toEqual({ status: "not-due" });
    expect(runDecisionFreshness({ ...options, now })).toMatchObject({ status: "ran" });
    expect(runDecisionFreshness({ ...options, now: new Date(2026, 10, 13, 5, 0) })).toMatchObject({ status: "ran" });
    expect(messages).toHaveLength(2);
  });
});
