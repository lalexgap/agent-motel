import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import {
  applyResult,
  beginSearch,
  BUSY_MESSAGE,
  DEFAULT_FILTERS,
  elapsed,
  failure,
  filterRows,
  highlightInto,
  matchesTerms,
  optionValues,
  queryTerms,
  readResponse,
  runtime,
  searchExcerpt,
  snippetLabel,
  snippetsFor,
  sortRows,
  summaryText,
  validConversationQuery,
  type SearchFilters,
  type SearchRow,
  type SortKey,
} from "../desktop/src/search";
import type { AgentRow } from "../desktop/src/types";

const T0 = Date.parse("2026-01-01T12:00:00Z");
const iso = (offsetMs: number) => new Date(T0 + offsetMs).toISOString();
function row(name: string, overrides: Partial<AgentRow> = {}): AgentRow {
  return {
    name,
    status: "idle",
    statusChangedAt: iso(0),
    provider: "claude",
    dir: `/home/u/.agent-manager/worktrees/lighthouse/${name}`,
    repoRoot: "/home/u/code/lighthouse",
    createdAt: iso(0),
    updatedAt: iso(0),
    ...overrides,
  };
}
const entry = (r: AgentRow, connection = "c1", connectionName = "Home"): SearchRow =>
  ({ key: `${connection}/${r.host ? r.host + ":" : ""}${r.name}`, connection, connectionName, row: r });
const names = (rows: SearchRow[]) => rows.map((item) => item.row.name);
const filters = (overrides: Partial<SearchFilters> = {}): SearchFilters => ({ ...DEFAULT_FILTERS, ...overrides });

// A tiny DOM: enough for highlightInto in both implementations.
const make = (tag: string) => ({ tag, textContent: "", children: [] as any[], append(...nodes: any[]) { this.children.push(...nodes); } });
const fakeDocument = { getElementById: () => ({}), createElement: make, createTextNode: (text: string) => Object.assign(make("text"), { textContent: text }) };
function loadWeb() {
  const context: any = { document: fakeDocument };
  runInNewContext(readFileSync(new URL("../web/search.js", import.meta.url), "utf8") + "\nthis.searchExcerpt = searchExcerpt; this.highlightInto = highlightInto;", context);
  return context as { searchExcerpt: typeof searchExcerpt; highlightInto: (node: any, text: string, terms: string[]) => any };
}
const flat = (node: any) => node.children.map((child: any) => `${child.tag}:${child.textContent}`);
const savedDocument = (globalThis as any).document;
afterEach(() => { (globalThis as any).document = savedDocument; });

describe("shared with web/search.js", () => {
  const web = loadWeb();
  const texts = [
    "", "short task", "intro ".repeat(80) + "the deploy\n\nstep " + "tail ".repeat(80),
    "**Bold** `code` ## heading and # hash#tag", "Deploy DEPLOY deploy", "a.b*c (x) [y] {z} ^$ | \\ end",
    "café — naïve 🚀 rocket " + "x ".repeat(200) + "rocket", null, 42,
  ];
  const termSets = [[], ["deploy"], ["missing"], ["x", "rocket"], ["a.b*c", "(x)", "[y]"], ["#", "code"], ["tail", "intro"]];
  test("searchExcerpt matches for every input and length", () => {
    for (const text of texts) for (const terms of termSets) for (const length of [undefined, 180, 40, 5]) {
      expect(searchExcerpt(text, terms, length)).toBe(web.searchExcerpt(text, terms, length));
    }
  });
  test("highlightInto builds the same nodes, marks as text never markup", () => {
    (globalThis as any).document = fakeDocument;
    for (const text of [...texts.filter((text): text is string => typeof text === "string"), "Deploy <b>x</b> then deploy."]) {
      for (const terms of [...termSets, ["deploy", "<b>"]]) {
        expect(flat(highlightInto(make("p") as any, text, terms))).toEqual(flat(web.highlightInto(make("p"), text, terms)));
      }
    }
    expect(flat(highlightInto(make("p") as any, "Deploy <b>x</b>", ["deploy", "<b>"]))).toEqual(["text:", "mark:Deploy", "text: ", "mark:<b>", "text:x</b>"]);
  });
});

describe("term matching", () => {
  const r = row("blue-fox", { task: "Fix the Deploy script", worktreeBranch: "am/blue-fox", spawnedBy: "lead-1", host: "lab", provider: "codex" });
  test("every term must appear in the details, case-insensitively", () => {
    expect(queryTerms("  Deploy   LIGHTHOUSE ")).toEqual(["deploy", "lighthouse"]);
    for (const query of ["deploy", "blue fox", "am/blue", "lead-1", "codex", "lab", "lighthouse", "worktrees", ""]) expect(matchesTerms(r, queryTerms(query))).toBe(true);
    expect(matchesTerms(r, queryTerms("deploy nothing"))).toBe(false);
    expect(matchesTerms(row("x"), queryTerms("local"))).toBe(true);
    expect(matchesTerms(row("x", { host: "lab" }), queryTerms("local"))).toBe(false);
  });
  test("a conversation hit includes an agent its details do not match", () => {
    const rows = [entry(row("a")), entry(row("b"))];
    expect(names(filterRows(rows, ["zebra"], filters()))).toEqual([]);
    expect(names(filterRows(rows, ["zebra"], filters(), (key) => key === "c1/b"))).toEqual(["b"]);
    // Filters still apply to conversation hits.
    expect(names(filterRows(rows, ["zebra"], filters({ status: "finished" }), (key) => key === "c1/b"))).toEqual([]);
  });
  test("conversation queries follow the bridge's rule: 2 code points, 256 UTF-8 bytes, no control characters", () => {
    expect(validConversationQuery("a")).toBe(false);
    expect(validConversationQuery("ab")).toBe(true);
    expect(validConversationQuery("  ab  ")).toBe(true);
    expect(validConversationQuery("x".repeat(256))).toBe(true);
    expect(validConversationQuery("x".repeat(257))).toBe(false);
    expect(validConversationQuery("é".repeat(128))).toBe(true);
    expect(validConversationQuery("é".repeat(129))).toBe(false);
    expect(validConversationQuery("🙂")).toBe(false);
    expect(validConversationQuery("🙂🙂")).toBe(true);
    expect(validConversationQuery("a\u0007b")).toBe(false);
  });
});

describe("filters", () => {
  const rows = [
    entry(row("w", { status: "working", repoRoot: "/r/one", provider: "codex" })),
    entry(row("i", { status: "idle", repoRoot: undefined, dir: "/r/two" })),
    entry(row("e", { status: "exited", host: "lab", provider: "antigravity" })),
    entry(row("d", { status: "dead", host: "lab" })),
  ];
  const by = (overrides: Partial<SearchFilters>) => names(filterRows(rows, [], filters(overrides))).sort();
  test("repository, host, provider", () => {
    expect(by({ repository: "/r/one" })).toEqual(["w"]);
    expect(by({ repository: "/r/two" })).toEqual(["i"]);
    expect(by({ host: "local" })).toEqual(["i", "w"]);
    expect(by({ host: "lab" })).toEqual(["d", "e"]);
    expect(by({ provider: "codex" })).toEqual(["w"]);
    expect(by({ provider: "antigravity", host: "lab" })).toEqual(["e"]);
  });
  test("status: live, finished or one status", () => {
    expect(by({ status: "live" })).toEqual(["i", "w"]);
    expect(by({ status: "finished" })).toEqual(["d", "e"]);
    expect(by({ status: "exited" })).toEqual(["e"]);
    expect(by({ status: "starting" })).toEqual([]);
  });
  test("select values are sorted, unique, and keep a vanished choice", () => {
    expect(optionValues(["b", "a", "b"], "")).toEqual(["a", "b"]);
    expect(optionValues(["b", "a"], "gone")).toEqual(["a", "b", "gone"]);
    expect(optionValues(["b", "a"], "a")).toEqual(["a", "b"]);
  });
});

describe("sorts", () => {
  const now = T0 + 3 * 3600_000;
  const rows = () => [
    entry(row("charlie", { status: "working", statusChangedAt: iso(2 * 3600_000), updatedAt: iso(1000), repoRoot: "/b" })),
    entry(row("alpha", { status: "idle", updatedAt: iso(3000), repoRoot: "/c" })),
    entry(row("bravo", { status: "waiting", statusChangedAt: iso(0), updatedAt: iso(2000), repoRoot: "/a" })),
    entry(row("delta", { status: "exited", updatedAt: iso(2000), repoRoot: "/a" })),
  ];
  const sorted = (sort: SortKey) => names(sortRows(rows(), sort, now));
  test("as the browser UI orders them, quirks included", () => {
    expect(sorted("recent")).toEqual(["alpha", "bravo", "delta", "charlie"]);
    // Not working or waiting counts as -1: last, by name.
    expect(sorted("runtime")).toEqual(["bravo", "charlie", "alpha", "delta"]);
    expect(sorted("repo")).toEqual(["bravo", "delta", "charlie", "alpha"]);
    // Status strings compare alphabetically, not by urgency.
    expect(sorted("status")).toEqual(["delta", "alpha", "bravo", "charlie"]);
    // "name" has no branch of its own: the tie-break orders by name.
    expect(sorted("name")).toEqual(["alpha", "bravo", "charlie", "delta"]);
  });
  test("runtime and elapsed", () => {
    expect(runtime(row("x", { status: "idle" }), now)).toBe(-1);
    expect(runtime(row("x", { status: "working", statusChangedAt: "nope" }), now)).toBe(-1);
    expect(runtime(row("x", { status: "working", statusChangedAt: iso(0) }), now)).toBe(3 * 3600_000);
    expect([-1, 0, 59_000, 60_000, 59 * 60_000, 61 * 60_000, 25 * 3600_000].map(elapsed)).toEqual(["—", "<1m", "<1m", "1m", "59m", "1h 1m", "1d 1h"]);
  });
});

describe("conversation responses", () => {
  test("snippets are keyed by connection and host:name, shaped and capped at three", () => {
    const snippet = (text: string) => ({ kind: "assistant", text, extra: true });
    const result = readResponse("c1", "Home", {
      status: 200,
      body: {
        matches: [
          { name: "a", snippets: [snippet("1"), snippet("2"), snippet("3"), snippet("4")] },
          { name: "b", host: "lab", snippets: [{ kind: "user", text: "hi" }, { kind: 3, text: "bad" }, null] },
          { host: "lab" },
          { name: "c", snippets: "nope" },
        ],
        partial: true,
        unavailable: ["far", 7],
      },
    });
    expect(result.error).toBeUndefined();
    expect(result.partial).toBe(true);
    expect(result.unavailable).toEqual(["far"]);
    expect([...result.matches!.keys()]).toEqual(["c1/a", "c1/lab:b", "c1/c"]);
    expect(result.matches!.get("c1/a")).toEqual([{ kind: "assistant", text: "1" }, { kind: "assistant", text: "2" }, { kind: "assistant", text: "3" }]);
    expect(result.matches!.get("c1/lab:b")).toEqual([{ kind: "user", text: "hi" }]);
    expect(result.matches!.get("c1/c")).toEqual([]);
    expect(readResponse("c1", "Home", { status: 200, body: null }).matches!.size).toBe(0);
    expect(["user", "assistant", "tool"].map(snippetLabel)).toEqual(["You", "Agent", "tool"]);
  });
  test("errors: busy, the server's 400 message, other statuses, rejected calls", () => {
    expect(readResponse("c1", "Home", { status: 429, body: { error: "anything" } }).error).toBe(BUSY_MESSAGE);
    expect(readResponse("c1", "Home", { status: 429, body: null }).error).toBe("Search is busy. Try again shortly.");
    expect(readResponse("c1", "Home", { status: 400, body: { error: "Search must contain 2–256 characters" } }).error).toBe("Search must contain 2–256 characters");
    expect(readResponse("c1", "Home", { status: 401, body: {} }).error).toBe("Token rejected (401)");
    expect(readResponse("c1", "Home", { status: 502, body: {} }).error).toBe("HTTP 502");
    expect(failure("c1", "Home", new Error("invalid query")).error).toBe("invalid query");
    expect(failure("c1", "Home", "timed out").error).toBe("timed out");
  });
});

describe("sequence handling and connections", () => {
  const conns = [{ id: "c1", name: "Home" }, { id: "c2", name: "Lab" }];
  const ok = (connection: string, name: string, matches: unknown[] = [], extra = {}) =>
    readResponse(connection, name, { status: 200, body: { matches, partial: false, unavailable: [], ...extra } });
  test("responses for an older search or an unknown connection are dropped", () => {
    const first = beginSearch("deploy", 1, conns);
    const second = beginSearch("deploy", 2, conns);
    expect(applyResult(second, 1, ok("c1", "Home"))).toBe(false);
    expect(second.results.get("c1")!.pending).toBe(true);
    expect(applyResult(second, 2, ok("c3", "Other"))).toBe(false);
    expect(applyResult(null, 2, ok("c1", "Home"))).toBe(false);
    expect(applyResult(second, 2, ok("c1", "Home"))).toBe(true);
    expect(second.results.get("c1")!.pending).toBe(false);
    expect(first.results.get("c1")!.pending).toBe(true);
  });
  test("results merge across connections; one failure leaves the others' results", () => {
    const search = beginSearch("deploy", 1, conns);
    expect(summaryText(0, 4, "conversations", search)).toBe("0 of 4 agents · includes child and finished agents · Searching conversations…");
    applyResult(search, 1, ok("c1", "Home", [{ name: "a", snippets: [{ kind: "user", text: "deploy it" }] }], { unavailable: ["far"] }));
    expect(summaryText(1, 4, "conversations", search)).toContain("Searching conversations…");
    applyResult(search, 1, readResponse("c2", "Lab", { status: 429, body: {} }));
    expect(snippetsFor(search, "c1/a")).toEqual([{ kind: "user", text: "deploy it" }]);
    expect(snippetsFor(search, "c2/a")).toBeUndefined();
    const rows = [entry(row("a")), entry(row("a"), "c2", "Lab")];
    expect(filterRows(rows, ["zebra"], filters(), (key) => !!snippetsFor(search, key)).map((item) => item.key)).toEqual(["c1/a"]);
    expect(summaryText(1, 4, "conversations", search)).toBe(
      "1 of 4 agents · includes child and finished agents · Lab: Search is busy. Try again shortly. · Conversation search complete · up to 3 snippets per agent Unavailable hosts: Home: far");
  });
  test("summary for one connection reads as in the browser UI", () => {
    const one = [{ id: "c1", name: "Home" }];
    expect(summaryText(3, 5, "agents", null)).toBe("3 of 5 agents · includes child and finished agents");
    expect(summaryText(3, 5, "conversations", null)).toBe("3 of 5 agents · includes child and finished agents · Press Search or Enter to include conversations.");
    const done = beginSearch("x y", 1, one);
    applyResult(done, 1, ok("c1", "Home", [], { partial: true, unavailable: ["lab", "far"] }));
    expect(summaryText(0, 5, "conversations", done)).toBe(
      "0 of 5 agents · includes child and finished agents · Partial results: search reached a limit or some transcripts were unavailable. Unavailable hosts: lab, far");
    const failed = beginSearch("x y", 1, one);
    applyResult(failed, 1, failure("c1", "Home", new Error("Dev bridge unreachable")));
    expect(summaryText(0, 5, "conversations", failed)).toBe("0 of 5 agents · includes child and finished agents · Dev bridge unreachable");
    const complete = beginSearch("x y", 1, one);
    applyResult(complete, 1, ok("c1", "Home"));
    expect(summaryText(0, 5, "conversations", complete)).toBe("0 of 5 agents · includes child and finished agents · Conversation search complete · up to 3 snippets per agent");
  });
});
