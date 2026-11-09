import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as daemon from "../src/daemon";
import * as tmux from "../src/tmux";
import * as codexHooks from "../src/codexHooks";
import * as claudeTrust from "../src/claudeTrust";
import { resumeCommand, reviveAgent } from "../src/commands/resume";
import { startApiServer, type ApiServerHandle } from "../src/server";
import { readAgent, writeAgent, type AgentState } from "../src/state";
import { queueDepth } from "../src/queue";

let home: string;
let previousHome: string | undefined;
let server: ApiServerHandle | undefined;
let spies: ReturnType<typeof spyOn>[];

beforeEach(() => {
  previousHome = process.env.AGENTMGR_HOME;
  home = mkdtempSync(join(tmpdir(), "am-concierge-resume-"));
  process.env.AGENTMGR_HOME = home;
  spies = [
    spyOn(tmux, "hasSession").mockReturnValue(false),
    spyOn(tmux, "newSession").mockImplementation(() => {}),
    spyOn(daemon, "ensureDaemon").mockResolvedValue(true),
    spyOn(codexHooks, "ensureCodexHooks").mockReturnValue({ changed: false, file: "fixture-hooks" }),
    spyOn(claudeTrust, "pretrustClaudeAgentDir").mockImplementation(() => {}),
    spyOn(console, "log").mockImplementation(() => {}),
  ];
});

afterEach(() => {
  server?.stop(); server = undefined;
  for (const spy of spies) spy.mockRestore();
  if (previousHome === undefined) delete process.env.AGENTMGR_HOME;
  else process.env.AGENTMGR_HOME = previousHome;
  rmSync(home, { recursive: true, force: true });
});

function seed(provider: AgentState["provider"], extra: Partial<AgentState> = {}) {
  const agent: AgentState = {
    name: "concierge", provider, status: "exited", dir: home,
    tmuxSession: "fixture-concierge", createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z", ...extra,
  };
  writeAgent(agent);
  return readAgent(agent.name)!;
}

async function apiResume(name = "concierge") {
  server = startApiServer({ port: 0, hostname: "127.0.0.1", token: "fixture-token" });
  return fetch(`${server.url}/api/agents/${name}/resume`, {
    method: "POST", headers: { Authorization: "Bearer fixture-token" },
  });
}

for (const route of ["cli", "api"] as const) describe(`${route} concierge exact revival`, () => {
  for (const provider of ["claude", "codex", "antigravity"] as const) {
    test.each([undefined, "", "   "])(`${provider} rejects missing or blank ID (%s) before side effects`, async sessionId => {
      const before = seed(provider, { sessionId });
      if (route === "cli") {
        await expect(resumeCommand("concierge", { message: "must not be queued" })).rejects.toThrow(/no captured session ID.*unrelated conversation/);
      } else {
        const response = await apiResume();
        expect(response.status).toBe(409);
        expect(((await response.json()) as { error: string }).error).toMatch(/no captured session ID.*unrelated conversation/);
      }
      expect(daemon.ensureDaemon).not.toHaveBeenCalled();
      expect(tmux.newSession).not.toHaveBeenCalled();
      expect(codexHooks.ensureCodexHooks).not.toHaveBeenCalled();
      expect(claudeTrust.pretrustClaudeAgentDir).not.toHaveBeenCalled();
      expect(readAgent("concierge")).toEqual(before);
      expect(queueDepth("concierge")).toBe(0);
    });
  }

  for (const provider of ["claude", "codex"] as const) {
    test.each(["sessionId", "claudeSessionId"])(`${provider} launches only captured %s`, async field => {
      seed(provider, { [field]: "exact-concierge-conversation" });
      if (route === "cli") await resumeCommand("concierge", {});
      else expect((await apiResume()).status).toBe(200);
      expect(tmux.newSession).toHaveBeenCalledTimes(1);
      const launch = (tmux.newSession as any).mock.calls[0][0];
      expect(launch.command).toContain("exact-concierge-conversation");
      expect(launch.command).not.toContain("--last");
      expect(launch.command).not.toContain("--continue");
      expect(readAgent("concierge")?.status).toBe("starting");
    });
  }
});

for (const provider of ["claude", "codex"] as const) {
  test(`${provider} live concierge remains a no-op without captured ID`, async () => {
    const agent = seed(provider);
    (tmux.hasSession as any).mockReturnValue(true);
    await reviveAgent(agent);
    expect(tmux.newSession).not.toHaveBeenCalled();
    expect(daemon.ensureDaemon).not.toHaveBeenCalled();
    expect(readAgent("concierge")).toEqual(agent);
  });

  test(`${provider} ordinary agent keeps legacy resume behavior`, async () => {
    const agent = seed(provider, { name: "ordinary-worker" });
    await reviveAgent(agent);
    expect(tmux.newSession).toHaveBeenCalledTimes(1);
    const launch = (tmux.newSession as any).mock.calls[0][0];
    expect(launch.command).toContain(provider === "codex" ? "--last" : "--continue");
  });
}
