import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
const source = readFileSync(new URL("../web/app.js", import.meta.url), "utf8");

test("latest affordance only marks a visible chat read when at bottom", () => {
  const view = { scrollHeight: 2000, scrollTop: 0, clientHeight: 500, dataset: { lastIndex: "42" } };
  const button = { hidden: true };
  const state = { selected: "example", detailMode: "chat", lastRead: new Map() };
  const context: any = { state, $: (id: string) => id === "transcript" ? view : button };
  runInNewContext(source.slice(source.indexOf("function updateLatestButton("), source.indexOf('$("transcript").addEventListener')), context);
  context.updateLatestButton();
  expect(button.hidden).toBe(false);
  expect(state.lastRead.size).toBe(0);
  view.scrollTop = 1500;
  state.detailMode = "terminal";
  context.updateLatestButton();
  expect(state.lastRead.size).toBe(0);
  state.detailMode = "chat";
  context.updateLatestButton();
  expect(button.hidden).toBe(true);
  expect(state.lastRead.get("example")).toBe(42);
});

test("detail-first refresh advances the seen snapshot only when the selected detail is visible", async () => {
  const start = source.indexOf("function markDetailSeen(");
  const end = source.indexOf("async function refreshDetail", start);
  const state = { detailMode: "chat", lastSeen: new Map<string, string>() };
  const context: any = { state };
  runInNewContext(source.slice(start, end), context);
  const detail = Promise.resolve({ updatedAt: "2026-11-10T16:02:00.000Z" });
  const fleet = new Promise<{ rows: { updatedAt: string }[] }>(resolve =>
    queueMicrotask(() => resolve({ rows: [{ updatedAt: "2026-11-10T16:02:00.000Z" }] })));

  context.markDetailSeen("example", (await detail).updatedAt, true);
  const rows = (await fleet).rows;
  expect(state.lastSeen.get("example")).toBe(rows[0]!.updatedAt);
  expect(rows[0]!.updatedAt > state.lastSeen.get("example")!).toBe(false);

  context.markDetailSeen("example", "2026-11-10T16:03:00.000Z", false);
  expect(state.lastSeen.get("example")).toBe("2026-11-10T16:02:00.000Z");
  state.detailMode = "terminal";
  context.markDetailSeen("example", "2026-11-10T16:03:00.000Z", false);
  expect(state.lastSeen.get("example")).toBe("2026-11-10T16:03:00.000Z");
  context.markDetailSeen("example", "2026-11-10T16:01:00.000Z", true);
  expect(state.lastSeen.get("example")).toBe("2026-11-10T16:03:00.000Z");
});

test("palette filters agents and routes to the selected host without executing lifecycle actions", () => {
  const nodes = new Map<string, any>();
  const node = (id: string) => {
    if (!nodes.has(id)) nodes.set(id, { value: "", children: [], append(child: any) { this.children.push(child); }, replaceChildren() { this.children = []; }, get childNodes() { return this.children; }, close() {} });
    return nodes.get(id);
  };
  const selected: string[] = [];
  const state = { selected: null, rows: [{ name: "example", host: "remote", status: "idle" }] };
  const context: any = { state, $: node, el: (tag: string, cls: string, text: string) => ({ tag, cls, text }), showOverview() {}, createDialog() {}, repoName: () => "repo", statusName: (s: string) => s, key: (r: any) => `${r.host}:${r.name}`, selectAgent: (key: string) => selected.push(key) };
  runInNewContext(source.slice(source.indexOf("function renderCommands("), source.indexOf("function openCommands(")), context);
  node("command-query").value = "remote";
  context.renderCommands();
  expect(node("command-results").children.length).toBe(1);
  expect(selected).toEqual([]);
  node("command-results").children[0].onclick();
  expect(selected).toEqual(["remote:example"]);
  node("command-query").value = "does-not-exist";
  context.renderCommands();
  expect(node("command-results").children[0].text).toBe("No matching commands or agents.");
});
