import { afterEach, beforeEach, describe, expect, test, spyOn } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { restartAgent, restartIfIdle } from "../src/commands/restart";
import { startDaemonServer, type DaemonHandle } from "../src/daemon";
import { acquireDeliverLock, beginDeliveryHandoff, endDeliveryHandoff, releaseDeliverLock } from "../src/deliver";
import { queueAppend, queueAppendForAgent, queueClear, queueList, queuePopId } from "../src/queue";
import { readAgent, updateAgentStatus, writeAgent, type AgentState } from "../src/state";
import { markDelivered, queueTrackedMessage, readMessage } from "../src/messages";
import { SelectionError } from "../src/catalog";
import { startApiServer, type ApiServerHandle } from "../src/server";
import { acquireLifecycleLock, releaseLifecycleLock } from "../src/lifecycle";
import { destroyAgent, stopAgent } from "../src/commands/rm";

let home: string;
let oldPath: string | undefined;
let daemon: DaemonHandle;
let spawnSpy: ReturnType<typeof spyOn>;
let oldCodexHome: string | undefined;
const actualTmux = Bun.which("tmux");

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "am-restart-"));
  oldPath = process.env.PATH;
  process.env.AGENTMGR_HOME = home;
  oldCodexHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = join(home, "codex-home");
  process.env.PATH = `${home}:${oldPath}`;
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
  chmodSync(join(home, "tmux"), 0o755);
  for (const provider of ["claude", "codex"]) {
    writeFileSync(join(home, provider), "#!/bin/sh\nexit 0\n");
    chmodSync(join(home, provider), 0o755);
  }
  const spawn = Bun.spawnSync;
  spawnSpy = spyOn(Bun, "spawnSync").mockImplementation((cmd: any, opts?: any) => {
    return spawn(cmd, { ...opts, env: { ...process.env, ...opts?.env } });
  });
  daemon = startDaemonServer();
  const now = new Date().toISOString();
  writeAgent({ name: "api", provider: "claude", dir: home, tmuxSession: "agentmgr-api", sessionId: "conversation-123", status: "working", task: "keep this task", reportTo: "lead", createdAt: now, updatedAt: now });
});

afterEach(() => {
  daemon.stop();
  spawnSpy.mockRestore();
  releaseDeliverLock("api");
  process.env.PATH = oldPath;
  delete process.env.AGENTMGR_HOME;
  if (oldCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = oldCodexHome;
  rmSync(home, { recursive: true, force: true });
});

describe("restartAgent", () => {
  test.skipIf(!actualTmux)("a real tmux restart preserves the pane and launches the installed provider with the saved conversation", async () => {
    spawnSpy.mockRestore();
    const spawn = Bun.spawnSync.bind(Bun);
    const socket = `am-restart-test-${process.pid}-${Date.now()}`;
    spawnSpy = spyOn(Bun, "spawnSync").mockImplementation((cmd: any, opts?: any) => {
      if (Array.isArray(cmd) && cmd[0] === "tmux") {
        return spawn([actualTmux!, "-L", socket, ...cmd.slice(1)], { ...opts, env: { ...process.env, ...opts?.env } });
      }
      return spawn(cmd, opts);
    });
    writeFileSync(join(home, "claude"), '#!/bin/sh\nprintf "%s\\n" "$@" > "$AGENTMGR_HOME/provider-args"\nexec sleep 30\n');
    try {
      expect(Bun.spawnSync(["tmux", "new-session", "-d", "-s", "agentmgr-api", "sleep 30"]).exitCode).toBe(0);
      const identity = () => Bun.spawnSync(["tmux", "display-message", "-p", "-t", "=agentmgr-api:", "#{pane_id} #{pane_pid}"]).stdout.toString().trim().split(" ");
      const before = identity();
      await restartAgent("api", { remote: false });
      for (let i = 0; i < 50 && !existsSync(join(home, "provider-args")); i++) await Bun.sleep(20);
      const after = identity();
      expect(after[0]).toBe(before[0]);
      expect(after[1]).not.toBe(before[1]);
      expect(readFileSync(join(home, "provider-args"), "utf8")).toContain("--resume\nconversation-123\n");
    } finally {
      Bun.spawnSync(["tmux", "kill-server"]);
    }
  });
  test("resumes a Codex conversation using the legacy saved ID", async () => {
    const agent = readAgent("api")!;
    agent.provider = "codex";
    agent.claudeSessionId = agent.sessionId;
    delete agent.sessionId;
    writeAgent(agent);
    await restartAgent("api");
    expect(readFileSync(join(home, "launch"), "utf8")).toContain("'resume' 'conversation-123'");
  });
  test("respawns a live Claude pane with its exact conversation and preserves queued mail and metadata", async () => {
    queueAppend("api", "pending message");
    await restartAgent("ap", { remote: false });
    const launch = readFileSync(join(home, "launch"), "utf8");
    expect(launch).toContain("respawn-pane\n-k\n-t\n=agentmgr-api:\n");
    expect(launch).toContain("PATH=");
    expect(launch).toContain(`'${join(home, "claude")}'`);
    expect(launch).toContain("'--resume' 'conversation-123'");
    expect(launch).toContain('You are reporting to "lead"');
    expect(readAgent("api")).toMatchObject({ status: "starting", statusReason: "restarting", sessionId: "conversation-123", task: "keep this task", reportTo: "lead" });
    expect(queueList("api").map(e => e.message)).toEqual(["pending message"]);
  });

  test("starts a stopped agent and accepts a deferred follow-up message", async () => {
    writeFileSync(join(home, "dead"), "");
    await restartAgent("api", { message: "continue", remote: true });
    expect(readFileSync(join(home, "launch"), "utf8")).toStartWith("new-session\n");
    expect(queueList("api").map(e => e.message)).toEqual(["continue"]);
  });

  test("rejects a restart during delivery or handoff without replacing the pane", async () => {
    expect(acquireDeliverLock("api")).toBe(true);
    await expect(restartAgent("api")).rejects.toThrow(/busy or being moved/);
    beginDeliveryHandoff("api", "moving");
    releaseDeliverLock("api");
    await expect(restartAgent("api")).rejects.toThrow(/busy or being moved/);
    expect(existsSync(join(home, "launch"))).toBe(false);
    endDeliveryHandoff("api", "moving");
  });

  test("refuses to terminate a live agent without an exact saved conversation", async () => {
    const agent = readAgent("api")!;
    delete agent.sessionId;
    writeAgent(agent);
    await expect(restartAgent("api")).rejects.toThrow(/no saved conversation ID/);
    expect(existsSync(join(home, "launch"))).toBe(false);
    expect(readAgent("api")!.status).toBe("working");
  });

  test("validates the working directory before replacing the pane", async () => {
    const agent = readAgent("api")!;
    agent.dir = join(home, "missing");
    writeAgent(agent);
    await expect(restartAgent("api")).rejects.toThrow(/directory no longer exists/);
    expect(existsSync(join(home, "launch"))).toBe(false);
  });

  test("restores the previous status if tmux rejects the restart and releases its lock", async () => {
    writeFileSync(join(home, "fail"), "");
    await expect(restartAgent("api", { remote: false })).rejects.toThrow(/tmux restart failed/);
    expect(readAgent("api")!.status).toBe("working");
    expect(acquireDeliverLock("api")).toBe(true);
  });

  test("separate stop and remove operations cannot race a restart", async () => {
    writeFileSync(join(home, "tmux"), `#!/bin/sh
case "$1" in
  has-session) exit 0 ;;
  respawn-pane)
    touch "$AGENTMGR_HOME/restarting"
    while test ! -f "$AGENTMGR_HOME/continue"; do sleep 0.01; done
    ;;
  *) exit 0 ;;
esac
`);
    const child = Bun.spawn([
      process.execPath,
      "-e",
      `import { restartAgent } from ${JSON.stringify(new URL("../src/commands/restart.ts", import.meta.url).href)}; await restartAgent("api");`,
    ], { env: { ...process.env }, stdout: "pipe", stderr: "pipe" });

    for (let i = 0; i < 200 && !existsSync(join(home, "restarting")); i++) await Bun.sleep(10);
    expect(existsSync(join(home, "restarting"))).toBe(true);
    expect(() => stopAgent(readAgent("api")!)).toThrow(/being stopped, removed, renamed, or restarted/);
    expect(() => destroyAgent(readAgent("api")!, { clean: false })).toThrow(/being stopped, removed, renamed, or restarted/);
    expect(readAgent("api")).not.toBeNull();
    writeFileSync(join(home, "continue"), "");
    expect(await child.exited).toBe(0);
    expect(readAgent("api")?.status).toBe("starting");
  });
});

describe("restart with a model change", () => {
  const launch = () => readFileSync(join(home, "launch"), "utf8");
  const codexCatalog = JSON.stringify({
    models: [
      { slug: "gpt-6-luna", supported_reasoning_levels: [{ effort: "low" }, { effort: "medium" }] },
      { slug: "gpt-6.1-sol", supported_reasoning_levels: [{ effort: "low" }, { effort: "high" }] },
    ],
  });
  function useCodex(extra: Partial<AgentState> = {}) {
    writeFileSync(join(home, "codex"), `#!/bin/sh\nif [ "$1" = debug ]; then printf '%s' '${codexCatalog}'; fi\nexit 0\n`);
    writeAgent({ ...readAgent("api")!, provider: "codex", ...extra });
  }

  test("claude: launches with the new model and effort and keeps them for later restarts", async () => {
    expect(await restartAgent("api", { model: "opus", effort: "high" })).toEqual({ model: "opus", effort: "high" });
    expect(launch()).toContain("'--model' 'opus' '--effort' 'high' '--resume' 'conversation-123'");
    expect(readAgent("api")).toMatchObject({ model: "opus", effort: "high", sessionId: "conversation-123" });
    await restartAgent("api");
    expect(launch()).toContain("'--model' 'opus' '--effort' 'high' '--resume' 'conversation-123'");
    // null goes back to the provider default.
    expect(await restartAgent("api", { model: null })).toEqual({ model: null, effort: "high" });
    expect(launch()).not.toContain("'--model'");
    expect(readAgent("api")!.model).toBeUndefined();
  });

  test("codex: passes --model and the effort override ahead of resume and persists them", async () => {
    useCodex({ model: "gpt-6-luna" });
    expect(await restartAgent("api", { model: "gpt-6.1-sol", effort: "high" })).toEqual({ model: "gpt-6.1-sol", effort: "high" });
    expect(launch()).toContain("'--model' 'gpt-6.1-sol' '-c' 'model_reasoning_effort=high' 'resume' 'conversation-123'");
    expect(readAgent("api")).toMatchObject({ model: "gpt-6.1-sol", effort: "high" });
  });

  test("an invalid model or effort is rejected before the pane is touched", async () => {
    useCodex({ model: "gpt-6-luna" });
    await expect(restartAgent("api", { model: "gpt-nope" })).rejects.toThrow(SelectionError);
    // luna has no high effort.
    await expect(restartAgent("api", { effort: "high" })).rejects.toThrow(/unknown codex effort "high" for gpt-6-luna/);
    expect(existsSync(join(home, "launch"))).toBe(false);
    expect(readAgent("api")).toMatchObject({ model: "gpt-6-luna", status: "working" });
    expect(readAgent("api")!.effort).toBeUndefined();
  });

  test("a model change made while waiting for the lock is re-checked against the catalog", async () => {
    useCodex({ model: "gpt-6.1-sol" });
    const spawn = spawnSpy.getMockImplementation()!;
    spawnSpy.mockImplementation((cmd: any, opts?: any) => {
      const result = spawn(cmd, opts);
      // A concurrent restart lands after the early check: luna has no high effort.
      if (cmd[1] === "debug") writeAgent({ ...readAgent("api")!, model: "gpt-6-luna" });
      return result;
    });
    await expect(restartAgent("api", { effort: "high" })).rejects.toThrow(/unknown codex effort "high" for gpt-6-luna/);
    expect(existsSync(join(home, "launch"))).toBe(false);
    expect(readAgent("api")!.effort).toBeUndefined();
  });

  test("an enqueue during an ifIdle restart is not refused", async () => {
    const agent = readAgent("api")!;
    updateAgentStatus(agent, "idle");
    writeAgent(agent);
    const spawn = spawnSpy.getMockImplementation()!;
    let enqueued: unknown;
    spawnSpy.mockImplementation((cmd: any, opts?: any) => {
      if (cmd[1] === "respawn-pane") {
        try { enqueued = queueAppendForAgent("api", "heads-up"); } catch (error) { enqueued = error; }
      }
      return spawn(cmd, opts);
    });
    expect(await restartIfIdle("api", { model: "opus" })).toEqual({ ok: true, model: "opus", effort: null });
    expect(typeof enqueued).toBe("string");
    expect(queueList("api").map((e) => e.message)).toEqual(["heads-up"]);
  });

  test("a queued message survives the restart, receipt still queued", async () => {
    const id = queueTrackedMessage("api", "after the restart");
    await restartAgent("api", { model: "opus" });
    expect(queueList("api").map((e) => e.message)).toEqual(["after the restart"]);
    expect(readMessage("api", id)).toMatchObject({ state: "queued", deliveredAt: null });
  });
});

describe("POST /api/agents/:name/restart", () => {
  let server: ApiServerHandle;
  const TOKEN = "restart-token";
  beforeEach(() => {
    server = startApiServer({ port: 0, hostname: "127.0.0.1", token: TOKEN });
  });
  afterEach(() => server.stop());
  const restart = (name: string, body?: unknown) =>
    fetch(`${server.url}/api/agents/${name}/restart`, {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN}` },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const setStatus = (status: AgentState["status"]) => {
    const agent = readAgent("api")!;
    updateAgentStatus(agent, status);
    writeAgent(agent);
  };

  test("restarts on the new model and answers with what it now runs", async () => {
    const res = await restart("api", { model: "sonnet", effort: "low" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, model: "sonnet", effort: "low" });
    expect(readFileSync(join(home, "launch"), "utf8")).toContain("'--model' 'sonnet' '--effort' 'low' '--resume' 'conversation-123'");
    // "" and null both mean the provider default; omitted keeps the value.
    expect(await (await restart("api", { effort: "" })).json()).toEqual({ ok: true, model: "sonnet", effort: null });
    expect(await (await restart("api")).json()).toEqual({ ok: true, model: "sonnet", effort: null });
  });

  test("ifIdle refuses busy, queued and in_turn agents without touching the pane", async () => {
    let res = await restart("api", { model: "opus", ifIdle: true });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'agent "api" is working', reason: "busy" });

    setStatus("idle");
    queueAppend("api", "later");
    res = await restart("api", { model: "opus", ifIdle: true });
    expect(res.status).toBe(409);
    expect(((await res.json()) as any).reason).toBe("queued");

    queueClear("api");
    const id = queueTrackedMessage("api", "now");
    queuePopId("api", `${id}.json`);
    markDelivered("api", `${id}.json`);
    res = await restart("api", { model: "opus", ifIdle: true });
    expect(res.status).toBe(409);
    expect(((await res.json()) as any).reason).toBe("in_turn");

    expect(existsSync(join(home, "launch"))).toBe(false);
    expect(readAgent("api")!.model).toBeUndefined();
  });

  test("ifIdle restarts an idle agent; a held lifecycle lock is busy", async () => {
    setStatus("idle");
    expect(acquireLifecycleLock("api")).toBe(true);
    try {
      const res = await restart("api", { model: "opus", ifIdle: true });
      expect(res.status).toBe(409);
      expect(((await res.json()) as any).reason).toBe("busy");
    } finally {
      releaseLifecycleLock("api");
    }
    const res = await restart("api", { model: "opus", ifIdle: true });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, model: "opus", effort: null });
    expect(readAgent("api")).toMatchObject({ model: "opus", status: "starting" });
    // Both mailbox locks are free again.
    expect(acquireDeliverLock("api")).toBe(true);
    releaseDeliverLock("api");
    queueAppend("api", "after");
  });

  test("400 on an invalid model or body, 404 for an unknown agent", async () => {
    writeFileSync(join(home, "claude"), `#!/bin/sh
if [ "$1" = --help ]; then printf '  --effort <level>  Effort level (low, medium, high)\\n  --model <model>  Model\\n  -x\\n'; fi
exit 0
`);
    const bad = await restart("api", { effort: "ultra" });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as any).error).toContain('unknown claude effort "ultra"');
    expect((await restart("api", { model: 5 })).status).toBe(400);
    expect((await restart("api", { model: "a b" })).status).toBe(400);
    expect((await restart("api", { ifIdle: "yes" })).status).toBe(400);
    expect((await restart("nobody", { model: "opus" })).status).toBe(404);
    expect(existsSync(join(home, "launch"))).toBe(false);
  });

  test("detail reports the model, effort and the restartModel capability", async () => {
    const detail = async () => (await (await fetch(`${server.url}/api/agents/api`, { headers: { Authorization: `Bearer ${TOKEN}` } })).json()) as any;
    expect(await detail()).toMatchObject({ model: null, effort: null, restartModel: true });
    await restart("api", { model: "opus", effort: "high" });
    expect(await detail()).toMatchObject({ model: "opus", effort: "high", restartModel: true });
  });
});
