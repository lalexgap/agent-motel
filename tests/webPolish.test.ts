import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
const source = readFileSync(new URL("../web/app.js", import.meta.url), "utf8");

test("latest affordance only marks a visible chat read when at bottom", () => {
  const view = { scrollHeight: 2000, scrollTop: 0, clientHeight: 500, dataset: { lastIndex: "42" } };
  const button = { hidden: true };
  const state = { selected: "example", detailMode: "chat", lastRead: new Map() };
  const context: any = { state, $: (id: string) => id === "transcript" ? view : button, markDisplayedDetailSeen() {} };
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

test("scroll, Jump latest and terminal transitions acknowledge only the displayed detail before leaving", () => {
  for (const transition of ["scroll", "jump", "terminal", "chat-tab"]) {
    const t1 = "2026-11-10T16:01:00.000Z", t2 = "2026-11-10T16:02:00.000Z", t3 = "2026-11-10T16:03:00.000Z";
    const handlers: Record<string, () => void> = {};
    const view = {
      scrollHeight: 2000, scrollTop: 0, clientHeight: 500,
      dataset: { agent: "example", detailVersion: "1", updatedAt: t2, lastIndex: "42" },
      addEventListener: (event: string, handler: () => void) => { handlers[event] = handler; },
    };
    const nodes: Record<string, any> = { transcript: view };
    const node = (id: string) => nodes[id] ??= { hidden: true, setAttribute() {} };
    const state = {
      selected: "example", detailVersion: 1, detailMode: "chat",
      rows: [{ name: "example", updatedAt: t3 }], lastRead: new Map(), lastSeen: new Map([["example", t1]]),
    };
    const context: any = { state, $: node, renderFleet() {}, key: (row: any) => row.name,
      agentTerminal: { open() {}, close() {} } };
    runInNewContext(source.slice(source.indexOf("function markDetailSeen("), source.indexOf("async function refreshDetail(")), context);
    runInNewContext(source.slice(source.indexOf("function updateLatestButton("), source.indexOf("function promptTerminalButton(")), context);
    runInNewContext(source.slice(source.indexOf("function updateAgentView("), source.indexOf("// The Terminal/Chat choice")), context);
    context.setDetailMode = (mode: string) => { state.detailMode = mode; };
    runInNewContext(source.slice(source.indexOf('$("chat-tab").onclick'), source.indexOf('$("terminal-reconnect").onclick')), context);
    context.updateLatestButton();
    expect(state.lastSeen.get("example")).toBe(t1);
    if (transition === "scroll") { view.scrollTop = 1500; handlers.scroll!(); }
    else if (transition === "jump") node("jump-latest").onclick();
    else if (transition === "chat-tab") { state.detailMode = "terminal"; node("chat-tab").onclick(); }
    else { state.detailMode = "terminal"; context.updateAgentView(); }
    expect(state.lastSeen.get("example")).toBe(t2);
    expect(t2 > state.lastSeen.get("example")!).toBe(false);
    if (transition !== "terminal") expect(state.lastRead.get("example")).toBe(42);
    state.selected = "other";
    state.detailVersion++;
    context.updateLatestButton();
    context.updateAgentView();
    expect(state.lastSeen.get("other")).toBeUndefined();
    expect(state.lastSeen.get("example")).toBe(t2);
    // A newer fleet snapshot is still unread, even after viewing the displayed T2 update.
    expect(state.rows[0]!.updatedAt > state.lastSeen.get("example")!).toBe(true);
    state.selected = "example";
    context.markDisplayedDetailSeen(true);
    expect(state.lastSeen.get("example")).toBe(t2);
  }
});
