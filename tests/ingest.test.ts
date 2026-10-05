import { afterEach, beforeEach, expect, test, spyOn } from "bun:test";
import * as fs from "node:fs";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { injectCollected } from "../src/daemon";
import { acquireDeliverLock, releaseDeliverLock } from "../src/deliver";
import { attribute, seenRecently } from "../src/comms";
import { queueAppendOnce, queueDepth, queueHead, queueList, queuePop, queuePopId, queueReceived } from "../src/queue";
import { writeAgent } from "../src/state";
import type { OutboxEntry } from "../src/outbox";

let home: string;
const entry: OutboxEntry = {
  msgId: "01MESSAGE", to: "worker", from: "lead", fromHost: "remote",
  body: "do work", queuedAt: new Date().toISOString(), ttlMs: 172_800_000,
};

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "am-ingest-"));
  process.env.AGENTMGR_HOME = home;
  const now = new Date().toISOString();
  writeAgent({ name: "worker", status: "working", dir: "/tmp", tmuxSession: "am-ingest-worker", createdAt: now, updatedAt: now });
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  delete process.env.AGENTMGR_HOME;
});

test("an old ledger entry cannot acknowledge mail that was never queued", async () => {
  attribute("remote:lead", "worker", entry.body, "send", entry.msgId);
  expect(await injectCollected(entry, "remote")).toBe(true);
  expect(queueDepth("worker")).toBe(1);
  expect(queueList("worker")[0]?.msgId).toBe(entry.msgId);
});

test("enqueue failure neither marks received nor logs successful ingestion", async () => {
  writeFileSync(join(home, "queue", "worker"), "blocks queue directory");
  await expect(injectCollected(entry, "remote")).rejects.toThrow();
  expect(seenRecently(entry.msgId)).toBe(false);
  expect(queueReceived("worker", entry.msgId)).toBe(false);
  rmSync(join(home, "queue", "worker"));
  expect(await injectCollected(entry, "remote")).toBe(true);
  expect(queueDepth("worker")).toBe(1);
});

test("retry recovers a queued entry left before the receipt was written", async () => {
  queueAppendOnce("worker", "[am · from remote:lead] do work", entry.msgId);
  expect(await injectCollected(entry, "remote")).toBe(true);
  expect(queueDepth("worker")).toBe(1);
  expect(queueReceived("worker", entry.msgId)).toBe(true);
});

test("receipt-write failure retains the queue and retry does not duplicate it", async () => {
  queueAppendOnce("worker", "[am · from remote:lead] do work", entry.msgId);
  writeFileSync(join(home, "queue", "worker", ".received"), "blocks receipts");
  await expect(injectCollected(entry, "remote")).rejects.toThrow();
  expect(queueDepth("worker")).toBe(1);
  expect(seenRecently(entry.msgId)).toBe(false);
  rmSync(join(home, "queue", "worker", ".received"));
  expect(await injectCollected(entry, "remote")).toBe(true);
  expect(queueDepth("worker")).toBe(1);
});

test("redelivery after consumption is deduplicated independently of the comms ledger", async () => {
  expect(await injectCollected(entry, "remote")).toBe(true);
  expect(queuePop("worker")).toContain("do work");
  rmSync(join(home, "comms.jsonl"));
  expect(await injectCollected(entry, "remote")).toBe(true);
  expect(queueDepth("worker")).toBe(0);
});

test("invalid message IDs cannot escape queue storage", async () => {
  await expect(injectCollected({ ...entry, msgId: "../../escape" }, "remote")).rejects.toThrow("invalid message id");
  expect(queueDepth("worker")).toBe(0);
});

test("an active delivery defers ingestion without acknowledging the message", async () => {
  expect(acquireDeliverLock("worker")).toBe(true);
  try {
    expect(await injectCollected(entry, "remote")).toBe(false);
    expect(queueDepth("worker")).toBe(0);
    expect(queueReceived("worker", entry.msgId)).toBe(false);
  } finally {
    releaseDeliverLock("worker");
  }
  expect(await injectCollected(entry, "remote")).toBe(true);
});

test("native hooks do not surface a pending typed message a second time", () => {
  const id = queueAppendOnce("worker", "pending typed message", entry.msgId);
  writeFileSync(join(home, "queue", "worker", ".delivery.pending"), JSON.stringify({ id, message: "pending typed message", typed: true }));
  const result = Bun.spawnSync([process.execPath, join(import.meta.dir, "../src/index.ts"), "hook", "post-tool-use"], {
    env: { ...process.env, AGENTMGR_AGENT: "worker" }, stdin: Buffer.from("{}"),
  });
  expect(result.exitCode).toBe(0);
  expect(result.stdout.toString()).not.toContain("pending typed message");
  expect(queueDepth("worker")).toBe(1);
});


test("consumption repairs a missing receipt before a collected message can be retried", async () => {
  const id = queueAppendOnce("worker", "do work", entry.msgId);
  expect(queueReceived("worker", entry.msgId)).toBe(false);
  expect(acquireDeliverLock("worker")).toBe(true);
  try {
    queuePopId("worker", id);
  } finally {
    releaseDeliverLock("worker");
  }
  expect(queueReceived("worker", entry.msgId)).toBe(true);
  expect(await injectCollected(entry, "remote")).toBe(true);
  expect(queueDepth("worker")).toBe(0);
});

test("failed receipt persistence prevents consumption of crash recovery evidence", () => {
  const id = queueAppendOnce("worker", "do work", entry.msgId);
  writeFileSync(join(home, "queue", "worker", ".received"), "blocks receipts");
  expect(acquireDeliverLock("worker")).toBe(true);
  try {
    expect(() => queuePopId("worker", id)).toThrow();
  } finally {
    releaseDeliverLock("worker");
  }
  expect(queueHead("worker")?.id).toBe(id);
});

test("ingestion flushes the message and directories before the receipt and acknowledgement", async () => {
  const opened = new Map<number, string>();
  const flushed: string[] = [];
  const open = fs.openSync;
  const sync = fs.fsyncSync;
  const openSpy = spyOn(fs, "openSync").mockImplementation((...args: Parameters<typeof fs.openSync>) => {
    const fd = open(...args);
    opened.set(fd, String(args[0]));
    return fd;
  });
  const syncSpy = spyOn(fs, "fsyncSync").mockImplementation(fd => {
    flushed.push(opened.get(fd)!);
    sync(fd);
  });
  try {
    expect(await injectCollected(entry, "remote")).toBe(true);
    const dir = join(home, "queue", "worker");
    expect(flushed).toEqual([
      join(dir, `${entry.msgId}.json`), dir, join(home, "queue"), home,
      join(dir, ".received", entry.msgId), join(dir, ".received"), dir, join(home, "queue"), home,
    ]);
  } finally {
    openSpy.mockRestore();
    syncSpy.mockRestore();
  }
});

test("fsync failure withholds acknowledgement and retry durably repairs the receipt", async () => {
  const sync = fs.fsyncSync;
  let calls = 0;
  const syncSpy = spyOn(fs, "fsyncSync").mockImplementation(fd => {
    if (++calls === 6) throw new Error("receipt directory fsync failed");
    sync(fd);
  });
  try {
    await expect(injectCollected(entry, "remote")).rejects.toThrow("receipt directory fsync failed");
    expect(queueDepth("worker")).toBe(1);
    expect(seenRecently(entry.msgId)).toBe(false);
    expect(await injectCollected(entry, "remote")).toBe(true);
    expect(calls).toBe(11);
    expect(queueDepth("worker")).toBe(1);
  } finally {
    syncSpy.mockRestore();
  }
});


test("queue fsync failure withholds acknowledgement and retry flushes the recovered entry", async () => {
  const sync = fs.fsyncSync;
  let calls = 0;
  const syncSpy = spyOn(fs, "fsyncSync").mockImplementation(fd => {
    if (++calls === 1) throw new Error("queue fsync failed");
    sync(fd);
  });
  try {
    await expect(injectCollected(entry, "remote")).rejects.toThrow("queue fsync failed");
    expect(queueReceived("worker", entry.msgId)).toBe(false);
    expect(seenRecently(entry.msgId)).toBe(false);
    expect(await injectCollected(entry, "remote")).toBe(true);
    expect(calls).toBe(10);
    expect(queueDepth("worker")).toBe(1);
  } finally {
    syncSpy.mockRestore();
  }
});
