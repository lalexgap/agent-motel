import { afterEach, beforeEach, describe, expect, test, spyOn } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireDeliverLock, deliverNext, releaseDeliverLock, __lockPath } from "../src/deliver";
import { ensureDirs } from "../src/paths";
import { queueAppend, queueDepth } from "../src/queue";
import { writeAgent } from "../src/state";
import { sendCommand } from "../src/commands/send";

let home: string;
let oldPath: string | undefined;
let spawnSpy: ReturnType<typeof spyOn> | undefined;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "am-test-"));
  process.env.AGENTMGR_HOME = home;
  oldPath = process.env.PATH;
  ensureDirs();
});

afterEach(() => {
  spawnSpy?.mockRestore();
  spawnSpy = undefined;
  releaseDeliverLock("api");
  releaseDeliverLock("other");
  process.env.PATH = oldPath;
  rmSync(home, { recursive: true, force: true });
  delete process.env.AGENTMGR_HOME;
});

function fakeSession(mode = "swallow", provider: "claude" | "codex" = "claude") {
  writeAgent({ name: "api", provider, status: "idle", tmuxSession: "agentmgr-api", dir: home, createdAt: "now", updatedAt: "now" });
  writeFileSync(join(home, "mode"), mode);
  writeFileSync(join(home, "provider"), provider);
  writeFileSync(join(home, "input"), "");
  writeFileSync(join(home, "tmux"), `#!/bin/sh
case "$1" in
  has-session) exit 0 ;;
  capture-pane)
    [ "$(cat "$AGENTMGR_HOME/mode")" = unavailable ] && exit 1
    [ "$(cat "$AGENTMGR_HOME/mode")" = unknown ] && { echo 'unrecognized screen'; exit 0; }
    if [ "$(cat "$AGENTMGR_HOME/provider")" = codex ]; then
      printf '› '; cat "$AGENTMGR_HOME/input"; echo
      echo
      echo '  GPT-6.1-Sol medium · ~/project'
      echo '  ? for shortcuts'
      exit 0
    fi
    echo '────────────────────'
    printf '❯ '; cat "$AGENTMGR_HOME/input"; echo
    echo '────────────────────'
    ;;
  send-keys)
    if [ "$4" = '-l' ]; then
      printf '%s' "$6" >> "$AGENTMGR_HOME/input"
      echo text >> "$AGENTMGR_HOME/sends"
      [ "$(cat "$AGENTMGR_HOME/mode")" = capture-loss ] && echo unavailable > "$AGENTMGR_HOME/mode"
    else
      echo enter >> "$AGENTMGR_HOME/sends"
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

describe("delivery lock", () => {
  test("is mutually exclusive while held, and frees on release", () => {
    expect(acquireDeliverLock("api")).toBe(true);
    expect(acquireDeliverLock("api")).toBe(false);
    expect(acquireDeliverLock("other")).toBe(true);
    releaseDeliverLock("api");
    expect(acquireDeliverLock("api")).toBe(true);
  });

  test("an old live lock cannot be stolen", () => {
    expect(acquireDeliverLock("api")).toBe(true);
    const old = (Date.now() - 60_000) / 1000;
    utimesSync(__lockPath("api"), old, old);
    expect(acquireDeliverLock("api")).toBe(false);
  });

  test("concurrent processes recover a crashed holder without overlapping", async () => {
    const module = JSON.stringify(join(import.meta.dir, "../src/deliver.ts"));
    const crash = Bun.spawnSync([process.execPath, "-e", `import {acquireDeliverLock} from ${module}; if (!acquireDeliverLock('api')) process.exit(1); process.exit(0);`], { env: { ...process.env } });
    expect(crash.exitCode).toBe(0);
    const probe = `import {acquireDeliverLock,releaseDeliverLock} from ${module}; import {writeFileSync,rmSync} from 'node:fs'; for(let i=0;i<20;i++){while(!acquireDeliverLock('api')) await Bun.sleep(1); try{writeFileSync(process.env.AGENTMGR_HOME+'/active','held',{flag:'wx'}); await Bun.sleep(2); rmSync(process.env.AGENTMGR_HOME+'/active');}finally{releaseDeliverLock('api');}}`;
    const workers = Array.from({ length: 4 }, () => Bun.spawn([process.execPath, "-e", probe], { stdout: "pipe", stderr: "pipe", env: { ...process.env } }));
    for (const worker of workers) { const status = await worker.exited; if(status) console.error(await new Response(worker.stderr).text()); expect(status).toBe(0); }
    expect(acquireDeliverLock("api")).toBe(true);
  });

  test("a non-owner release cannot unlock another process", async () => {
    const module = JSON.stringify(join(import.meta.dir, "../src/deliver.ts"));
    expect(acquireDeliverLock("api")).toBe(true);
    const child = Bun.spawnSync([process.execPath, "-e", `import {releaseDeliverLock,acquireDeliverLock} from ${module}; releaseDeliverLock('api'); process.exit(acquireDeliverLock('api')?1:0);`], { env: { ...process.env } });
    if(child.exitCode) console.error(child.stderr.toString());
    expect(child.exitCode).toBe(0);
  });
});

describe("delivery verification", () => {
  test("failed submit retains even short messages and retry does not retype", async () => {
    fakeSession();
    const id = queueAppend("api", "hi");
    expect(await deliverNext("api")).toEqual({ status: "queued", reason: "unverified" });
    expect(queueDepth("api")).toBe(1);
    writeFileSync(join(home, "mode"), "submit");
    expect(await deliverNext("api")).toEqual({ status: "submitted", id });
    expect(queueDepth("api")).toBe(0);
    expect(readFileSync(join(home, "sends"), "utf8").split("\n").filter(line => line === "text")).toHaveLength(1);
  });


  test("Codex draft blocks delivery and a submitted Codex message leaves the queue", async () => {
    fakeSession("submit", "codex");
    const id = queueAppend("api", "message");
    writeFileSync(join(home, "input"), "human draft");
    expect(await deliverNext("api")).toEqual({ status: "queued", reason: "composing" });
    writeFileSync(join(home, "input"), "");
    expect(await deliverNext("api")).toEqual({ status: "submitted", id });
    expect(queueDepth("api")).toBe(0);
  });

  test("missing verification capture retains the message, then an empty box confirms it without retyping", async () => {
    fakeSession("capture-loss");
    const id = queueAppend("api", "message");
    expect(await deliverNext("api")).toEqual({ status: "queued", reason: "unverified" });
    expect(queueDepth("api")).toBe(1);
    writeFileSync(join(home, "mode"), "submit");
    writeFileSync(join(home, "input"), "");
    expect(await deliverNext("api")).toEqual({ status: "submitted", id });
    expect(readFileSync(join(home, "sends"), "utf8").split("\n").filter(line => line === "text")).toHaveLength(1);
  });

  test("an unrecognized input layout is not confirmation of submission", async () => {
    fakeSession("unknown");
    queueAppend("api", "message");
    expect(await deliverNext("api")).toEqual({ status: "queued", reason: "unavailable" });
    expect(queueDepth("api")).toBe(1);
  });

  test("composition and unavailable capture leave the message queued", async () => {
    fakeSession();
    queueAppend("api", "message");
    writeFileSync(join(home, "input"), "human draft");
    expect(await deliverNext("api")).toEqual({ status: "queued", reason: "composing" });
    writeFileSync(join(home, "mode"), "unavailable");
    expect(await deliverNext("api")).toEqual({ status: "queued", reason: "unavailable" });
    expect(queueDepth("api")).toBe(1);
  });

  test("send reports queued when another delivery holds the lock", async () => {
    fakeSession();
    expect(acquireDeliverLock("api")).toBe(true);
    const messages: string[] = [];
    const log = console.log;
    console.log = text => messages.push(text);
    try { await sendCommand("api", "hello", { now: false }); }
    finally { console.log = log; }
    expect(messages).toHaveLength(1);
    expect(messages[0]).toStartWith('queued for "api"');
    expect(queueDepth("api")).toBe(1);
  });

  test("send does not claim a newly queued message was delivered when it drained an older one", async () => {
    fakeSession("submit");
    queueAppend("api", "older message");
    const messages: string[] = [];
    const log = console.log;
    console.log = text => messages.push(text);
    try { await sendCommand("api", "new message", { now: false }); }
    finally { console.log = log; }
    expect(messages[0]).toStartWith('queued for "api"');
    expect(queueDepth("api")).toBe(1);
  });
});
