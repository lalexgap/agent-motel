import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clientMessageId, queueCodexMessage } from "../src/codexQueue";
import { deliverNext, releaseDeliverLock } from "../src/deliver";
import { ensureDirs } from "../src/paths";
import { queueAppend, queueDepth } from "../src/queue";
import { writeAgent } from "../src/state";

let home: string;
let oldPath: string | undefined;
let spawnSpy: ReturnType<typeof spyOn> | undefined;

// Fake `codex app-server --listen stdio://`.
function fakeCodex(mode: "ok" | "error") {
  writeFileSync(join(home, "codex-mode"), mode);
  writeFileSync(join(home, "codex"), `#!${process.execPath}
const { appendFileSync, readFileSync } = require("node:fs");
const home = process.env.AGENTMGR_HOME;
const mode = readFileSync(home + "/codex-mode", "utf8");
const reply = (msg) => process.stdout.write(JSON.stringify(msg) + "\\n");
let buf = "";
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf("\\n")) >= 0) {
    const msg = JSON.parse(buf.slice(0, i));
    buf = buf.slice(i + 1);
    appendFileSync(home + "/codex-calls", JSON.stringify({ argv: process.argv.slice(2), msg }) + "\\n");
    if (msg.method === "initialize") reply({ id: msg.id, result: { userAgent: "fake" } });
    if (msg.method === "thread/queue/add") {
      if (mode === "error") { reply({ id: msg.id, error: { code: -32601, message: "unknown method" } }); continue; }
      reply({ id: msg.id, result: { queuedSubmission: { id: "q1" } } });
    }
  }
});
`);
  chmodSync(join(home, "codex"), 0o755);
}

const calls = () => existsSync(join(home, "codex-calls"))
  ? readFileSync(join(home, "codex-calls"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l))
  : [];
const typed = () => existsSync(join(home, "sends")) && readFileSync(join(home, "sends"), "utf8").includes("text");

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "am-codexq-"));
  process.env.AGENTMGR_HOME = home;
  ensureDirs();
  oldPath = process.env.PATH;
  process.env.PATH = `${home}:${oldPath}`;
  writeFileSync(join(home, "tmux"), `#!/bin/sh
case "$1" in
  has-session) exit 0 ;;
  display-message) echo '%7' ;;
  capture-pane) printf '› \\n\\n  GPT-6.1-Sol medium · ~/project\\n  ? for shortcuts\\n' ;;
  send-keys) [ "$4" = '-l' ] && echo text >> "$AGENTMGR_HOME/sends" || echo enter >> "$AGENTMGR_HOME/sends" ;;
esac
exit 0
`);
  chmodSync(join(home, "tmux"), 0o755);
  const spawn = Bun.spawnSync.bind(Bun);
  spawnSpy = spyOn(Bun, "spawnSync").mockImplementation((cmd: any, opts?: any) =>
    Array.isArray(cmd) && cmd[0] === "tmux"
      ? spawn([join(home, "tmux"), ...cmd.slice(1)], { ...opts, env: { ...process.env } })
      : spawn(cmd, opts));
  writeAgent({ name: "api", provider: "codex", status: "idle", tmuxSession: "agentmgr-api", dir: home, createdAt: "now", updatedAt: "now", sessionId: "thread-1" });
});

afterEach(() => {
  spawnSpy?.mockRestore();
  releaseDeliverLock("api");
  process.env.PATH = oldPath;
  delete process.env.AGENTMGR_HOME;
  rmSync(home, { recursive: true, force: true });
});

describe("queueCodexMessage", () => {
  test("initializes with the experimental API and queues on the thread", async () => {
    fakeCodex("ok");
    await queueCodexMessage("thread-1", "hello", "cid");
    const sent = calls();
    expect(sent[0].argv).toEqual(["app-server", "--listen", "stdio://"]);
    expect(sent[0].msg).toMatchObject({ method: "initialize", params: { capabilities: { experimentalApi: true } } });
    expect(sent.at(-1).msg).toMatchObject({
      method: "thread/queue/add",
      params: { threadId: "thread-1", clientUserMessageId: "cid", input: [{ type: "text", text: "hello" }] },
    });
  });

  test("an error reply rejects", async () => {
    fakeCodex("error");
    await expect(queueCodexMessage("thread-1", "hello", "cid")).rejects.toThrow("unknown method");
  });

  test("client ids are stable per entry and UUID-shaped", () => {
    expect(clientMessageId("a.json")).toBe(clientMessageId("a.json"));
    expect(clientMessageId("a.json")).not.toBe(clientMessageId("b.json"));
    expect(clientMessageId("a.json")).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-a[0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});

describe("codex inbox delivery", () => {
  test("operator and peer messages go to the thread queue, not the pane", async () => {
    fakeCodex("ok");
    const id = queueAppend("api", "operator note");
    expect(await deliverNext("api")).toEqual({ status: "submitted", id });
    expect(queueDepth("api")).toBe(0);
    expect(typed()).toBe(false);
  });

  test("an unsupported codex falls back to typing", async () => {
    fakeCodex("error");
    queueAppend("api", "operator note");
    await deliverNext("api");
    expect(typed()).toBe(true);
  });

  test("after an Esc, typing until a prompt is submitted", async () => {
    fakeCodex("ok");
    const agent = { name: "api", provider: "codex" as const, status: "idle" as const, tmuxSession: "agentmgr-api", dir: home, createdAt: "now", updatedAt: "now", sessionId: "thread-1" };
    writeAgent({ ...agent, promptAt: "2026-01-01T00:00:00.000Z", escapedAt: "2026-01-01T00:00:01.000Z" });
    queueAppend("api", "operator note");
    await deliverNext("api");
    expect(calls()).toHaveLength(0);
    expect(typed()).toBe(true);

    writeAgent({ ...agent, promptAt: "2026-01-01T00:00:02.000Z", escapedAt: "2026-01-01T00:00:01.000Z" });
    const id = queueAppend("api", "next note");
    expect(await deliverNext("api")).toEqual({ status: "submitted", id });
    expect(calls().some((c) => c.msg.method === "thread/queue/add")).toBe(true);
  });

  test("no thread id means typing", async () => {
    fakeCodex("ok");
    writeAgent({ name: "api", provider: "codex", status: "idle", tmuxSession: "agentmgr-api", dir: home, createdAt: "now", updatedAt: "now" });
    queueAppend("api", "operator note");
    await deliverNext("api");
    expect(calls()).toHaveLength(0);
    expect(typed()).toBe(true);
  });
});
