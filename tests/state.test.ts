import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  listAgents,
  readAgent,
  readLastAttached,
  recordAttached,
  removeAgent,
  resolveAgentName,
  resolveAgent,
  setStatus,
  updateAgentStatus,
  writeAgent,
  type AgentState,
} from "../src/state";

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "am-test-"));
  process.env.AGENTMGR_HOME = home;
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  delete process.env.AGENTMGR_HOME;
});

function makeAgent(name: string): AgentState {
  const now = new Date().toISOString();
  return {
    name,
    status: "starting",
    dir: "/tmp",
    tmuxSession: `agentmgr-${name}`,
    createdAt: now,
    updatedAt: now,
  };
}

describe("agent state", () => {
  test("write, read, list, remove round-trip", () => {
    writeAgent(makeAgent("alpha"));
    writeAgent(makeAgent("beta"));

    expect(readAgent("alpha")?.name).toBe("alpha");
    expect(listAgents().map((a) => a.name)).toEqual(["alpha", "beta"]);

    removeAgent("alpha");
    expect(readAgent("alpha")).toBeNull();
    expect(listAgents().map((a) => a.name)).toEqual(["beta"]);
  });

  test("setStatus updates status, reason, and transition timestamp", () => {
    writeAgent(makeAgent("alpha"));
    setStatus("alpha", "needs-attention", "approval requested — shell");
    expect(readAgent("alpha")).toMatchObject({
      status: "needs-attention",
      statusReason: "approval requested — shell",
    });
    expect(readAgent("alpha")?.statusChangedAt).toBeTruthy();
  });

  test("a new transition clears a stale reason", () => {
    const state = makeAgent("alpha");
    updateAgentStatus(state, "needs-attention", "permission requested", "2026-01-01T00:01:00Z");
    updateAgentStatus(state, "working", undefined, "2026-01-01T00:02:00Z");
    expect(state.status).toBe("working");
    expect(state.statusReason).toBeUndefined();
    expect(state.statusChangedAt).toBe("2026-01-01T00:02:00Z");
  });

  test("repeated status writes preserve the original transition time", () => {
    const state = makeAgent("alpha");
    updateAgentStatus(state, "working", undefined, "2026-01-01T00:01:00Z");
    updateAgentStatus(state, "working", undefined, "2026-01-01T00:02:00Z");
    expect(state.statusChangedAt).toBe("2026-01-01T00:01:00Z");
  });

  test("setStatus on unknown agent is a no-op", () => {
    setStatus("ghost", "working");
    expect(readAgent("ghost")).toBeNull();
  });

  test("stale metadata writes preserve newer status and session metadata", () => {
    writeAgent(makeAgent("alpha"));
    const stale = readAgent("alpha")!;
    const session = readAgent("alpha")!;
    session.sessionId = "new-session";
    writeAgent(session);
    setStatus("alpha", "working");
    stale.task = "new task";
    writeAgent(stale);
    expect(readAgent("alpha")).toMatchObject({ status: "working", sessionId: "new-session", task: "new task" });
  });

  test("stale status writes preserve metadata and honor an unchanged requested status", () => {
    writeAgent(makeAgent("alpha"));
    const stale = readAgent("alpha")!;
    const session = readAgent("alpha")!;
    session.sessionId = "new-session";
    writeAgent(session);
    setStatus("alpha", "needs-attention", "approval");
    updateAgentStatus(stale, "starting", undefined, "2026-01-01T00:01:00Z");
    writeAgent(stale);
    expect(readAgent("alpha")).toMatchObject({
      status: "starting", sessionId: "new-session", statusChangedAt: "2026-01-01T00:01:00Z",
    });
    expect(readAgent("alpha")?.statusReason).toBeUndefined();
  });

  test("explicit clears and deletions survive merging", () => {
    const original = makeAgent("alpha");
    original.reportTo = "parent";
    original.transcriptPath = "/old/transcript";
    writeAgent(original);
    const stale = readAgent("alpha")!;
    setStatus("alpha", "working");
    stale.reportTo = undefined;
    delete stale.transcriptPath;
    writeAgent(stale);
    expect(readAgent("alpha")?.reportTo).toBeUndefined();
    expect(readAgent("alpha")?.transcriptPath).toBeUndefined();
    expect(readAgent("alpha")?.status).toBe("working");
  });

  test("a stale writer cannot recreate removed state", () => {
    writeAgent(makeAgent("alpha"));
    const stale = readAgent("alpha")!;
    removeAgent("alpha");
    stale.sessionId = "late-hook";
    writeAgent(stale);
    expect(readAgent("alpha")).toBeNull();
  });

  test("parallel processes preserve each other's changes from a shared snapshot", async () => {
    writeAgent(makeAgent("alpha"));
    const fields = ["sessionId", "task", "role", "reportTo", "transcriptPath", "spawnedBy", "repoRoot", "dir"];
    const stateModule = new URL("../src/state.ts", import.meta.url).href;
    const processes = fields.map((field) => Bun.spawn([process.execPath, "-e", `
      import { readAgent, writeAgent } from ${JSON.stringify(stateModule)};
      import { existsSync, writeFileSync } from "node:fs";
      const state = readAgent("alpha");
      writeFileSync(${JSON.stringify(join(home, `${field}.ready`))}, "");
      const wait = new Int32Array(new SharedArrayBuffer(4));
      while (!existsSync(${JSON.stringify(join(home, "go"))})) Atomics.wait(wait, 0, 0, 5);
      state[${JSON.stringify(field)}] = ${JSON.stringify(`new-${field}`)};
      writeAgent(state);
    `], { env: { ...process.env, AGENTMGR_HOME: home }, stdout: "pipe", stderr: "pipe" }));
    try {
      const deadline = Date.now() + 5000;
      while (!fields.every((field) => existsSync(join(home, `${field}.ready`)))) {
        if (Date.now() > deadline) throw new Error("state writers did not reach the barrier");
        await Bun.sleep(5);
      }
      writeFileSync(join(home, "go"), "");
      const codes = await Promise.all(processes.map((child) => child.exited));
      if (codes.some((code) => code !== 0)) {
        throw new Error((await Promise.all(processes.map((child) => new Response(child.stderr).text()))).join("\n"));
      }
      expect(codes).toEqual(fields.map(() => 0));
      const saved = readAgent("alpha")!;
      for (const field of fields) expect(saved[field as keyof AgentState]).toBe(`new-${field}`);
    } finally {
      for (const child of processes) child.kill();
      await Promise.all(processes.map((child) => child.exited));
    }
  });

  test("a corrupt state file is quarantined, not fatal", () => {
    writeAgent(makeAgent("alpha"));
    writeFileSync(join(home, "agents", "torn.json"), '{"name": "torn", "status"');

    expect(readAgent("torn")).toBeNull();
    expect(listAgents().map((a) => a.name)).toEqual(["alpha"]);
    // Moved aside (name freed, damage visible) rather than silently shadowing.
    const files = readdirSync(join(home, "agents")).sort();
    expect(files).toEqual(["alpha.json", "torn.json.corrupt"]);
  });

  test("writes are atomic — no lingering partial .json files", () => {
    writeAgent(makeAgent("alpha"));
    const files = readdirSync(join(home, "agents"));
    expect(files).toEqual(["alpha.json"]);
  });
});

describe("resolveAgentName", () => {
  const names = ["api-refactor", "api-docs", "bugfix"];

  test("exact match wins even when it is a prefix of another", () => {
    expect(resolveAgentName("api-docs", ["api-docs", "api-docs-2"])).toBe("api-docs");
  });

  test("unambiguous prefix resolves", () => {
    expect(resolveAgentName("bug", names)).toBe("bugfix");
    expect(resolveAgentName("api-r", names)).toBe("api-refactor");
  });

  test("ambiguous prefix throws with candidates", () => {
    expect(() => resolveAgentName("api", names)).toThrow(/ambiguous.*api-refactor.*api-docs/);
  });

  test("no match throws", () => {
    expect(() => resolveAgentName("zzz", names)).toThrow(/no agent matches/);
  });
});

describe("agent aliases", () => {
  test("resolveAgent accepts exact aliases but not alias prefixes", () => {
    writeAgent(makeAgent("current"));
    const renamed = readAgent("current")!;
    renamed.aliases = ["former-name"];
    writeAgent(renamed);

    expect(resolveAgent("former-name").name).toBe("current");
    expect(() => resolveAgent("former")).toThrow(/no agent matches/);
  });
});

describe("last attached", () => {
  test("tracks current and previous", () => {
    recordAttached("alpha");
    recordAttached("beta");
    expect(readLastAttached()).toMatchObject({ current: "beta", previous: "alpha" });
  });

  test("re-attaching the same agent does not clobber previous", () => {
    recordAttached("alpha");
    recordAttached("beta");
    recordAttached("beta");
    expect(readLastAttached()).toMatchObject({ current: "beta", previous: "alpha" });
  });
});
