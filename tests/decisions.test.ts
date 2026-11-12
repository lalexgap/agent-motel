import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseOpenDecisions, readOpenDecisions } from "../src/decisions";

let home: string;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), "am-decisions-")); process.env.DECISIONS_HOME = home; });
afterEach(() => { rmSync(home, { recursive: true, force: true }); delete process.env.DECISIONS_HOME; });

const item = (overrides: object = {}) => ({ id: "d-1", status: "open", question: " Ship behind\n a flag? ", blocking: true, asked_at: "2026-07-22T10:00:00Z", link: null, ...overrides });
const store = (decisions: unknown[], version = 1) => JSON.stringify({ version, agent: "worker", decisions });

test("reads open decisions and the PRs they are about", () => {
  const open = parseOpenDecisions(store([
    item({ link: "https://github.com/owner/repo/pull/7/files#diff-1" }),
    item({ id: "d-2", link: "https://drop.example/x", prs: ["https://github.com/owner/repo/pull/8", "https://github.com/owner/repo/pull/8?x=1", "not a url"] }),
    item({ id: "d-3", blocking: "yes", link: "javascript:alert(1)", asked_at: "soon" }),
    item({ id: "d-4", status: "decided" }),
    item({ id: "d-5", status: "withdrawn" }),
    { status: "open" },
  ]));
  expect(open).toEqual([
    { id: "d-1", question: "Ship behind a flag?", blocking: true, askedAt: "2026-07-22T10:00:00Z", link: "https://github.com/owner/repo/pull/7/files#diff-1", prs: ["https://github.com/owner/repo/pull/7"] },
    { id: "d-2", question: "Ship behind a flag?", blocking: true, askedAt: "2026-07-22T10:00:00Z", link: "https://drop.example/x", prs: ["https://github.com/owner/repo/pull/8"] },
    { id: "d-3", question: "Ship behind a flag?", blocking: false, prs: [] },
  ]);
});

test("strips control characters from a question", () => {
  expect(parseOpenDecisions(store([item({ question: "Ship\x1b[2J it?\x07" })]))[0]!.question).toBe("Ship [2J it?");
});

test("ignores a store it does not understand rather than guessing", () => {
  expect(parseOpenDecisions("{not json")).toEqual([]);
  expect(parseOpenDecisions(store([item()], 2))).toEqual([]);
  expect(parseOpenDecisions(JSON.stringify({ version: 1, decisions: {} }))).toEqual([]);
  expect(readOpenDecisions("nobody")).toEqual([]);
});

test("finds an agent's store by the CLI's file naming", () => {
  writeFileSync(join(home, "host-worker.json"), store([item()]));
  expect(readOpenDecisions("host:worker").map(decision => decision.id)).toEqual(["d-1"]);
});
