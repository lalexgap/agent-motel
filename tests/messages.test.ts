import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { appendFileSync, chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireDeliverLock, cancelMessage, releaseDeliverLock } from "../src/deliver";
import { acquireProducerLock, releaseProducerLock } from "../src/mailbox";
import { ensureDirs } from "../src/paths";
import { queueDepth, queuePopId } from "../src/queue";
import { readAgent, writeAgent, type AgentState } from "../src/state";
import { interruptCommand, sendCommand } from "../src/commands/send";
import { queueCommand } from "../src/commands/queue";
import { renameAgent } from "../src/commands/rename";
import {
  deliveryMark,
  markDelivered,
  queueTrackedMessage,
  readMessage,
  recordImmediateDelivery,
  transcriptLength,
} from "../src/messages";
import { startApiServer, type ApiServerHandle } from "../src/server";

let home: string;
let oldPath: string | undefined;
let spawnSpy: ReturnType<typeof spyOn> | undefined;
let sleepSpy: ReturnType<typeof spyOn> | undefined;
let callingAgent: string | undefined;

const CLI = join(import.meta.dir, "../src/index.ts");

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "am-messages-test-"));
  process.env.AGENTMGR_HOME = home;
  oldPath = process.env.PATH;
  // These are operator sends; inside an am session they'd be attributed.
  callingAgent = process.env.AGENTMGR_AGENT;
  delete process.env.AGENTMGR_AGENT;
  ensureDirs();
  // Hooks run in child processes; keep them from popping desktop notifications.
  writeFileSync(join(home, "config.json"), JSON.stringify({ notifyCommand: "true" }));
});

afterEach(() => {
  spawnSpy?.mockRestore();
  spawnSpy = undefined;
  sleepSpy?.mockRestore();
  sleepSpy = undefined;
  releaseDeliverLock("api");
  releaseProducerLock("api");
  process.env.PATH = oldPath;
  if (callingAgent !== undefined) process.env.AGENTMGR_AGENT = callingAgent;
  rmSync(home, { recursive: true, force: true });
  delete process.env.AGENTMGR_HOME;
});

function transcriptFile(): string {
  return join(home, "session.jsonl");
}

function say(type: "user" | "assistant", text: string): void {
  const message = type === "user" ? { role: "user", content: text } : { content: [{ type: "text", text }] };
  appendFileSync(transcriptFile(), JSON.stringify({ type, message }) + "\n");
}

// A claude agent with a three-entry transcript and a fake tmux whose input
// box clears on Enter (mode "submit"); mode "dead" makes the session vanish.
function fakeSession(status: AgentState["status"] = "idle") {
  writeAgent({
    name: "api", provider: "claude", status, tmuxSession: "agentmgr-api", dir: home,
    transcriptPath: transcriptFile(), createdAt: "now", updatedAt: "now",
  });
  say("user", "first");
  say("assistant", "one");
  say("user", "second");
  writeFileSync(join(home, "mode"), "submit");
  writeFileSync(join(home, "input"), "");
  writeFileSync(join(home, "tmux"), `#!/bin/sh
case "$1" in
  has-session) [ "$(cat "$AGENTMGR_HOME/mode")" = dead ] && exit 1; exit 0 ;;
  display-message) echo "server:session:pane:1" ;;
  capture-pane)
    echo '────────────────────'
    printf '❯ '; cat "$AGENTMGR_HOME/input"; echo
    echo '────────────────────'
    ;;
  send-keys)
    if [ "$4" = '-l' ]; then
      printf '%s' "$6" >> "$AGENTMGR_HOME/input"
      printf '%s\\n' "$6" >> "$AGENTMGR_HOME/typed"
    else
      [ "$(cat "$AGENTMGR_HOME/mode")" = submit ] && printf '' > "$AGENTMGR_HOME/input"
    fi
    ;;
esac
exit 0
`);
  chmodSync(join(home, "tmux"), 0o755);
  process.env.PATH = `${home}:${oldPath}`;
  const spawn = Bun.spawnSync.bind(Bun);
  spawnSpy = spyOn(Bun, "spawnSync").mockImplementation((cmd: any, opts?: any) => {
    if (Array.isArray(cmd) && cmd[0] === "tmux") {
      return spawn([join(home, "tmux"), ...cmd.slice(1)], { ...opts, env: { ...process.env } });
    }
    return spawn(cmd, opts);
  });
}

function hook(event: string, payload: Record<string, unknown> = {}): string {
  const result = Bun.spawnSync([process.execPath, CLI, "hook", event], {
    env: { ...process.env, AGENTMGR_AGENT: "api" },
    stdin: Buffer.from(JSON.stringify(payload)),
  });
  expect(result.exitCode).toBe(0);
  return result.stdout.toString();
}

function fastSleep() {
  sleepSpy = spyOn(Bun, "sleep").mockResolvedValue(undefined);
}

describe("delivery receipts", () => {
  test("typed in: queued → delivered at the pre-typing transcript length → done at the next stop", async () => {
    fakeSession("idle");
    fastSleep();
    const { id } = await sendCommand("api", "hello there", { now: false, track: true });
    expect(id).toMatch(/^[0-9A-Z]{26}$/);
    expect(readFileSync(join(home, "typed"), "utf8")).toBe("hello there\n");
    const delivered = readMessage("api", id!)!;
    expect(delivered).toMatchObject({ id, state: "delivered", transcriptIndex: 3, doneAt: null });
    expect(delivered.deliveredAt).not.toBeNull();
    expect(queueDepth("api")).toBe(0);

    hook("user-prompt-submit", { prompt: "hello there" });
    expect(readMessage("api", id!)!.state).toBe("delivered");
    say("user", "hello there");
    say("assistant", "hi");
    hook("stop");
    const done = readMessage("api", id!)!;
    expect(done.state).toBe("done");
    expect(done.doneAt).not.toBeNull();
    expect(Date.parse(done.doneAt!)).toBeGreaterThanOrEqual(Date.parse(done.deliveredAt!));
  });

  test("a turn that ends before the typed delivery is confirmed goes straight to done", () => {
    fakeSession("idle");
    const id = queueTrackedMessage("api", "quick one");
    const mark = deliveryMark("api", `${id}.json`)!;
    const agent = readAgent("api")!;
    writeAgent({ ...agent, status: "idle", statusChangedAt: new Date(Date.parse(mark.handedAt) + 50).toISOString() });
    expect(acquireDeliverLock("api")).toBe(true);
    queuePopId("api", `${id}.json`);
    markDelivered("api", `${id}.json`, mark);
    releaseDeliverLock("api");
    expect(readMessage("api", id)).toMatchObject({ state: "done", transcriptIndex: 3 });
  });

  test("hook inbox block: a busy agent's Stop gate delivers it (isMeta in the transcript) → done at the real stop", async () => {
    fakeSession("working");
    const { id } = await sendCommand("api", "while you were busy", { now: false, track: true });
    expect(readMessage("api", id!)).toMatchObject({ state: "queued", deliveredAt: null, transcriptIndex: null });

    const gate = hook("stop");
    expect(JSON.parse(gate).decision).toBe("block");
    expect(gate).toContain("while you were busy");
    expect(readMessage("api", id!)).toMatchObject({ state: "delivered", transcriptIndex: 3, doneAt: null });

    say("assistant", "handled it");
    expect(hook("stop")).toBe("");
    expect(readMessage("api", id!)!.state).toBe("done");
  });

  test("PostToolUse surfacing delivers mid-turn", async () => {
    fakeSession("working");
    const { id } = await sendCommand("api", "mid turn note", { now: false, track: true });
    say("assistant", "working on it");
    expect(hook("post-tool-use")).toContain("mid turn note");
    expect(readMessage("api", id!)).toMatchObject({ state: "delivered", transcriptIndex: 4 });
  });

  test("now and interrupt are delivered immediately but still get an id and record", async () => {
    fakeSession("working");
    fastSleep();
    const now = await sendCommand("api", "steer", { now: true, track: true });
    const int = await interruptCommand("api", "new plan", { exact: true, track: true });
    for (const id of [now.id, int.id]) {
      const record = readMessage("api", id!)!;
      expect(record).toMatchObject({ state: "delivered", transcriptIndex: 3, doneAt: null });
      expect(record.queuedAt).toBeTruthy();
      expect(record.deliveredAt).toBeTruthy();
    }
    expect(now.id).not.toBe(int.id);
    hook("stop");
    expect(readMessage("api", now.id!)!.state).toBe("done");
    expect(readMessage("api", int.id!)!.state).toBe("done");
  });

  test("untracked sends make no record; --json prints only the id", async () => {
    fakeSession("working");
    expect((await sendCommand("api", "plain", { now: false })).id).toBeNull();
    expect(existsSync(join(home, "queue", "api", ".messages"))).toBe(false);
    const log = spyOn(console, "log").mockImplementation(() => {});
    try {
      const { id } = await sendCommand("api", "json please", { now: false, json: true });
      expect(log.mock.calls).toEqual([[JSON.stringify({ id })]]);
    } finally {
      log.mockRestore();
    }
  });

  test("cancel while queued removes it; after delivery it is refused", async () => {
    fakeSession("working");
    const id = queueTrackedMessage("api", "never mind");
    expect(queueDepth("api")).toBe(1);
    expect(await cancelMessage("api", id)).toEqual({ ok: true, state: "cancelled" });
    expect(queueDepth("api")).toBe(0);
    expect(readMessage("api", id)!.state).toBe("cancelled");
    expect(await cancelMessage("api", id)).toMatchObject({ ok: false, state: "cancelled" });
    expect(await cancelMessage("api", "NOPE")).toBeNull();

    const delivered = recordImmediateDelivery("api", { transcriptIndex: 3, handedAt: new Date().toISOString() });
    expect(await cancelMessage("api", delivered)).toMatchObject({ ok: false, state: "delivered" });
  });

  test("cancel waits for the delivery lock, and loses to a delivery that took the message meanwhile", async () => {
    fakeSession("working");
    const id = queueTrackedMessage("api", "race me");
    expect(acquireDeliverLock("api")).toBe(true);
    const cancelling = cancelMessage("api", id);
    await Bun.sleep(250);
    expect(readMessage("api", id)!.state).toBe("queued");
    const mark = deliveryMark("api", `${id}.json`);
    queuePopId("api", `${id}.json`);
    markDelivered("api", `${id}.json`, mark);
    releaseDeliverLock("api");
    expect(await cancelling).toMatchObject({ ok: false, state: "delivered" });
    expect(readMessage("api", id)!.state).toBe("delivered");
  });

  test("cancel waits out an enqueue in progress (producer lock) before removing", async () => {
    fakeSession("working");
    const id = queueTrackedMessage("api", "hold on");
    expect(acquireProducerLock("api")).toBe(true);
    const cancelling = cancelMessage("api", id);
    await Bun.sleep(250);
    expect(queueDepth("api")).toBe(1);
    releaseProducerLock("api");
    expect(await cancelling).toEqual({ ok: true, state: "cancelled" });
    expect(queueDepth("api")).toBe(0);
  });

  test("a message typed in but not yet confirmed cannot be cancelled", async () => {
    fakeSession("idle");
    const id = queueTrackedMessage("api", "in flight");
    writeFileSync(join(home, "queue", "api", ".delivery.pending"), JSON.stringify({ id: `${id}.json`, message: "in flight", typed: true }));
    expect(await cancelMessage("api", id)).toMatchObject({ ok: false, state: "queued" });
    expect(queueDepth("api")).toBe(1);
  });

  test("a session that dies: queued → failed (and out of the queue), delivered → done", async () => {
    fakeSession("working");
    const queued = queueTrackedMessage("api", "too late");
    const delivered = recordImmediateDelivery("api", { transcriptIndex: 3, handedAt: new Date().toISOString() });
    writeFileSync(join(home, "mode"), "dead");
    const failed = readMessage("api", queued)!;
    expect(failed.state).toBe("failed");
    expect(failed.error).toContain("session ended");
    expect(queueDepth("api")).toBe(0);
    expect(readMessage("api", delivered)!.state).toBe("done");
  });

  test("am queue --clear cancels tracked messages", () => {
    fakeSession("working");
    const id = queueTrackedMessage("api", "clear me");
    const log = spyOn(console, "log").mockImplementation(() => {});
    try {
      queueCommand("api", { clear: true });
    } finally {
      log.mockRestore();
    }
    expect(queueDepth("api")).toBe(0);
    expect(readMessage("api", id)!.state).toBe("cancelled");
  });

  test("finished records older than a week are pruned", () => {
    fakeSession("working");
    const dir = join(home, "queue", "api", ".messages");
    const old = recordImmediateDelivery("api", { transcriptIndex: 0, handedAt: new Date().toISOString() });
    const stale = new Date(Date.now() - 8 * 86_400_000).toISOString();
    writeFileSync(join(dir, `${old}.json`), JSON.stringify({ id: old, state: "done", queuedAt: stale, deliveredAt: stale, doneAt: stale, transcriptIndex: 0 }));
    const fresh = recordImmediateDelivery("api", { transcriptIndex: 0, handedAt: new Date().toISOString() });
    expect(existsSync(join(dir, `${old}.json`))).toBe(false);
    expect(existsSync(join(dir, `${fresh}.json`))).toBe(true);
  });

  test("transcriptLength is the GET /transcript entry count", () => {
    fakeSession("idle");
    expect(transcriptLength(readAgent("api")!)).toBe(3);
    expect(transcriptLength({ ...readAgent("api")!, transcriptPath: undefined, sessionId: undefined })).toBe(0);
  });

  test("hidden CLI: __message prints the receipt, __cancel the outcome, __detail advertises receipts", () => {
    fakeSession("working");
    const id = queueTrackedMessage("api", "remote me");
    const am = (...args: string[]) =>
      Bun.spawnSync([process.execPath, CLI, ...args, "--local", "--exact"], { env: { ...process.env } });
    expect(JSON.parse(am("__message", "api", id).stdout.toString())).toMatchObject({ id, state: "queued" });
    expect(JSON.parse(am("__detail", "api").stdout.toString()).messageReceipts).toBe(true);
    expect(JSON.parse(am("__cancel", "api", id).stdout.toString())).toEqual({ ok: true, state: "cancelled" });
    expect(JSON.parse(am("__cancel", "api", id).stdout.toString())).toMatchObject({ ok: false, state: "cancelled" });
    const missing = am("__message", "api", "01NOPE");
    expect(missing.exitCode).toBe(1);
    expect(missing.stderr.toString()).toContain('no message "01NOPE"');
    expect(am("__message", "ghost", id).stderr.toString()).toContain("no local agent");
  });

  test("rename carries the records", async () => {
    const now = new Date().toISOString();
    writeAgent({ name: "alpha", status: "exited", dir: "/tmp", tmuxSession: "agentmgr-alpha", createdAt: now, updatedAt: now });
    const id = recordImmediateDelivery("alpha", { transcriptIndex: 7, handedAt: now });
    await renameAgent("alpha", "omega");
    expect(readMessage("alpha", id)).toBeNull();
    expect(readMessage("omega", id)).toMatchObject({ id, transcriptIndex: 7 });
  });
});

describe("messages api", () => {
  let server: ApiServerHandle;
  const TOKEN = "t";

  beforeEach(() => {
    server = startApiServer({ port: 0, hostname: "127.0.0.1", token: TOKEN });
  });

  afterEach(() => {
    server.stop();
  });

  const call = (path: string, init: RequestInit = {}) =>
    fetch(server.url + path, { ...init, headers: { Authorization: `Bearer ${TOKEN}`, "content-type": "application/json" } });

  test("POST returns an id; GET reads the receipt; DELETE cancels once, then 409", async () => {
    fakeSession("working");
    fastSleep();
    const posted = await call("/api/agents/api/messages", { method: "POST", body: JSON.stringify({ text: "queued one" }) });
    expect(posted.status).toBe(200);
    const { ok, mode, id } = (await posted.json()) as any;
    expect({ ok, mode }).toEqual({ ok: true, mode: "queue" });

    const got = (await (await call(`/api/agents/api/messages/${id}`)).json()) as any;
    expect(Object.keys(got).sort()).toEqual(["deliveredAt", "doneAt", "id", "queuedAt", "state", "transcriptIndex"]);
    expect(got).toMatchObject({ id, state: "queued", deliveredAt: null, doneAt: null, transcriptIndex: null });

    const cancelled = await call(`/api/agents/api/messages/${id}`, { method: "DELETE" });
    expect(cancelled.status).toBe(200);
    expect(await cancelled.json()).toEqual({ ok: true, state: "cancelled" });
    const again = await call(`/api/agents/api/messages/${id}`, { method: "DELETE" });
    expect(again.status).toBe(409);
    expect(((await again.json()) as any).state).toBe("cancelled");

    const steer = (await (await call("/api/agents/api/messages", { method: "POST", body: JSON.stringify({ text: "now", mode: "now" }) })).json()) as any;
    expect(steer).toMatchObject({ ok: true, mode: "now" });
    const late = await call(`/api/agents/api/messages/${steer.id}`, { method: "DELETE" });
    expect(late.status).toBe(409);
    expect(await late.json()).toMatchObject({ state: "delivered" });

    expect((await call("/api/agents/api/messages/NOPE")).status).toBe(404);
    expect((await call("/api/agents/api/messages/NOPE", { method: "DELETE" })).status).toBe(404);
    expect((await call(`/api/agents/ghost/messages/${id}`)).status).toBe(404);
    expect((await call("/api/agents/ghost/messages", { method: "POST", body: JSON.stringify({ text: "x" }) })).status).toBe(404);
  });
});
