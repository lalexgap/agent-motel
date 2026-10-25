import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as daemon from "../src/daemon";
import { readAgent, writeAgent } from "../src/state";
import { recordSubagentStop } from "../src/subagents";
import { startWebEvents, type WebEventsCallbacks } from "../src/webEvents";

let home: string;
let previousHome: string | undefined;
let fleet: () => void;
let daemonStops: number;
let activeWatchers: number;
let daemonSpy: ReturnType<typeof spyOn>;
let watchSpy: ReturnType<typeof spyOn>;
type Reader = Pick<ReadableStreamDefaultReader<Uint8Array>, "read" | "cancel">;
const streams: Reader[] = [];
const nativeWatch = fs.watch;

beforeEach(() => {
  previousHome = process.env.AGENTMGR_HOME;
  home = mkdtempSync(join(tmpdir(), "am-web-events-"));
  process.env.AGENTMGR_HOME = home;
  daemonStops = 0;
  activeWatchers = 0;
  daemonSpy = spyOn(daemon, "watchDaemonEvents").mockImplementation((listener) => {
    fleet = () => listener({ id: 1, type: "fleet", event: "status", at: new Date().toISOString() });
    return () => { daemonStops++; };
  });
  watchSpy = spyOn(fs, "watch").mockImplementation(((...args: Parameters<typeof fs.watch>) => {
    const watcher = nativeWatch(...args);
    activeWatchers++;
    watcher.once("close", () => { activeWatchers--; });
    return watcher;
  }) as typeof fs.watch);
});

afterEach(async () => {
  for (const reader of streams.splice(0)) await reader.cancel();
  daemonSpy.mockRestore();
  watchSpy.mockRestore();
  if (previousHome === undefined) delete process.env.AGENTMGR_HOME;
  else process.env.AGENTMGR_HOME = previousHome;
  rmSync(home, { recursive: true, force: true });
});

function seed(name = "alice", path = join(home, `${name}.jsonl`)) {
  const now = new Date().toISOString();
  writeAgent({ name, dir: home, status: "idle", tmuxSession: name, createdAt: now, updatedAt: now, transcriptPath: path });
  return path;
}

function open(query = "agent=alice", callbacks: WebEventsCallbacks = { isSessionValid: () => true }, signal?: AbortSignal) {
  const response = startWebEvents(new Request(`http://localhost/api/web-events?${query}`, { signal }), callbacks);
  expect(response.status).toBe(200);
  const reader = response.body!.getReader();
  streams.push(reader);
  return reader;
}

async function next(reader: Reader) {
  let timer: ReturnType<typeof setTimeout>;
  try {
    const chunk = await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("SSE event exceeded 900ms")), 900); }),
    ]);
    return { done: chunk.done, text: new TextDecoder().decode(chunk.value) };
  } finally { clearTimeout(timer!); }
}

test("real file appends emit a small changed event within one second", async () => {
  const file = seed();
  writeFileSync(file, "");
  const reader = open();
  expect((await next(reader)).text).toContain("event: ready");
  const start = performance.now();
  appendFileSync(file, "private transcript token");
  const event = (await next(reader)).text;
  expect(performance.now() - start).toBeLessThan(1000);
  expect(event).toContain("event: changed");
  expect(event).toContain("transcript");
  expect(event).not.toContain("private");
  expect(event.length).toBeLessThan(150);
});

test("missing file and missing parent directory are retried", async () => {
  const file = seed("alice", join(home, "later", "session.jsonl"));
  const reader = open();
  await next(reader);
  mkdirSync(join(home, "later"));
  writeFileSync(file, "first token");
  expect((await next(reader)).text).toContain("event: changed");
});

test("fleet events rewire a changed session path", async () => {
  const file = seed();
  writeFileSync(file, "");
  const reader = open();
  await next(reader);
  const replacement = join(home, "replacement.jsonl");
  writeFileSync(replacement, "");
  writeAgent({ ...readAgent("alice")!, transcriptPath: replacement });
  fleet();
  expect((await next(reader)).text).toContain("fleet");
  appendFileSync(replacement, "next token");
  expect((await next(reader)).text).toContain("transcript");
});

test("overview watches local concierge", async () => {
  const file = seed("concierge");
  writeFileSync(file, "");
  const reader = open("");
  await next(reader);
  appendFileSync(file, "concierge token");
  expect((await next(reader)).text).toContain("transcript");
});

test("native subagent paths come from the selected agent ledger", async () => {
  writeFileSync(seed(), "");
  const file = join(home, "child.jsonl");
  writeFileSync(file, "");
  recordSubagentStop("alice", { id: "native-id", transcriptPath: file });
  const reader = open("agent=alice&subagent=native-id");
  await next(reader);
  appendFileSync(file, "child token");
  expect((await next(reader)).text).toContain("transcript");
  expect(startWebEvents(new Request("http://localhost/api/web-events?agent=../bad"), { isSessionValid: () => true }).status).toBe(400);
  expect(startWebEvents(new Request("http://localhost/api/web-events?agent=alice&subagent=../child"), { isSessionValid: () => true }).status).toBe(400);
});

test("remote selections explicitly fall back to polling without watching their local namesake", async () => {
  writeFileSync(seed(), "");
  const reader = open("agent=remote:alice");
  expect((await next(reader)).text).toContain('"pollingFallback":true');
  expect(activeWatchers).toBe(0);
});

test("disconnect closes watchers and daemon subscription", async () => {
  writeFileSync(seed(), "");
  const reader = open();
  await next(reader);
  expect(activeWatchers).toBe(1);
  await reader.cancel();
  await Bun.sleep(10);
  expect(activeWatchers).toBe(0);
  expect(daemonStops).toBe(1);
  fleet();
  expect((await next(reader)).done).toBe(true);
});

test("missing or invalid sessions create no stream or subscriptions", () => {
  const request = new Request("http://localhost/api/web-events?agent=alice");
  for (const callbacks of [undefined, { isSessionValid: () => false }, { isSessionValid: () => { throw new Error("expired"); } }]) {
    const response = startWebEvents(request, callbacks);
    expect(response.status).toBe(401);
    expect(response.body).toBeNull();
  }
  expect(daemonSpy).not.toHaveBeenCalled();
  expect(activeWatchers).toBe(0);
});

test("expired session cannot emit queued changes", async () => {
  let valid = true;
  const reader = open("agent=alice", { isSessionValid: () => valid });
  await next(reader);
  fleet();
  valid = false;
  expect((await next(reader)).done).toBe(true);
  expect(daemonStops).toBe(1);
});

test("logout subscription immediately closes an idle stream", async () => {
  let revoke!: () => void;
  let unsubscribed = false;
  const reader = open("", { isSessionValid: () => true, onRevoke(close) { revoke = close; return () => { unsubscribed = true; }; } });
  await next(reader);
  revoke();
  expect((await next(reader)).done).toBe(true);
  expect(unsubscribed).toBe(true);
  expect(daemonStops).toBe(1);
});

test("request disconnect and auth abort signals close idle streams", async () => {
  for (const kind of ["request", "auth"]) {
    const abort = new AbortController();
    const reader = open("", { isSessionValid: () => true, ...(kind === "auth" ? { signal: abort.signal } : {}) }, kind === "request" ? abort.signal : undefined);
    await next(reader);
    abort.abort();
    expect((await next(reader)).done).toBe(true);
  }
  expect(daemonStops).toBe(2);
});

test("slow readers are disconnected instead of accumulating events", async () => {
  const reader = open();
  await next(reader);
  for (let i = 0; i < 10; i++) { fleet(); await Bun.sleep(110); }
  expect(daemonStops).toBe(1);
});

test("continuous token appends do not postpone refresh until the writer stops", async () => {
  const file = seed();
  writeFileSync(file, "");
  const reader = open();
  await next(reader);
  const started = performance.now();
  const writer = setInterval(() => appendFileSync(file, "token"), 20);
  try {
    expect((await next(reader)).text).toContain("event: changed");
    expect(performance.now() - started).toBeLessThan(500);
  } finally { clearInterval(writer); }
});

test("an unrecorded native id does not add a file watcher", async () => {
  writeFileSync(seed(), "");
  const reader = open("agent=alice&subagent=unknown-native-id");
  await next(reader);
  expect(activeWatchers).toBe(1);
});

test("real HTTP disconnect releases the stream resources", async () => {
  const file = seed();
  writeFileSync(file, "");
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: (req) => startWebEvents(req, { isSessionValid: () => true }),
  });
  const abort = new AbortController();
  try {
    const response = await fetch(`${server.url}api/web-events?agent=alice`, { signal: abort.signal });
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    const reader = response.body!.getReader();
    expect((await next(reader)).text).toContain("event: ready");
    appendFileSync(file, "token");
    expect((await next(reader)).text).toContain("event: changed");
    abort.abort();
    const deadline = Date.now() + 800;
    while ((daemonStops === 0 || activeWatchers > 0) && Date.now() < deadline) await Bun.sleep(10);
    expect(daemonStops).toBe(1);
    expect(activeWatchers).toBe(0);
  } finally {
    abort.abort();
    server.stop(true);
  }
});
