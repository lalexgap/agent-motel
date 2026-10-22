import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clientMessageId, queueCodexMessage } from "../src/codexQueue";
import { deliverNext, dropCodexHandoff, interruptMessage, releaseDeliverLock, releaseEscapeHold } from "../src/deliver";
import { claimPrompt, markTurnEnded, promptKey, queueTrackedMessage, readMessage } from "../src/messages";
import { ensureDirs } from "../src/paths";
import { queueAppend, queueDepth } from "../src/queue";
import { abortTurn } from "../src/commands/send";
import { readAgent, writeAgent } from "../src/state";

let home: string;
let oldPath: string | undefined;
let spawnSpy: ReturnType<typeof spyOn> | undefined;
let sleepSpy: ReturnType<typeof spyOn> | undefined;

// Fake `codex app-server --listen stdio://`, its thread queue kept in
// codex-queue. Past the first delete (counted across processes), the
// delete-fails mode answers each with an error, and delete-exits applies it
// and exits without answering; add-exits does that to an add.
type CodexMode = "ok" | "error" | "delete-fails" | "delete-exits" | "add-exits";
function fakeCodex(mode: CodexMode) {
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
    const queueFile = home + "/codex-queue";
    let queue = [];
    try { queue = JSON.parse(readFileSync(queueFile, "utf8")); } catch {}
    const save = () => require("node:fs").writeFileSync(queueFile, JSON.stringify(queue));
    if (msg.method.startsWith("thread/queue/") && mode === "error") { reply({ id: msg.id, error: { code: -32601, message: "unknown method" } }); continue; }
    if (msg.method === "thread/queue/add") {
      const submission = { id: "q" + (queue.length + 1) + "-" + msg.params.clientUserMessageId, clientUserMessageId: msg.params.clientUserMessageId, input: msg.params.input };
      queue.push(submission);
      save();
      if (mode === "add-exits") process.exit(0);
      reply({ id: msg.id, result: { queuedSubmission: submission } });
    }
    if (msg.method === "thread/queue/list") reply({ id: msg.id, result: { data: queue, nextCursor: null } });
    if (msg.method === "thread/queue/delete") {
      const counter = home + "/codex-deletes";
      let n = 0;
      try { n = Number(readFileSync(counter, "utf8")); } catch {}
      require("node:fs").writeFileSync(counter, String(++n));
      if (n > 1 && mode === "delete-fails") { reply({ id: msg.id, error: { code: -32000, message: "delete failed" } }); continue; }
      const before = queue.length;
      queue = queue.filter((s) => s.id !== msg.params.queuedSubmissionId);
      save();
      if (n > 1 && mode === "delete-exits") process.exit(0);
      reply({ id: msg.id, result: { deleted: queue.length < before } });
    }
  }
});
`);
  chmodSync(join(home, "codex"), 0o755);
}

const calls = () => existsSync(join(home, "codex-calls"))
  ? readFileSync(join(home, "codex-calls"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l))
  : [];
const codexQueue = () => JSON.parse(readFileSync(join(home, "codex-queue"), "utf8")) as { id: string; input: { text: string }[] }[];
const handoffs = () => existsSync(join(home, "queue", "api", ".codex-handoffs"))
  ? JSON.parse(readFileSync(join(home, "queue", "api", ".codex-handoffs"), "utf8")) as { entryId: string; reclaiming?: boolean; uncertain?: boolean }[]
  : [];
const typedLines = () => existsSync(join(home, "typed")) ? readFileSync(join(home, "typed"), "utf8") : "";
// What the UserPromptSubmit hook does to state, a few ms after the last.
const prompt = (body: string) => {
  Bun.sleepSync(3);
  const agent = { ...readAgent("api")!, status: "working" as const, promptAt: new Date().toISOString(), promptKey: promptKey(body) };
  releaseEscapeHold(agent);
  writeAgent(agent);
  const started = claimPrompt("api", agent.promptAt, agent.promptKey);
  if (started) dropCodexHandoff("api", `${started}.json`);
};
const stop = () => {
  Bun.sleepSync(3);
  const agent = { ...readAgent("api")!, status: "idle" as const, statusChangedAt: new Date().toISOString() };
  writeAgent(agent);
  markTurnEnded("api", agent);
};
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
  send-keys) [ "$4" = '-l' ] && { echo text >> "$AGENTMGR_HOME/sends"; printf '%s\n' "$6" >> "$AGENTMGR_HOME/typed"; } || echo enter >> "$AGENTMGR_HOME/sends" ;;
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
  sleepSpy?.mockRestore();
  sleepSpy = undefined;
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

  test("after an Esc, typing until a prompt am typed since is submitted", async () => {
    fakeCodex("ok");
    writeAgent({ ...readAgent("api")!, promptAt: "2026-01-01T00:00:00.000Z", escapedAt: "2026-01-01T00:00:01.000Z", escapedKeys: [promptKey("aborted")] });
    // A prompt before am types anything doesn't lift the hold.
    prompt("someone else's");
    queueAppend("api", "operator note");
    await deliverNext("api");
    expect(calls()).toHaveLength(0);
    expect(typedLines()).toBe("operator note\n");

    // The aborted prompt's own hook, landing after am typed, doesn't either.
    prompt("aborted");
    queueAppend("api", "late hook");
    await deliverNext("api");
    expect(calls()).toHaveLength(0);
    expect(typedLines()).toBe("operator note\nlate hook\n");

    // However soon after the Esc, the prompt am typed lifts it.
    prompt("operator note");
    expect(readAgent("api")!.escReleasedAt).toBe(readAgent("api")!.promptAt);
    const id = queueAppend("api", "next note");
    expect(await deliverNext("api")).toEqual({ status: "submitted", id });
    expect(calls().some((c) => c.msg.method === "thread/queue/add")).toBe(true);
  });

  test("after an Esc, any prompt but the aborted one lifts the hold once am has typed", async () => {
    fakeCodex("ok");
    writeAgent({ ...readAgent("api")!, promptAt: "2026-01-01T00:00:00.000Z", escapedAt: "2026-01-01T00:00:01.000Z", escapedKeys: [promptKey("aborted")] });
    queueAppend("api", "typed note");
    await deliverNext("api");
    prompt("reworded by the TUI");
    expect(readAgent("api")!.escReleasedAt).toBeDefined();
  });

  test("no thread id means typing", async () => {
    fakeCodex("ok");
    writeAgent({ name: "api", provider: "codex", status: "idle", tmuxSession: "agentmgr-api", dir: home, createdAt: "now", updatedAt: "now" });
    queueAppend("api", "operator note");
    await deliverNext("api");
    expect(calls()).toHaveLength(0);
    expect(typed()).toBe(true);
  });

  test("an Esc'd turn takes back what waits in Codex's queue and types it, in order", async () => {
    fakeCodex("ok");
    const ids = [];
    for (const body of ["first", "second", "third"]) {
      ids.push(queueTrackedMessage("api", body));
      expect((await deliverNext("api")).status).toBe("submitted");
    }
    const [first, second, third] = ids as [string, string, string];
    expect(codexQueue().map((s) => s.input[0]!.text)).toEqual(["first", "second", "third"]);
    for (const id of ids) expect(readMessage("api", id)).toMatchObject({ state: "delivered" });

    // Codex starts the first; the other two wait behind its turn.
    writeFileSync(join(home, "codex-queue"), JSON.stringify(codexQueue().slice(1)));
    prompt("first");
    sleepSpy = spyOn(Bun, "sleep").mockResolvedValue(undefined);

    expect(await interruptMessage("api", first)).toEqual({ ok: true, state: "delivered" });
    expect(readMessage("api", first)).toMatchObject({ state: "done", interrupted: true });
    expect(codexQueue()).toEqual([]);
    expect(readFileSync(join(home, "typed"), "utf8")).toBe("second\n");
    expect(readMessage("api", second)).toMatchObject({ state: "delivered" });
    expect(readMessage("api", third)).toMatchObject({ state: "queued", deliveredAt: null });
    expect(queueDepth("api")).toBe(1);

    prompt("second");
    stop();
    expect(readMessage("api", second)).toMatchObject({ state: "done" });
    expect(readMessage("api", second)!.interrupted).toBeUndefined();
    // The prompt am typed lifted the hold, so the third goes to Codex's queue.
    expect(await deliverNext("api")).toEqual({ status: "submitted", id: `${third}.json` });
    expect(typedLines()).toBe("second\n");
    expect(codexQueue().map((q) => q.input[0]!.text)).toEqual(["third"]);
    writeFileSync(join(home, "codex-queue"), "[]");
    prompt("third");
    stop();
    expect(readMessage("api", third)).toMatchObject({ state: "done" });
    expect(handoffs()).toEqual([]);
  });

  test("a message Codex already started is left with it", async () => {
    fakeCodex("ok");
    const id = queueTrackedMessage("api", "only");
    await deliverNext("api");
    writeFileSync(join(home, "codex-queue"), "[]");
    const promptAt = new Date().toISOString();
    writeAgent({ ...readAgent("api")!, status: "working", promptAt, promptKey: promptKey("only") });
    claimPrompt("api", promptAt, promptKey("only"));
    sleepSpy = spyOn(Bun, "sleep").mockResolvedValue(undefined);

    expect(await interruptMessage("api", id)).toEqual({ ok: true, state: "delivered" });
    expect(readMessage("api", id)).toMatchObject({ state: "done", interrupted: true });
    expect(queueDepth("api")).toBe(0);
    expect(existsSync(join(home, "typed"))).toBe(false);
    expect(calls().filter((c) => c.msg.method === "thread/queue/delete")).toHaveLength(0);
  });

  // Three handed to Codex's queue; Codex starts the first, and am Escs it.
  async function escAfterThree(mode: CodexMode): Promise<[string, string, string]> {
    fakeCodex("ok");
    const ids: string[] = [];
    for (const body of ["first", "second", "third"]) {
      ids.push(queueTrackedMessage("api", body));
      await deliverNext("api");
    }
    writeFileSync(join(home, "codex-queue"), JSON.stringify(codexQueue().slice(1)));
    prompt("first");
    sleepSpy = spyOn(Bun, "sleep").mockResolvedValue(undefined);
    fakeCodex(mode);
    const log = spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(await interruptMessage("api", ids[0]!)).toEqual({ ok: true, state: "delivered" });
    } finally {
      log.mockRestore();
    }
    return ids as [string, string, string];
  }

  test("a delete that fails part way keeps what it took back, and the rest stays with Codex until a later try", async () => {
    const [first, second, third] = await escAfterThree("delete-fails");
    expect(readMessage("api", first)).toMatchObject({ state: "done", interrupted: true });
    expect(typedLines()).toBe("second\n");
    expect(readMessage("api", second)).toMatchObject({ state: "delivered" });
    expect(codexQueue().map((q) => q.input[0]!.text)).toEqual(["third"]);
    expect(handoffs()).toEqual([expect.objectContaining({ entryId: `${third}.json`, reclaiming: true })]);
    expect(readMessage("api", third)).toMatchObject({ state: "delivered" });
    expect(queueDepth("api")).toBe(0);

    fakeCodex("ok");
    expect(await deliverNext("api")).toEqual({ status: "submitted", id: `${third}.json` });
    expect(typedLines()).toBe("second\nthird\n");
    expect(codexQueue()).toEqual([]);
    expect(handoffs()).toEqual([]);
  });

  test("a delete Codex applied but never answered is put back from the note", async () => {
    const [, second, third] = await escAfterThree("delete-exits");
    expect(typedLines()).toBe("second\n");
    expect(readMessage("api", second)).toMatchObject({ state: "delivered" });
    expect(codexQueue()).toEqual([]);
    expect(queueDepth("api")).toBe(1);
    expect(readMessage("api", third)).toMatchObject({ state: "queued", deliveredAt: null });
    expect(handoffs()).toEqual([]);
  });

  test("an add whose outcome is unknown keeps its note, so a reclaim deletes Codex's copy without typing it again", async () => {
    fakeCodex("add-exits");
    const id = queueTrackedMessage("api", "maybe");
    expect(await deliverNext("api")).toEqual({ status: "submitted", id: `${id}.json` });
    expect(typedLines()).toBe("maybe\n");
    expect(codexQueue().map((q) => q.input[0]!.text)).toEqual(["maybe"]);
    expect(handoffs()).toEqual([expect.objectContaining({ entryId: `${id}.json`, uncertain: true })]);

    writeAgent({ ...readAgent("api")!, status: "working" });
    sleepSpy = spyOn(Bun, "sleep").mockResolvedValue(undefined);
    const log = spyOn(console, "log").mockImplementation(() => {});
    try {
      await abortTurn("api");
    } finally {
      log.mockRestore();
    }
    expect(codexQueue()).toEqual([]);
    expect(handoffs()).toEqual([]);
    expect(queueDepth("api")).toBe(0);
    expect(typedLines()).toBe("maybe\n");
  });

  test("the prompt hook drops the note of a message once it starts", async () => {
    fakeCodex("ok");
    const id = queueTrackedMessage("api", "pruned");
    await deliverNext("api");
    expect(handoffs()).toHaveLength(1);
    const result = Bun.spawnSync([process.execPath, join(import.meta.dir, "../src/index.ts"), "hook", "user-prompt-submit"], {
      env: { ...process.env, AGENTMGR_AGENT: "api" },
      stdin: Buffer.from(JSON.stringify({ prompt: "pruned" })),
    });
    expect(result.exitCode).toBe(0);
    expect(handoffs()).toEqual([]);
    expect(existsSync(join(home, "queue", "api", ".codex-handoffs"))).toBe(false);
    expect(readMessage("api", id)).toMatchObject({ state: "delivered" });
  });
});
