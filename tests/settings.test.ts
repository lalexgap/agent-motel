import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildHookSettings, HOOK_EVENTS, writeHookSettings } from "../src/settings";
import { shQuote } from "../src/tmux";

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "am-test-"));
  process.env.AGENTMGR_HOME = home;
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  delete process.env.AGENTMGR_HOME;
});

describe("hook settings", () => {
  test("covers every tracked Claude Code event", () => {
    const settings = buildHookSettings() as { hooks: Record<string, unknown> };
    expect(Object.keys(settings.hooks).sort()).toEqual(Object.keys(HOOK_EVENTS).sort());
  });

  test("hook commands use absolute bun and entrypoint paths", () => {
    const settings = buildHookSettings() as {
      hooks: Record<string, [{ hooks: [{ type: string; command: string }] }]>;
    };
    const stop = settings.hooks.Stop![0].hooks[0];
    expect(stop.type).toBe("command");
    expect(stop.command).toContain(process.execPath);
    expect(stop.command).toContain("src/index.ts");
    expect(stop.command).toEndWith("hook stop");
  });

  test("PermissionRequest relays to am, with a timeout past the configured wait", () => {
    type Hook = { command: string; timeout?: number };
    const hooks = () => (buildHookSettings() as { hooks: Record<string, [{ hooks: [Hook] }]> }).hooks;
    const permission = hooks().PermissionRequest![0].hooks[0];
    expect(permission.command).toEndWith("hook permission-request");
    expect(permission.timeout).toBe(150);
    expect(hooks().Stop![0].hooks[0].timeout).toBeUndefined();
    writeFileSync(join(home, "config.json"), JSON.stringify({ permissionWaitSeconds: 10 }));
    expect(hooks().PermissionRequest![0].hooks[0].timeout).toBe(40);
  });

  test("writeHookSettings writes valid JSON into AGENTMGR_HOME", () => {
    const file = writeHookSettings();
    expect(file.startsWith(home)).toBe(true);
    expect(existsSync(file)).toBe(true);
    expect(() => JSON.parse(readFileSync(file, "utf8"))).not.toThrow();
  });
});

describe("shQuote", () => {
  test("wraps and escapes for sh", () => {
    expect(shQuote("plain")).toBe("'plain'");
    expect(shQuote("two words")).toBe("'two words'");
    expect(shQuote("it's")).toBe("'it'\\''s'");
  });
});
