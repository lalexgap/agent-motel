import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveTarget } from "../src/route";
import { configFile } from "../src/paths";
import { writeAgent, type AgentState } from "../src/state";

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "am-test-"));
  process.env.AGENTMGR_HOME = home;
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  delete process.env.AGENTMGR_HOME;
});

function agent(name: string): void {
  const s: AgentState = {
    name,
    status: "idle",
    dir: "/tmp",
    tmuxSession: `agentmgr-${name}`,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  };
  writeAgent(s);
}

describe("resolveTarget", () => {
  test("local exact and unambiguous prefix", () => {
    agent("web");
    agent("worker");
    expect(resolveTarget("web")).toEqual({ kind: "local", name: "web" });
    expect(resolveTarget("wor")).toEqual({ kind: "local", name: "worker" });
  });

  test("ambiguous local prefix throws", () => {
    agent("api-one");
    agent("api-two");
    expect(() => resolveTarget("api")).toThrow(/ambiguous/);
  });

  test("explicit host:name resolves to a known remote, else none (bare name)", () => {
    writeFileSync(configFile(), JSON.stringify({ remotes: ["box"] }));
    expect(resolveTarget("box:web")).toEqual({ kind: "remote", host: "box", name: "web" });
    expect(resolveTarget("nope:web")).toEqual({ kind: "none", name: "web" }); // unknown host → outbox
  });

  test("no match with no remotes → none (outbox handles it)", () => {
    expect(resolveTarget("ghost")).toEqual({ kind: "none", name: "ghost" });
  });
});
