import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { auditLogFile } from "../src/audit";
import { newCommand } from "../src/commands/new";
import { restartAgent } from "../src/commands/restart";
import { stopAgent } from "../src/commands/rm";
import {
  continueMessage,
  modelSwitchOverdue,
  performModelSwitch,
  requestModelSwitch,
  triggerModelSwitch,
} from "../src/commands/switchModel";
import { startDaemonServer, type DaemonHandle } from "../src/daemon";
import { deliverNext } from "../src/deliver";
import { queueAppend, queueList } from "../src/queue";
import { readAgent, writeAgent, type AgentState, type PendingModelSwitch } from "../src/state";

const CLI = join(import.meta.dir, "../src/index.ts");
let home: string;
let oldPath: string | undefined;
let oldCodexHome: string | undefined;
let daemon: DaemonHandle;
let spawnSpy: ReturnType<typeof spyOn>;

const codexCatalog = JSON.stringify({
  models: [
    { slug: "gpt-6-luna", supported_reasoning_levels: [{ effort: "low" }, { effort: "medium" }] },
    { slug: "gpt-6.1-sol", supported_reasoning_levels: [{ effort: "low" }, { effort: "high" }] },
  ],
});

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "am-switch-"));
  oldPath = process.env.PATH;
  oldCodexHome = process.env.CODEX_HOME;
  process.env.AGENTMGR_HOME = home;
  process.env.CODEX_HOME = join(home, "codex-home");
  process.env.PATH = `${home}:${oldPath}`;
  writeFileSync(join(home, "config.json"), JSON.stringify({ notifyCommand: `touch "$AGENTMGR_HOME/notified"`, idleNotifyMinSeconds: 0 }));
  writeFileSync(join(home, "tmux"), `#!/bin/sh
case "$1" in
  has-session) test ! -f "$AGENTMGR_HOME/dead" ;;
  respawn-pane|new-session)
    printf '%s\\n' "$@" > "$AGENTMGR_HOME/launch"
    test ! -f "$AGENTMGR_HOME/fail"
    ;;
  *) exit 0 ;;
esac
`);
  writeFileSync(join(home, "claude"), "#!/bin/sh\nexit 0\n");
  writeFileSync(join(home, "codex"), `#!/bin/sh\nif [ "$1" = debug ]; then printf '%s' '${codexCatalog}'; fi\nexit 0\n`);
  for (const bin of ["tmux", "claude", "codex"]) chmodSync(join(home, bin), 0o755);
  const spawn = Bun.spawnSync;
  spawnSpy = spyOn(Bun, "spawnSync").mockImplementation((cmd: any, opts?: any) => spawn(cmd, { ...opts, env: { ...process.env, ...opts?.env } }));
  daemon = startDaemonServer();
  const now = new Date().toISOString();
  writeAgent({ name: "api", provider: "codex", model: "gpt-6-luna", dir: home, tmuxSession: "agentmgr-api", sessionId: "conversation-123", status: "working", turns: 1, reportTo: "lead", createdAt: now, updatedAt: now });
});

afterEach(() => {
  daemon.stop();
  spawnSpy.mockRestore();
  process.env.PATH = oldPath;
  delete process.env.AGENTMGR_HOME;
  if (oldCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = oldCodexHome;
  rmSync(home, { recursive: true, force: true });
});

function update(fields: Partial<AgentState>): void {
  writeAgent({ ...readAgent("api")!, ...fields });
}

function audit(): Record<string, string>[] {
  if (!existsSync(auditLogFile())) return [];
  return readFileSync(auditLogFile(), "utf8").trim().split("\n").map((line) => JSON.parse(line));
}

async function hook(event: string, payload: Record<string, unknown> = {}): Promise<string> {
  // Async: the daemon the hook talks to runs in this process.
  const { AGENTMGR_PEER_INBOX: _ambient, ...env } = process.env;
  const child = Bun.spawn([process.execPath, CLI, "hook", event], {
    env: { ...env, AGENTMGR_AGENT: "api" },
    stdin: new Blob([JSON.stringify(payload)]),
    stdout: "pipe",
    stderr: "pipe",
  });
  const out = await new Response(child.stdout).text();
  expect(await child.exited).toBe(0);
  return out.trim();
}

async function until(check: () => boolean, ms = 8000): Promise<void> {
  for (const deadline = Date.now() + ms; !check() && Date.now() < deadline; ) await Bun.sleep(50);
}

describe("am switch-model request", () => {
  const request = (fields: { model?: string; effort?: string; reason?: string } = {}) =>
    requestModelSwitch("api", { model: "gpt-6.1-sol", reason: "needs deeper reasoning", ...fields });

  test("records a pending switch for the calling agent", () => {
    const { agent, pending } = request({ effort: "high" });
    expect(agent.name).toBe("api");
    expect(pending).toMatchObject({ model: "gpt-6.1-sol", effort: "high", reason: "needs deeper reasoning" });
    expect(readAgent("api")!.pendingModelSwitch).toEqual(pending);
    expect(readAgent("api")!.model).toBe("gpt-6-luna");
  });

  test("resolves the caller through a rename alias", () => {
    update({ aliases: ["old-api"] });
    expect(requestModelSwitch("old-api", { model: "gpt-6.1-sol", reason: "x" }).agent.name).toBe("api");
  });

  test("refuses outside a managed agent, pointing operators at am restart", () => {
    expect(() => requestModelSwitch(undefined, { model: "gpt-6.1-sol", reason: "x" })).toThrow(/am restart <name> --model/);
    expect(() => requestModelSwitch("nobody", { model: "gpt-6.1-sol", reason: "x" })).toThrow(/not a managed agent/);
  });

  test("requires a reason", () => {
    expect(() => request({ reason: undefined })).toThrow(/--reason/);
    expect(() => request({ reason: "  " })).toThrow(/--reason/);
  });

  test("refuses when disabled", () => {
    writeFileSync(join(home, "config.json"), JSON.stringify({ selfModelSwitchMaxTurns: 0 }));
    expect(() => request()).toThrow(/disabled/);
  });

  test("refuses an unknown context age and a conversation past the turn limit", () => {
    update({ turns: undefined });
    expect(() => request()).toThrow(/context age is unknown/);
    update({ turns: 3 });
    expect(() => request()).toThrow(/first 2 turns \(this is turn 3\)/);
    update({ turns: 2 });
    expect(request().pending.model).toBe("gpt-6.1-sol");
  });

  test("allows one self-switch, and one pending request, per agent", () => {
    request();
    expect(() => request()).toThrow(/already pending/);
    update({ pendingModelSwitch: undefined, selfModelSwitches: 1 });
    expect(() => request()).toThrow(/one self-switch per agent/);
  });

  test("rejects a no-op and anything the provider catalog rejects", () => {
    expect(() => request({ model: "gpt-6-luna" })).toThrow(/already running on gpt-6-luna/);
    expect(() => request({ model: "gpt-nope" })).toThrow(/unknown codex model "gpt-nope"/);
    // luna keeps its effort; sol has no medium.
    update({ effort: "medium" });
    expect(() => request()).toThrow(/unknown codex effort "medium" for gpt-6.1-sol/);
    expect(readAgent("api")!.pendingModelSwitch).toBeUndefined();
  });

  test("refuses antigravity agents", () => {
    update({ provider: "antigravity" });
    expect(() => request()).toThrow(/supports claude and codex/);
  });

  test("the CLI runs it for AGENTMGR_AGENT and prints the end-of-turn instruction", async () => {
    const run = (args: string[], agent?: string) => {
      const { AGENTMGR_AGENT: _a, CODEX_THREAD_ID: _t, ...env } = process.env;
      return Bun.spawn([process.execPath, CLI, "switch-model", ...args], { env: { ...env, ...(agent ? { AGENTMGR_AGENT: agent } : {}) }, stdout: "pipe", stderr: "pipe" });
    };
    const outside = run(["gpt-6.1-sol", "--reason", "x"]);
    expect(await outside.exited).toBe(1);
    expect(await new Response(outside.stderr).text()).toContain("am restart <name> --model");
    const inside = run(["gpt-6.1-sol", "--effort", "high", "--reason", "harder than it looked", "--json"], "api");
    expect(await inside.exited).toBe(0);
    expect(JSON.parse(await new Response(inside.stdout).text())).toMatchObject({ agent: "api", model: "gpt-6.1-sol", effort: "high", reason: "harder than it looked", when: "end-of-turn" });
    expect(readAgent("api")!.pendingModelSwitch?.reason).toBe("harder than it looked");
  }, 30_000);
});

describe("turn counting", () => {
  test("am new starts a fresh conversation at 0; adopted ones stay unknown", async () => {
    writeFileSync(join(home, "dead"), "");
    await newCommand({ name: "fresh", dir: home, provider: "claude", remote: false, inPlace: true, jump: false, quiet: true, noPlan: true });
    await newCommand({ name: "adopted", dir: home, provider: "claude", resume: "abc", remote: false, inPlace: true, jump: false, quiet: true, noPlan: true });
    await newCommand({ name: "continued", dir: home, provider: "claude", continue: true, remote: false, inPlace: true, jump: false, quiet: true, noPlan: true });
    await newCommand({ name: "handed", dir: home, provider: "claude", message: "read this", inheritsContext: true, remote: false, inPlace: true, jump: false, quiet: true, noPlan: true });
    expect(readAgent("fresh")!.turns).toBe(0);
    expect(readAgent("adopted")!.turns).toBeUndefined();
    expect(readAgent("continued")!.turns).toBeUndefined();
    expect(readAgent("handed")!.turns).toBeUndefined();
  });

  test("each main prompt counts only when the count is known", async () => {
    update({ provider: "claude", status: "idle", turns: 0 });
    await hook("user-prompt-submit", { prompt: "go" });
    expect(readAgent("api")!.turns).toBe(1);
    await hook("user-prompt-submit", { prompt: "inside a subagent", agent_id: "sub-1" });
    expect(readAgent("api")!.turns).toBe(1);
    update({ turns: undefined });
    await hook("user-prompt-submit", { prompt: "again" });
    expect(readAgent("api")!.turns).toBeUndefined();
  }, 30_000);
});

describe("carrying out the switch", () => {
  const pending = (fields: Partial<PendingModelSwitch> = {}): PendingModelSwitch => ({
    model: "gpt-6.1-sol", effort: "high", reason: "needs deeper reasoning", requestedAt: "2026-11-10T00:00:00.000Z", triggeredAt: new Date().toISOString(), ...fields,
  });
  const launch = () => readFileSync(join(home, "launch"), "utf8");

  test("restarts on the new model with the continue prompt, spends the switch and audits the reason", async () => {
    update({ status: "idle", pendingModelSwitch: pending() });
    expect(await performModelSwitch("api")).toBe("switched");
    expect(launch()).toContain("'--model' 'gpt-6.1-sol' '-c' 'model_reasoning_effort=high' 'resume' 'conversation-123'");
    expect(launch()).toContain("[am] You are now running on gpt-6.1-sol at high effort — the switch you requested (needs deeper reasoning). Continue the task from where you left off.");
    const agent = readAgent("api")!;
    expect(agent).toMatchObject({ model: "gpt-6.1-sol", effort: "high", selfModelSwitches: 1, status: "starting" });
    expect(agent.pendingModelSwitch).toBeUndefined();
    const entries = audit();
    expect(entries.filter((e) => e.action === "switch-model").map((e) => [e.phase, e.reason, e.source, e.route])).toEqual([
      ["requested", "needs deeper reasoning", "self-model-switch", "switch-model"],
      ["completed", "needs deeper reasoning", "self-model-switch", "switch-model"],
    ]);
    expect(entries.find((e) => e.action === "restart")).toMatchObject({ source: "self-model-switch", actor: "api" });
  });

  test("a failed launch keeps the old model, clears the request and tells the agent through its queue", async () => {
    writeFileSync(join(home, "fail"), "");
    update({ status: "idle", pendingModelSwitch: pending() });
    expect(await performModelSwitch("api")).toBe("failed");
    const agent = readAgent("api")!;
    expect(agent).toMatchObject({ model: "gpt-6-luna", status: "idle", selfModelSwitches: 1 });
    expect(agent.effort).toBeUndefined();
    expect(agent.pendingModelSwitch).toBeUndefined();
    const [message] = queueList("api").map((e) => e.message);
    expect(message).toStartWith("[am] Your requested switch to gpt-6.1-sol at high effort did not happen:");
    expect(message).toContain("You are still on gpt-6-luna. Continue the task on it.");
    expect(audit().filter((e) => e.action === "switch-model").map((e) => e.phase)).toEqual(["requested", "failed"]);
  });

  test("a catalog rejection at switch time is a failure too, counted once", async () => {
    update({ status: "idle", effort: "medium", pendingModelSwitch: pending({ effort: undefined }) });
    expect(await performModelSwitch("api")).toBe("failed");
    expect(readAgent("api")).toMatchObject({ model: "gpt-6-luna", effort: "medium", selfModelSwitches: 1 });
    expect(readAgent("api")!.pendingModelSwitch).toBeUndefined();
    expect(queueList("api")[0]!.message).toContain('unknown codex effort "medium" for gpt-6.1-sol');
    expect(existsSync(join(home, "launch"))).toBe(false);
  });

  test("a busy lifecycle is retried, then reported", async () => {
    update({ status: "idle", pendingModelSwitch: pending() });
    let calls = 0;
    const busy = async () => {
      calls++;
      throw new Error('agent "api" is being stopped, removed, renamed, or restarted — retry restart');
    };
    expect(await performModelSwitch("api", { restart: busy, retryDelayMs: 1 })).toBe("failed");
    expect(calls).toBe(5);
    expect(queueList("api")[0]!.message).toContain("retry restart");
  });

  test("a turn that started first defers the switch to that turn's end", async () => {
    update({ status: "working", pendingModelSwitch: pending() });
    expect(await performModelSwitch("api")).toBe("deferred");
    expect(readAgent("api")!.pendingModelSwitch).toMatchObject({ model: "gpt-6.1-sol" });
    expect(readAgent("api")!.pendingModelSwitch!.triggeredAt).toBeUndefined();
    expect(existsSync(join(home, "launch"))).toBe(false);
    // Not yet due: nothing happens.
    expect(await performModelSwitch("api")).toBe("none");
  });

  test("a due switch holds deliveries until the restart and is overdue for the sweep after 30s", async () => {
    queueAppend("api", "peer note");
    update({ status: "idle", pendingModelSwitch: pending() });
    expect(await deliverNext("api")).toEqual({ status: "queued", reason: "locked" });
    const agent = readAgent("api")!;
    expect(modelSwitchOverdue(agent)).toBe(false);
    expect(modelSwitchOverdue(agent, Date.now() + 31_000)).toBe(true);
    expect(modelSwitchOverdue({ ...agent, status: "working" }, Date.now() + 31_000)).toBe(false);
  });

  test("the trigger hands it to the daemon, or abandons it with the agent told", async () => {
    update({ status: "idle", pendingModelSwitch: pending({ triggeredAt: undefined }) });
    const requested: string[] = [];
    expect(await triggerModelSwitch("api", pending(), { request: async (name) => (requested.push(name), true) })).toBe(true);
    expect(requested).toEqual(["api"]);
    expect(readAgent("api")!.pendingModelSwitch!.triggeredAt).toBeString();

    update({ pendingModelSwitch: pending({ triggeredAt: undefined }) });
    let ensured = 0;
    expect(await triggerModelSwitch("api", pending(), { request: async () => false, ensure: async () => (ensured++, true) })).toBe(false);
    expect(ensured).toBe(1);
    expect(readAgent("api")!.pendingModelSwitch).toBeUndefined();
    expect(readAgent("api")!.selfModelSwitches).toBeUndefined();
    expect(queueList("api")[0]!.message).toContain("daemon");
  });

  test("an operator restart, stop or session end clears a pending switch", async () => {
    update({ status: "working", pendingModelSwitch: pending({ triggeredAt: undefined }) });
    await restartAgent("api");
    expect(readAgent("api")!.pendingModelSwitch).toBeUndefined();

    update({ status: "working", pendingModelSwitch: pending({ triggeredAt: undefined }) });
    stopAgent(readAgent("api")!);
    expect(readAgent("api")!.pendingModelSwitch).toBeUndefined();

    update({ provider: "claude", status: "idle", pendingModelSwitch: pending({ triggeredAt: undefined }) });
    await hook("session-end");
    expect(readAgent("api")).toMatchObject({ status: "exited" });
    expect(readAgent("api")!.pendingModelSwitch).toBeUndefined();
  }, 30_000);

  test("continueMessage names a default model and omits an unset effort", () => {
    expect(continueMessage({ reason: "r", requestedAt: "t" })).toContain("You are now running on the provider's default model — the switch");
  });
});

describe("the Stop hook trigger", () => {
  const requestedAt = "2026-11-10T00:00:00.000Z";
  const launched = () => existsSync(join(home, "launch"));

  test("a real stop has the daemon carry out the switch and skips the report, idle notice and drain", async () => {
    update({ status: "working", workingSince: new Date(Date.now() - 120_000).toISOString(), pendingModelSwitch: { model: "gpt-6.1-sol", reason: "deeper", requestedAt } });
    writeAgent({ name: "lead", provider: "claude", dir: home, tmuxSession: "agentmgr-lead", status: "working", createdAt: requestedAt, updatedAt: requestedAt });
    expect(await hook("stop")).toBe("");
    await until(launched);
    expect(readFileSync(join(home, "launch"), "utf8")).toContain("'--model' 'gpt-6.1-sol'");
    expect(readAgent("api")).toMatchObject({ model: "gpt-6.1-sol", selfModelSwitches: 1, status: "starting" });
    expect(existsSync(join(home, "notified"))).toBe(false);
    expect(queueList("lead")).toEqual([]);
  }, 30_000);

  test("a stop the inbox gate blocks is no turn end", async () => {
    update({ status: "working", pendingModelSwitch: { model: "gpt-6.1-sol", reason: "deeper", requestedAt } });
    queueAppend("api", "read this first");
    expect(JSON.parse(await hook("stop")).decision).toBe("block");
    expect(readAgent("api")!.pendingModelSwitch).toEqual({ model: "gpt-6.1-sol", reason: "deeper", requestedAt });
    await Bun.sleep(800);
    expect(launched()).toBe(false);
  }, 30_000);

  test("a subagent's stop does not trigger it", async () => {
    update({ status: "working", pendingModelSwitch: { model: "gpt-6.1-sol", reason: "deeper", requestedAt } });
    await hook("subagent-stop", { agent_id: "sub-1" });
    await hook("stop", { agent_id: "sub-1" });
    expect(readAgent("api")!.pendingModelSwitch!.triggeredAt).toBeUndefined();
    await Bun.sleep(800);
    expect(launched()).toBe(false);
  }, 30_000);
});
