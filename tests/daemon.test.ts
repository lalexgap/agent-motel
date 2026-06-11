import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startDaemonServer, daemonHealth, daemonRequest, type DaemonHandle } from "../src/daemon";
import { writeAgent } from "../src/state";
import { queueAppend } from "../src/queue";

let home: string;
let daemon: DaemonHandle;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "am-test-"));
  process.env.AGENTMGR_HOME = home;
  daemon = startDaemonServer();
});

afterEach(() => {
  daemon.stop();
  rmSync(home, { recursive: true, force: true });
  delete process.env.AGENTMGR_HOME;
});

describe("daemon", () => {
  test("health reports pid", async () => {
    const health = await daemonHealth();
    expect(health?.pid).toBe(process.pid);
  });

  test("GET /agents returns rows with queue depth", async () => {
    const now = new Date().toISOString();
    writeAgent({
      name: "alpha",
      status: "working",
      dir: "/tmp",
      tmuxSession: "agentmgr-alpha",
      createdAt: now,
      updatedAt: now,
    });
    queueAppend("alpha", "next task");

    const res = await daemonRequest("/agents");
    const rows = (await res!.json()) as { name: string; status: string; queued: number }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]!.name).toBe("alpha");
    // No real tmux session exists for it, so the daemon reports it dead.
    expect(rows[0]!.status).toBe("dead");
    expect(rows[0]!.queued).toBe(1);
  });

  test("POST /event validates payload", async () => {
    const bad = await daemonRequest("/event", { method: "POST", body: JSON.stringify({}) });
    expect(bad!.status).toBe(400);

    const ok = await daemonRequest("/event", {
      method: "POST",
      body: JSON.stringify({ agent: "alpha", event: "stop" }),
    });
    expect(ok!.status).toBe(200);
  });

  test("unknown route 404s", async () => {
    const res = await daemonRequest("/nope");
    expect(res!.status).toBe(404);
  });
});
