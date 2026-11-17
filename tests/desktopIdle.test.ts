import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { isActive, pollIntervals } from "../desktop/src/activity";
import { appendedEntries, type RenderedEntries } from "../desktop/src/transcriptAppend";
import type { TranscriptEntry } from "../desktop/src/types";

describe("pollIntervals", () => {
  test("a focused window polls at the normal rate", () => {
    expect(isActive({ hidden: false, focused: true })).toBe(true);
    expect(pollIntervals({ hidden: false, focused: true })).toEqual({ fleetMs: 5000, detailMs: 4000 });
  });

  test("an unfocused window polls less often", () => {
    expect(isActive({ hidden: false, focused: false })).toBe(false);
    expect(pollIntervals({ hidden: false, focused: false })).toEqual({ fleetMs: 15_000, detailMs: 15_000 });
  });

  test("a hidden window does not poll", () => {
    expect(pollIntervals({ hidden: true, focused: true })).toBeNull();
    expect(pollIntervals({ hidden: true, focused: false })).toBeNull();
  });
});

describe("appendedEntries", () => {
  const user = (index: number): TranscriptEntry => ({ index, kind: "user", text: `u${index}` });
  const assistant = (index: number, text = `a${index}`): TranscriptEntry => ({ index, kind: "assistant", text });
  const tool = (index: number): TranscriptEntry => ({ index, kind: "tool", name: "Bash", input: "ls", output: "" });
  const rendered = (entries: TranscriptEntry[], extra: Partial<RenderedEntries> = {}): RenderedEntries =>
    ({ key: "a", agentName: "a", readBoundary: null, prints: entries.map((entry) => JSON.stringify(entry)), ...extra });

  test("returns only the new entries when the old ones are unchanged", () => {
    const old = [user(0), assistant(1)];
    const next = [...old, tool(2), assistant(3)];
    expect(appendedEntries(rendered(old), rendered(next), next)).toEqual([tool(2), assistant(3)]);
  });

  test("re-renders when an old entry changed, nothing was added, or the view started empty", () => {
    const old = [user(0), assistant(1)];
    const edited = [user(0), assistant(1, "longer"), user(2)];
    expect(appendedEntries(rendered(old), rendered(edited), edited)).toBeNull();
    expect(appendedEntries(rendered(old), rendered(old), old)).toBeNull();
    expect(appendedEntries(rendered([]), rendered(old), old)).toBeNull();
    expect(appendedEntries(null, rendered(old), old)).toBeNull();
  });

  test("re-renders for another agent, name or read boundary", () => {
    const old = [user(0)];
    const next = [user(0), assistant(1)];
    expect(appendedEntries(rendered(old), rendered(next, { key: "b" }), next)).toBeNull();
    expect(appendedEntries(rendered(old), rendered(next, { agentName: "b" }), next)).toBeNull();
    expect(appendedEntries(rendered(old), rendered(next, { readBoundary: 0 }), next)).toBeNull();
  });

  test("a tool entry after a rendered tool entry re-renders their shared group", () => {
    const old = [user(0), tool(1)];
    expect(appendedEntries(rendered(old), rendered([...old, tool(2)]), [...old, tool(2)])).toBeNull();
    expect(appendedEntries(rendered(old), rendered([...old, assistant(2)]), [...old, assistant(2)])).toEqual([assistant(2)]);
  });
});

test("the working label animates opacity only, and nothing animates while the window is inactive", () => {
  const css = readFileSync(new URL("../web/style.css", import.meta.url), "utf8");
  expect(css).not.toContain("working-shine");
  expect(css).toMatch(/:root\[data-inactive\] \.dot, :root\[data-inactive\] \.working-text \{ animation: none; \}/);
});
