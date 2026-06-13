import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  collectedSender,
  isExpired,
  outboxAppend,
  outboxList,
  outboxTake,
  readBounces,
  takeBouncesFrom,
  type OutboxEntry,
} from "../src/outbox";
import { formatEnvelope } from "../src/comms";

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "am-test-"));
  process.env.AGENTMGR_HOME = home;
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  delete process.env.AGENTMGR_HOME;
});

const HOUR = 60 * 60 * 1000;

describe("outbox append + take round-trip", () => {
  test("take returns and removes entries for the named targets only", () => {
    outboxAppend({ to: "web", from: "api", fromHost: "server", body: "build ready" });
    outboxAppend({ to: "web", from: "api", fromHost: "server", body: "and deployed" });
    outboxAppend({ to: "worker", from: "api", fromHost: "server", body: "for you" });

    const got = outboxTake(["web"]);
    expect(got.map((e) => e.body)).toEqual(["build ready", "and deployed"]);
    expect(got[0]).toMatchObject({ to: "web", from: "api", fromHost: "server" });

    // web is drained; worker untouched.
    expect(outboxTake(["web"])).toEqual([]);
    expect(outboxTake(["worker"]).map((e) => e.body)).toEqual(["for you"]);
  });

  test("take sweeps multiple names at once", () => {
    outboxAppend({ to: "a", fromHost: "h", body: "1" });
    outboxAppend({ to: "b", fromHost: "h", body: "2" });
    expect(outboxTake(["a", "b"]).map((e) => e.body).sort()).toEqual(["1", "2"]);
  });
});

describe("expiry", () => {
  test("isExpired honors the per-entry ttl", () => {
    const entry: OutboxEntry = { to: "x", fromHost: "h", body: "b", queuedAt: new Date(Date.now() - 2 * HOUR).toISOString(), ttlMs: HOUR };
    expect(isExpired(entry)).toBe(true);
    expect(isExpired({ ...entry, ttlMs: 3 * HOUR })).toBe(false);
  });

  test("take drops expired entries to bounces instead of delivering them", () => {
    outboxAppend({ to: "web", from: "api", fromHost: "server", body: "stale", ttlMs: HOUR, queuedAt: new Date(Date.now() - 2 * HOUR).toISOString() });
    outboxAppend({ to: "web", from: "api", fromHost: "server", body: "fresh" });

    const got = outboxTake(["web"]);
    expect(got.map((e) => e.body)).toEqual(["fresh"]); // expired not returned
    expect(readBounces().map((b) => b.body)).toEqual(["stale"]);
  });

  test("list shows live, drops expired, and records the bounce (observable)", () => {
    outboxAppend({ to: "web", from: "api", fromHost: "server", body: "stale", ttlMs: HOUR, queuedAt: new Date(Date.now() - 2 * HOUR).toISOString() });
    outboxAppend({ to: "web", from: "api", fromHost: "server", body: "live" });

    const view = outboxList();
    expect(view.live.map((e) => e.body)).toEqual(["live"]);
    expect(view.bounced.map((b) => b.body)).toEqual(["stale"]);
    // The live entry survives a second look; the expired one is already gone.
    expect(outboxList().live.map((e) => e.body)).toEqual(["live"]);
  });
});

describe("takeBouncesFrom", () => {
  test("returns and clears only the given sender's bounces", () => {
    outboxAppend({ to: "web", from: "api", fromHost: "server", body: "x", ttlMs: 1, queuedAt: new Date(Date.now() - HOUR).toISOString() });
    outboxAppend({ to: "web", from: "lead", fromHost: "server", body: "y", ttlMs: 1, queuedAt: new Date(Date.now() - HOUR).toISOString() });
    outboxTake(["web"]); // both expire into bounces

    expect(takeBouncesFrom("api").map((b) => b.body)).toEqual(["x"]);
    expect(takeBouncesFrom("api")).toEqual([]); // cleared
    expect(readBounces().map((b) => b.from)).toEqual(["lead"]); // lead's bounce remains
  });
});

describe("collectedSender (attribution formatting)", () => {
  test("qualifies the sender by short host so the recipient sees the origin", () => {
    expect(collectedSender("web", "server", "box")).toBe("web@server");
    expect(collectedSender("web", "home.alexgap.ca", "box")).toBe("web@home"); // short host
    expect(collectedSender(undefined, "server", "box")).toBe("server"); // anonymous → host only
    expect(collectedSender("web", "", "box")).toBe("web@box"); // fall back to ssh alias

    // …and that label flows straight into the envelope the recipient reads.
    expect(formatEnvelope(collectedSender("web", "server", "box"), "ping")).toBe("[am · from web@server] ping");
  });
});
