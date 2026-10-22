import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { peerTarget, sendPeerMessage } from "../src/claudePeer";
import { confirmInboxDelivery, deliverNext, finishConfirmedDelivery, pendingDeliveryId, releaseDeliverLock } from "../src/deliver";
import { ensureDirs, queueDir } from "../src/paths";
import { queueAppend, queueDepth } from "../src/queue";
import { readAgent, writeAgent, type AgentState } from "../src/state";
import { promptKey, queueTrackedMessage, readMessage, recordImmediateDelivery } from "../src/messages";

let home: string;
let sessions: string;
let server: Server | undefined;
let frames: Record<string, unknown>[];
let oldPath: string | undefined;
let spawnSpy: ReturnType<typeof spyOn> | undefined;
const socketPath = () => join(home, "inbox.sock");

const agent = (over: Partial<AgentState> = {}): AgentState => ({
  name: "api", provider: "claude", status: "idle", tmuxSession: "agentmgr-api", dir: home,
  createdAt: "now", updatedAt: "now", peerInboxSession: "sess-1", ...over,
});

function registry(file: string, entry: Record<string, unknown>) {
  writeFileSync(join(sessions, file), JSON.stringify(entry));
}

function liveEntry(over: Record<string, unknown> = {}) {
  registry(`${process.pid}.json`, {
    pid: process.pid, sessionId: "sess-1", kind: "interactive", status: "idle",
    tmux: "agentmgr-api:@7.%7", messagingSocketPath: socketPath(), ...over,
  });
}

// Fake inbox: records frames; `confirm` plays the UserPromptSubmit hook.
function listen(confirm: boolean): Promise<void> {
  frames = [];
  return new Promise((resolve) => {
    server = createServer((socket) => {
      let data = "";
      socket.on("data", (chunk) => { data += chunk; });
      socket.on("end", () => {
        for (const line of data.split("\n").filter(Boolean)) {
          const frame = JSON.parse(line);
          frames.push(frame);
          if (confirm && frame.type === "user") confirmInboxDelivery("api", frame.message.content);
        }
      });
    });
    server.listen(socketPath(), resolve);
  });
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "am-peer-"));
  process.env.AGENTMGR_HOME = home;
  process.env.CLAUDE_CONFIG_DIR = join(home, "claude");
  sessions = join(home, "claude", "sessions");
  mkdirSync(sessions, { recursive: true });
  ensureDirs();
  oldPath = process.env.PATH;
  writeFileSync(join(home, "tmux"), `#!/bin/sh
case "$1" in
  has-session) exit 0 ;;
  display-message) echo '%7' ;;
  capture-pane)
    echo '────────────────────'; printf '❯ '; cat "$AGENTMGR_HOME/input" 2>/dev/null; echo
    echo '────────────────────' ;;
  send-keys) [ "$4" = '-l' ] && echo text >> "$AGENTMGR_HOME/sends" || { echo enter >> "$AGENTMGR_HOME/sends"; }
    ;;
esac
exit 0
`);
  chmodSync(join(home, "tmux"), 0o755);
  const spawn = Bun.spawnSync.bind(Bun);
  spawnSpy = spyOn(Bun, "spawnSync").mockImplementation((cmd: any, opts?: any) =>
    Array.isArray(cmd) && cmd[0] === "tmux"
      ? spawn([join(home, "tmux"), ...cmd.slice(1)], { ...opts, env: { ...process.env } })
      : spawn(cmd, opts));
});

afterEach(async () => {
  spawnSpy?.mockRestore();
  releaseDeliverLock("api");
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = undefined;
  process.env.PATH = oldPath;
  delete process.env.AGENTMGR_HOME;
  delete process.env.CLAUDE_CONFIG_DIR;
  rmSync(home, { recursive: true, force: true });
});

const typed = () => existsSync(join(home, "sends")) && readFileSync(join(home, "sends"), "utf8").includes("text");

describe("peerTarget", () => {
  test("matches the live registry entry in the agent's pane and session", () => {
    registry("1.json", { pid: 1, sessionId: "sess-1", kind: "interactive", tmux: "x:@1.%1", messagingSocketPath: "/nope" });
    registry("999999.json", { pid: 999999, sessionId: "sess-1", kind: "interactive", tmux: "agentmgr-api:@7.%7", messagingSocketPath: "/dead" });
    liveEntry();
    expect(peerTarget(agent())).toEqual({ pid: process.pid, sessionId: "sess-1", socketPath: socketPath() });
  });

  test("requires a session launched with inbound accepted, and the same session id", () => {
    liveEntry();
    expect(peerTarget(agent({ peerInboxSession: undefined }))).toBeNull();
    expect(peerTarget(agent({ peerInboxSession: "sess-2" }))).toBeNull();
  });

  test("skips a session that is mid-turn", () => {
    liveEntry({ status: "busy" });
    expect(peerTarget(agent())).toBeNull();
  });
});

describe("sendPeerMessage", () => {
  test("authenticates when a key exists and targets the session", async () => {
    await listen(false);
    writeFileSync(join(sessions, `${process.pid}.abc.key`), JSON.stringify({ peerToken: "tok" }));
    await sendPeerMessage({ pid: process.pid, sessionId: "sess-1", socketPath: socketPath() }, "hello", "m1");
    await Bun.sleep(50);
    expect(frames[0]).toEqual({ type: "auth", token: "tok" });
    expect(frames[1]).toMatchObject({ type: "user", message: { role: "user", content: "hello" }, session_id: "sess-1", msg_id: "m1" });
  });

  test("rejects when nothing listens", async () => {
    await expect(sendPeerMessage({ pid: 1, sessionId: "s", socketPath: socketPath() }, "hi", "m")).rejects.toThrow();
  });
});

describe("inbox delivery", () => {
  test("a confirmed peer message leaves the queue without touching the pane", async () => {
    writeAgent(agent());
    liveEntry();
    await listen(true);
    const id = queueAppend("api", "[am · from web] ping");
    expect(await deliverNext("api")).toEqual({ status: "submitted", id });
    expect(queueDepth("api")).toBe(0);
    expect(typed()).toBe(false);
    expect(frames.find((f) => f.type === "user")).toMatchObject({ message: { content: "[am · from web] ping" } });
  });

  test("operator messages go through the inbox with a tagged marker the hook can verify", async () => {
    writeAgent(agent());
    liveEntry();
    await listen(false);
    const id = queueAppend("api", "operator note");
    await deliverNext("api");
    expect(typed()).toBe(false);
    const content: string = (frames.find((f: any) => f.type === "user") as any).message.content;
    const tag = /^\[am · operator message ([0-9a-f]{16})\] operator note$/.exec(content)?.[1];
    expect(tag).toBeDefined();
    expect(confirmInboxDelivery("api", `Another Claude session sent a message:\n${content}`)).toBe(tag!);
    expect(finishConfirmedDelivery("api", id)).toBe(true);
  }, 20_000);

  test("an operator message falls back to typing without the marker", async () => {
    writeAgent(agent());
    liveEntry();
    queueAppend("api", "operator note");
    await deliverNext("api");
    expect(typed()).toBe(true);
  });

  test("an unreachable socket falls back to typing", async () => {
    writeAgent(agent());
    liveEntry();
    queueAppend("api", "[am · from web] ping");
    await deliverNext("api");
    expect(typed()).toBe(true);
  });

  test("an unconfirmed send waits, then is typed once instead of resent", async () => {
    writeAgent(agent());
    liveEntry();
    await listen(false);
    const id = queueAppend("api", "[am · from web] ping");
    expect(await deliverNext("api")).toEqual({ status: "queued", reason: "unverified" });
    expect(pendingDeliveryId("api")).toBe(id);
    expect(await deliverNext("api")).toEqual({ status: "queued", reason: "unverified" });
    expect(frames.filter((f) => f.type === "user")).toHaveLength(1);
    expect(typed()).toBe(false);

    const marker = join(queueDir(), "api", ".delivery.pending");
    writeFileSync(marker, JSON.stringify({ ...JSON.parse(readFileSync(marker, "utf8")), sentAt: 0 }));
    await deliverNext("api");
    expect(frames.filter((f) => f.type === "user")).toHaveLength(1);
    expect(typed()).toBe(true);
  }, 20_000);

  test("a pending marker from before `content` existed still confirms a peer send", () => {
    const id = queueAppend("api", "[am · from web] ping");
    writeFileSync(join(queueDir(), "api", ".delivery.pending"), JSON.stringify({ id, message: "[am · from web] ping", via: "inbox", sentAt: Date.now() }));
    expect(confirmInboxDelivery("api", "Another Claude session sent a message:\n[am · from web] ping")).toBeNull();
    expect(finishConfirmedDelivery("api", id)).toBe(true);
  });

  test("a late confirmation retires the message for hook drains", async () => {
    writeAgent(agent());
    liveEntry();
    await listen(false);
    const id = queueAppend("api", "[am · from web] ping");
    await deliverNext("api");
    expect(finishConfirmedDelivery("api", id)).toBe(false);
    confirmInboxDelivery("api", "Another Claude session sent a message:\n[am · from web] ping");
    expect(finishConfirmedDelivery("api", id)).toBe(true);
    expect(queueDepth("api")).toBe(0);
    expect(pendingDeliveryId("api")).toBeNull();
  }, 20_000);

  test("an operator message is confirmed only by its own tagged marker", async () => {
    writeAgent(agent());
    liveEntry();
    await listen(false);
    const id = queueAppend("api", "ok");
    await deliverNext("api");
    const content: string = (frames.find((f: any) => f.type === "user") as any).message.content;
    expect(confirmInboxDelivery("api", "ok, look at the logs")).toBeNull();
    expect(confirmInboxDelivery("api", "[am · operator message 0000000000000000] ok")).toBeNull();
    expect(finishConfirmedDelivery("api", id)).toBe(false);
    expect(confirmInboxDelivery("api", content)).not.toBeNull();
    expect(finishConfirmedDelivery("api", id)).toBe(true);
  }, 20_000);

  test("peer messages confirm without an operator tag", async () => {
    writeAgent(agent());
    liveEntry();
    await listen(false);
    queueAppend("api", "[am · from web] ping");
    await deliverNext("api");
    expect(confirmInboxDelivery("api", "Another Claude session sent a message:\n[am · from web] ping")).toBeNull();
  }, 20_000);
});

describe("SessionStart", () => {
  async function sessionStart(env: Record<string, string>, provider: "claude" | "codex" = "claude") {
    writeAgent(agent({ provider, peerInboxSession: "stale" }));
    // Tests may run inside an am agent whose own launch set AGENTMGR_PEER_INBOX.
    const { AGENTMGR_PEER_INBOX: _ambient, ...inherited } = process.env;
    const proc = Bun.spawn([process.execPath, join(import.meta.dir, "..", "src", "index.ts"), "hook", "session-start"], {
      env: { ...inherited, AGENTMGR_AGENT: "api", ...env },
      stdin: new Blob([JSON.stringify({ session_id: "sess-9" })]),
      stdout: "ignore",
      stderr: "ignore",
    });
    await proc.exited;
    return JSON.parse(readFileSync(join(home, "agents", "api.json"), "utf8")).peerInboxSession;
  }

  test("records the session only when launched with inbound accepted", async () => {
    expect(await sessionStart({ AGENTMGR_PEER_INBOX: "1" })).toBe("sess-9");
    expect(await sessionStart({})).toBeUndefined();
    expect(await sessionStart({ AGENTMGR_PEER_INBOX: "1" }, "codex")).toBeUndefined();
  }, 20_000);
});

describe("operator inbox receipts", () => {
  const CLI = join(import.meta.dir, "..", "src", "index.ts");
  const framed = (content: string) => `Another Claude session sent a message:\n${content}`;
  const raw = (id: string) => JSON.parse(readFileSync(join(queueDir(), "api", ".messages", `${id}.json`), "utf8"));

  // The real hook, in a child process, against this test's fake tmux.
  function hook(event: string, payload: Record<string, unknown> = {}): string {
    const result = Bun.spawnSync([process.execPath, CLI, "hook", event], {
      env: { ...process.env, AGENTMGR_AGENT: "api", PATH: `${home}:${oldPath}` },
      stdin: Buffer.from(JSON.stringify(payload)),
    });
    expect(result.exitCode).toBe(0);
    return result.stdout.toString();
  }

  // Fake inbox whose frames are submitted as prompts through the real hook.
  function listenWithHook(): Promise<string[]> {
    frames = [];
    const outputs: string[] = [];
    return new Promise((resolve) => {
      server = createServer((socket) => {
        let data = "";
        socket.on("data", (chunk) => { data += chunk; });
        socket.on("end", () => {
          for (const line of data.split("\n").filter(Boolean)) {
            const frame = JSON.parse(line);
            frames.push(frame);
            if (frame.type === "user") outputs.push(hook("user-prompt-submit", { prompt: framed(frame.message.content) }));
          }
        });
      });
      server.listen(socketPath(), () => resolve(outputs));
    });
  }

  beforeEach(() => {
    writeFileSync(join(home, "config.json"), JSON.stringify({ notifyCommand: "true" }));
    const transcript = join(home, "session.jsonl");
    for (const text of ["first", "second"]) appendFileSync(transcript, JSON.stringify({ type: "user", message: { role: "user", content: text } }) + "\n");
    writeAgent(agent({ transcriptPath: transcript }));
    liveEntry();
  });

  test("an operator inbox delivery is marked delivered, started by its verified prompt, then done", async () => {
    const outputs = await listenWithHook();
    const id = queueTrackedMessage("api", "operator note");
    expect(await deliverNext("api")).toEqual({ status: "submitted", id: `${id}.json` });
    expect(typed()).toBe(false);
    expect(outputs.join("")).toContain("[am] Verified operator message");
    const promptAt = readAgent("api")!.promptAt;
    expect(raw(id)).toMatchObject({ state: "delivered", via: "prompt", transcriptIndex: 2, startedAt: promptAt });
    // Keyed by the message am sent, not Claude's framing or the marker.
    expect(readAgent("api")!.promptKey).toBe(promptKey("operator note"));
    hook("stop");
    expect(readMessage("api", id)!.state).toBe("done");
  }, 20_000);

  test("the inbox prompt starts its own message, not an older one with the same text", async () => {
    const older = recordImmediateDelivery("api", { transcriptIndex: 2, handedAt: new Date(Date.now() - 1000).toISOString() }, "ok");
    await listenWithHook();
    const id = queueTrackedMessage("api", "ok");
    expect(await deliverNext("api")).toEqual({ status: "submitted", id: `${id}.json` });
    expect(raw(id).startedAt).toBe(readAgent("api")!.promptAt);
    expect(raw(older).startedAt).toBeUndefined();
  }, 20_000);

  test("the typed fallback for an operator message keeps its receipt", async () => {
    const id = queueTrackedMessage("api", "operator note");
    expect(await deliverNext("api")).toEqual({ status: "submitted", id: `${id}.json` });
    expect(typed()).toBe(true);
    expect(raw(id)).toMatchObject({ state: "delivered", transcriptIndex: 2 });
    expect(hook("user-prompt-submit", { prompt: "operator note" })).not.toContain("Verified operator message");
    expect(raw(id).startedAt).toBe(readAgent("api")!.promptAt);
    hook("stop");
    expect(readMessage("api", id)!.state).toBe("done");
  }, 20_000);
});
