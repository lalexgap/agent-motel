import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileNote, resolveFileTarget } from "../src/commands/sendfile";
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

function agent(name: string, aliases?: string[]): void {
  const s: AgentState = {
    name,
    aliases,
    status: "idle",
    dir: "/tmp",
    tmuxSession: `agentmgr-${name}`,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  };
  writeAgent(s);
}

describe("fileNote", () => {
  test("defaults to a generic lead, keeps a custom message, always points at the path", () => {
    expect(fileNote(undefined, "/in/box/a.txt")).toBe("sent you a file → /in/box/a.txt");
    expect(fileNote("  ", "/in/box/a.txt")).toBe("sent you a file → /in/box/a.txt");
    expect(fileNote("ship it", "/in/box/a.txt")).toBe("ship it → /in/box/a.txt");
  });
});

describe("resolveFileTarget", () => {
  test("resolves a local agent by exact name and unambiguous prefix", () => {
    agent("web");
    agent("worker");
    expect(resolveFileTarget("web")).toEqual({ name: "web" });
    expect(resolveFileTarget("wor")).toEqual({ name: "worker" }); // unique prefix
  });

  test("resolves a local agent's previous name to its current inbox", () => {
    agent("web", ["frontend"]);
    expect(resolveFileTarget("frontend")).toEqual({ name: "web" });
  });

  test("an ambiguous local prefix throws", () => {
    agent("api-one");
    agent("api-two");
    expect(() => resolveFileTarget("api")).toThrow(/ambiguous/);
  });

  test("explicit host:name requires a known remote", () => {
    writeFileSync(configFile(), JSON.stringify({ remotes: ["box"] }));
    expect(resolveFileTarget("box:web")).toEqual({ host: "box", name: "web" });
    expect(() => resolveFileTarget("nope:web")).toThrow(/unknown host/);
  });

  test("an unmatched name with no remotes configured throws (no ssh fan-out)", () => {
    expect(() => resolveFileTarget("ghost")).toThrow(/no agent matches/);
  });
});
