import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseOpenDecisions,
  readOpenDecisions,
  decisionStoreFile,
  decisionSummary,
  decisionsHome,
  decisionsLabel,
  openDecisions,
  readDecisionStore,
  readDecisionStoreTexts,
  type Decision,
} from "../src/decisions";
import { agentRows, formatRows, type AgentRow } from "../src/commands/ls";
import { decisionsWanted } from "../src/decisionHooks";
import { destroyAgent } from "../src/commands/rm";
import { renameAgent } from "../src/commands/rename";
import { restoreCommand } from "../src/commands/restore";
import { importPayload } from "../src/commands/move";
import { planFile, trashDir } from "../src/paths";
import { ensurePlan } from "../src/plan";
import { readAgent, writeAgent, type AgentState } from "../src/state";
import { buildFleetSummary, formatFleetSummary } from "../src/summary";
import type { FleetRow } from "../src/fleet";

let home: string;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), "am-decisions-")); process.env.DECISIONS_HOME = home; });
afterEach(() => { rmSync(home, { recursive: true, force: true }); delete process.env.DECISIONS_HOME; });

const item = (overrides: object = {}) => ({ id: "d-1", status: "open", question: " Ship behind\n a flag? ", blocking: true, asked_at: "2026-07-22T10:00:00Z", link: null, ...overrides });
const store = (decisions: unknown[], version = 1) => JSON.stringify({ version, agent: "worker", decisions });

test("reads open decisions and the PRs they are about", () => {
  const open = parseOpenDecisions(store([
    item({ link: "https://github.com/owner/repo/pull/7/files#diff-1" }),
    item({ id: "d-2", link: "https://drop.example/x", prs: ["https://github.com/owner/repo/pull/8", "https://github.com/owner/repo/pull/8?x=1", "not a url"] }),
    item({ id: "d-3", blocking: "yes", link: "javascript:alert(1)", asked_at: "soon" }),
    item({ id: "d-4", status: "decided" }),
    item({ id: "d-5", status: "withdrawn" }),
    { status: "open" },
  ]));
  expect(open).toEqual([
    { id: "d-1", question: "Ship behind a flag?", blocking: true, askedAt: "2026-07-22T10:00:00Z", link: "https://github.com/owner/repo/pull/7/files#diff-1", prs: ["https://github.com/owner/repo/pull/7"] },
    { id: "d-2", question: "Ship behind a flag?", blocking: true, askedAt: "2026-07-22T10:00:00Z", link: "https://drop.example/x", prs: ["https://github.com/owner/repo/pull/8"] },
    { id: "d-3", question: "Ship behind a flag?", blocking: false, prs: [] },
  ]);
});

test("strips control characters from a question", () => {
  expect(parseOpenDecisions(store([item({ question: "Ship\x1b[2J it?\x07" })]))[0]!.question).toBe("Ship [2J it?");
});

test("ignores a store it does not understand rather than guessing", () => {
  expect(parseOpenDecisions("{not json")).toEqual([]);
  expect(parseOpenDecisions(store([item()], 2))).toEqual([]);
  expect(parseOpenDecisions(JSON.stringify({ version: 1, decisions: {} }))).toEqual([]);
  expect(readOpenDecisions("nobody")).toEqual([]);
});

test("finds an agent's store by the CLI's file naming", () => {
  writeFileSync(join(home, "host-worker.json"), store([item()]));
  expect(readOpenDecisions("host:worker").map(decision => decision.id)).toEqual(["d-1"]);
});

describe("the whole store (ls, summary, lifecycle)", () => {
  let amHome: string;
  let oldDecisionsHome: string | undefined;

  beforeEach(() => {
    amHome = mkdtempSync(join(tmpdir(), "am-decisions-test-"));
    process.env.AGENTMGR_HOME = amHome;
    oldDecisionsHome = process.env.DECISIONS_HOME;
    process.env.DECISIONS_HOME = join(amHome, "decisions");
  });

  afterEach(() => {
    rmSync(amHome, { recursive: true, force: true });
    delete process.env.AGENTMGR_HOME;
    if (oldDecisionsHome === undefined) delete process.env.DECISIONS_HOME;
    else process.env.DECISIONS_HOME = oldDecisionsHome;
  });

  function decision(id: string, extra: Partial<Decision> = {}): Decision {
    return { id, status: "open", question: `question ${id}?`, options: [], blocking: false, asked_at: "2026-11-10T00:00:00Z", updated_at: "2026-11-10T00:00:00Z", ...extra };
  }

  function writeStore(name: string, decisions: Decision[], extra: Record<string, unknown> = {}): void {
    mkdirSync(decisionsHome(), { recursive: true });
    const store = { version: 1, agent: name, host: "box", dir: "/tmp", plan: null, updated_at: "2026-11-10T00:00:00Z", next_id: decisions.length + 1, decisions, ...extra };
    writeFileSync(decisionStoreFile(name), JSON.stringify(store, null, 2));
  }

  function agent(name: string, extra: Partial<AgentState> = {}): AgentState {
    const now = new Date().toISOString();
    return { name, status: "exited", dir: "/tmp", tmuxSession: `agentmgr-decisions-none-${name}`, createdAt: now, updatedAt: now, ...extra };
  }

  describe("the decisions store reader", () => {
    test("honours DECISIONS_HOME, else $HOME/.local/state/agent-decisions read live", () => {
      expect(decisionsHome()).toBe(join(amHome, "decisions"));
      const oldHome = process.env.HOME;
      delete process.env.DECISIONS_HOME;
      process.env.HOME = join(amHome, "fake-amHome");
      try {
        expect(decisionsHome()).toBe(join(amHome, "fake-amHome", ".local", "state", "agent-decisions"));
      } finally {
        process.env.HOME = oldHome;
      }
    });

    test("a missing, invalid or unknown-version file reads as no decisions", () => {
      expect(readDecisionStore("api")).toBeNull();
      expect(openDecisions("api")).toEqual([]);
      mkdirSync(decisionsHome(), { recursive: true });
      writeFileSync(decisionStoreFile("api"), "{not json");
      expect(readDecisionStore("api")).toBeNull();
      expect(decisionSummary("api")).toEqual({ open: 0, blocking: 0 });
      writeFileSync(decisionStoreFile("api"), JSON.stringify({ version: 2, agent: "api", decisions: [decision("d-1")] }));
      expect(readDecisionStore("api")).toBeNull();
      writeFileSync(decisionStoreFile("api"), JSON.stringify({ version: 1, agent: "api", decisions: "nope" }));
      expect(readDecisionStore("api")).toBeNull();
      writeFileSync(decisionStoreFile("api"), "[]");
      expect(readDecisionStore("api")).toBeNull();
    });

    test("only regular files are read: a FIFO named like a store is skipped", () => {
      mkdirSync(decisionsHome(), { recursive: true });
      Bun.spawnSync(["mkfifo", join(decisionsHome(), "pipe.json")]);
      writeStore("api", [decision("d-1")]);
      const texts = readDecisionStoreTexts();
      expect([...texts.keys()]).toEqual(["api"]);
      expect(readDecisionStore("pipe")).toBeNull();
    });

    test("open decisions come blocking first, then oldest; malformed and closed ones are left out", () => {
      writeStore("api", [
        decision("d-1", { asked_at: "2026-11-09T00:00:00Z" }),
        decision("d-2", { asked_at: "2026-11-11T00:00:00Z", blocking: true }),
        decision("d-3", { asked_at: "2026-11-08T00:00:00Z", status: "decided", answer: "yes" }),
        decision("d-4", { asked_at: "2026-11-07T00:00:00Z" }),
        { id: "d-5", status: "bogus", question: "?" } as unknown as Decision,
        "junk" as unknown as Decision,
      ]);
      expect(openDecisions("api").map((d) => d.id)).toEqual(["d-2", "d-4", "d-1"]);
      expect(decisionSummary("api")).toEqual({ open: 3, blocking: 1, oldestAskedAt: "2026-11-07T00:00:00Z", first: "question d-2?" });
    });

    test("labels", () => {
      expect(decisionsLabel(1, 0)).toBe("1 decision");
      expect(decisionsLabel(2, 0)).toBe("2 decisions");
      expect(decisionsLabel(1, 1)).toBe("1 decision (blocking)");
      expect(decisionsLabel(3, 1)).toBe("3 decisions (1 blocking)");
    });
  });

  describe("am ls", () => {
    test("rows carry decision counts, exited agents included, and 0 when none", () => {
      writeAgent(agent("api"));
      writeAgent(agent("web"));
      writeStore("api", [decision("d-1", { blocking: true }), decision("d-2")]);
      const rows = agentRows();
      const api = rows.find((r) => r.name === "api")!;
      const web = rows.find((r) => r.name === "web")!;
      expect(api).toMatchObject({ status: "exited", openDecisions: 2, blockingDecisions: 1, firstDecision: "question d-1?", oldestDecisionAt: "2026-11-10T00:00:00Z" });
      expect(web).toMatchObject({ openDecisions: 0, blockingDecisions: 0 });
      expect(web.firstDecision).toBeUndefined();
      const lines = formatRows(rows);
      expect(lines.find((l) => l.includes(" api "))).toContain("exited · 2 decisions (1 blocking)");
      expect(lines.find((l) => l.includes(" web "))).not.toContain("decision");
    });

    test("the suffix follows the subagent rollup; an older remote row has none", () => {
      const base = { provider: "claude" as const, queued: 0, updatedAt: new Date().toISOString(), dir: "/tmp" };
      const rows: (AgentRow & { host?: string })[] = [
        { ...base, name: "busy", status: "working", statusDetail: "2 subagents · Explore", openDecisions: 1, blockingDecisions: 1 },
        { ...base, name: "old", status: "idle", host: "far" },
      ];
      const lines = formatRows(rows);
      expect(lines[1]).toContain("working · 2 subagents · Explore · 1 decision (blocking)");
      expect(lines[2]).not.toContain("decision");
    });

    test("decisions: false hides them, PR status included", () => {
      writeFileSync(join(amHome, "config.json"), JSON.stringify({ decisions: false }));
      const pr = { repository: "o/r", number: 7, url: "https://github.com/o/r/pull/7", state: "OPEN" as const, updatedAt: new Date().toISOString() };
      writeAgent(agent("api", { prMonitor: { pullRequests: [pr] } as AgentState["prMonitor"] }));
      writeStore("api", [decision("d-1")]);
      const row = agentRows()[0]!;
      expect(row).toMatchObject({ openDecisions: 0, blockingDecisions: 0 });
      expect(row.prStatus?.[0]?.state).not.toBe("needs-decision");
      expect(row.prStatus?.[0]?.decision).toBeUndefined();
    });
  });

  describe("am summary", () => {
    const NOW = new Date("2026-11-12T12:00:00.000Z");
    function row(name: string, status: FleetRow["status"], overrides: Partial<FleetRow> = {}): FleetRow {
      return { name, status, provider: "claude", queued: 0, updatedAt: "2026-11-12T11:59:00.000Z", statusChangedAt: "2026-11-12T11:59:00.000Z", dir: "/tmp", ...overrides };
    }

    test("agents waiting on decisions need attention, exited ones too, with the age once two days old", () => {
      const summary = buildFleetSummary({
        rows: [
          row("fresh", "idle", { openDecisions: 2, blockingDecisions: 0, firstDecision: "Ship  it\nnow?", oldestDecisionAt: "2026-11-12T00:00:00Z" }),
          row("gone", "exited", { openDecisions: 1, blockingDecisions: 1, firstDecision: "x".repeat(200), oldestDecisionAt: "2026-11-09T00:00:00Z" }),
          row("blocked", "needs-attention", { statusReason: "approval requested — shell", openDecisions: 1, blockingDecisions: 0, firstDecision: "Which db?" }),
          row("quiet", "idle", { openDecisions: 0, blockingDecisions: 0 }),
          row("old-remote", "idle", { host: "far" }),
        ],
        unreachable: [],
      }, NOW, null, { decisions: true });
      expect(summary.waitingOnDecisions).toBe(3);
      expect(summary.attention.map((i) => i.name).sort()).toEqual(["blocked", "fresh", "gone"]);
      expect(summary.exited).toEqual([]);
      expect(summary.idle.map((i) => i.name).sort()).toEqual(["old-remote", "quiet"]);
      const byName = Object.fromEntries(summary.attention.map((i) => [i.name, i]));
      expect(byName.fresh!.reason).toBe("waiting on 2 decisions from you: Ship it now?");
      expect(byName.gone!.reason).toBe(`waiting on 1 decision from you: ${"x".repeat(79)}… (open 3d)`);
      expect(byName.blocked!.reason).toBe("approval requested — shell; waiting on 1 decision from you: Which db?");
      expect(byName.fresh!.decisions).toEqual({ open: 2, blocking: 0, oldestAskedAt: "2026-11-12T00:00:00Z", first: "Ship  it\nnow?" });

      const text = formatFleetSummary(summary);
      expect(text[0]).toBe("Fleet: 5 agents · 3 agents waiting on decisions");
      expect(text).toContain("Needs attention (3)");
      expect(text.some((l) => l.includes("gone") && l.includes("exited — waiting on 1 decision"))).toBe(true);
    });

    test("terminal controls in a question never reach the summary text", () => {
      const rows = [row("evil", "idle", { openDecisions: 1, blockingDecisions: 0, firstDecision: "ok\x1b]52;c;cGF5bG9hZA==\x07\x1b[2J\x9b31mdone?" })];
      const summary = buildFleetSummary({ rows, unreachable: [] }, NOW, null, { decisions: true });
      const text = formatFleetSummary(summary).join("\n");
      expect(text).not.toMatch(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/);
      expect(summary.attention[0]!.reason).toBe("waiting on 1 decision from you: ok ]52;c;cGF5bG9hZA== [2J 31mdone?");
    });

    test("no decisions: no headline, and decisions: false ignores them", () => {
      const rows = [row("a", "idle", { openDecisions: 1, blockingDecisions: 0 })];
      const off = buildFleetSummary({ rows, unreachable: [] }, NOW, null, { decisions: false });
      expect(off.waitingOnDecisions).toBe(0);
      expect(off.idle.map((i) => i.name)).toEqual(["a"]);
      expect(formatFleetSummary(off)[0]).toBe("Fleet: 1 agent");
    });
  });

  describe("lifecycle", () => {
    test("rename moves the store and its markers without rewriting the CLI's file", async () => {
      writeAgent(agent("alpha"));
      ensurePlan("alpha", "task");
      writeStore("alpha", [decision("d-1")], { plan: planFile("alpha") });
      mkdirSync(decisionsHome(), { recursive: true });
      writeFileSync(join(decisionsHome(), ".alpha.nudge"), "remind");
      await renameAgent("alpha", "omega");
      expect(existsSync(decisionStoreFile("alpha"))).toBe(false);
      const store = JSON.parse(readFileSync(decisionStoreFile("omega"), "utf8"));
      expect(store).toMatchObject({ agent: "alpha", plan: planFile("alpha"), host: "box" });
      expect(store.decisions.map((d: Decision) => d.id)).toEqual(["d-1"]);
      expect(readFileSync(join(decisionsHome(), ".omega.nudge"), "utf8")).toBe("remind");
    });

    test("a name the CLI slugs onto another agent's store never moves it", async () => {
      writeAgent(agent("foo"));
      writeAgent(agent("foo-"));
      writeStore("foo", [decision("d-1")]);
      destroyAgent(readAgent("foo-")!, { clean: false });
      expect(openDecisions("foo").map((d) => d.id)).toEqual(["d-1"]);
      writeAgent(agent("bar-"));
      await renameAgent("bar-", "baz");
      expect(openDecisions("foo").map((d) => d.id)).toEqual(["d-1"]);
      writeAgent(agent("foo-"));
      expect(agentRows().find((r) => r.name === "foo-")).toMatchObject({ openDecisions: 0 });
      expect(decisionsWanted({ name: "foo-" })).toBe(false);
      await expect(renameAgent("foo", "qux-")).rejects.toThrow(/cannot keep "foo"'s decisions store/);
      expect(readAgent("foo")).not.toBeNull();
    });

    test("rename refuses to clobber another store", async () => {
      writeAgent(agent("alpha"));
      writeStore("alpha", [decision("d-1")]);
      writeStore("omega", [decision("d-9")]);
      await expect(renameAgent("alpha", "omega")).rejects.toThrow(/decisions store already exists/);
      expect(readAgent("alpha")).not.toBeNull();
      expect(openDecisions("alpha").map((d) => d.id)).toEqual(["d-1"]);
    });

    test("rm sends the store to trash with the plan; restore brings it back", async () => {
      writeAgent(agent("alpha"));
      writeStore("alpha", [decision("d-1")]);
      destroyAgent(readAgent("alpha")!, { clean: false });
      expect(existsSync(decisionStoreFile("alpha"))).toBe(false);
      expect(existsSync(join(trashDir(), "alpha.decisions"))).toBe(true);
      expect(agentRows()).toEqual([]);
      await restoreCommand("alpha", { resume: false });
      expect(openDecisions("alpha").map((d) => d.id)).toEqual(["d-1"]);
      expect(existsSync(join(trashDir(), "alpha.decisions"))).toBe(false);
    });

    test("a move import writes the carried store for this host, never over a local one", () => {
      const text = JSON.stringify({ version: 1, agent: "alpha", host: "far", dir: "/far", plan: null, decisions: [decision("d-1")] });
      importPayload(JSON.stringify({ state: agent("alpha", { dir: amHome }), queue: [], decisions: text }));
      const store = JSON.parse(readFileSync(decisionStoreFile("alpha"), "utf8"));
      expect(store.agent).toBe("alpha");
      expect(store.dir).toBe(amHome);
      expect(store.host).not.toBe("far");
      expect(store.decisions).toHaveLength(1);

      writeStore("beta", [decision("d-7")]);
      importPayload(JSON.stringify({ state: agent("beta", { dir: amHome }), queue: [], decisions: text }));
      expect(openDecisions("beta").map((d) => d.id)).toEqual(["d-7"]);
    });
  });
});
