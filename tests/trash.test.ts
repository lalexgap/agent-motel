import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listTrashed, readTrashedState, trashState } from "../src/trash";
import type { AgentState } from "../src/state";

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "am-trash-"));
  process.env.AGENTMGR_HOME = home;
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  delete process.env.AGENTMGR_HOME;
});

function agent(name: string, extra: Partial<AgentState> = {}): AgentState {
  const now = new Date().toISOString();
  return { name, status: "idle", dir: `/tmp/${name}`, tmuxSession: `agentmgr-${name}`, createdAt: now, updatedAt: now, ...extra };
}

describe("trash", () => {
  test("snapshots a state file and reads it back with a trashedAt stamp", () => {
    trashState(agent("ghost", { sessionId: "sid-1", worktreeBranch: "am/ghost" }));
    const back = readTrashedState("ghost");
    expect(back?.name).toBe("ghost");
    expect(back?.sessionId).toBe("sid-1");
    expect(back?.worktreeBranch).toBe("am/ghost");
    expect(typeof back?.trashedAt).toBe("string");
  });

  test("readTrashedState returns null for an unknown name", () => {
    expect(readTrashedState("nope")).toBeNull();
  });

  test("listTrashed returns entries newest-deletion-first", async () => {
    trashState(agent("older"));
    await Bun.sleep(5);
    trashState(agent("newer"));
    const names = listTrashed().map((t) => t.name);
    expect(names).toEqual(["newer", "older"]);
  });

  test("re-trashing the same name overwrites (latest delete wins)", () => {
    trashState(agent("dup", { dir: "/tmp/first" }));
    trashState(agent("dup", { dir: "/tmp/second" }));
    expect(listTrashed().filter((t) => t.name === "dup")).toHaveLength(1);
    expect(readTrashedState("dup")?.dir).toBe("/tmp/second");
  });
});
