import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inboxDir } from "../src/paths";
import { queueAppend, queueList } from "../src/queue";
import { readSnapshot, writeSnapshot } from "../src/snapshots";
import { readAgent, readLastAttached, recordAttached, resolveAgent, writeAgent, type AgentState } from "../src/state";
import { renameAgent } from "../src/commands/rename";
import { reportCommand } from "../src/commands/report";
import { hasSession } from "../src/tmux";

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "am-rename-test-"));
  process.env.AGENTMGR_HOME = home;
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  delete process.env.AGENTMGR_HOME;
});

function agent(name: string, extra: Partial<AgentState> = {}): AgentState {
  const now = new Date().toISOString();
  return {
    name,
    status: "exited",
    dir: "/tmp",
    tmuxSession: `agentmgr-${name}`,
    createdAt: now,
    updatedAt: now,
    ...extra,
  };
}

describe("renameAgent", () => {
  test("migrates durable identity and keeps the old name as a routing alias", async () => {
    writeAgent(agent("alpha", {
      aliases: ["first-alpha"],
      provider: "codex",
      worktreePath: "/tmp/worktree-alpha",
      worktreeBranch: "am/alpha",
    }));
    writeAgent(agent("lead", { reportTo: "alpha" }));
    writeAgent(agent("child", { spawnedBy: "alpha" }));
    queueAppend("alpha", "pending work");
    writeSnapshot("alpha", ["last screen"]);
    mkdirSync(inboxDir("alpha"), { recursive: true });
    writeFileSync(join(inboxDir("alpha"), "brief.txt"), "hello");
    recordAttached("lead");
    recordAttached("alpha");

    const result = await renameAgent("alpha", "omega");

    expect(result).toMatchObject({ oldName: "alpha", newName: "omega", live: false });
    expect(readAgent("alpha")).toBeNull();
    expect(readAgent("omega")).toMatchObject({
      name: "omega",
      aliases: ["first-alpha", "alpha"],
      tmuxSession: "agentmgr-omega",
      worktreePath: "/tmp/worktree-alpha",
      worktreeBranch: "am/alpha",
    });
    expect(resolveAgent("alpha").name).toBe("omega");
    expect(resolveAgent("first-alpha").name).toBe("omega");
    expect(queueList("omega").map((entry) => entry.message)).toEqual([
      "pending work",
      expect.stringContaining('renamed from "alpha" to "omega"'),
    ]);
    expect(queueList("alpha")).toEqual([]);
    expect(readSnapshot("omega")).toEqual(["last screen"]);
    expect(readSnapshot("alpha")).toBeNull();
    expect(existsSync(join(inboxDir("omega"), "brief.txt"))).toBe(true);
    expect(existsSync(inboxDir("alpha"))).toBe(false);
    expect(readAgent("lead")?.reportTo).toBe("omega");
    expect(readAgent("child")?.spawnedBy).toBe("omega");
    expect(readLastAttached().current).toBe("omega");
  });

  test("refuses a name owned by another agent or one of its aliases", async () => {
    writeAgent(agent("alpha"));
    writeAgent(agent("beta", { aliases: ["old-beta"] }));

    await expect(renameAgent("alpha", "beta")).rejects.toThrow(/already used/);
    await expect(renameAgent("alpha", "old-beta")).rejects.toThrow(/alias/);
    expect(readAgent("alpha")?.name).toBe("alpha");
  });

  test("can rename back to one of the same agent's previous aliases", async () => {
    writeAgent(agent("omega", { aliases: ["alpha"] }));

    await renameAgent("omega", "alpha");

    expect(readAgent("alpha")?.aliases).toEqual(["omega"]);
    expect(resolveAgent("omega").name).toBe("alpha");
  });

  test.skipIf(!Bun.which("tmux"))("renames a working session in place without restarting its process", async () => {
    const stamp = `${process.pid}-${Date.now()}`;
    const oldName = `live-${stamp}`;
    const newName = `renamed-${stamp}`;
    const oldSession = `agentmgr-${oldName}`;
    const newSession = `agentmgr-${newName}`;
    const started = Bun.spawnSync(["tmux", "new-session", "-d", "-s", oldSession, "sleep", "30"]);
    expect(started.exitCode).toBe(0);
    const panePid = Bun.spawnSync(["tmux", "list-panes", "-t", `=${oldSession}:`, "-F", "#{pane_pid}"])
      .stdout.toString().trim();
    const workingSince = new Date(Date.now() - 1_000).toISOString();
    writeAgent(agent(oldName, { status: "working", workingSince }));

    try {
      const result = await renameAgent(oldName, newName);

      expect(result).toMatchObject({ oldName, newName, live: true });
      expect(hasSession(oldSession)).toBe(false);
      expect(hasSession(newSession)).toBe(true);
      expect(Bun.spawnSync(["tmux", "list-panes", "-t", `=${newSession}:`, "-F", "#{pane_pid}"])
        .stdout.toString().trim()).toBe(panePid);
      expect(readAgent(newName)).toMatchObject({
        name: newName,
        aliases: [oldName],
        status: "working",
        workingSince,
        tmuxSession: newSession,
      });
      expect(resolveAgent(oldName).name).toBe(newName);
      expect(queueList(newName).map((entry) => entry.message)).toContainEqual(
        expect.stringContaining(`renamed from "${oldName}" to "${newName}"`),
      );

      // The provider process still exports the old name. A subsequent hook
      // must resolve that alias to the renamed state instead of recreating an
      // old-name state file or writing to the old queue.
      const renamed = readAgent(newName)!;
      renamed.status = "idle";
      writeAgent(renamed);
      const hook = Bun.spawnSync(
        [process.execPath, join(import.meta.dir, "../src/index.ts"), "hook", "pre-tool-use"],
        {
          env: { ...process.env, AGENTMGR_HOME: home, AGENTMGR_AGENT: oldName },
          stdin: Buffer.from("{}"),
        },
      );
      expect(hook.exitCode).toBe(0);
      expect(readAgent(oldName)).toBeNull();
      expect(readAgent(newName)?.status).toBe("working");
    } finally {
      Bun.spawnSync(["tmux", "kill-session", "-t", `=${newSession}`]);
      Bun.spawnSync(["tmux", "kill-session", "-t", `=${oldSession}`]);
    }
  });
});

describe("rename aliases", () => {
  test("normalizes a reporting target's old name to its current identity", () => {
    writeAgent(agent("lead", { aliases: ["old-lead"] }));
    writeAgent(agent("worker"));

    reportCommand("worker", { to: "old-lead" });

    expect(readAgent("worker")?.reportTo).toBe("lead");
  });
});
