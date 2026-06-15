import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  attribute,
  bareName,
  commsFor,
  formatEnvelope,
  hasMessagedSince,
  isSelfSend,
  resolveSender,
  seenRecently,
  shouldReport,
  splitAddr,
} from "../src/comms";
import { configFile } from "../src/paths";

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "am-test-"));
  process.env.AGENTMGR_HOME = home;
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  delete process.env.AGENTMGR_HOME;
  delete process.env.AGENTMGR_AGENT;
});

describe("resolveSender", () => {
  test("explicit wins, else AGENTMGR_AGENT, else undefined", () => {
    process.env.AGENTMGR_AGENT = "api";
    expect(resolveSender()).toBe("api");
    expect(resolveSender("lead")).toBe("lead");
    delete process.env.AGENTMGR_AGENT;
    expect(resolveSender()).toBeUndefined();
    expect(resolveSender("  ")).toBeUndefined();
  });
});

describe("splitAddr / bareName", () => {
  test("parses host:name (canonical), bare names, and tolerates legacy name@host", () => {
    expect(splitAddr("api")).toEqual({ name: "api" });
    expect(splitAddr("server:api")).toEqual({ host: "server", name: "api" });
    // legacy outbox form — must still de-qualify to the right name, not misroute
    expect(splitAddr("api@server")).toEqual({ host: "server", name: "api" });
    expect(bareName("server:api")).toBe("api");
    expect(bareName("api@server")).toBe("api");
    expect(bareName("api")).toBe("api");
  });
});

describe("envelope + self-send", () => {
  test("formats a terse, host-qualifiable prefix", () => {
    expect(formatEnvelope("api", "done")).toBe("[am · from api] done");
    expect(formatEnvelope("laptop:api", "done")).toBe("[am · from laptop:api] done");
  });

  test("self-send only when an unqualified name matches the target", () => {
    expect(isSelfSend("api", "api")).toBe(true);
    expect(isSelfSend("api", "docs")).toBe(false);
    expect(isSelfSend("laptop:api", "api")).toBe(false); // a peer on another host
  });
});

describe("attribute", () => {
  test("anonymous and self sends pass through untouched, unlogged", () => {
    expect(attribute(undefined, "docs", "hi", "send")).toMatchObject({ body: "hi", allowed: true, attributed: false });
    expect(attribute("docs", "docs", "hi", "send")).toMatchObject({ body: "hi", attributed: false });
    expect(commsFor("docs")).toHaveLength(0);
  });

  test("a peer send is wrapped and recorded", () => {
    const att = attribute("api", "docs", "tests green", "send");
    expect(att).toMatchObject({ body: "[am · from api] tests green", allowed: true, attributed: true });
    const log = commsFor("docs");
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ from: "api", to: "docs", kind: "send", body: "tests green" });
  });

  test("rate limiter drops the send past the per-pair window cap", () => {
    writeFileSync(configFile(), JSON.stringify({ commsMaxPerWindow: 3, commsWindowSeconds: 60 }));
    for (let i = 0; i < 3; i++) expect(attribute("api", "docs", `m${i}`, "send").allowed).toBe(true);
    const dropped = attribute("api", "docs", "m3", "send");
    expect(dropped.allowed).toBe(false);
    // The dropped message is not recorded, and an unrelated pair is unaffected.
    expect(commsFor("docs")).toHaveLength(3);
    expect(attribute("lead", "docs", "still ok", "send").allowed).toBe(true);
  });
});

describe("seenRecently (dedup index)", () => {
  test("true once a message with that id has been attributed", () => {
    expect(seenRecently("mid-1")).toBe(false);
    attribute("api", "docs", "hello", "send", "mid-1");
    expect(seenRecently("mid-1")).toBe(true);
    expect(seenRecently("other")).toBe(false);
    expect(seenRecently("")).toBe(false);
  });
});

describe("hasMessagedSince", () => {
  test("true only for a send at/after the cutoff", () => {
    const before = new Date(Date.now() - 10_000).toISOString();
    const future = new Date(Date.now() + 10_000).toISOString();
    attribute("api", "lead", "update", "send");
    expect(hasMessagedSince("api", "lead", before)).toBe(true);
    expect(hasMessagedSince("api", "lead", future)).toBe(false);
    expect(hasMessagedSince("api", "other", before)).toBe(false);
  });
});

describe("shouldReport", () => {
  const minSeconds = 30;
  test("fires only for a real stint the agent didn't already report", () => {
    expect(shouldReport({ reportTo: "lead", workedSeconds: 60, minSeconds, alreadyReported: false })).toBe(true);
    expect(shouldReport({ reportTo: "lead", workedSeconds: 60, minSeconds, alreadyReported: true })).toBe(false);
    expect(shouldReport({ reportTo: "lead", workedSeconds: 5, minSeconds, alreadyReported: false })).toBe(false);
    expect(shouldReport({ reportTo: undefined, workedSeconds: 60, minSeconds, alreadyReported: false })).toBe(false);
  });
});

describe("commsFor", () => {
  test("matches either direction by base name, newest last, capped", () => {
    attribute("api", "docs", "a", "send"); // api → docs
    attribute("lead", "api", "b", "send"); // lead → api
    attribute("laptop:api", "docs", "c", "send"); // host-qualified api → docs
    // "api" matches outgoing (a), incoming (b), and a host-qualified sender (c).
    expect(commsFor("api").map((e) => e.body)).toEqual(["a", "b", "c"]);
    // "docs" only ever received.
    expect(commsFor("docs").map((e) => e.body)).toEqual(["a", "c"]);
    expect(commsFor("api", 2).map((e) => e.body)).toEqual(["b", "c"]);
  });
});
