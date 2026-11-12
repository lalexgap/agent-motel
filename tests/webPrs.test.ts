import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const source = readFileSync(new URL("../web/prs.js", import.meta.url), "utf8");

function load(document?: unknown) {
  const window: any = {};
  runInNewContext(source, { window, URL, ...(document ? { document } : {}) });
  return window.agentPrs;
}

const P = load();
const NOW = Date.parse("2026-07-22T12:00:00.000Z");

function pr(number: number, extra: Record<string, unknown> = {}) {
  return {
    key: `acme/storefront#${number}`,
    repository: "acme/storefront",
    number,
    url: `https://github.com/acme/storefront/pull/${number}`,
    title: `Change ${number}`,
    state: "waiting",
    reason: "CI running (3 pending)",
    needsMe: false,
    lastActivity: "2026-07-22T11:00:00.000Z",
    agent: "importer-dedupe",
    agentName: "importer-dedupe",
    agentStatus: "working",
    ...extra,
  };
}

describe("formatting", () => {
  test("relative time", () => {
    expect(P.relativeTime("2026-07-22T11:59:40.000Z", NOW)).toBe("<1m");
    expect(P.relativeTime("2026-07-22T11:15:00.000Z", NOW)).toBe("45m");
    expect(P.relativeTime("2026-07-22T10:00:00.000Z", NOW)).toBe("2h");
    expect(P.relativeTime("2026-07-19T12:00:00.000Z", NOW)).toBe("3d");
    expect(P.relativeTime(undefined, NOW)).toBe("");
    expect(P.relativeTime("not a date", NOW)).toBe("");
  });

  test("reason line appends the time since the state began", () => {
    expect(P.reasonLine(pr(1, { reason: "conflicts with main", since: "2026-07-22T10:00:00.000Z" }), NOW)).toBe("conflicts with main · 2h");
    expect(P.reasonLine(pr(1, { reason: "head moved since it was marked ready" }), NOW)).toBe("head moved since it was marked ready");
  });

  test("counts line", () => {
    expect(P.countsLine({ open: 8, needsMe: 2, "merge-ready": 1 })).toBe("8 open · 2 need you · 1 merge-ready");
    expect(P.countsLine({ open: 3, needsMe: 1, "merge-ready": 0 })).toBe("3 open · 1 needs you");
    expect(P.countsLine({ open: 0, needsMe: 0 })).toBe("0 open");
    expect(P.countsLine(undefined)).toBe("");
  });

  test("state labels and agent labels", () => {
    expect(P.STATES).toHaveLength(8);
    expect(P.stateLabel("ci-failing")).toBe("CI failing");
    expect(P.stateLabel("something-new")).toBe("something-new");
    expect(P.agentLabel(pr(1))).toBe("importer-dedupe");
    expect(P.agentLabel(pr(1, { agent: "harbor:tax-lookup-retry", agentName: "tax-lookup-retry", host: "harbor" }))).toBe("tax-lookup-retry on harbor");
  });

  test("secondary notes", () => {
    expect(P.notes(pr(1))).toEqual([]);
    expect(P.notes(pr(1, {
      readyMark: { current: false, note: "not marked with am pr --ready" },
      draft: true,
      alsoTrackedBy: ["cli-cleanup", "harbor:docs-refresh"],
      decision: { id: "d-1", question: "Ship it?", blocking: true, more: 1 },
    }))).toEqual(["not marked with am pr --ready", "draft", "also tracked by cli-cleanup, harbor:docs-refresh", "+1 more decision"]);
    expect(P.notes(pr(1, { decision: { id: "d-1", question: "?", blocking: false, more: 3 } }))).toEqual(["+3 more decisions"]);
  });

  test("notice line for stale agents and unreachable hosts", () => {
    expect(P.noticeLine({ stale: [], unreachable: [] })).toBe("");
    expect(P.noticeLine({ stale: ["harbor:docs-refresh"], unreachable: ["harbor"] }))
      .toBe("GitHub lookups are failing for harbor:docs-refresh; their rows may be out of date. Unreachable hosts: harbor.");
  });
});

describe("filtering", () => {
  const prs = [
    pr(1, { state: "needs-decision", needsMe: true }),
    pr(2, { state: "merge-ready" }),
    pr(57, { repository: "acme/toolbox", key: "acme/toolbox#57", url: "https://github.com/acme/toolbox/pull/57", state: "conflict" }),
    pr(3, { state: "ci-failing", needsMe: true }),
  ];

  test("repo, state and needs-me combine and keep the server's order", () => {
    expect(P.filterPrs(prs, {}).map((p: any) => p.number)).toEqual([1, 2, 57, 3]);
    expect(P.filterPrs(prs, { repo: "acme/toolbox" }).map((p: any) => p.number)).toEqual([57]);
    expect(P.filterPrs(prs, { repo: "ACME/Storefront" }).map((p: any) => p.number)).toEqual([1, 2, 3]);
    expect(P.filterPrs(prs, { needsMe: true }).map((p: any) => p.number)).toEqual([1, 3]);
    expect(P.filterPrs(prs, { needsMe: true, state: "ci-failing" }).map((p: any) => p.number)).toEqual([3]);
    expect(P.filterPrs(prs, { repo: "acme/toolbox", needsMe: true })).toEqual([]);
    expect(P.filterPrs(undefined, {})).toEqual([]);
  });

  test("the list signature changes only when what is drawn would", () => {
    const rows = [pr(1, { lastActivity: "2026-07-22T11:59:30.000Z" }), pr(2, { stack: { position: 2, size: 2, parent: 1, children: [] } })];
    const view = { state: "", showAllFinished: false, expanded: new Set(["acme/storefront#1"]) };
    const base = P.listSignature(rows, 0, view, NOW);
    expect(P.listSignature(rows.map((row) => ({ ...row })), 0, { ...view, expanded: new Set(["acme/storefront#1"]) }, NOW + 20_000)).toBe(base);
    expect(P.listSignature(rows, 0, view, NOW + 40_000)).not.toBe(base);
    expect(P.listSignature(rows, 0, { ...view, state: "merged" }, NOW)).not.toBe(base);
    expect(P.listSignature([rows[0], { ...rows[1], reason: "CI green" }], 0, view, NOW)).not.toBe(base);
    expect(P.listSignature(rows, 3, view, NOW)).not.toBe(base);
    expect(P.listSignature(rows, 0, { ...view, expanded: new Set() }, NOW)).not.toBe(base);
    expect(P.listSignature(rows, 0, { ...view, showAllFinished: true }, NOW)).not.toBe(base);
  });

  test("finished PRs past the latest few wait behind a show-more row", () => {
    const open = [{ number: 1, state: "waiting" }, { number: 2, state: "conflict" }];
    const finished = Array.from({ length: 11 }, (_item, index) => ({ number: 10 + index, state: index % 2 ? "closed" : "merged" }));
    const all = [...open, ...finished];
    const collapsed = P.visibleRows(all);
    expect(collapsed.hidden).toBe(3);
    expect(collapsed.rows.map((p: any) => p.number)).toEqual([1, 2, 10, 11, 12, 13, 14, 15, 16, 17]);
    expect(P.visibleRows(all, { showAllFinished: true })).toEqual({ rows: all, hidden: 0 });
    expect(P.visibleRows(all, { state: "merged" }).hidden).toBe(0);
    expect(P.visibleRows(all, { state: "waiting" }).hidden).toBe(3);
    expect(P.visibleRows(open)).toEqual({ rows: open, hidden: 0 });
    expect(P.visibleRows(undefined)).toEqual({ rows: [], hidden: 0 });
  });

  test("repo options are distinct and sorted", () => {
    expect(P.repoOptions(prs)).toEqual(["acme/storefront", "acme/toolbox"]);
    expect(P.repoOptions(undefined)).toEqual([]);
  });
});

describe("links", () => {
  test("only GitHub pull request URLs are linked", () => {
    expect(P.safePrUrl("https://github.com/acme/storefront/pull/412")).toBe("https://github.com/acme/storefront/pull/412");
    expect(P.safePrUrl("https://github.com/acme/store.front-2/pull/1")).toBe("https://github.com/acme/store.front-2/pull/1");
    for (const bad of [
      "http://github.com/acme/storefront/pull/412",
      "https://github.com/acme/storefront/pull/412/files",
      "https://github.com.evil.example/acme/storefront/pull/412",
      "https://github.com/acme/storefront/issues/412",
      "javascript:alert(1)//https://github.com/acme/storefront/pull/1",
      "https://github.com/acme/storefront/pull/412\nhttps://evil.example",
      undefined,
    ]) expect(P.safePrUrl(bad)).toBeNull();
  });

  test("decision links require https", () => {
    expect(P.safeLink("https://example.com/decisions/d-3")).toBe("https://example.com/decisions/d-3");
    expect(P.safeLink("http://example.com/decisions/d-3")).toBeNull();
    expect(P.safeLink("javascript:alert(1)")).toBeNull();
    expect(P.safeLink("see the thread")).toBeNull();
    expect(P.safeLink(undefined)).toBeNull();
  });
});

test("nudge text names the PR, its state and reason", () => {
  expect(P.nudgeText(pr(405, { state: "merge-ready", reason: "merge-ready: CI green, shepherd verdict" })))
    .toBe("PR #405 (https://github.com/acme/storefront/pull/405) is merge-ready: merge-ready: CI green, shepherd verdict. What is its status, and what do you need to move it forward?");
  expect(P.nudgeText(pr(412, { state: "needs-decision", reason: "needs decision: Hold or drop?" })))
    .toBe("PR #412 (https://github.com/acme/storefront/pull/412) is needs-decision: needs decision: Hold or drop? What is its status, and what do you need to move it forward?");
});

describe("stacks", () => {
  const bottom = pr(409, { stack: { position: 1, size: 3, children: [410] } });
  const middle = pr(410, { stack: { position: 2, size: 3, parent: 409, children: [411] } });
  const top = pr(411, { stack: { position: 3, size: 3, parent: 410, children: [] } });
  const other = pr(500);

  test("label and tooltip", () => {
    expect(P.stackLabel(middle)).toBe("2/3");
    expect(P.stackLabel(other)).toBe("");
    expect(P.stackTitle(middle)).toBe("Stack position 2 of 3 · based on #409 · #411 builds on it");
    expect(P.stackTitle(bottom)).toBe("Stack position 1 of 3 · #410 builds on it");
    expect(P.stackTitle(pr(1, { stack: { position: 1, size: 2, children: [2, 3] } }))).toBe("Stack position 1 of 2 · #2, #3 build on it");
    expect(P.stackTitle(other)).toBe("");
  });

  test("adjacent parent/child rows chain without reordering", () => {
    expect(P.stackChains([bottom, middle, top])).toEqual([{ up: false, down: true }, { up: true, down: true }, { up: true, down: false }]);
    expect(P.stackChains([bottom, other, middle, top])).toEqual([
      { up: false, down: false }, { up: false, down: false }, { up: false, down: true }, { up: true, down: false },
    ]);
    // Reverse order still reads as linked neighbours.
    expect(P.stackChains([top, middle])).toEqual([{ up: false, down: true }, { up: true, down: false }]);
    // The same number in another repository is not a parent.
    const elsewhere = pr(410, { repository: "acme/toolbox", stack: { position: 2, size: 2, parent: 409, children: [] } });
    expect(P.stackChains([bottom, elsewhere])).toEqual([{ up: false, down: false }, { up: false, down: false }]);
    expect(P.stackChains([])).toEqual([]);
  });
});

test("builds DOM without innerHTML and never fetches", () => {
  expect(source).not.toMatch(/innerHTML|insertAdjacentHTML|outerHTML/);
  expect(source).not.toMatch(/\bfetch\(|EventSource|localStorage|\bapi\(/);
});

test("buildPage builds the same skeleton as index.html's PRs page", () => {
  class Node {
    attrs: [string, string][] = [];
    children: (Node | string)[] = [];
    constructor(readonly tag: string) {}
    setAttribute(name: string, value: string) { this.attrs.push([name, value]); }
    append(...nodes: (Node | string)[]) { this.children.push(...nodes); }
    get html(): string {
      const attrs = this.attrs.map(([name, value]) => (name === "hidden" ? ` ${name}` : ` ${name}="${value.replace(/&/g, "&amp;").replace(/"/g, "&quot;")}"`)).join("");
      const inner = this.children.map(child => typeof child === "string" ? child.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;") : child.html).join("");
      return `<${this.tag}${attrs}>${inner}</${this.tag}>`;
    }
  }
  const prs = load({ createElement: (tag: string) => new Node(tag) });
  const root = new Node("section");
  prs.buildPage(root);
  const html = readFileSync(new URL("../web/index.html", import.meta.url), "utf8");
  const page = html.slice(html.indexOf('<section id="prs-page"'), html.indexOf('<section id="usage-page"'));
  const inner = page.slice(page.indexOf(">") + 1, page.lastIndexOf("</section>")).replace(/>\s+</g, "><").trim();
  expect(root.html.slice("<section>".length, -"</section>".length)).toBe(inner);
});

test("the page loads prs.js before app.js, the server serves it, and the nav links to it", () => {
  const html = readFileSync(new URL("../web/index.html", import.meta.url), "utf8");
  const server = readFileSync(new URL("../src/server.ts", import.meta.url), "utf8");
  const app = readFileSync(new URL("../web/app.js", import.meta.url), "utf8");
  expect(html.indexOf('<script src="/prs.js" defer></script>')).toBeGreaterThan(-1);
  expect(html.indexOf("/prs.js")).toBeLessThan(html.indexOf("/app.js"));
  expect(server).toContain('"/prs.js": "web/prs.js"');
  expect(html).toMatch(/<button id="prs-nav" class="nav"/);
  expect(html).toMatch(/<b id="prs-count" hidden>/);
  expect(app).toContain('["Pull requests", () => $("prs-nav").click()]');
});
