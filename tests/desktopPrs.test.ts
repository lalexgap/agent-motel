import { describe, expect, test } from "bun:test";
import { validateApiPath } from "../desktop/src/policy";
import {
  DEFAULT_PRS_PREFS,
  fleetRefetchDelay,
  mergeNudge,
  needsMeCount,
  parsePrsPrefs,
  periodicDue,
  prAgentKey,
  PRS_BACKGROUND_MS,
  PRS_INTERVAL_MS,
  prsPath,
  serializePrsPrefs,
} from "../desktop/src/prs";

describe("prsPath", () => {
  test("the report, and with all=1 when older merged/closed PRs are wanted", () => {
    expect(prsPath(false)).toBe("/api/prs");
    expect(prsPath(true)).toBe("/api/prs?all=1");
  });
  test("both pass the bridge's API path check", () => {
    for (const path of [prsPath(false), prsPath(true)]) expect(validateApiPath(path)).toBeNull();
  });
});

describe("refetch scheduling", () => {
  const now = 1_000_000;
  test("the periodic clock fetches only while the page shows in a visible window, once per interval", () => {
    const base = { pageVisible: true, documentHidden: false, fetchedAt: now - PRS_INTERVAL_MS, now };
    expect(periodicDue(base)).toBe(true);
    expect(periodicDue({ ...base, fetchedAt: now - PRS_INTERVAL_MS + 1 })).toBe(false);
    expect(periodicDue({ ...base, pageVisible: false })).toBe(false);
    expect(periodicDue({ ...base, documentHidden: true })).toBe(false);
    expect(periodicDue({ ...base, fetchedAt: 0 })).toBe(true);
  });
  test("fleet events refetch at once while the page shows", () => {
    expect(fleetRefetchDelay({ pageVisible: true, fetchedAt: now - 1, now })).toBe(0);
  });
  test("in the background, at most once per PRS_BACKGROUND_MS, trailing", () => {
    expect(fleetRefetchDelay({ pageVisible: false, fetchedAt: 0, now })).toBe(0);
    expect(fleetRefetchDelay({ pageVisible: false, fetchedAt: now - PRS_BACKGROUND_MS, now })).toBe(0);
    expect(fleetRefetchDelay({ pageVisible: false, fetchedAt: now - 10_000, now })).toBe(PRS_BACKGROUND_MS - 10_000);
    expect(fleetRefetchDelay({ pageVisible: false, fetchedAt: now, now })).toBe(PRS_BACKGROUND_MS);
  });
});

describe("prAgentKey", () => {
  const rows = [{ name: "fog-signal" }, { name: "kelp-forest", host: "annex" }, { name: "fog-signal", host: "annex" }];
  test("a local agent's plain name and a remote agent's host:name map to the app key", () => {
    expect(prAgentKey("c1", rows, "fog-signal")).toBe("c1/fog-signal");
    expect(prAgentKey("c1", rows, "annex:kelp-forest")).toBe("c1/annex:kelp-forest");
    expect(prAgentKey("c1", rows, "annex:fog-signal")).toBe("c1/annex:fog-signal");
  });
  test("an agent no longer in the fleet, or on another host, has nowhere to open", () => {
    expect(prAgentKey("c1", rows, "kelp-forest")).toBeNull();
    expect(prAgentKey("c1", rows, "lantern:fog-signal")).toBeNull();
    expect(prAgentKey("c1", rows, "")).toBeNull();
    expect(prAgentKey("c1", [], "fog-signal")).toBeNull();
  });
});

describe("mergeNudge", () => {
  const nudge = "PR #12 (https://github.com/example/a/pull/12) is waiting: CI running. What is its status?";
  test("an empty or blank draft becomes the nudge", () => {
    expect(mergeNudge("", nudge)).toBe(nudge);
    expect(mergeNudge("  \n\n ", nudge)).toBe(nudge);
  });
  test("an existing draft is kept, with the nudge after a blank line", () => {
    expect(mergeNudge("Half a thought", nudge)).toBe(`Half a thought\n\n${nudge}`);
    expect(mergeNudge("  indented\nsecond line\n\n\n", nudge)).toBe(`  indented\nsecond line\n\n${nudge}`);
  });
  test("nudging twice does not add it twice", () => {
    const once = mergeNudge("Draft", nudge);
    expect(mergeNudge(once, nudge)).toBe(once);
    expect(mergeNudge(nudge + "\n", nudge)).toBe(nudge);
  });
});

describe("needsMeCount", () => {
  test("the report's needsMe count, zero when missing or odd", () => {
    expect(needsMeCount({ counts: { needsMe: 3 } })).toBe(3);
    for (const report of [null, undefined, {}, { counts: {} }, { counts: { needsMe: 0 } }, { counts: { needsMe: -1 } }, { counts: { needsMe: "2" } }, { counts: { needsMe: NaN } }]) {
      expect(needsMeCount(report)).toBe(0);
    }
  });
});

describe("prefs", () => {
  test("round-trip", () => {
    const prefs = { includeOlder: true, connection: "c2" };
    expect(parsePrsPrefs(serializePrsPrefs(prefs))).toEqual(prefs);
  });
  test("missing, broken or odd values fall back to the defaults", () => {
    for (const raw of [null, "", "not json", "null", "[]", "42"]) expect(parsePrsPrefs(raw)).toEqual(DEFAULT_PRS_PREFS);
    expect(parsePrsPrefs(JSON.stringify({ includeOlder: "yes", connection: 7 }))).toEqual(DEFAULT_PRS_PREFS);
    expect(parsePrsPrefs(JSON.stringify({ includeOlder: true, connection: "" }))).toEqual({ includeOlder: true, connection: null });
  });
});

