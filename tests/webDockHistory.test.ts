import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const source = readFileSync(new URL("../web/app.js", import.meta.url), "utf8");
const context: any = {};
runInNewContext(source.slice(source.indexOf("function dockHistoryEntries("), source.indexOf("async function refreshDock(")), context);
const turns = (count: number) => Array.from({ length: count }, (_, index) => ({ kind: index % 2 ? "assistant" : "user", index, text: `Message ${index}` }));
const load = (view: any, entries: any[], sessionId: string | null = "session-a", name = "concierge") =>
  context.dockHistoryEntries(view, { entries, sessionId }, name).map((entry: any) => entry.index);

describe("Concierge history", () => {
  test("starts with 20 messages, then retains every displayed message as new messages arrive", () => {
    const view = { dataset: {} };
    expect(load(view, turns(25))).toEqual(Array.from({ length: 20 }, (_, i) => i + 5));
    expect(load(view, turns(26))).toEqual(Array.from({ length: 21 }, (_, i) => i + 5));
    expect(load(view, turns(70))).toEqual(Array.from({ length: 65 }, (_, i) => i + 5));
  });

  test("ignores tools when choosing the starting message, using stable full-transcript indexes", () => {
    const view = { dataset: {} };
    const entries = turns(60).map(entry => ({ ...entry, kind: entry.index % 2 ? "tool" : "assistant" }));
    expect(load(view, entries)).toEqual(Array.from({ length: 20 }, (_, i) => 20 + i * 2));
    expect(load(view, [...entries, { kind: "user", index: 60, text: "New" }])).toEqual([...Array.from({ length: 20 }, (_, i) => 20 + i * 2), 60]);
  });

  test("resets the initial window for a different agent or session", () => {
    const view = { dataset: {} };
    load(view, turns(25));
    expect(load(view, turns(70), "session-b")).toEqual(Array.from({ length: 20 }, (_, i) => 50 + i));
    expect(load(view, turns(80), "session-b", "remote:concierge")).toEqual(Array.from({ length: 20 }, (_, i) => 60 + i));
  });

  test("handles empty transcripts and resets when the old starting message no longer exists", () => {
    const view = { dataset: {} };
    expect(load(view, [])).toEqual([]);
    expect(load(view, turns(2))).toEqual([0, 1]);
    load(view, turns(30), "session-b");
    expect(load(view, turns(3), "session-b")).toEqual([0, 1, 2]);
  });
});
