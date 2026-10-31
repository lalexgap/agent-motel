import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const source = readFileSync(new URL("../web/app.js", import.meta.url), "utf8");

function composer(provider?: string, dock = false, fail = false) {
  const target = "gapserver:training";
  const elements = new Map<string, any>();
  const element = (id: string): any => {
    if (!elements.has(id)) elements.set(id, {
      value: id === "message" || id === "dock-message" ? "Keep this prompt" : "",
      disabled: false, textContent: "", querySelector: () => element("dock-button"),
    });
    return elements.get(id);
  };
  const calls: { path: string; body: any }[] = [];
  const pending: any[] = [];
  const notices: string[] = [];
  const state = {
    selected: target, authenticated: true, sessionEpoch: 1, rows: provider ? [{ name: "training", host: "gapserver", provider }] : [],
    sending: new Map(), draftRevisions: new Map(), drafts: new Map([[target, "Keep this prompt"]]),
    attachments: new Map(), dockRevision: 0, dockBusy: false, conciergeKey: null,
    detailCapabilities: null as any,
  };
  const context = {
    $, state, key: (row: any) => row.host ? `${row.host}:${row.name}` : row.name,
    agentAttachments: () => [], uploadsPending: () => false,
    renderAttachments: () => { element("message-send").disabled = state.sending.has(target); },
    refreshDetail: async () => {}, refreshDock: async () => {},
    notice: (text: string) => notices.push(text), notePending: (...args: any[]) => pending.push(args),
    api: async (path: string, body: any) => {
      if (path === "/api/concierge") return { key: target };
      calls.push({ path, body });
      if (fail) throw new Error("delivery refused");
      return { id: "receipt-1" };
    },
  };
  function $(id: string) { return element(id); }
  const helperStart = source.indexOf("function messageSendMode(");
  if (helperStart >= 0) runInNewContext(source.slice(helperStart, source.indexOf('$("message").oninput', helperStart)), context);
  const start = source.indexOf(dock ? '$("dock-form").onsubmit' : '$("message-form").onsubmit');
  const end = source.indexOf(dock ? '$("dock-message").oninput' : "const IMAGE_TYPES", start);
  runInNewContext(source.slice(start, end), context);
  return {
    state, calls, pending, notices, element,
    submit: () => element(dock ? "dock-form" : "message-form").onsubmit({ preventDefault() {} }),
  };
}

for (const dock of [false, true]) describe(dock ? "concierge composer" : "agent composer", () => {
  test.each(["idle", "working"])("queues Antigravity messages while %s", async (status) => {
    const c = composer("antigravity", dock);
    Object.assign(c.state.rows[0]!, { status });
    await c.submit();
    expect(c.calls).toEqual([{ path: "/api/agents/gapserver%3Atraining/messages", body: { text: "Keep this prompt", mode: "queue" } }]);
    expect(c.pending).toEqual([["gapserver:training", "Keep this prompt", "receipt-1"]]);
    expect(c.element(dock ? "dock-message" : "message").value).toBe("");
  });

  test.each(["claude", "codex"])("preserves %s immediate delivery", async (provider) => {
    const c = composer(provider, dock);
    await c.submit();
    expect(c.calls[0]!.body.mode).toBe("now");
  });

  test("queues safely before provider metadata loads", async () => {
    const c = composer(undefined, dock);
    await c.submit();
    expect(c.calls[0]!.body.mode).toBe("queue");
  });

  test("uses matching detail metadata when the fleet row is missing", async () => {
    const c = composer(undefined, dock);
    c.state.detailCapabilities = { name: c.state.selected, detail: { provider: "codex" } };
    await c.submit();
    expect(c.calls[0]!.body.mode).toBe("now");
  });

  test("does not use another agent's cached detail", async () => {
    const c = composer(undefined, dock);
    c.state.detailCapabilities = { name: "other", detail: { provider: "codex" } };
    await c.submit();
    expect(c.calls[0]!.body.mode).toBe("queue");
  });

  test("keeps a refused prompt available for retry", async () => {
    const c = composer("antigravity", dock, true);
    await c.submit();
    expect(c.element(dock ? "dock-message" : "message").value).toBe("Keep this prompt");
    expect(c.pending).toHaveLength(0);
    expect(c.state.sending.size).toBe(0);
    expect(c.element(dock ? "dock-button" : "message-send").disabled).toBe(false);
  });
});
