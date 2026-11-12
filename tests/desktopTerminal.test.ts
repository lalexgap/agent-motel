import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { selectionAfterRemove } from "../desktop/src/actions";
import { isIsolated, shortcutFor, type Shortcut } from "../desktop/src/keyboard";
import {
  BridgeSocket,
  clientClose,
  CONSENT_DECLINED_TEXT,
  decodeBase64,
  isFocusChord,
  mayReopen,
  MERGE_LIMIT,
  OrderedSender,
  OUTPUT_LIMIT_TEXT,
  parseAgentViewMode,
  parseClientMessage,
  planSignature,
  REAUTH_WINDOW_MS,
  retryControl,
  STOPPED_STATUSES,
  STOPPED_TEXT,
  terminalPlan,
  TerminalOpens,
  TerminalRouter,
  type ClientMessage,
  type TerminalBridge,
} from "../desktop/src/terminalModel";

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("agent view mode", () => {
  test("defaults to chat and only accepts the two modes", () => {
    expect(parseAgentViewMode(null)).toBe("chat");
    expect(parseAgentViewMode("terminal")).toBe("terminal");
    expect(parseAgentViewMode("chat")).toBe("chat");
    expect(parseAgentViewMode("Terminal")).toBe("chat");
    expect(parseAgentViewMode("")).toBe("chat");
  });
});

describe("terminal plan", () => {
  const base = { screen: "fleet", mainView: "chat", mode: "terminal" as const, selected: "c1/keeper-log", connectionKnown: true, status: "idle" };
  test("opens only for the open agent's chat view in Terminal mode", () => {
    expect(terminalPlan(base)).toEqual({ kind: "open", key: "c1/keeper-log", status: "idle" });
    expect(terminalPlan({ ...base, status: undefined })).toEqual({ kind: "open", key: "c1/keeper-log", status: "" });
    for (const change of [
      { mode: "chat" as const }, { mainView: "subagent" }, { mainView: "overview" }, { mainView: "usage" }, { mainView: "search" },
      { mainView: null }, { selected: null }, { connectionKnown: false }, { screen: "setup" },
    ]) expect(terminalPlan({ ...base, ...change })).toEqual({ kind: "closed" });
  });
  test("a stopped agent shows the notice instead of a terminal", () => {
    expect(terminalPlan({ ...base, status: "exited" }).kind).toBe("stopped");
    expect(terminalPlan({ ...base, status: "dead" }).kind).toBe("stopped");
    expect(terminalPlan({ ...base, status: "working" }).kind).toBe("open");
    for (const status of STOPPED_STATUSES) expect(terminalPlan({ ...base, status })).toEqual({ kind: "stopped", key: base.selected, status });
  });
  test("removing the open agent clears the selection, which closes the terminal", () => {
    const selected = selectionAfterRemove(base.selected, base.selected);
    expect(selected).toBeNull();
    expect(terminalPlan({ ...base, selected: selected ?? null, mainView: "overview" })).toEqual({ kind: "closed" });
    expect(selectionAfterRemove(base.selected, "c1/other")).toBeUndefined();
    expect(terminalPlan(base).kind).toBe("open");
  });
  test("signatures change with the agent and stopped state, not the live status", () => {
    const idle = planSignature(terminalPlan(base));
    expect(planSignature(terminalPlan({ ...base, status: "working" }))).toBe(idle);
    expect(planSignature(terminalPlan({ ...base, status: "exited" }))).not.toBe(idle);
    expect(planSignature(terminalPlan({ ...base, selected: "c1/other" }))).not.toBe(idle);
    expect(planSignature({ kind: "closed" })).toBe("closed");
  });
});

describe("client messages", () => {
  test("maps the client's input and resize frames", () => {
    expect(parseClientMessage('{"type":"input","data":"ls\\r"}')).toEqual({ type: "input", data: "ls\r" });
    expect(parseClientMessage('{"type":"resize","cols":120,"rows":40}')).toEqual({ type: "resize", cols: 120, rows: 40 });
  });
  test("clamps sizes to the bridge's limits", () => {
    expect(parseClientMessage('{"type":"resize","cols":1,"rows":1}')).toEqual({ type: "resize", cols: 2, rows: 2 });
    expect(parseClientMessage('{"type":"resize","cols":900,"rows":900}')).toEqual({ type: "resize", cols: 500, rows: 200 });
  });
  test("drops anything else", () => {
    for (const raw of ["", "nope", "null", "[]", '{"type":"input"}', '{"type":"input","data":""}', '{"type":"input","data":3}',
      '{"type":"resize","cols":"80","rows":24}', '{"type":"resize","cols":80.5,"rows":24}', '{"type":"ping"}'])
      expect(parseClientMessage(raw)).toBeNull();
  });
});

describe("closes", () => {
  test("the shell's output cap becomes a no-retry close with the client's wording", () => {
    expect(clientClose(1013, "Output exceeded rendering capacity")).toEqual({ code: 1008, reason: OUTPUT_LIMIT_TEXT });
  });
  test("other codes pass through for the client to handle", () => {
    for (const code of [1000, 1001, 1006, 1008, 1011, 4001]) expect(clientClose(code, "why")).toEqual({ code, reason: "why" });
  });
});

describe("base64 output", () => {
  const bytes = new Uint8Array(70_000).map((_, index) => (index * 31) % 256);
  const encoded = Buffer.from(bytes).toString("base64");
  test("decodes to an ArrayBuffer of the raw bytes", () => {
    const buffer = decodeBase64(encoded);
    expect(buffer).toBeInstanceOf(ArrayBuffer);
    expect(new Uint8Array(buffer)).toEqual(bytes);
    expect(decodeBase64("").byteLength).toBe(0);
  });
  test("the atob fallback decodes the same", () => {
    const native = (Uint8Array as unknown as Record<string, unknown>).fromBase64;
    (Uint8Array as unknown as Record<string, unknown>).fromBase64 = undefined;
    try {
      expect(new Uint8Array(decodeBase64(encoded))).toEqual(bytes);
    } finally {
      (Uint8Array as unknown as Record<string, unknown>).fromBase64 = native;
    }
  });
});

describe("keyboard", () => {
  const key = (overrides: Partial<KeyboardEvent>) =>
    ({ key: "", code: "", ctrlKey: false, shiftKey: false, metaKey: false, altKey: false, defaultPrevented: false, ...overrides }) as KeyboardEvent;
  test("the focus chord is control-shift-backquote by physical key", () => {
    expect(isFocusChord(key({ key: "~", code: "Backquote", ctrlKey: true, shiftKey: true }))).toBe(true);
    expect(isFocusChord(key({ key: "`", code: "IntlBackslash", ctrlKey: true, shiftKey: true }))).toBe(true);
    expect(isFocusChord(key({ key: "`", code: "Backquote", ctrlKey: true }))).toBe(false);
    expect(isFocusChord(key({ key: "~", code: "Backquote", shiftKey: true }))).toBe(false);
    expect(isFocusChord(key({ key: "~", code: "Backquote", ctrlKey: true, shiftKey: true, metaKey: true }))).toBe(false);
    expect(isFocusChord(key({ key: "C", code: "KeyC", ctrlKey: true, shiftKey: true }))).toBe(false);
  });

  // Every shortcut the app registers, as broad as possible: any key, while typing.
  const keys = ["Escape", "Tab", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End", "/", "c", "o", "u", "s", "i", "j", "k",
    "Enter", " ", "a", "z", "ContextMenu", "F10"];
  const ran: string[] = [];
  const shortcuts: Shortcut[] = [
    { keys, whileTyping: true, run: (event) => ran.push(event.key) },
    { keys, run: (event) => ran.push(event.key) },
  ];
  test("no shortcut runs for any key inside an isolated element", () => {
    for (const name of keys) {
      for (const shiftKey of [false, true])
        expect(shortcutFor(shortcuts, key({ key: name, shiftKey }), { screen: "fleet", typing: true, isolated: true })).toBeNull();
    }
    expect(ran).toEqual([]);
  });
  test("isolation is any element inside a data-keyboard-isolated one", () => {
    const saved = (globalThis as { Element?: unknown }).Element;
    class Element {
      constructor(private readonly inside: boolean) {}
      closest(selector: string) { return selector === "[data-keyboard-isolated]" && this.inside ? this : null; }
    }
    (globalThis as { Element?: unknown }).Element = Element;
    try {
      expect(isIsolated(new Element(true) as unknown as EventTarget)).toBe(true);
      expect(isIsolated(new Element(false) as unknown as EventTarget)).toBe(false);
      expect(isIsolated(null)).toBe(false);
    } finally {
      (globalThis as { Element?: unknown }).Element = saved;
    }
  });
  test("outside it the usual rules still apply", () => {
    expect(shortcutFor(shortcuts, key({ key: "Escape" }), { screen: "fleet", typing: true, isolated: false })).toBe(shortcuts[0]!);
    expect(shortcutFor(shortcuts.slice(1), key({ key: "c" }), { screen: "fleet", typing: true, isolated: false })).toBeNull();
    expect(shortcutFor(shortcuts.slice(1), key({ key: "c" }), { screen: "fleet", typing: false, isolated: false })).toBe(shortcuts[1]!);
    expect(shortcutFor(shortcuts, key({ key: "c", ctrlKey: true }), { screen: "fleet", typing: false, isolated: false })).toBeNull();
  });
});

describe("status line control", () => {
  test("hidden while live, connecting, for a stopped agent or with nothing to say", () => {
    for (const status of ["● Live terminal", "Connecting…", "Reconnecting…", STOPPED_TEXT, ""])
      expect(retryControl(status, false).hidden).toBe(true);
  });
  test("offers Reconnect after a failure and Ask again after a declined consent", () => {
    expect(retryControl("Terminal detached · Reconnect to attach", false)).toEqual({ hidden: false, label: "Reconnect" });
    expect(retryControl("Disconnected · reconnecting…", false)).toEqual({ hidden: false, label: "Reconnect" });
    expect(retryControl(CONSENT_DECLINED_TEXT, true)).toEqual({ hidden: false, label: "Ask again" });
    expect(retryControl("Couldn't reach the server", true)).toEqual({ hidden: false, label: "Reconnect" });
  });
  test("a session expiry reopens on its own at most once per window", () => {
    expect(mayReopen(-Infinity, 1000)).toBe(true);
    expect(mayReopen(1000, 1000 + REAUTH_WINDOW_MS - 1)).toBe(false);
    expect(mayReopen(1000, 1000 + REAUTH_WINDOW_MS)).toBe(true);
  });
});

describe("ordered sender", () => {
  function setup() {
    const sent: ClientMessage[] = [];
    const errors: unknown[] = [];
    let release: (() => void)[] = [];
    let fail = false;
    const sender = new OrderedSender(
      (message) => {
        sent.push(structuredClone(message));
        return new Promise<void>((resolve, reject) => release.push(() => (fail ? reject(new Error("unknown terminal")) : resolve())));
      },
      (error) => errors.push(error),
    );
    const flush = async () => {
      while (release.length) {
        const next = release;
        release = [];
        for (const done of next) done();
        await tick();
      }
    };
    return { sender, sent, errors, flush, setFail: (value: boolean) => { fail = value; } };
  }
  test("sends one at a time, in order, merging input typed meanwhile", async () => {
    const { sender, sent, flush } = setup();
    sender.push({ type: "input", data: "e" });
    sender.push({ type: "input", data: "c" });
    sender.push({ type: "input", data: "ho" });
    sender.push({ type: "resize", cols: 80, rows: 24 });
    sender.push({ type: "input", data: " hi" });
    sender.push({ type: "input", data: "\r" });
    expect(sent).toEqual([{ type: "input", data: "e" }]);
    await flush();
    expect(sent).toEqual([
      { type: "input", data: "e" },
      { type: "input", data: "cho" },
      { type: "resize", cols: 80, rows: 24 },
      { type: "input", data: " hi\r" },
    ]);
  });
  test("never merges past the limit", async () => {
    const { sender, sent, flush } = setup();
    sender.push({ type: "input", data: "x" });
    sender.push({ type: "input", data: "a".repeat(MERGE_LIMIT - 1) });
    sender.push({ type: "input", data: "bb" });
    await flush();
    expect(sent.map((message) => (message.type === "input" ? message.data.length : 0))).toEqual([1, MERGE_LIMIT - 1, 2]);
  });
  test("stop drops what is queued and silences failures", async () => {
    const { sender, sent, errors, flush, setFail } = setup();
    setFail(true);
    sender.push({ type: "input", data: "a" });
    sender.push({ type: "input", data: "b" });
    sender.stop();
    sender.push({ type: "input", data: "c" });
    await flush();
    expect(sent).toEqual([{ type: "input", data: "a" }]);
    expect(errors).toEqual([]);
  });
  test("a failure is reported and the queue goes on", async () => {
    const { sender, sent, errors, flush, setFail } = setup();
    setFail(true);
    sender.push({ type: "input", data: "a" });
    sender.push({ type: "input", data: "b" });
    await flush();
    expect(sent.length).toBe(2);
    expect(errors.length).toBe(2);
  });
});

// The shared browser client (web/terminal.js) driven through BridgeSocket and a fake bridge.
function harness(options: { open?: (connection: string, agent: string) => Promise<{ id?: unknown; cancelled?: unknown }> } = {}) {
  const calls: { method: string; args: unknown[] }[] = [];
  const warnings: string[] = [];
  const writes: Uint8Array[] = [];
  const router = new TerminalRouter();
  let opens: TerminalOpens;
  let opened = 0;
  let declined = 0;
  const pendingOpens: { resolve: (value: { id?: unknown; cancelled?: unknown }) => void; reject: (error: Error) => void }[] = [];
  const bridge: TerminalBridge = {
    open: (connection, agent) => {
      calls.push({ method: "open", args: [connection, agent] });
      if (options.open) return options.open(connection, agent);
      return new Promise((resolve, reject) => pendingOpens.push({ resolve, reject }));
    },
    input: async (id, data) => { calls.push({ method: "input", args: [id, data] }); },
    resize: async (id, cols, rows) => { calls.push({ method: "resize", args: [id, cols, rows] }); },
    close: async (id) => { calls.push({ method: "close", args: [id] }); },
    warn: (message) => warnings.push(message),
    declined: () => { declined++; },
  };
  opens = new TerminalOpens(bridge, router);
  class Terminal {
    cols = 100; rows = 30;
    loadAddon() {} open() {} reset() {} dispose() {} focus() {}
    onData() {}
    resize(cols: number, rows: number) { this.cols = cols; this.rows = rows; }
    write(data: Uint8Array, done: () => void) { writes.push(data); done(); }
  }
  const window: Record<string, any> = {};
  runInNewContext(readFileSync(new URL("../web/terminal.js", import.meta.url), "utf8"), {
    window, Terminal, WebLinksAddon: { WebLinksAddon: class {} }, FitAddon: { FitAddon: class { fit() {} } },
    ResizeObserver: class { observe() {} disconnect() {} }, URL, ArrayBuffer, Uint8Array, location: { href: "app://x/", protocol: "app:" },
    setTimeout, clearTimeout,
  });
  const status = { textContent: "" };
  let unauthorized = 0;
  const sockets: BridgeSocket[] = [];
  const controller = window.createAgentTerminal({
    screen: { clientWidth: 800, clientHeight: 400, replaceChildren() {} }, status,
    onUnauthorized: () => { unauthorized++; },
    preflight: async () => ({ ok: true, status: 200 }),
    connect: (name: string) => {
      opened++;
      const [connection, agent] = name.split("/");
      const socket = new BridgeSocket(bridge, opens, connection!, agent!);
      sockets.push(socket);
      return socket;
    },
  });
  return {
    controller, status, calls, warnings, writes, router, sockets, pendingOpens, get opens() { return opens; },
    output: (id: string, text: string) => router.dispatch({ name: "output", id, data: Buffer.from(text).toString("base64") }),
    get opened() { return opened; }, get declined() { return declined; }, get unauthorized() { return unauthorized; },
    methods: (method: string) => calls.filter((call) => call.method === method).map((call) => call.args),
  };
}
const ID = "0123456789abcdef0123456789abcdef";
const ID2 = "fedcba9876543210fedcba9876543210";

describe("bridge socket with the shared client", () => {
  test("opens through the bridge, goes live, sizes the terminal and types in order", async () => {
    const h = harness();
    h.controller.open("c1/keeper-log", "idle");
    await tick();
    expect(h.methods("open")).toEqual([["c1", "keeper-log"]]);
    expect(h.status.textContent).toBe("Connecting…");
    h.pendingOpens[0]!.resolve({ id: ID });
    await tick();
    expect(h.status.textContent).toBe("● Live terminal");
    expect(h.router.has(ID)).toBe(true);
    h.controller.input("echo hi\r");
    await tick();
    expect(h.methods("resize")).toEqual([[ID, 100, 30]]);
    expect(h.methods("input")).toEqual([[ID, "echo hi\r"]]);
    h.output(ID, "echo hi\r\nhi\r\n");
    h.output(ID, "$ ");
    expect(h.writes.map((bytes) => Buffer.from(bytes).toString())).toEqual(["echo hi\r\nhi\r\n", "$ "]);
    h.router.dispatch({ name: "control", id: ID, message: { type: "error", message: "tmux went away" } });
    expect(h.status.textContent).toBe("tmux went away");
    h.controller.close();
    expect(h.methods("close")).toEqual([[ID]]);
    expect(h.router.size).toBe(0);
    // A late event for the closed id goes nowhere.
    h.output(ID, "late");
    expect(h.writes.length).toBe(2);
  });

  test("an open that resolves after the user left is closed at once and never goes live", async () => {
    const h = harness();
    h.controller.open("c1/keeper-log", "idle");
    await tick();
    h.controller.close();
    h.pendingOpens[0]!.resolve({ id: ID });
    await tick();
    expect(h.methods("close")).toEqual([[ID]]);
    expect(h.router.size).toBe(0);
    expect(h.status.textContent).toBe("Connecting…");
  });

  test("switching agents closes the first terminal before the second opens", async () => {
    const h = harness();
    h.controller.open("c1/keeper-log", "idle");
    await tick();
    h.pendingOpens[0]!.resolve({ id: ID });
    await tick();
    h.controller.open("c1/lantern-ops", "idle");
    await tick();
    expect(h.methods("close")).toEqual([[ID]]);
    expect(h.methods("open")).toEqual([["c1", "keeper-log"], ["c1", "lantern-ops"]]);
    h.pendingOpens[1]!.resolve({ id: ID2 });
    await tick();
    expect(h.router.has(ID2) && !h.router.has(ID)).toBe(true);
  });

  test("closing is idempotent: the bridge closes the terminal exactly once", async () => {
    const h = harness();
    h.controller.open("c1/keeper-log", "idle");
    await tick();
    h.pendingOpens[0]!.resolve({ id: ID });
    await tick();
    h.controller.close();
    h.controller.close();
    h.sockets[0]!.close();
    await tick();
    expect(h.methods("close")).toEqual([[ID]]);
  });

  test("stopping the live agent closes its terminal once and shows the notice", async () => {
    const h = harness();
    h.controller.open("c1/keeper-log", "idle");
    await tick();
    h.pendingOpens[0]!.resolve({ id: ID });
    await tick();
    h.controller.open("c1/keeper-log", "exited");
    await tick();
    expect(h.methods("close")).toEqual([[ID]]);
    expect(h.status.textContent).toBe(STOPPED_TEXT);
    // Removing it afterwards (selection cleared) closes nothing more.
    h.controller.close();
    await tick();
    expect(h.methods("close")).toEqual([[ID]]);
    expect(h.methods("open")).toEqual([["c1", "keeper-log"]]);
    expect(h.router.size).toBe(0);
  });

  test("a stopped agent gets the notice and no open", async () => {
    const h = harness();
    h.controller.open("c1/keeper-log", "exited");
    await tick();
    expect(h.status.textContent).toBe(STOPPED_TEXT);
    expect(h.calls).toEqual([]);
  });

  test("a declined consent shows the plain words and does not ask again by itself", async () => {
    const h = harness({ open: async () => ({ cancelled: true }) });
    h.controller.open("c1/keeper-log", "idle");
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(h.status.textContent).toBe(CONSENT_DECLINED_TEXT);
    expect(h.declined).toBe(1);
    expect(h.methods("open").length).toBe(1);
    h.controller.reconnect();
    await tick();
    expect(h.methods("open").length).toBe(2);
  });

  test("a refused open shows the bridge's error without retrying", async () => {
    const h = harness({ open: async () => { throw new Error("This server has no web sign-in, so terminals are unavailable"); } });
    h.controller.open("c1/keeper-log", "idle");
    await new Promise((resolve) => setTimeout(resolve, 1200));
    expect(h.status.textContent).toBe("This server has no web sign-in, so terminals are unavailable");
    expect(h.methods("open").length).toBe(1);
  });

  test("the shell's output cap stops without reconnecting", async () => {
    const h = harness({ open: async () => ({ id: ID }) });
    h.controller.open("c1/keeper-log", "idle");
    await tick();
    await tick();
    h.router.dispatch({ name: "closed", id: ID, code: 1013, reason: "Output exceeded rendering capacity" });
    await new Promise((resolve) => setTimeout(resolve, 1200));
    expect(h.status.textContent).toBe(OUTPUT_LIMIT_TEXT);
    expect(h.methods("open").length).toBe(1);
    expect(h.router.size).toBe(0);
  });

  test("a 4001 close asks the view to sign in again and nothing else", async () => {
    const h = harness({ open: async () => ({ id: ID }) });
    h.controller.open("c1/keeper-log", "idle");
    await tick();
    await tick();
    h.router.dispatch({ name: "closed", id: ID, code: 4001, reason: "Session expired" });
    expect(h.unauthorized).toBe(1);
    expect(h.router.size).toBe(0);
    // The bridge has already dropped the id: the client's close sends nothing.
    expect(h.methods("close")).toEqual([]);
  });

  test("a dropped connection reconnects with backoff while the terminal is shown", async () => {
    const h = harness({ open: async () => ({ id: ID }) });
    h.controller.open("c1/keeper-log", "idle");
    await tick();
    await tick();
    h.router.dispatch({ name: "closed", id: ID, code: 1006, reason: "Connection lost" });
    expect(h.status.textContent).toBe("Disconnected · reconnecting…");
    await new Promise((resolve) => setTimeout(resolve, 1100));
    expect(h.methods("open").length).toBe(2);
    h.controller.close();
  });

  test("events that overtake the open's reply are held and replayed in order after it goes live", async () => {
    const h = harness();
    h.controller.open("c1/keeper-log", "idle");
    await tick();
    h.router.dispatch({ name: "control", id: ID, message: { type: "ready" } });
    h.output(ID, "first ");
    h.output(ID, "second");
    // Unrelated stale ids are held too, then dropped once the open settles.
    h.output(ID2, "stale");
    expect(h.writes.length).toBe(0);
    expect(h.router.heldCount()).toBe(4);
    h.pendingOpens[0]!.resolve({ id: ID });
    await tick();
    expect(h.status.textContent).toBe("● Live terminal");
    expect(h.writes.map((bytes) => Buffer.from(bytes).toString())).toEqual(["first ", "second"]);
    expect(h.router.heldCount()).toBe(0);
    h.output(ID, " third");
    expect(h.writes.length).toBe(3);
    h.controller.close();
  });

  test("a close that overtakes the reply closes the terminal right after it opens", async () => {
    const h = harness();
    h.controller.open("c1/keeper-log", "idle");
    await tick();
    h.output(ID, "bye");
    h.router.dispatch({ name: "closed", id: ID, code: 1000, reason: "Terminal detached" });
    h.pendingOpens[0]!.resolve({ id: ID });
    await tick();
    expect(h.writes.map((bytes) => Buffer.from(bytes).toString())).toEqual(["bye"]);
    expect(h.status.textContent).toBe("Terminal detached · Reconnect to attach");
    expect(h.router.size).toBe(0);
  });

  test("held events of an abandoned open are discarded", async () => {
    const h = harness();
    h.controller.open("c1/keeper-log", "idle");
    await tick();
    h.output(ID, "early");
    h.controller.close();
    h.pendingOpens[0]!.resolve({ id: ID });
    await tick();
    expect(h.writes.length).toBe(0);
    expect(h.router.heldCount()).toBe(0);
    expect(h.router.size).toBe(0);
    expect(h.methods("close")).toEqual([[ID]]);
  });

  test("with no open in flight, unknown ids are dropped at once", () => {
    const router = new TerminalRouter();
    router.dispatch({ name: "output", id: ID, data: "eA==" });
    expect(router.heldCount()).toBe(0);
  });

  test("an open in flight is reused by the client's next socket for the same agent", async () => {
    const h = harness();
    h.controller.open("c1/keeper-log", "idle");
    await tick();
    expect(h.opens.inFlight).toBe(1);
    // Leave and come back (or Reconnect) while the consent sheet is still up.
    h.controller.close();
    h.controller.open("c1/keeper-log", "idle");
    h.controller.reconnect();
    h.controller.reconnect();
    await tick();
    expect(h.methods("open")).toEqual([["c1", "keeper-log"]]);
    expect(h.opens.inFlight).toBe(1);
    h.pendingOpens[0]!.resolve({ id: ID });
    await tick();
    expect(h.opens.inFlight).toBe(0);
    expect(h.status.textContent).toBe("● Live terminal");
    expect(h.router.has(ID)).toBe(true);
    expect(h.sockets.at(-1)!.readyState).toBe(1);
    expect(h.methods("close")).toEqual([]);
    h.controller.input("x");
    await tick();
    expect(h.methods("input")).toEqual([[ID, "x"]]);
  });

  test("an open in flight for another agent is not reused, and is closed when it lands", async () => {
    const h = harness();
    h.controller.open("c1/keeper-log", "idle");
    await tick();
    h.controller.open("c1/lantern-ops", "idle");
    await tick();
    expect(h.methods("open")).toEqual([["c1", "keeper-log"], ["c1", "lantern-ops"]]);
    expect(h.opens.inFlight).toBe(2);
    h.pendingOpens[0]!.resolve({ id: ID });
    h.pendingOpens[1]!.resolve({ id: ID2 });
    await tick();
    expect(h.methods("close")).toEqual([[ID]]);
    expect(h.router.has(ID2) && !h.router.has(ID)).toBe(true);
    expect(h.opens.inFlight).toBe(0);
  });

  test("a reused open that is declined shows the declined state once", async () => {
    const h = harness();
    h.controller.open("c1/keeper-log", "idle");
    await tick();
    h.controller.reconnect();
    await tick();
    h.pendingOpens[0]!.resolve({ cancelled: true });
    await tick();
    expect(h.status.textContent).toBe(CONSENT_DECLINED_TEXT);
    expect(h.declined).toBe(1);
    expect(h.methods("open").length).toBe(1);
  });
});
