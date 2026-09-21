import { describe, expect, test } from "bun:test";
import { filterRowsByRole, liveSubagents, paneWaitingInfo, sortLsRows, type AgentRow } from "../src/commands/ls";

const SEP = "─".repeat(40);

function row(name: string, role: string | undefined, status: AgentRow["status"] = "idle", updatedAt = "2026-01-01T00:00:00Z"): AgentRow {
  return { name, role, status, updatedAt, statusChangedAt: updatedAt, provider: "claude", queued: 0, dir: "/tmp" };
}

describe("role filtering and sorting", () => {
  const rows = [row("zeta", undefined), row("beta", "reviewer", "idle"), row("alpha", "builder", "working")];

  test("filters an assigned role or explicitly unassigned agents", () => {
    expect(filterRowsByRole(rows, "reviewer").map((item) => item.name)).toEqual(["beta"]);
    expect(filterRowsByRole(rows, "unassigned").map((item) => item.name)).toEqual(["zeta"]);
    expect(filterRowsByRole(rows).map((item) => item.name)).toEqual(["zeta", "beta", "alpha"]);
  });

  test("sorts roles alphabetically, unassigned last, then status and name", () => {
    const sorted = sortLsRows([...rows, row("aardvark", "reviewer", "working")], "role");
    expect(sorted.map((item) => item.name)).toEqual(["alpha", "aardvark", "beta", "zeta"]);
  });

  test("rejects an unknown sort", () => {
    expect(() => sortLsRows(rows, "mystery")).toThrow(/status, recent, or role/);
  });
});

describe("paneWaitingInfo", () => {
  test("detects indicators in the status region with display detail", () => {
    const info = paneWaitingInfo(["⏺ Done.", SEP, "❯ ", SEP, "  ✶ next wake-up in 4m (watching CI)"]);
    expect(info.waiting).toBe(true);
    expect(info.detail).toBe("next wake-up in 4m (watching CI)");

    expect(paneWaitingInfo([SEP, "1 background task running"]).waiting).toBe(true);
    expect(paneWaitingInfo([SEP, "2 bashes running · 30k tokens"]).detail).toBe("2 bashes running · 30k tokens");
  });

  test("conversation text above the separator can't false-positive", () => {
    const info = paneWaitingInfo(["⏺ I started a background task for you.", SEP, "❯ ", SEP, "  42k tokens"]);
    expect(info.waiting).toBe(false);
  });

  test("strips SGR color codes from matches", () => {
    const info = paneWaitingInfo([SEP, "\x1b[2m✶ wake-up in 90s\x1b[0m"]);
    expect(info.waiting).toBe(true);
    expect(info.detail).toBe("wake-up in 90s");
  });

  test("no separator falls back to the last few lines only", () => {
    expect(paneWaitingInfo(["background task mentioned early", "a", "b", "c", "d", "e"]).waiting).toBe(false);
    expect(paneWaitingInfo(["a", "b", "1 background task running"]).waiting).toBe(true);
  });

  test("plain idle panes are not waiting", () => {
    expect(paneWaitingInfo([SEP, "  ⏵⏵ auto mode on · 30k tokens"]).waiting).toBe(false);
  });
});

describe("background task surfacing", () => {
  test("lastNonEmptyLine strips ANSI and trailing blanks", async () => {
    const { lastNonEmptyLine } = await import("../src/commands/ls");
    expect(lastNonEmptyLine("a\nb\n\n\x1b[32mDEPLOYED: web=abc\x1b[0m\n\n")).toBe("DEPLOYED: web=abc");
    expect(lastNonEmptyLine("\n\n")).toBeNull();
  });

  test("sessionTasksDir mirrors claude's slug/session layout", async () => {
    const { sessionTasksDir } = await import("../src/commands/ls");
    const dir = sessionTasksDir({
      name: "x", status: "idle", dir: "/home/u/code/app", tmuxSession: "agentmgr-x",
      sessionId: "abc-123", createdAt: "", updatedAt: "",
    } as never);
    expect(dir).toMatch(/^\/tmp\/claude-\d+\/-home-u-code-app\/abc-123\/tasks$/);
    expect(sessionTasksDir({ name: "x", status: "idle", dir: "/d", tmuxSession: "t", createdAt: "", updatedAt: "" } as never)).toBeNull();
  });

  test("backgroundTasks reads the freshest output tail", async () => {
    const { backgroundTasks, sessionTasksDir } = await import("../src/commands/ls");
    const { mkdirSync, writeFileSync, rmSync } = await import("node:fs");
    const agent = {
      name: "x", status: "idle", dir: "/tmp/am-bg-fixture", tmuxSession: "agentmgr-x",
      sessionId: "fixture-session", createdAt: "", updatedAt: "",
    } as never;
    const dir = sessionTasksDir(agent)!;
    mkdirSync(dir, { recursive: true });
    try {
      writeFileSync(`${dir}/old.output`, "stale watcher\n");
      await Bun.sleep(20);
      writeFileSync(`${dir}/fresh.output`, "polling…\ntick-7\n");
      const bg = backgroundTasks(agent)!;
      expect(bg.lastLine).toBe("tick-7");
      expect(bg.count).toBe(2);
    } finally {
      rmSync(dir.replace(/\/tasks$/, ""), { recursive: true, force: true });
    }
  });
});

describe("gitDiffSummary", () => {
  test("reports tracked line changes and all dirty files", async () => {
    const { gitDiffSummary } = await import("../src/commands/ls");
    const { mkdtempSync, rmSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "am-diff-"));
    const git = (...args: string[]) => Bun.spawnSync(["git", "-C", dir, ...args], { stdout: "ignore", stderr: "ignore" });
    try {
      git("init", "-q");
      git("config", "user.email", "am@example.test");
      git("config", "user.name", "Agent Motel");
      writeFileSync(join(dir, "tracked.txt"), "one\n");
      git("add", "tracked.txt");
      git("commit", "-qm", "initial");
      writeFileSync(join(dir, "tracked.txt"), "one\ntwo\n");
      writeFileSync(join(dir, "new.txt"), "untracked\n");

      expect(gitDiffSummary(dir)).toEqual({ added: 1, removed: 0, files: 2, dirty: true });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("liveSubagents", () => {
  const summary = { active: 2, types: "Explore", detail: "2 subagents · Explore" };

  test("reports what a live agent is running", () => {
    expect(liveSubagents("working", () => summary)).toEqual(summary);
    expect(liveSubagents("working", () => null)).toBeUndefined();
  });

  test("a gone agent reports nothing and never reads its ledger", () => {
    let reads = 0;
    const read = () => {
      reads++;
      return summary;
    };
    expect(liveSubagents("dead", read)).toBeUndefined();
    expect(liveSubagents("exited", read)).toBeUndefined();
    expect(reads).toBe(0);
  });
});
