import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const source = readFileSync(new URL("../web/app.js", import.meta.url), "utf8");
const context: any = {};
runInNewContext(source.slice(source.indexOf("function dockHistoryEntries("), source.indexOf("async function refreshDock(")), context);
const turns = (count: number) => Array.from({ length: count }, (_, index) => ({ kind: index % 2 ? "assistant" : "user", index, text: `Message ${index}` }));
const load = (view: any, entries: any[], sessionId: string | null = "session-a", name = "concierge") =>
  context.dockHistoryEntries(view, { entries, sessionId }, name).map((entry: any) => entry.index);

function conciergeNavigation(savedMode?: string) {
  const elements = new Map<string, any>();
  const element = (id: string): any => {
    if (!elements.has(id)) elements.set(id, {
      hidden: false, value: "", textContent: "", dataset: {}, attributes: {},
      classList: { remove() {}, toggle() {} }, replaceChildren() {},
      setAttribute(name: string, value: string) { this.attributes[name] = value; },
      focus() { this.focused = true; },
    });
    return elements.get(id);
  };
  const question = element("suggested-question");
  question.dataset.ask = "What needs attention?";
  const storage = new Map(savedMode ? [["am.detailMode", savedMode]] : []);
  const writes: string[] = [];
  const state = { selected: null, rows: [], drafts: new Map(), detailVersion: 0, detailMode: "terminal" };
  const vm = {
    state, $: element,
    document: {
      querySelector: () => element("page-heading"),
      querySelectorAll: (selector: string) => selector === "[data-ask]" ? [question] : [],
    },
    localStorage: {
      getItem: (name: string) => storage.get(name) ?? null,
      setItem: (name: string, value: string) => { writes.push(name); storage.set(name, value); },
    },
    agentTerminal: { open() {}, close() {} },
    key: (row: any) => row.name,
    el: () => ({}), notice() {}, renderFleet() {}, refreshWorkspace() {},
    connectEvents() {}, updateDetailMetaToggle() {}, renderAttachments() {},
    refreshDetail: async () => {}, api: async () => ({ key: "concierge" }),
  };
  runInNewContext([
    source.slice(source.indexOf("function updateAgentView("), source.indexOf('$("terminal-reconnect").onclick')),
    source.slice(source.indexOf("function saveDraft("), source.indexOf("function updateDetailMetaToggle(")),
    source.slice(source.indexOf("async function openConcierge("), source.indexOf("function runtimeLabel(")),
  ].join("\n"), vm);
  return { state, element, question, storage, writes };
}

function dockLifecycle() {
  const elements = new Map<string, any>();
  const element = (id: string): any => {
    if (!elements.has(id)) elements.set(id, {
      dataset: {}, children: [], value: "", hidden: false,
      replaceChildren(...nodes: any[]) { this.children = nodes; },
      append(node: any) { this.children.push(node); }, close() {}, reset() {},
    });
    return elements.get(id);
  };
  const state = {
    authenticated: true, selected: null, conciergeKey: "concierge", detailVersion: 0, sessionEpoch: 0, dockRevision: 0,
    rows: [{ name: "concierge" }], drafts: new Map(), draftRevisions: new Map(), sending: new Map(), attachments: new Map(),
  };
  let respond!: (transcript: any) => void;
  const vm: any = {
    state, $: element, key: (row: any) => row.name,
    api: () => new Promise(resolve => { respond = resolve; }),
    showWorking() {}, pendingFor: () => [], preserveConversationScroll: () => () => {},
    chatTurn: (entry: any) => ({ index: entry.index }), el: (_tag: string, _class: string, text: string) => ({ text }),
    agentTerminal: { close() {} }, closeAgentMenu() {}, stopEvents() {}, clearConversationSearch() {},
    pendingSent: new Map(), lastUserTexts: new Map(), handoverSource: null, manageAgent: null, diffRequest: null,
  };
  runInNewContext([
    source.slice(source.indexOf("function lock("), source.indexOf("async function unlock(")),
    source.slice(source.indexOf("function dockHistoryEntries("), source.indexOf('$("dock-form").onsubmit')),
  ].join("\n"), vm);
  return {
    state, view: element("dock-transcript"), lock: () => vm.lock(), refresh: () => vm.refreshDock(),
    respond: (entries: any[], sessionId = "session-a") => respond({ entries, sessionId }),
    async receive(entries: any[], sessionId = "session-a") {
      const pending = vm.refreshDock();
      respond({ entries, sessionId });
      await pending;
    },
  };
}

describe("Concierge navigation", () => {
  test.each([undefined, "terminal", "chat"])("Full conversation opens Chat for this visit with preference %s", async (preference) => {
    const nav = conciergeNavigation(preference);
    const expectMode = (mode: string) => {
      expect(nav.state.selected).toBe("concierge");
      expect(nav.state.detailMode).toBe(mode);
      expect(nav.element("chat-panel").hidden).toBe(mode !== "chat");
      expect(nav.element("terminal-panel").hidden).toBe(mode !== "terminal");
      expect(nav.element("chat-tab").attributes["aria-pressed"]).toBe(String(mode === "chat"));
    };
    await nav.element("expand-concierge").onclick();
    expectMode("chat");
    expect(nav.element("message").value).toBe("");

    await nav.element("concierge-nav").onclick();
    expectMode(preference ?? "terminal");

    await nav.question.onclick();
    expectMode("chat");
    expect(nav.element("message").value).toBe(nav.question.dataset.ask);
    expect(nav.element("message").focused).toBe(true);

    await nav.element("concierge-nav").onclick();
    expectMode(preference ?? "terminal");
    expect(nav.storage.get("am.detailMode")).toBe(preference);
    expect(nav.writes).toEqual([]);
  });
});

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

  test("renders an empty state and starts a fresh window when history returns or the session changes", async () => {
    const dock = dockLifecycle();
    await dock.receive(turns(25));
    expect(dock.view.children[0].index).toBe(5);
    await dock.receive([]);
    expect(dock.view.children).toEqual([{ text: "Send a task or ask about your fleet." }]);
    expect(dock.view.dataset.historyStart).toBeUndefined();
    await dock.receive(turns(70));
    expect(dock.view.children.map((node: any) => node.index)).toEqual(Array.from({ length: 20 }, (_, i) => 50 + i));
    await dock.receive(turns(80), "session-b");
    expect(dock.view.children.map((node: any) => node.index)).toEqual(Array.from({ length: 20 }, (_, i) => 60 + i));
  });

  test.each(["logout", "agent change", "navigation"])("ignores an in-flight transcript after %s", async (change) => {
    const dock = dockLifecycle();
    await dock.receive(turns(25));
    const pending = dock.refresh();
    if (change === "logout") dock.lock();
    else if (change === "agent change") dock.state.conciergeKey = "other:concierge";
    else dock.state.detailVersion++;
    const before = JSON.stringify({ children: dock.view.children, dataset: dock.view.dataset });
    dock.respond(turns(70), "late-session");
    await pending;
    expect(JSON.stringify({ children: dock.view.children, dataset: dock.view.dataset })).toBe(before);
    if (change === "logout") {
      expect(dock.view.children).toEqual([]);
      expect(dock.view.dataset.historyStart).toBeUndefined();
      expect(dock.view.dataset.historySession).toBeUndefined();
      expect(dock.view.dataset.content).toBeUndefined();
      dock.state.authenticated = true;
      dock.state.rows = [{ name: "concierge" }];
      dock.state.conciergeKey = "concierge";
      await dock.receive(turns(70));
      expect(dock.view.children.map((node: any) => node.index)).toEqual(Array.from({ length: 20 }, (_, i) => 50 + i));
    }
  });
});
