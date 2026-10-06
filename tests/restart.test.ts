import { afterEach, beforeEach, describe, expect, test, spyOn } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { restartAgent } from "../src/commands/restart";
import { startDaemonServer, type DaemonHandle } from "../src/daemon";
import { acquireDeliverLock, beginDeliveryHandoff, endDeliveryHandoff, releaseDeliverLock } from "../src/deliver";
import { queueAppend, queueList } from "../src/queue";
import { readAgent, writeAgent } from "../src/state";

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
});
