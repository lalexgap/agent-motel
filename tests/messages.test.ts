import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { appendFileSync, chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireDeliverLock, cancelMessage, releaseDeliverLock } from "../src/deliver";
import { acquireProducerLock, releaseProducerLock } from "../src/mailbox";
import { ensureDirs } from "../src/paths";
import { queueDepth, queuePopId } from "../src/queue";
import { readAgent, writeAgent, type AgentState } from "../src/state";
import { abortTurn, interruptCommand, sendCommand } from "../src/commands/send";
import { queueCommand } from "../src/commands/queue";
import { renameAgent } from "../src/commands/rename";
import { stopIfIdle } from "../src/commands/rm";
import {
  deliveryMark,
  markDelivered,
  queueTrackedMessage,
  readMessage,
  claimPrompt,
  promptKey,
  recordImmediateDelivery,
  transcriptLength,
  withSettledRecord,
  awaitTurnReply,
  markTurnEnded,
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
// box clears on Enter (mode "submit"); mode "dead" makes the session vanish,
// a `busy` file hides the composer behind a running turn, and a `running`
// file shows an empty composer with the running-turn hint under it. C-u
// empties the input box and returns to mode "submit", unless a `stuck` file
// makes it do nothing, or a `late` file holding N makes it take one word
// off, showing at the Nth capture after the press (a slow redraw of a
// multi-row composer).
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
    if [ -e "$AGENTMGR_HOME/redraw-in" ]; then
      n=$(($(cat "$AGENTMGR_HOME/redraw-in") - 1))
      if [ "$n" -le 0 ]; then rm "$AGENTMGR_HOME/redraw-in"; printf '%s' "$(sed 's/ *[^ ]*$//' "$AGENTMGR_HOME/input")" > "$AGENTMGR_HOME/input"
      else echo "$n" > "$AGENTMGR_HOME/redraw-in"; fi
    fi
    [ -e "$AGENTMGR_HOME/busy" ] && { echo '✻ Working… (esc to interrupt)'; exit 0; }
    echo '────────────────────'
    printf '❯ '; cat "$AGENTMGR_HOME/input"; echo
    echo '────────────────────'
    [ -e "$AGENTMGR_HOME/running" ] && echo '  ⏵⏵ bypass permissions on · esc to interrupt'
    ;;
  send-keys)
    if [ "$4" = '-l' ]; then
      printf '%s' "$6" >> "$AGENTMGR_HOME/input"
      printf '%s\\n' "$6" >> "$AGENTMGR_HOME/typed"
    else
      printf '%s\\n' "$4" >> "$AGENTMGR_HOME/keys"
      [ "$4" = C-u ] && [ -e "$AGENTMGR_HOME/late" ] && cp "$AGENTMGR_HOME/late" "$AGENTMGR_HOME/redraw-in"
      [ "$4" = C-u ] && [ ! -e "$AGENTMGR_HOME/stuck" ] && [ ! -e "$AGENTMGR_HOME/late" ] && { printf '' > "$AGENTMGR_HOME/input"; echo submit > "$AGENTMGR_HOME/mode"; }
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
    const later = (ms: number) => new Date(Date.parse(mark.handedAt) + ms).toISOString();
    writeAgent({ ...agent, status: "idle", promptAt: later(20), promptKey: promptKey("quick one"), statusChangedAt: later(50) });
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

  test("PostToolUse surfacing delivers mid-turn; the running turn's stop finishes it", async () => {
    fakeSession("working");
    const { id } = await sendCommand("api", "mid turn note", { now: false, track: true });
    say("assistant", "working on it");
    expect(hook("post-tool-use")).toContain("mid turn note");
    expect(readMessage("api", id!)).toMatchObject({ state: "delivered", transcriptIndex: 4 });
    hook("stop");
    expect(readMessage("api", id!)!.state).toBe("done");
  });

  test("a --now steer finishes only at a stop after the prompt that took it in", async () => {
    fakeSession("working");
    fastSleep();
    const { id } = await sendCommand("api", "steer one", { now: true, track: true });
    hook("stop");
    expect(readMessage("api", id!)!.state).toBe("delivered");
    hook("post-tool-use");
    hook("stop");
    expect(readMessage("api", id!)!.state).toBe("delivered");
    hook("user-prompt-submit", { prompt: "steer one" });
    hook("stop");
    expect(readMessage("api", id!)!.state).toBe("done");
  });

  test("a stale stop after an interrupt leaves it delivered; the new turn's stop finishes it", async () => {
    fakeSession("working");
    fastSleep();
    const { id } = await interruptCommand("api", "change course", { exact: true, track: true });
    // The new message is the turn's prompt: no Esc-only turn end.
    expect(readAgent("api")!.status).toBe("working");
    hook("stop");
    expect(readMessage("api", id!)!.state).toBe("delivered");
    hook("user-prompt-submit", { prompt: "change course" });
    hook("stop");
    expect(readMessage("api", id!)!.state).toBe("done");
  });

  test("a prompt delivery (Codex queue, typed) is not finished by the earlier turn's stop", () => {
    fakeSession("working");
    const id = queueTrackedMessage("api", "for the next turn");
    const mark = deliveryMark("api", `${id}.json`);
    queuePopId("api", `${id}.json`);
    markDelivered("api", `${id}.json`, mark);
    hook("post-tool-use");
    hook("stop");
    expect(readMessage("api", id)!.state).toBe("delivered");
    hook("user-prompt-submit", { prompt: "for the next turn" });
    hook("stop");
    expect(readMessage("api", id)!.state).toBe("done");
  });

  test("a session that ends before the message's turn finishes fails it", () => {
    fakeSession("working");
    const handled = recordImmediateDelivery("api", { transcriptIndex: 3, handedAt: new Date().toISOString() }, "go");
    hook("user-prompt-submit", { prompt: "go" });
    hook("stop");
    const unhandled = recordImmediateDelivery("api", { transcriptIndex: 3, handedAt: new Date().toISOString() }, "go");
    const midTurn = recordImmediateDelivery("api", { transcriptIndex: 3, handedAt: new Date().toISOString() }, "go");
    hook("user-prompt-submit", { prompt: "go again" });
    hook("session-end");
    expect(readMessage("api", handled)!.state).toBe("done");
    for (const id of [unhandled, midTurn]) {
      expect(readMessage("api", id)).toMatchObject({ state: "failed", error: "session ended before the turn finished", doneAt: null });
    }
  });

  test("a session that ended idle keeps a message its last turn handled", () => {
    fakeSession("working");
    const id = recordImmediateDelivery("api", { transcriptIndex: 3, handedAt: new Date().toISOString() }, "go");
    const agent = readAgent("api")!;
    const later = (ms: number) => new Date(Date.now() + ms).toISOString();
    writeAgent({ ...agent, status: "idle", promptAt: later(10), statusChangedAt: later(20) });
    expect(claimPrompt("api", readAgent("api")!.promptAt!, promptKey("go"))).toBe(id);
    hook("session-end");
    expect(readMessage("api", id)!.state).toBe("done");
  });

  test("one drain marks every tracked message with a single transcript parse", async () => {
    fakeSession("working");
    for (let i = 0; i < 20_000; i++) say(i % 2 ? "assistant" : "user", `line ${i}`);
    const ids = [];
    for (const text of ["a", "b", "c"]) ids.push(queueTrackedMessage("api", text));
    const out = hook("post-tool-use");
    for (const text of ["a", "b", "c"]) expect(out).toContain(text);
    const raw = ids.map((id) => JSON.parse(readFileSync(join(home, "queue", "api", ".messages", `${id}.json`), "utf8")));
    expect(raw.map((r) => r.state)).toEqual(["delivered", "delivered", "delivered"]);
    expect(new Set(raw.map((r) => r.handedAt)).size).toBe(1);
    expect(new Set(raw.map((r) => r.transcriptIndex))).toEqual(new Set([20_003]));
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
    hook("user-prompt-submit", { prompt: "steer" });
    hook("stop");
    expect(readMessage("api", now.id!)!.state).toBe("done");
    expect(readMessage("api", int.id!)!.state).toBe("delivered");
    hook("user-prompt-submit", { prompt: "new plan" });
    hook("stop");
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

    const delivered = recordImmediateDelivery("api", { transcriptIndex: 3, handedAt: new Date().toISOString() }, "go");
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
    expect(await cancelMessage("api", id)).toEqual({ ok: false, error: `message ${id} is being delivered`, state: "queued", reason: "already_delivered" });
    expect(queueDepth("api")).toBe(1);
  });

  test("a session that dies: queued stays queued for a resume, an unfinished delivery fails", async () => {
    fakeSession("working");
    const queued = queueTrackedMessage("api", "after resume");
    const delivered = recordImmediateDelivery("api", { transcriptIndex: 3, handedAt: new Date().toISOString() }, "go");
    writeFileSync(join(home, "mode"), "dead");
    expect(readMessage("api", queued)!.state).toBe("queued");
    expect(queueDepth("api")).toBe(1);
    expect(readMessage("api", delivered)).toMatchObject({ state: "failed", error: "session ended before the turn finished" });
  });

  test("am queue --clear cancels queued messages and fails the unconfirmed in-flight one", async () => {
    fakeSession("working");
    const a = queueTrackedMessage("api", "clear me");
    const b = queueTrackedMessage("api", "typed already");
    writeFileSync(join(home, "queue", "api", ".delivery.pending"), JSON.stringify({ id: `${b}.json`, message: "typed already", typed: true }));
    const log = spyOn(console, "log").mockImplementation(() => {});
    try {
      await queueCommand("api", { clear: true });
    } finally {
      log.mockRestore();
    }
    expect(queueDepth("api")).toBe(0);
    expect(readMessage("api", a)).toMatchObject({ state: "cancelled", error: "queue cleared" });
    expect(readMessage("api", b)).toMatchObject({ state: "failed", error: "queue cleared during an unconfirmed delivery" });
  });

  test("am queue --clear refuses while a delivery holds the mailbox", async () => {
    fakeSession("working");
    const id = queueTrackedMessage("api", "keep me");
    expect(acquireDeliverLock("api")).toBe(true);
    fastSleep();
    let t = Date.now();
    const clock = spyOn(Date, "now").mockImplementation(() => (t += 20_000));
    try {
      await expect(queueCommand("api", { clear: true })).rejects.toThrow('agent "api" mailbox is busy — retry');
    } finally {
      clock.mockRestore();
    }
    expect(queueDepth("api")).toBe(1);
    expect(readMessage("api", id)!.state).toBe("queued");
  });

  test("finished records older than a week are pruned", () => {
    fakeSession("working");
    const dir = join(home, "queue", "api", ".messages");
    const old = recordImmediateDelivery("api", { transcriptIndex: 0, handedAt: new Date().toISOString() }, "go");
    const stale = new Date(Date.now() - 8 * 86_400_000).toISOString();
    writeFileSync(join(dir, `${old}.json`), JSON.stringify({ id: old, state: "done", queuedAt: stale, deliveredAt: stale, doneAt: stale, transcriptIndex: 0 }));
    const fresh = recordImmediateDelivery("api", { transcriptIndex: 0, handedAt: new Date().toISOString() }, "go");
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
    expect(JSON.parse(am("__cancel", "api", id).stdout.toString())).toMatchObject({ reason: "already_cancelled" });
    expect(JSON.parse(am("__interrupt", "api", id).stdout.toString())).toEqual({ ok: false, error: `message ${id} is already cancelled`, state: "cancelled", reason: "already_cancelled" });
    expect(am("__interrupt", "api", "01NOPE").stderr.toString()).toContain('no message "01NOPE"');
    const missing = am("__message", "api", "01NOPE");
    expect(missing.exitCode).toBe(1);
    expect(missing.stderr.toString()).toContain('no message "01NOPE"');
    expect(am("__message", "ghost", id).stderr.toString()).toContain("no local agent");
  });

  test("Codex-style queue adds start in order: each prompt finishes only its own message", () => {
    fakeSession("working");
    const deliver = (text: string) => {
      const id = queueTrackedMessage("api", text);
      const mark = deliveryMark("api", `${id}.json`);
      queuePopId("api", `${id}.json`);
      markDelivered("api", `${id}.json`, mark);
      return id;
    };
    const first = deliver("one");
    const second = deliver("two");
    hook("stop");
    expect([readMessage("api", first)!.state, readMessage("api", second)!.state]).toEqual(["delivered", "delivered"]);
    hook("user-prompt-submit", { prompt: "one" });
    hook("stop");
    expect([readMessage("api", first)!.state, readMessage("api", second)!.state]).toEqual(["done", "delivered"]);
    hook("user-prompt-submit", { prompt: "two" });
    hook("stop");
    expect(readMessage("api", second)!.state).toBe("done");
  });

  test("a typed delivery confirmed after its UserPromptSubmit still claims that prompt", () => {
    fakeSession("working");
    const id = queueTrackedMessage("api", "typed");
    const mark = deliveryMark("api", `${id}.json`);
    // The deliverer holds the lock while it waits for the input box to clear.
    expect(acquireDeliverLock("api")).toBe(true);
    hook("user-prompt-submit", { prompt: "typed" });
    queuePopId("api", `${id}.json`);
    markDelivered("api", `${id}.json`, mark);
    releaseDeliverLock("api");
    expect(readMessage("api", id)!.state).toBe("delivered");
    hook("stop");
    expect(readMessage("api", id)!.state).toBe("done");
  });

  test("a repeated UserPromptSubmit (Claude's put-back) restarts the same message and starts no other", () => {
    fakeSession("working");
    const first = recordImmediateDelivery("api", { transcriptIndex: 3, handedAt: new Date().toISOString() }, "go");
    const other = recordImmediateDelivery("api", { transcriptIndex: 3, handedAt: new Date().toISOString() }, "other");
    hook("user-prompt-submit", { prompt: "go" });
    hook("user-prompt-submit", { prompt: "go" });
    const raw = (id: string) => JSON.parse(readFileSync(join(home, "queue", "api", ".messages", `${id}.json`), "utf8"));
    expect(raw(first).startedAt).toBe(readAgent("api")!.promptAt);
    expect(raw(other).startedAt).toBeUndefined();
    hook("stop");
    expect([readMessage("api", first)!.state, readMessage("api", other)!.state]).toEqual(["done", "delivered"]);
  });

  test("a prompt with other text ahead of a tracked message doesn't start it; whitespace doesn't matter", () => {
    fakeSession("working");
    const id = recordImmediateDelivery("api", { transcriptIndex: 3, handedAt: new Date().toISOString() }, "fix   the\nbuild ");
    hook("user-prompt-submit", { prompt: "something the operator typed" });
    hook("stop");
    expect(readMessage("api", id)!.state).toBe("delivered");
    hook("user-prompt-submit", { prompt: "fix the build" });
    hook("stop");
    expect(readMessage("api", id)!.state).toBe("done");
  });

  test("a long paste, which Claude wraps in pasted_content tags, still starts its message", () => {
    fakeSession("working");
    const body = "line one\nline two\n";
    const id = recordImmediateDelivery("api", { transcriptIndex: 0, handedAt: new Date().toISOString() }, body);
    hook("user-prompt-submit", { prompt: `\n\n<pasted_content id="9aed">\n${body}</pasted_content id="9aed">\n\n` });
    hook("stop");
    expect(readMessage("api", id)!.state).toBe("done");
  });

  test("a typed delivery confirmed after another prompt's UserPromptSubmit stays unstarted", () => {
    fakeSession("working");
    const id = queueTrackedMessage("api", "typed");
    const mark = deliveryMark("api", `${id}.json`);
    // The deliverer holds the lock while it waits for the input box to clear.
    expect(acquireDeliverLock("api")).toBe(true);
    hook("user-prompt-submit", { prompt: "not it" });
    queuePopId("api", `${id}.json`);
    markDelivered("api", `${id}.json`, mark);
    releaseDeliverLock("api");
    hook("stop");
    expect(readMessage("api", id)!.state).toBe("delivered");
  });

  test("an inbox delivery is started by the prompt that confirmed it", () => {
    fakeSession("working");
    const id = queueTrackedMessage("api", "[am · from web] ping");
    const mark = deliveryMark("api", `${id}.json`);
    writeFileSync(join(home, "queue", "api", ".delivery.pending"), JSON.stringify({
      id: `${id}.json`, message: "[am · from web] ping", via: "inbox", sentAt: Date.now(), mark,
    }));
    hook("user-prompt-submit", { prompt: "Another Claude session sent a message:\n[am · from web] ping" });
    const raw = JSON.parse(readFileSync(join(home, "queue", "api", ".messages", `${id}.json`), "utf8"));
    expect(raw).toMatchObject({ state: "delivered", via: "prompt", startedAt: readAgent("api")!.promptAt });
    expect(queueDepth("api")).toBe(0);
    hook("stop");
    expect(readMessage("api", id)!.state).toBe("done");
  });

  test("a record from before prompt claims (no via) still finishes at a later prompt's stop", () => {
    fakeSession("working");
    const id = recordImmediateDelivery("api", { transcriptIndex: 3, handedAt: new Date().toISOString() }, "go");
    const file = join(home, "queue", "api", ".messages", `${id}.json`);
    const { via: _via, ...legacy } = JSON.parse(readFileSync(file, "utf8"));
    writeFileSync(file, JSON.stringify(legacy));
    hook("user-prompt-submit", { prompt: "go" });
    hook("stop");
    expect(readMessage("api", id)!.state).toBe("done");
  });

  test("a turn end the hooks have not marked yet is settled inside the records lock", () => {
    fakeSession("working");
    const id = recordImmediateDelivery("api", { transcriptIndex: 3, handedAt: new Date().toISOString() }, "go");
    const later = (ms: number) => new Date(Date.now() + ms).toISOString();
    writeAgent({ ...readAgent("api")!, status: "idle", promptAt: later(10), statusChangedAt: later(20) });
    expect(claimPrompt("api", readAgent("api")!.promptAt!, promptKey("go"))).toBe(id);
    expect(withSettledRecord("api", id, (r) => r.state)).toBe("done");
    const raw = JSON.parse(readFileSync(join(home, "queue", "api", ".messages", `${id}.json`), "utf8"));
    expect(raw.state).toBe("done");
    expect(withSettledRecord("api", "01NOPE", (r) => r.state)).toBeNull();
  });

  test("rename carries the records", async () => {
    const now = new Date().toISOString();
    writeAgent({ name: "alpha", status: "exited", dir: "/tmp", tmuxSession: "agentmgr-alpha", createdAt: now, updatedAt: now });
    const id = recordImmediateDelivery("alpha", { transcriptIndex: 7, handedAt: now }, "go");
    await renameAgent("alpha", "omega");
    expect(readMessage("alpha", id)).toBeNull();
    expect(readMessage("omega", id)).toMatchObject({ id, transcriptIndex: 7 });
  });
});

describe("done waits for the reply on disk", () => {
  // A message delivered at index 3 whose turn has started; returns its id.
  async function turnRunning(): Promise<string> {
    fakeSession("idle");
    fastSleep();
    const { id } = await sendCommand("api", "check it", { now: false, track: true });
    sleepSpy?.mockRestore();
    sleepSpy = undefined;
    hook("user-prompt-submit", { prompt: "check it" });
    say("user", "check it");
    return id!;
  }

  test("a reply already flushed: done at once, transcriptComplete true", async () => {
    const id = await turnRunning();
    say("assistant", "All   done:\nit works.");
    const started = Date.now();
    hook("stop", { last_assistant_message: "All done: it works." });
    expect(Date.now() - started).toBeLessThan(1500);
    expect(readMessage("api", id)).toMatchObject({ state: "done", transcriptComplete: true });
  });

  test("a reply of several text blocks matches their run", async () => {
    const id = await turnRunning();
    say("assistant", "Part one.");
    say("assistant", "Part two.");
    expect(await awaitTurnReply("api", readAgent("api")!, "Part one.\n\nPart two.", new Date(), { capMs: 0 })).toBe(true);
    expect(readMessage("api", id)!.state).toBe("delivered");
  });

  test("a reply flushed after 500ms: done after it lands", async () => {
    await turnRunning();
    const started = Date.now();
    setTimeout(() => say("assistant", "Found it."), 500);
    const complete = await awaitTurnReply("api", readAgent("api")!, "Found it.");
    const waited = Date.now() - started;
    expect(complete).toBe(true);
    expect(waited).toBeGreaterThanOrEqual(450);
    expect(waited).toBeLessThan(1500);
  });

  test("a reply never flushed: done after the cap, transcriptComplete false", async () => {
    const id = await turnRunning();
    const started = Date.now();
    hook("stop", { last_assistant_message: "This never reaches disk." });
    const waited = Date.now() - started;
    expect(waited).toBeGreaterThanOrEqual(2900);
    expect(waited).toBeLessThan(6000);
    const done = readMessage("api", id)!;
    expect(done).toMatchObject({ state: "done", transcriptComplete: false });
    expect(readAgent("api")!.status).toBe("idle");
  }, 15_000);

  test("an earlier entry of the same turn does not satisfy the match", async () => {
    await turnRunning();
    say("assistant", "Let me check…");
    const started = Date.now();
    const complete = await awaitTurnReply("api", readAgent("api")!, "The answer is 42.", new Date(), { capMs: 400 });
    expect(complete).toBe(false);
    expect(Date.now() - started).toBeGreaterThanOrEqual(350);
  });

  test("the reply before the receipt's transcriptIndex does not count", async () => {
    await turnRunning();
    expect(await awaitTurnReply("api", readAgent("api")!, "one", new Date(), { capMs: 0 })).toBe(false);
  });

  test("no reply text (an interrupt, a tool-only turn) skips the wait and leaves the field off", async () => {
    const id = await turnRunning();
    const started = Date.now();
    expect(await awaitTurnReply("api", readAgent("api")!, undefined)).toBeUndefined();
    expect(await awaitTurnReply("api", readAgent("api")!, "  ")).toBeUndefined();
    expect(Date.now() - started).toBeLessThan(100);
    markTurnEnded("api", readAgent("api")!, new Date(), true);
    const done = readMessage("api", id)!;
    expect(done).toMatchObject({ state: "done", interrupted: true });
    expect(done.transcriptComplete).toBeUndefined();
  });

  test("a stop without a reply in its payload goes done at once, without the field", async () => {
    const id = await turnRunning();
    hook("stop");
    const done = readMessage("api", id)!;
    expect(done.state).toBe("done");
    expect(done.transcriptComplete).toBeUndefined();
  });

  test("no receipt finishing: no wait, no transcript parse", async () => {
    fakeSession("working");
    expect(await awaitTurnReply("api", readAgent("api")!, "anything")).toBeUndefined();
  });
});

describe("stop ifIdle after an untracked handover", () => {
  const handedOver = { ok: false, reason: "in_turn", error: 'agent "api" was handed a message it has not started on yet' } as const;
  const stop = () => stopIfIdle(readAgent("api")!);
  const nextTurn = (prompt: string) => {
    hook("user-prompt-submit", { prompt });
    hook("stop");
  };

  test("a --now steer refuses the stop until the agent's next idle", async () => {
    fakeSession("idle");
    fastSleep();
    expect((await sendCommand("api", "steer one", { now: true })).id).toBeNull();
    expect(await stop()).toEqual(handedOver);
    nextTurn("steer one");
    expect(await stop()).toEqual({ ok: true });
    expect(readAgent("api")!.status).toBe("exited");
  });

  test("an interrupt refuses the stop until the agent's next idle", async () => {
    fakeSession("idle");
    fastSleep();
    expect((await interruptCommand("api", "change course", { exact: true })).id).toBeNull();
    expect(await stop()).toEqual(handedOver);
    nextTurn("change course");
    expect(await stop()).toEqual({ ok: true });
  });

  // The hook marks the agent working as it drains, so the stop is refused as
  // busy until the turn the drain fed ends; that end shows the agent took it.
  test("a Stop gate drain holds the stop until the turn it fed ends", async () => {
    fakeSession("working");
    await sendCommand("api", "while you were busy", { now: false });
    expect(JSON.parse(hook("stop")).decision).toBe("block");
    expect(readAgent("api")!.lastHandoffInTurn).toBe(true);
    expect(await stop()).toMatchObject({ ok: false, reason: "busy" });
    expect(hook("stop")).toBe("");
    expect(await stop()).toEqual({ ok: true });
  });

  test.each(["user-prompt-submit", "post-tool-use"])("a %s inbox drain holds the stop until that turn ends", async (event) => {
    fakeSession("working");
    await sendCommand("api", `note for ${event}`, { now: false });
    expect(hook(event, { prompt: "other" })).toContain(`note for ${event}`);
    expect(await stop()).toMatchObject({ ok: false, reason: "busy" });
    hook("stop");
    expect(await stop()).toEqual({ ok: true });
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
    expect(await again.json()).toEqual({ error: `message ${id} is already cancelled`, state: "cancelled", reason: "already_cancelled" });

    const steer = (await (await call("/api/agents/api/messages", { method: "POST", body: JSON.stringify({ text: "now", mode: "now" }) })).json()) as any;
    expect(steer).toMatchObject({ ok: true, mode: "now" });
    const late = await call(`/api/agents/api/messages/${steer.id}`, { method: "DELETE" });
    expect(late.status).toBe(409);
    expect(await late.json()).toEqual({ error: `message ${steer.id} is already delivered`, state: "delivered", reason: "already_delivered" });

    expect((await call("/api/agents/api/messages/NOPE")).status).toBe(404);
    expect((await call("/api/agents/api/messages/NOPE", { method: "DELETE" })).status).toBe(404);
    expect((await call(`/api/agents/ghost/messages/${id}`)).status).toBe(404);
    expect((await call("/api/agents/ghost/messages", { method: "POST", body: JSON.stringify({ text: "x" }) })).status).toBe(404);
  });

  test("GET on a stopped agent leaves a queued message queued", async () => {
    fakeSession("working");
    const posted = (await (await call("/api/agents/api/messages", { method: "POST", body: JSON.stringify({ text: "later" }) })).json()) as any;
    writeFileSync(join(home, "mode"), "dead");
    const got = (await (await call(`/api/agents/api/messages/${posted.id}`)).json()) as any;
    expect(got).toMatchObject({ id: posted.id, state: "queued" });
    expect(queueDepth("api")).toBe(1);
  });

  test("health and local detail report messageReceipts and stopIfIdle", async () => {
    fakeSession("idle");
    expect(await (await call("/api/health")).json()).toEqual({ ok: true, name: "am", messageReceipts: true, stopIfIdle: true });
    expect(((await (await call("/api/agents/api")).json()) as any).messageReceipts).toBe(true);
  });

  describe("interrupt by messageId", () => {
    const keys = () => (existsSync(join(home, "keys")) ? readFileSync(join(home, "keys"), "utf8") : "");
    const interrupt = (body: unknown) => call("/api/agents/api/interrupt", { method: "POST", body: JSON.stringify(body) });

    test("refused before its turn starts; one Esc once started; refused once done", async () => {
      fakeSession("working");
      const id = recordImmediateDelivery("api", { transcriptIndex: 3, handedAt: new Date().toISOString() }, "go");
      const early = await interrupt({ messageId: id });
      expect(early.status).toBe(409);
      expect(await early.json()).toEqual({ error: `message ${id} has not started yet`, state: "delivered", reason: "not_started" });
      expect(keys()).toBe("");

      hook("user-prompt-submit", { prompt: "go" });
      // The pane never gets back to its prompt, so the turn is left running.
      writeFileSync(join(home, "busy"), "");
      fastSleep();
      const log = spyOn(console, "error").mockImplementation(() => {});
      let ok: Response;
      let logged: unknown[][];
      try {
        ok = await interrupt({ messageId: id });
      } finally {
        logged = [...log.mock.calls];
        log.mockRestore();
      }
      expect(ok.status).toBe(200);
      expect(await ok.json()).toEqual({ ok: true });
      expect(logged).toEqual([['am: "api" did not return to its prompt after Esc; leaving it as it is']]);
      expect(keys()).toBe("Escape\n");
      expect(readAgent("api")!.status).toBe("working");
      const again = await interrupt({ messageId: id });
      expect(again.status).toBe(409);
      expect(await again.json()).toEqual({ error: `message ${id} was already interrupted`, state: "delivered", reason: "already_interrupted" });
      expect(keys()).toBe("Escape\n");
      expect(Object.keys(readMessage("api", id)!).sort()).toEqual(["deliveredAt", "doneAt", "id", "queuedAt", "state", "transcriptIndex"]);

      rmSync(join(home, "keys"));
      hook("stop");
      const done = await interrupt({ messageId: id });
      expect(done.status).toBe(409);
      expect(await done.json()).toEqual({ error: `message ${id} is already done`, state: "done", reason: "already_done" });
      expect(keys()).toBe("");
    });

    test("Esc-only: back at its prompt, the turn ends interrupted, the queue drains, a late Stop is ignored", async () => {
      fakeSession("working");
      fastSleep();
      const id = recordImmediateDelivery("api", { transcriptIndex: 3, handedAt: new Date().toISOString() }, "go");
      hook("user-prompt-submit", { prompt: "go" });
      const next = queueTrackedMessage("api", "next one");

      const ok = await interrupt({ messageId: id });
      expect(ok.status).toBe(200);
      const interrupted = (await (await call(`/api/agents/api/messages/${id}`)).json()) as any;
      expect(interrupted).toMatchObject({ id, state: "done", interrupted: true });
      expect(interrupted.doneAt).not.toBeNull();
      expect(interrupted.transcriptComplete).toBeUndefined();
      const agent = readAgent("api")!;
      expect(agent.status).toBe("idle");
      expect(agent.workingSince).toBeUndefined();
      expect(queueDepth("api")).toBe(0);
      expect(readFileSync(join(home, "typed"), "utf8")).toBe("next one\n");
      expect(readMessage("api", next)).toMatchObject({ state: "delivered" });

      // A provider that does fire a Stop for the aborted turn, after the next
      // message was handed over: it neither re-finishes the interrupted
      // message nor finishes the next one, whose prompt hasn't come yet.
      hook("stop");
      expect(readMessage("api", id)).toEqual(interrupted);
      expect(readMessage("api", next)).toMatchObject({ state: "delivered" });
      const repeat = await interrupt({ messageId: id });
      expect(await repeat.json()).toMatchObject({ state: "done", reason: "already_done" });

      hook("user-prompt-submit", { prompt: "next one" });
      hook("stop");
      const finished = readMessage("api", next)!;
      expect(finished.state).toBe("done");
      expect(finished.interrupted).toBeUndefined();
    });

    test("Esc-only before the turn gets going: the prompt Claude puts back is cleared, and the queue drains", async () => {
      fakeSession("working");
      fastSleep();
      const id = recordImmediateDelivery("api", { transcriptIndex: 3, handedAt: new Date().toISOString() }, "go  slowly");
      hook("user-prompt-submit", { prompt: "go  slowly" });
      const next = queueTrackedMessage("api", "next one");
      writeFileSync(join(home, "mode"), "keep");
      writeFileSync(join(home, "input"), "go slowly");

      expect((await interrupt({ messageId: id })).status).toBe(200);
      expect(readMessage("api", id)).toMatchObject({ state: "done", interrupted: true });
      expect(readAgent("api")!.status).toBe("idle");
      expect(readFileSync(join(home, "keys"), "utf8")).toBe("Escape\nC-u\nEnter\n");
      expect(readMessage("api", next)).toMatchObject({ state: "delivered" });
    });

    test("a put-back prompt Ctrl+U doesn't shorten gets two presses, not one per poll", async () => {
      fakeSession("working");
      fastSleep();
      const id = recordImmediateDelivery("api", { transcriptIndex: 3, handedAt: new Date().toISOString() }, "go");
      hook("user-prompt-submit", { prompt: "go" });
      writeFileSync(join(home, "mode"), "keep");
      writeFileSync(join(home, "input"), "go");
      writeFileSync(join(home, "stuck"), "");

      const log = spyOn(console, "error").mockImplementation(() => {});
      try {
        expect((await interrupt({ messageId: id })).status).toBe(200);
      } finally {
        log.mockRestore();
      }
      expect(keys()).toBe("Escape\nC-u\nC-u\n");
      expect(readMessage("api", id)).toMatchObject({ state: "delivered" });
      expect(readAgent("api")!.status).toBe("working");
    });

    test("a put-back prompt the TUI is slow to redraw after Ctrl+U is still cleared, and the turn ends", async () => {
      fakeSession("working");
      fastSleep();
      const id = recordImmediateDelivery("api", { transcriptIndex: 3, handedAt: new Date().toISOString() }, "go on slowly");
      hook("user-prompt-submit", { prompt: "go on slowly" });
      writeFileSync(join(home, "mode"), "keep");
      writeFileSync(join(home, "input"), "go on slowly");
      writeFileSync(join(home, "late"), "4");

      expect((await interrupt({ messageId: id })).status).toBe(200);
      expect(keys()).toBe("Escape\nC-u\nC-u\nC-u\n");
      expect(readMessage("api", id)).toMatchObject({ state: "done", interrupted: true });
      expect(readAgent("api")!.status).toBe("idle");
    });

    test("a late hook for the aborted prompt doesn't keep its turn from ending", async () => {
      fakeSession("working");
      fastSleep();
      hook("user-prompt-submit", { prompt: "earlier" });
      // Handed over just before the Esc; its hook lands after it.
      recordImmediateDelivery("api", { transcriptIndex: 3, handedAt: new Date().toISOString() }, "go");
      const inner = spawnSpy!.getMockImplementation()!;
      let fired = false;
      spawnSpy!.mockImplementation((cmd: any, opts?: any) => {
        const result = inner(cmd, opts);
        if (!fired && Array.isArray(cmd) && cmd[0] === "tmux" && cmd[1] === "capture-pane" && keys()) {
          fired = true;
          Bun.sleepSync(5);
          hook("user-prompt-submit", { prompt: "go" });
        }
        return result;
      });
      const log = spyOn(console, "log").mockImplementation(() => {});
      try {
        await abortTurn("api");
      } finally {
        log.mockRestore();
      }
      expect(fired).toBe(true);
      expect(readAgent("api")!.status).toBe("idle");
    });

    test("Esc-only with other text in the composer leaves the turn running", async () => {
      fakeSession("working");
      fastSleep();
      const id = recordImmediateDelivery("api", { transcriptIndex: 3, handedAt: new Date().toISOString() }, "go");
      hook("user-prompt-submit", { prompt: "go" });
      writeFileSync(join(home, "mode"), "keep");
      writeFileSync(join(home, "input"), "something else");

      const log = spyOn(console, "error").mockImplementation(() => {});
      try {
        expect((await interrupt({ messageId: id })).status).toBe(200);
      } finally {
        log.mockRestore();
      }
      expect(readMessage("api", id)).toMatchObject({ state: "delivered" });
      expect(readAgent("api")!.status).toBe("working");
    });

    test("am interrupt / POST interrupt with no text end the Esc'd turn too", async () => {
      fakeSession("working");
      fastSleep();
      const first = recordImmediateDelivery("api", { transcriptIndex: 3, handedAt: new Date().toISOString() }, "go");
      hook("user-prompt-submit", { prompt: "go" });
      const log = spyOn(console, "log").mockImplementation(() => {});
      try {
        await abortTurn("api");
      } finally {
        log.mockRestore();
      }
      expect(readMessage("api", first)).toMatchObject({ state: "done", interrupted: true });
      expect(readAgent("api")!.status).toBe("idle");

      const second = recordImmediateDelivery("api", { transcriptIndex: 3, handedAt: new Date().toISOString() }, "again");
      hook("user-prompt-submit", { prompt: "again" });
      expect(readAgent("api")!.status).toBe("working");
      const res = await call("/api/agents/api/interrupt", { method: "POST" });
      expect(res.status).toBe(200);
      expect(readMessage("api", second)).toMatchObject({ state: "done", interrupted: true });
      expect(readAgent("api")!.status).toBe("idle");
    });

    test("a prompt that lands after the pane check keeps its turn running", async () => {
      fakeSession("working");
      fastSleep();
      const id = recordImmediateDelivery("api", { transcriptIndex: 3, handedAt: new Date().toISOString() }, "go");
      hook("user-prompt-submit", { prompt: "go" });
      const next = recordImmediateDelivery("api", { transcriptIndex: 3, handedAt: new Date(Date.now() + 1).toISOString() }, "next");
      const inner = spawnSpy!.getMockImplementation()!;
      let fired = false;
      spawnSpy!.mockImplementation((cmd: any, opts?: any) => {
        const result = inner(cmd, opts);
        if (!fired && Array.isArray(cmd) && cmd[0] === "tmux" && cmd[1] === "capture-pane" && keys()) {
          fired = true;
          Bun.sleepSync(5);
          hook("user-prompt-submit", { prompt: "next" });
        }
        return result;
      });

      expect((await interrupt({ messageId: id })).status).toBe(200);
      expect(fired).toBe(true);
      expect(readAgent("api")!.status).toBe("working");
      expect(readMessage("api", next)).toMatchObject({ state: "delivered" });
      hook("stop");
      expect(readMessage("api", next)).toMatchObject({ state: "done" });
      expect(readMessage("api", id)).toMatchObject({ state: "done" });
    });

    test("an empty composer that still shows a running turn is not ended", async () => {
      fakeSession("working");
      fastSleep();
      const id = recordImmediateDelivery("api", { transcriptIndex: 3, handedAt: new Date().toISOString() }, "go");
      hook("user-prompt-submit", { prompt: "go" });
      writeFileSync(join(home, "running"), "");
      const log = spyOn(console, "error").mockImplementation(() => {});
      try {
        expect((await interrupt({ messageId: id })).status).toBe(200);
      } finally {
        log.mockRestore();
      }
      expect(readMessage("api", id)).toMatchObject({ state: "delivered" });
      expect(readAgent("api")!.status).toBe("working");
    });

    test("an unrelated prompt doesn't make it interruptible", async () => {
      fakeSession("working");
      const id = recordImmediateDelivery("api", { transcriptIndex: 3, handedAt: new Date().toISOString() }, "go");
      hook("user-prompt-submit", { prompt: "something else" });
      const res = await interrupt({ messageId: id });
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ error: `message ${id} has not started yet`, state: "delivered", reason: "not_started" });
      expect(keys()).toBe("");
    });

    test("a turn that ended but is not marked yet is done, and gets no Esc", async () => {
      fakeSession("working");
      const id = recordImmediateDelivery("api", { transcriptIndex: 3, handedAt: new Date().toISOString() }, "go");
      const later = (ms: number) => new Date(Date.now() + ms).toISOString();
      writeAgent({ ...readAgent("api")!, status: "idle", promptAt: later(10), statusChangedAt: later(20) });
    expect(claimPrompt("api", readAgent("api")!.promptAt!, promptKey("go"))).toBe(id);
      const res = await interrupt({ messageId: id });
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ error: `message ${id} is already done`, state: "done", reason: "already_done" });
      expect(keys()).toBe("");
      expect(readMessage("api", id)!.state).toBe("done");
    });

    test("queued → 409; unknown or malformed id → 404; bad bodies → 400", async () => {
      fakeSession("working");
      const id = queueTrackedMessage("api", "not yet");
      const queued = await interrupt({ messageId: id });
      expect(queued.status).toBe(409);
      expect(await queued.json()).toEqual({ error: `message ${id} is not delivered yet`, state: "queued", reason: "not_delivered" });
      const missing = await interrupt({ messageId: "01NOPE" });
      expect(missing.status).toBe(404);
      expect(await missing.json()).toEqual({ error: 'no message "01NOPE" for agent "api"' });
      expect((await interrupt({ messageId: "a.b" })).status).toBe(404);
      const both = await interrupt({ messageId: id, text: "hi" });
      expect(both.status).toBe(400);
      expect(await both.json()).toEqual({ error: "messageId and text are mutually exclusive" });
      expect((await interrupt({ messageId: 5 })).status).toBe(400);
      expect(keys()).toBe("");
      expect(queueDepth("api")).toBe(1);
    });

    test("busy while a delivery holds the lock", async () => {
      fakeSession("working");
      const id = recordImmediateDelivery("api", { transcriptIndex: 3, handedAt: new Date().toISOString() }, "go");
      expect(acquireDeliverLock("api")).toBe(true);
      fastSleep();
      let t = Date.now();
      const clock = spyOn(Date, "now").mockImplementation(() => (t += 20_000));
      let res: Response;
      try {
        res = await interrupt({ messageId: id });
      } finally {
        clock.mockRestore();
      }
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ error: 'agent "api" mailbox is busy — retry', state: "delivered", reason: "mailbox_busy" });
      expect(keys()).toBe("");
    });
  });
});
