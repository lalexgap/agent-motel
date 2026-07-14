import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startDaemonServer, daemonHealth, daemonRequest, nextPollMs, watchDaemonEvents, type DaemonHandle } from "../src/daemon";
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

  test("GET /events streams posted fleet events", async () => {
    const response = await daemonRequest("/events", { timeoutMs: 0 });
    expect(response!.headers.get("content-type")).toContain("text/event-stream");
    const reader = response!.body!.getReader();
    const decoder = new TextDecoder();
    expect(decoder.decode((await reader.read()).value)).toContain("event: ready");

    await daemonRequest("/event", {
      method: "POST",
      body: JSON.stringify({ agent: "alpha", event: "working" }),
    });
    const chunk = decoder.decode((await reader.read()).value);
    expect(chunk).toContain("event: fleet");
    expect(chunk).toContain('"agent":"alpha"');
    expect(chunk).toContain('"event":"working"');
    await reader.cancel();
  });

  test("state-file changes emit a fleet update", async () => {
    const response = await daemonRequest("/events", { timeoutMs: 0 });
    const reader = response!.body!.getReader();
    const decoder = new TextDecoder();
    await reader.read(); // ready

    const now = new Date().toISOString();
    writeAgent({
      name: "watched",
      status: "working",
      dir: "/tmp",
      tmuxSession: "agentmgr-watched",
      createdAt: now,
      updatedAt: now,
    });
    const result = await Promise.race([
      reader.read(),
      Bun.sleep(1000).then(() => { throw new Error("timed out waiting for fleet event"); }),
    ]);
    expect(decoder.decode(result.value)).toContain('"event":"changed"');
    await reader.cancel();
  });

  test("queue changes emit a fleet update", async () => {
    const response = await daemonRequest("/events", { timeoutMs: 0 });
    const reader = response!.body!.getReader();
    const decoder = new TextDecoder();
    await reader.read(); // ready

    queueAppend("queued", "next task");
    const result = await Promise.race([
      reader.read(),
      Bun.sleep(1000).then(() => { throw new Error("timed out waiting for queue event"); }),
    ]);
    expect(decoder.decode(result.value)).toContain('"event":"changed"');
    await reader.cancel();
  });

  test("watchDaemonEvents decodes the stream for picker subscribers", async () => {
    let receive!: (event: string) => void;
    const received = new Promise<string>((resolve) => { receive = resolve; });
    const unsubscribe = watchDaemonEvents((event) => receive(event.event));
    try {
      await Bun.sleep(20);
      await daemonRequest("/event", {
        method: "POST",
        body: JSON.stringify({ agent: "alpha", event: "needs-attention" }),
      });
      expect(await Promise.race([
        received,
        Bun.sleep(1000).then(() => { throw new Error("timed out waiting for decoded event"); }),
      ])).toBe("needs-attention");
    } finally {
      unsubscribe();
    }
  });

  test("unknown route 404s", async () => {
    const res = await daemonRequest("/nope");
    expect(res!.status).toBe(404);
  });
});

describe("nextPollMs (adaptive backoff)", () => {
  test("snaps to hot on collected mail, else grows x1.5 up to the cap", () => {
    expect(nextPollMs(8000, 2000, 30000, 1)).toBe(2000); // got mail → hot floor
    expect(nextPollMs(2000, 2000, 30000, 0)).toBe(3000); // idle → x1.5
    expect(nextPollMs(25000, 2000, 30000, 0)).toBe(30000); // clamped to cap
  });
});
