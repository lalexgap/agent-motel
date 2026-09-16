import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { CONCIERGE_NAME } from "../src/providers";
import { conciergeRow } from "../src/fleet";
import { conciergeNewOptions, resolveConciergeHost } from "../src/commands/concierge";
import { newCommand } from "../src/commands/new";
import { renameAgent } from "../src/commands/rename";
import { writeAgent, type AgentState } from "../src/state";
import { configFile } from "../src/paths";
import type { Config } from "../src/config";

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "am-test-"));
  process.env.AGENTMGR_HOME = home;
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  delete process.env.AGENTMGR_HOME;
});

function writeConfig(config: Partial<Config>): void {
  writeFileSync(configFile(), JSON.stringify(config));
}

function seedAgent(name: string, overrides: Partial<AgentState> = {}): void {
  writeAgent({
    name,
    status: "exited",
    dir: "/tmp",
    tmuxSession: `agentmgr-${name}`,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    ...overrides,
  });
}

describe("conciergeNewOptions", () => {
  test("runs in-place in the home dir on the default provider and passes the reserved gate", () => {
    const opts = conciergeNewOptions();
    expect(opts.name).toBe(CONCIERGE_NAME);
    expect(opts.provider).toBe("codex");
    expect(opts.dir).toBe(homedir());
    expect(opts.inPlace).toBe(true);
    expect(opts.concierge).toBe(true);
    expect(opts.role).toBe("concierge");
    expect(opts.jump).toBe(false);
    // With no question, the first turn is a fleet status report.
    expect(opts.message).toContain("fleet status");
  });

  test("an operator question becomes the initial message", () => {
    expect(conciergeNewOptions("who touched the auth flow?").message).toBe("who touched the auth flow?");
  });

  test("config.conciergeProvider picks the provider", () => {
    writeConfig({ conciergeProvider: "claude" });
    expect(conciergeNewOptions().provider).toBe("claude");
  });
});

describe("conciergeRow", () => {
  test("marks only the concierge, with a ✦ and a role line", () => {
    expect(conciergeRow({ name: "worker", status: "idle" })).toBeNull();
    const row = conciergeRow({ name: CONCIERGE_NAME, status: "idle" })!;
    expect(row.label).toBe(`✦ ${CONCIERGE_NAME}`);
    expect(row.role).toBe("fleet concierge");
    // Idle is the concierge's usual state — the identity cyan keeps it findable.
    expect(row.labelStyle).toContain("125;207;255");
  });

  test("the built-in role drives the treatment for role-aware state", () => {
    expect(conciergeRow({ name: "legacy-name", role: "concierge", status: "idle" })?.label).toBe("✦ concierge");
  });

  test("status colors still win where they carry signal", () => {
    expect(conciergeRow({ name: CONCIERGE_NAME, status: "needs-attention" })!.labelStyle).toContain("224;175;104");
    expect(conciergeRow({ name: CONCIERGE_NAME, status: "exited" })!.labelStyle).toContain("86;95;137");
    expect(conciergeRow({ name: CONCIERGE_NAME, status: "dead" })!.labelStyle).toContain("86;95;137");
    expect(conciergeRow({ name: CONCIERGE_NAME, status: "working" })!.labelStyle).toContain("125;207;255");
  });
});

describe("resolveConciergeHost", () => {
  test("an explicit conciergeHost wins, with 'local' meaning this machine", () => {
    writeConfig({ conciergeHost: "server" });
    expect(resolveConciergeHost()).toBe("server");
    writeConfig({ conciergeHost: "local" });
    expect(resolveConciergeHost()).toBeUndefined();
  });

  test("without config, an existing local concierge is adopted", () => {
    seedAgent(CONCIERGE_NAME);
    expect(resolveConciergeHost()).toBeUndefined();
  });

  test("without config and no concierge anywhere, it is created locally", () => {
    expect(resolveConciergeHost()).toBeUndefined();
  });
});

describe("concierge name reservation", () => {
  test("am new rejects the reserved name and points at am concierge", async () => {
    await expect(newCommand({ name: CONCIERGE_NAME })).rejects.toThrow(/reserved.*am concierge/);
  });

  test("am new rejects direct use of the built-in concierge role", async () => {
    await expect(newCommand({ name: "helper", role: "concierge" })).rejects.toThrow(/reserved.*am concierge/);
  });

  test("renaming another agent onto the reserved name is rejected", async () => {
    seedAgent("worker");
    await expect(renameAgent("worker", CONCIERGE_NAME)).rejects.toThrow(/reserved/);
  });

  test("renaming the concierge away is rejected", async () => {
    seedAgent(CONCIERGE_NAME);
    await expect(renameAgent(CONCIERGE_NAME, "helper")).rejects.toThrow(/cannot be renamed/);
  });
});
