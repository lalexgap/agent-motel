import { describe, expect, test } from "bun:test";
import type { AgentRow } from "../desktop/src/types";
import {
  breakdownPath,
  DEFAULT_USAGE_PREFS,
  parseUsagePrefs,
  periodicDue,
  pickConnection,
  scopeForKey,
  serializeUsagePrefs,
  SUMMARY_INTERVAL_MS,
  summaryPath,
  summaryStatus,
  usageAgentKey,
} from "../desktop/src/usage";
import { validateApiPath } from "../desktop/src/policy";

function row(name: string, overrides: Partial<AgentRow> = {}): AgentRow {
  return {
    name, status: "idle", statusChangedAt: "2026-01-01T00:00:00Z", provider: "claude", dir: "/tmp", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

describe("summaryPath", () => {
  test("first load asks for quota; later loads send quota=0", () => {
    expect(summaryPath({ range: 7, repo: "", provider: "", refresh: false, quotaLoaded: false })).toBe("/api/usage/summary?range=7");
    expect(summaryPath({ range: 30, repo: "", provider: "", refresh: false, quotaLoaded: true })).toBe("/api/usage/summary?range=30&quota=0");
  });
  test("Refresh sends refresh=1 instead of quota=0", () => {
    expect(summaryPath({ range: 1, repo: "", provider: "", refresh: true, quotaLoaded: true })).toBe("/api/usage/summary?range=1&refresh=1");
  });
  test("repo and provider filters, in the browser UI's order", () => {
    expect(summaryPath({ range: 7, repo: "lighthouse", provider: "codex", refresh: false, quotaLoaded: true }))
      .toBe("/api/usage/summary?range=7&repo=lighthouse&provider=codex&quota=0");
  });
  test("the home repo and odd names stay valid bridge paths", () => {
    for (const repo of ["~", "my repo", "a+b&c=d", "ünï"]) {
      const path = summaryPath({ range: 7, repo, provider: "", refresh: false, quotaLoaded: false });
      expect(validateApiPath(path)).toBeNull();
      expect(new URL(path, "http://x").searchParams.get("repo")).toBe(repo);
    }
  });
});

describe("breakdownPath", () => {
  test("never asks for quota", () => {
    expect(breakdownPath({ agent: "", provider: "" })).toBe("/api/usage?quota=0");
  });
  test("agent and provider scopes", () => {
    expect(breakdownPath({ agent: "harbor-lights", provider: "" })).toBe("/api/usage?quota=0&agent=harbor-lights");
    expect(breakdownPath({ agent: "", provider: "claude" })).toBe("/api/usage?quota=0&provider=claude");
    expect(validateApiPath(breakdownPath({ agent: "fog_signal-2", provider: "codex" }))).toBeNull();
  });
});

describe("periodicDue", () => {
  const base = { pageVisible: true, documentHidden: false, fetchedAt: 1_000, now: 1_000 + SUMMARY_INTERVAL_MS };
  test("at most every 30 s while the page shows in a visible window", () => {
    expect(SUMMARY_INTERVAL_MS).toBe(30_000);
    expect(periodicDue(base)).toBe(true);
    expect(periodicDue({ ...base, now: base.now - 1 })).toBe(false);
  });
  test("never while the page or window is hidden", () => {
    expect(periodicDue({ ...base, pageVisible: false })).toBe(false);
    expect(periodicDue({ ...base, documentHidden: true })).toBe(false);
  });
});

describe("usage preferences", () => {
  test("defaults: 7 days in dollars, no filters", () => {
    expect(parseUsagePrefs(null)).toEqual(DEFAULT_USAGE_PREFS);
    expect(parseUsagePrefs("not json")).toEqual(DEFAULT_USAGE_PREFS);
    expect(parseUsagePrefs("null")).toEqual(DEFAULT_USAGE_PREFS);
  });
  test("round trip", () => {
    const prefs = { range: 30 as const, unit: "tokens" as const, repo: "lighthouse", provider: "codex", breakdownProvider: "claude", connection: "c1" };
    expect(parseUsagePrefs(serializeUsagePrefs(prefs))).toEqual(prefs);
  });
  test("bad values fall back", () => {
    expect(parseUsagePrefs(JSON.stringify({ range: 14, unit: "eur", repo: 3, provider: "gemini", breakdownProvider: "x", connection: "" })))
      .toEqual(DEFAULT_USAGE_PREFS);
  });
});

describe("pickConnection", () => {
  const ids = ["a", "b", "c"];
  test("explicit request, then the open agent's connection, then the saved one, then the first", () => {
    expect(pickConnection(ids, { requested: "c", openKey: "b/x", saved: "a" })).toBe("c");
    expect(pickConnection(ids, { openKey: "b/x", saved: "c" })).toBe("b");
    expect(pickConnection(ids, { openKey: null, saved: "c" })).toBe("c");
    expect(pickConnection(ids, {})).toBe("a");
  });
  test("ignores connections that are gone", () => {
    expect(pickConnection(ids, { requested: "z", openKey: "y/x", saved: "w" })).toBe("a");
    expect(pickConnection([], { saved: "a" })).toBeNull();
  });
});

describe("usageAgentKey", () => {
  const rows = [row("harbor-lights"), row("fog-signal", { host: "annex" }), row("drift-net")];
  test("maps a usage name to the local agent's key", () => {
    expect(usageAgentKey("c1", rows, "harbor-lights")).toBe("c1/harbor-lights");
    expect(usageAgentKey("c1", rows, "drift-net", "working")).toBe("c1/drift-net");
  });
  test("removed agents, remote-only names and unknown names have no key", () => {
    expect(usageAgentKey("c1", rows, "harbor-lights", "removed")).toBeNull();
    expect(usageAgentKey("c1", rows, "fog-signal")).toBeNull();
    expect(usageAgentKey("c1", rows, "gone")).toBeNull();
    expect(usageAgentKey("c1", rows, "")).toBeNull();
  });
});

describe("scopeForKey", () => {
  test("local agents scope the breakdown; remote ones only pick the connection", () => {
    expect(scopeForKey("c1/harbor-lights")).toEqual({ connection: "c1", agent: "harbor-lights" });
    expect(scopeForKey("c1/annex:fog-signal")).toEqual({ connection: "c1", agent: "" });
    expect(scopeForKey("nonsense")).toBeNull();
  });
});

describe("summaryStatus", () => {
  test("indexing progress wins", () => {
    expect(summaryStatus({ indexing: { pendingFiles: 1 } })).toBe("Indexing history… 1 file left");
    expect(summaryStatus({ indexing: { pendingFiles: 12 } })).toBe("Indexing history… 12 files left");
  });
  test("otherwise the time it was generated", () => {
    const at = new Date(2026, 10, 12, 9, 5);
    const expected = `Updated ${at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
    expect(summaryStatus({ generatedAt: at.toISOString(), indexing: { pendingFiles: 0 } })).toBe(expected);
    expect(summaryStatus({ generatedAt: "garbage" }, at.getTime())).toBe(expected);
    expect(summaryStatus(null, at.getTime())).toBe(expected);
  });
});
