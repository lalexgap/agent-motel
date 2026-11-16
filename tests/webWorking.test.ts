import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
const source = readFileSync(new URL("../web/app.js", import.meta.url), "utf8");
function harness() {
  const text = { textContent: "" }, announced = { textContent: "" };
  const box = { hidden: false, dataset: {} as Record<string, string>, querySelector: (selector: string) => selector === "[role=status]" ? announced : text };
  let now = Date.parse("2026-11-16T16:00:00Z"), tick: () => void;
  const context: any = { $: () => box, Date: { parse: Date.parse, now: () => now }, document: { querySelectorAll: () => box.hidden ? [] : [box] }, setInterval: (callback: () => void) => { tick = callback; } };
  runInNewContext(source.slice(source.indexOf("function workingLabel("), source.indexOf('const transcriptQueue =')), context);
  return { context, box, text, announced, advance: (ms: number) => { now += ms; tick!(); } };
}
test("browser clocks tick without SSE, suppress zero, and keep announcements stable", () => {
  const h = harness();
  h.context.showWorking("chat-working", { status: "working", workingSince: "2026-11-16T16:00:00Z", statusChangedAt: "2026-11-16T15:00:00Z" });
  expect(h.text.textContent).toBe("Working…");
  h.advance(1000); expect(h.text.textContent).toBe("Working…");
  h.advance(1000); expect(h.text.textContent).toBe("Working · 2s");
  h.advance(63000); expect(h.text.textContent).toBe("Working · 1m 05s");
  expect(h.announced.textContent).toBe("Working");
});
test("anchors use valid turn timestamps, but derived waiting uses the idle transition", () => {
  const {context: c} = harness();
  const row = { status: "working", workingSince: "bad", promptAt: "2026-11-16T15:58:00Z", statusChangedAt: "2026-11-16T15:59:00Z" };
  expect(c.workingAnchor(row)).toBe(Date.parse(row.promptAt));
  expect(c.workingAnchor({...row, rawStatus: "idle", busyWith: {subagents: 1}})).toBe(Date.parse(row.statusChangedAt));
  expect(c.workingAnchor({...row, status: "starting"})).toBe(Date.parse(row.statusChangedAt));
  expect(c.workingText("Working", undefined)).toBe("Working…");
  expect(c.workingText("Working", Date.parse("2027-01-01"))).toBe("Working…");
});
test("waiting names and attention states take precedence over timer animation", () => {
  const h = harness();
  const row = { status: "working", rawStatus: "idle", statusChangedAt: "2026-11-16T15:57:00Z", busyWith: {subagents: 1}, subagents: {running: [{type: "shepherd"}]} };
  h.context.showWorking("chat-working", row);
  expect(h.text.textContent).toBe("Waiting on shepherd · 3m 00s");
  h.context.showWorking("chat-working", {...row, status: "needs-attention", statusReason: "Approve the command"});
  h.advance(2000); expect(h.text.textContent).toBe("Approve the command");
  expect(h.box.dataset.attention).toBe("true");
  h.context.showWorking("chat-working", {...row, blockingDecisions: 1});
  expect(h.text.textContent).toBe("Waiting for your answer");
  h.context.showWorking("chat-working", {status: "exited"}); expect(h.box.hidden).toBe(true);
});
