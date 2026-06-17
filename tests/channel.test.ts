import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { channelActive, channelMarkerFile, clearChannelActive, markChannelActive } from "../src/channel";
import { ensureDirs } from "../src/paths";
import { buildMcpConfig } from "../src/settings";

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "am-test-"));
  process.env.AGENTMGR_HOME = home;
  ensureDirs();
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  delete process.env.AGENTMGR_HOME;
});

describe("channel marker (delivery hand-off)", () => {
  test("mark → active; clear → inactive; stale → inactive", () => {
    expect(channelActive("web")).toBe(false);
    markChannelActive("web");
    expect(channelActive("web")).toBe(true);
    // backdate the marker past the staleness window (a crashed channel)
    const old = (Date.now() - 60_000) / 1000;
    utimesSync(channelMarkerFile("web"), old, old);
    expect(channelActive("web")).toBe(false); // delivery resumes
    markChannelActive("web"); // heartbeat refreshes it
    expect(channelActive("web")).toBe(true);
    clearChannelActive("web");
    expect(channelActive("web")).toBe(false);
  });
});

describe("buildMcpConfig", () => {
  test("declares a stdio `am` server running `am mcp`", () => {
    const cfg = buildMcpConfig() as { mcpServers: { am: { type: string; args: string[] } } };
    expect(cfg.mcpServers.am.type).toBe("stdio");
    expect(cfg.mcpServers.am.args.at(-1)).toBe("mcp");
  });
});
