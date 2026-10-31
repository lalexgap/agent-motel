import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { antigravityCommand, antigravityOptions, type AntigravityOptions } from "../src/antigravity";
import { restartAgent } from "../src/commands/restart";
import * as daemon from "../src/daemon";
import { buildLaunchCommand, buildResumeCommand, permissionArgs, type LaunchPlan } from "../src/providers";
import { writeAgent, type AgentState } from "../src/state";
import * as tmux from "../src/tmux";

let home: string;
let savedEnv: NodeJS.ProcessEnv;
let spies: ReturnType<typeof spyOn>[];
beforeEach(() => {
  savedEnv = { ...process.env };
  home = mkdtempSync(join(tmpdir(), "am-agy-permissions-"));
  mkdirSync(join(home, "bin"));
  const agy = join(home, "bin", "agy");
  writeFileSync(agy, "#!/bin/sh\nexit 127\n");
  chmodSync(agy, 0o700);
  Object.assign(process.env, {
    HOME: home, AGENTMGR_HOME: home, PATH: join(home, "bin"), AGENTMGR_SYSTEMD: "0",
  });
  spies = [];
});
afterEach(() => {
  for (const spy of spies) spy.mockRestore();
  process.env = savedEnv;
  rmSync(home, { recursive: true, force: true });
});

function configure(skipPermissions: boolean): void {
  writeFileSync(join(home, "config.json"), JSON.stringify({ skipPermissions, remoteControl: false }));
}
function options(plan: LaunchPlan): AntigravityOptions {
  expect(plan.command[0]).toBe(process.execPath);
  expect(plan.command[1]).toMatch(/\/antigravityRunner\.ts$/);
  return JSON.parse(plan.command[3]!);
}
function agent(provider: AgentState["provider"] = "antigravity"): AgentState {
  const runId = "a".repeat(32);
  return {
    name: "permissions", provider, status: "exited", dir: home,
    tmuxSession: "fixture-permissions", sessionId: "exact-conversation",
    createdAt: "fixture-incarnation", updatedAt: "fixture-incarnation",
    ...(provider === "antigravity" ? {
      model: "gemini-4-argon-high", effort: "high", reportTo: "lead",
      antigravityRunId: runId, antigravityCleanupRunId: runId,
    } : {}),
  };
}

describe("Antigravity permissions", () => {
  for (const skip of [false, true]) {
    test(`global ${skip} maps only to the documented permission flag`, () => {
      configure(skip);
      expect(permissionArgs("antigravity")).toEqual(skip ? ["--dangerously-skip-permissions"] : []);
    });

    for (const conversation of [{}, { resume: "adopted-conversation" }, { continue: true }]) {
      test(`launch ${JSON.stringify(conversation)} carries global ${skip}`, () => {
        configure(skip);
        const plan = buildLaunchCommand("antigravity", "permissions", { ...conversation, message: "task" });
        const opts = options(plan);
        expect(opts.skipPermissions).toBe(skip);
        expect(opts.message).toBe("task");
        if ("resume" in conversation) expect(opts.resume).toBe(conversation.resume);
        if ("continue" in conversation) expect(opts.continue).toBe(true);
        expect(plan.command).not.toContain("--dangerously-skip-permissions");
      });
    }

    test(`resume rereads global ${skip} and preserves exact conversation and selection`, () => {
      const saved = agent();
      configure(!skip);
      expect(options(buildResumeCommand("antigravity", saved, {})).skipPermissions).toBe(!skip);
      configure(skip);
      expect(options(buildResumeCommand("antigravity", saved, { message: "continue task" }))).toMatchObject({
        skipPermissions: skip, resume: "exact-conversation", model: "gemini-4-argon-high",
        effort: "high", reportTo: "lead", message: "continue task",
      });
      expect(saved).not.toHaveProperty("skipPermissions");
    });

    test(`restart plan carries global ${skip} without launching a provider`, async () => {
      configure(skip);
      writeAgent(agent());
      let command: string[] | undefined;
      spies.push(spyOn(daemon, "ensureDaemon").mockResolvedValue(true));
      spies.push(spyOn(tmux, "hasSession").mockReturnValue(false));
      spies.push(spyOn(tmux, "newSession").mockImplementation((launch) => { command = launch.command; }));
      await restartAgent("permissions", { message: "restart task" });
      expect(command).toBeDefined();
      const start = command!.indexOf(process.execPath);
      expect(start).toBeGreaterThanOrEqual(0);
      expect(options({ command: command!.slice(start) })).toMatchObject({
        skipPermissions: skip, resume: "exact-conversation", message: "restart task",
      });
    });

    for (const provider of ["claude", "codex"] as const) {
      test(`${provider} launch/resume flags remain unchanged with global ${skip}`, () => {
        configure(skip);
        const flag = provider === "codex" ? "--dangerously-bypass-approvals-and-sandbox" : "--dangerously-skip-permissions";
        expect(permissionArgs(provider)).toEqual(skip ? [flag] : []);
        for (const plan of [
          buildLaunchCommand(provider, "permissions", { remote: false }),
          buildResumeCommand(provider, agent(provider), { remote: false }),
        ]) {
          expect(plan.command.includes(flag)).toBe(skip);
          expect(plan.command).not.toContain(provider === "codex" ? "--dangerously-skip-permissions" : "--dangerously-bypass-approvals-and-sandbox");
        }
        if (provider === "codex") {
          expect(buildResumeCommand(provider, agent(provider), { codexDaemon: true }).command).not.toContain(flag);
          expect(buildLaunchCommand(provider, "permissions", { resume: "exact-conversation", codexDaemonDir: home }).command).not.toContain(flag);
        }
      });
    }
  }

  test("omitted direct runner options default to false even when global bypass is enabled", () => {
    configure(true);
    expect(antigravityOptions({}).skipPermissions).toBe(false);
    expect(options(antigravityCommand("permissions", {})).skipPermissions).toBe(false);
  });

  for (const skip of [false, true]) {
    test(`direct options retain explicit ${skip} independently of global config`, () => {
      configure(!skip);
      expect(antigravityOptions({ skipPermissions: skip }).skipPermissions).toBe(skip);
      expect(options(antigravityCommand("permissions", { skipPermissions: skip })).skipPermissions).toBe(skip);
    });
  }

  for (const invalid of [null, "true", "false", "", 0, 1, [], {}, new Boolean(true)]) {
    test(`rejects non-boolean skipPermissions ${JSON.stringify(invalid)}`, () => {
      const opts = { skipPermissions: invalid } as unknown as AntigravityOptions;
      expect(() => antigravityOptions(opts)).toThrow(/skipPermissions/);
      expect(() => antigravityCommand("permissions", opts)).toThrow(/skipPermissions/);
    });
  }
});
