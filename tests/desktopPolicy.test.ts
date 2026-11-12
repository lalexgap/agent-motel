import { describe, expect, test } from "bun:test";
import {
  ACTION_METHODS,
  buildAction,
  checkAgent,
  checkMessageId,
  checkMessageText,
  checkMode,
  CONFIRM_METHODS,
  confirmMessage,
  displayText,
  externalUrlAllowed,
  MESSAGE_CONTROL,
  messagesPath,
  normalizeServerUrl,
  plainHttpAllowed,
  precheckStatus,
  validateApiPath,
  type ActionRequest,
} from "../desktop/src/policy";

describe("connection URL policy", () => {
  const ok = (input: string, url: string) => expect(normalizeServerUrl(input)).toEqual({ ok: true, url });
  const rejected = (input: string, pattern?: RegExp) => {
    const result = normalizeServerUrl(input);
    expect(result.ok).toBe(false);
    if (pattern && !result.ok) expect(result.error).toMatch(pattern);
  };

  test("https to any host, normalised to scheme://host[:port]", () => {
    ok("https://am.example.com", "https://am.example.com");
    ok("  https://AM.Example.com/  ", "https://am.example.com");
    ok("https://am.example.com:8443", "https://am.example.com:8443");
    ok("https://am.example.com:443/", "https://am.example.com");
  });

  test("plain http only to loopback, Tailscale CGNAT and .ts.net", () => {
    ok("http://localhost:8790", "http://localhost:8790");
    ok("http://127.0.0.1:8790", "http://127.0.0.1:8790");
    ok("http://127.5.6.7", "http://127.5.6.7");
    ok("http://[::1]:8790", "http://[::1]:8790");
    ok("http://100.64.0.1", "http://100.64.0.1");
    ok("http://100.127.255.254:8790", "http://100.127.255.254:8790");
    ok("http://box.tailnet-abc.ts.net:8790", "http://box.tailnet-abc.ts.net:8790");
    rejected("http://100.128.0.1", /Plain http is only allowed for localhost and Tailscale/);
    rejected("http://100.63.255.255");
    rejected("http://192.168.1.5", /Plain http/);
    rejected("http://10.0.0.1");
    rejected("http://evil.ts.net.example.com", /Plain http/);
    rejected("http://ts.net");
    rejected("http://am.example.com");
  });

  test("drops any path, query or fragment", () => {
    ok("https://am.example.com/api/agents", "https://am.example.com");
    ok("https://am.example.com/?x=1#agent=harbor", "https://am.example.com");
    ok("http://127.0.0.1:8790/#overview", "http://127.0.0.1:8790");
  });

  test("rejects userinfo and other schemes", () => {
    rejected("https://user:pass@am.example.com", /user name or password/);
    rejected("https://user@am.example.com", /user name or password/);
    rejected("http://user@127.0.0.1", /user name or password/);
    rejected("http://user@100.64.0.1/x@y", /user name or password/);
    rejected("ftp://am.example.com");
    rejected("javascript:alert(1)");
    rejected("am.example.com", /https:\/\//);
    rejected("");
  });

  test("plainHttpAllowed on bare hostnames", () => {
    expect(plainHttpAllowed("100.64.0.1")).toBe(true);
    expect(plainHttpAllowed("100.128.0.1")).toBe(false);
    expect(plainHttpAllowed("127.0.0.1")).toBe(true);
    expect(plainHttpAllowed("x.ts.net")).toBe(true);
    expect(plainHttpAllowed("x.ts.net.example.com")).toBe(false);
  });
});

describe("api.get path rules", () => {
  test("accepts plain /api/ paths with an encoded agent key and a query", () => {
    expect(validateApiPath("/api/agents")).toBeNull();
    expect(validateApiPath("/api/agents/annex%3Akelp-forest/transcript")).toBeNull();
    expect(validateApiPath("/api/usage?provider=claude")).toBeNull();
  });
  test("rejects anything that could leave /api/ or change the origin", () => {
    for (const path of [
      "//evil.example/api/x",
      "/api/../x",
      "/api/agents/../../etc/passwd",
      "/etc/passwd",
      "/api",
      "api/agents",
      "https://evil.example/api/x",
      "/api/x#frag",
      "/api\\..\\x",
      "/api/%2e%2e/x",
      "/api/%2E%2E/x",
      "/api/a%2fb",
      "/api//evil.example",
      "/api/a b",
      "/api/a\nb",
      "",
    ]) expect(validateApiPath(path)).not.toBeNull();
    expect(validateApiPath(42)).not.toBeNull();
    expect(validateApiPath(undefined)).not.toBeNull();
  });
});

describe("open.external", () => {
  test("http/https without credentials only", () => {
    expect(externalUrlAllowed("https://github.com/example/lighthouse/pull/12")).toBe(true);
    expect(externalUrlAllowed("http://localhost:3000")).toBe(true);
    expect(externalUrlAllowed("https://u:p@example.com")).toBe(false);
    expect(externalUrlAllowed("file:///etc/passwd")).toBe(false);
    expect(externalUrlAllowed("javascript:alert(1)")).toBe(false);
    expect(externalUrlAllowed(7)).toBe(false);
  });
});

// The same vectors as the Swift MessagePolicy tests (milestone 2 contract).
describe("message policy", () => {
  test("agent: name or host:name", () => {
    for (const agent of ["harbor-lights", "annex:kelp-forest", "a_b-1", "host.example:agent", "a.b.c:x", "h.:x", "_h:x"]) expect(checkAgent(agent)).toEqual({ ok: true, value: agent });
    for (const agent of ["", "a/b", "a:b:c", "../x", "a b", ":x", "x:", "host:../x", "a%2Fb", "-host:x", "a".repeat(65), "é", "an..nex:x", "a..:x"])
      expect(checkAgent(agent)).toEqual({ ok: false, error: `invalid agent: ${agent}` });
    expect(checkAgent("a".repeat(64)).ok).toBe(true);
    expect(checkAgent(".host:x").ok).toBe(false);
    expect(checkAgent(`${"h".repeat(255)}:x`).ok).toBe(true);
    expect(checkAgent(`${"h".repeat(256)}:x`).ok).toBe(false);
    expect(checkAgent(7)).toEqual({ ok: false, error: "invalid agent: 7" });
    expect(checkAgent(null)).toEqual({ ok: false, error: "invalid agent: null" });
    expect(checkAgent(undefined)).toEqual({ ok: false, error: "invalid agent: null" });
  });

  test("mode: exactly queue or now", () => {
    expect(checkMode("queue")).toEqual({ ok: true, value: "queue" });
    expect(checkMode("now")).toEqual({ ok: true, value: "now" });
    for (const mode of ["interrupt", "Now", "", "queue ", 1, null, undefined, ["now"]])
      expect(checkMode(mode)).toEqual({ ok: false, error: "mode must be queue or now" });
  });

  test("text: trimmed, non-empty, at most 100,000 UTF-8 bytes", () => {
    expect(checkMessageText("")).toEqual({ ok: false, error: "Message is empty" });
    expect(checkMessageText("   \n ")).toEqual({ ok: false, error: "Message is empty" });
    for (const text of [undefined, null, 5, { text: "x" }]) expect(checkMessageText(text).ok).toBe(false);
    expect(checkMessageText("a".repeat(100_001))).toEqual({ ok: false, error: "Message is too long (limit 100,000 bytes)" });
    expect(checkMessageText("a".repeat(100_000))).toEqual({ ok: true, value: "a".repeat(100_000) });
    // Trimmed before counting.
    expect(checkMessageText(`  ${"a".repeat(100_000)}\n`).ok).toBe(true);
    // 3 bytes each: 33,333 fit (99,999 bytes), 33,334 do not.
    expect(checkMessageText("€".repeat(33_333)).ok).toBe(true);
    expect(checkMessageText("€".repeat(33_334))).toEqual({ ok: false, error: "Message is too long (limit 100,000 bytes)" });
    expect(checkMessageText("😀".repeat(25_000)).ok).toBe(true);
    expect(checkMessageText("😀".repeat(25_001)).ok).toBe(false);
  });

  // Same vectors as macos/Tests/main.swift.
  const CONTROL_CHARACTERS = ["\u0000", "\u0001", "\u0003", "\u0004", "\u0008", "\u000b", "\u000c", "\u000e", "\u001a", "\u001b", "\u001f", "\u007f", "\u0080", "\u0085", "\u009b", "\u009f"];
  test("text: C0 controls other than tab and line breaks, DEL and C1 are rejected", () => {
    for (const control of CONTROL_CHARACTERS) {
      for (const text of [control, `a${control}b`, `  hi${control}`, `${control}[A`]) {
        expect(checkMessageText(text)).toEqual({ ok: false, error: MESSAGE_CONTROL });
      }
    }
    for (const [text, expected] of [["a\tb", "a\tb"], ["a\r\nb", "a\r\nb"], ["line\n\tindented", "line\n\tindented"], ["\u00a0x\u00a0y", "x\u00a0y"], ["\u2028x", "x"]]) {
      expect(checkMessageText(text)).toEqual({ ok: true, value: expected });
    }
  });

  test("text: ends trimmed, inside untouched", () => {
    expect(checkMessageText("  first\n\n  second  \n")).toEqual({ ok: true, value: "first\n\n  second" });
  });

  test("message id", () => {
    expect(checkMessageId("01JABCDEFGHJKMNPQRSTVWXYZ0")).toEqual({ ok: true, value: "01JABCDEFGHJKMNPQRSTVWXYZ0" });
    expect(checkMessageId("a".repeat(128)).ok).toBe(true);
    for (const id of ["", "a/b", "..", "a b", "a".repeat(129), 3, null]) expect(checkMessageId(id).ok).toBe(false);
  });

  test("paths are built from validated parts", () => {
    expect(messagesPath("harbor-lights")).toBe("/api/agents/harbor-lights/messages");
    expect(messagesPath("annex:kelp-forest")).toBe("/api/agents/annex%3Akelp-forest/messages");
    expect(messagesPath("annex:kelp-forest", "01JABCDEFGHJKMNPQRSTVWXYZ0")).toBe("/api/agents/annex%3Akelp-forest/messages/01JABCDEFGHJKMNPQRSTVWXYZ0");
    expect(validateApiPath(messagesPath("host.example:agent", "x_y-1"))).toBeNull();
  });
});

// Agent actions. Every table below is mirrored by the Swift
// ActionPolicy tests in macos/Tests/main.swift: same inputs, same verdicts,
// same error strings.
const ULID = "01JABCDEFGHJKMNPQRSTVWXYZ0";
const PROMPT_ID = "0123456789abcdef0123456789abcdef";
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG = [0xff, 0xd8, 0xff, 0xe0];
const GIF = [...new TextEncoder().encode("GIF89a")];
const WEBP = [...new TextEncoder().encode("RIFF\u0000\u0000\u0000\u0000WEBPVP8 ")];
const b64 = (bytes: number[] | Uint8Array): string => Buffer.from(bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes)).toString("base64");

const BASE: Record<string, Record<string, unknown>> = {
  "agents.resume": { agent: "harbor-lights" },
  "agents.restart": { agent: "harbor-lights" },
  "agents.interrupt": { agent: "harbor-lights" },
  "agents.stop": { agent: "harbor-lights" },
  "agents.remove": { agent: "harbor-lights" },
  "agents.rename": { agent: "harbor-lights", name: "harbor-beacon" },
  "agents.move": { agent: "harbor-lights", host: "annex" },
  "agents.model": { agent: "harbor-lights", model: "opus", createdAt: "2026-11-01T09:00:00.000Z", status: "idle" },
  "agents.handoff": { agent: "harbor-lights", to: "codex" },
  "agents.create": { name: "tide-tables", task: "Chart the tides", provider: "claude" },
  "permissions.answer": { agent: "fog-signal", id: ULID, optionId: "accept" },
  "prompt.answer": { agent: "origami-docs", id: PROMPT_ID, optionId: "2" },
  "files.upload": { agent: "harbor-lights", type: "image/png", data: b64(PNG) },
  "concierge.ensure": {},
  "search.query": { query: "lighthouse" },
};
const build = (method: string, overrides: Record<string, unknown> = {}) => buildAction(method, { ...BASE[method], ...overrides });
const request = (method: string, overrides: Record<string, unknown> = {}): ActionRequest => {
  const result = build(method, overrides);
  if (!result.ok) throw new Error(`expected ${method} to be accepted, got ${result.error}`);
  return result.value;
};
const bodyOf = (method: string, overrides: Record<string, unknown> = {}) => request(method, overrides).body;

const CONTROLS = ["\u0000", "\u0001", "\u0003", "\u0004", "\u0008", "\u000b", "\u000c", "\u000e", "\u001a", "\u001b", "\u001f", "\u007f", "\u0080", "\u0085", "\u009b", "\u009f"];
const describeValue = (value: unknown) =>
  value === undefined || value === null ? "null" : typeof value === "object" ? "[object]" : String(value);

// One row per rule: the method and param it is exercised through, accepted
// inputs with the value that lands in the body (key absent when `sentAs` is
// OMIT), rejected inputs, and the exact rejection string.
const OMIT = Symbol("omitted");
interface Rule {
  rule: string;
  method: string;
  param: string;
  // Path params are checked in the request path instead of the body.
  inPath?: true;
  accepted: [input: unknown, sentAs: unknown][];
  rejected: unknown[];
  error: (input: unknown) => string;
}
const same = (...inputs: unknown[]): [unknown, unknown][] => inputs.map((input) => [input, input]);

const RULES: Rule[] = [
  {
    rule: "name (rename target)",
    method: "agents.rename",
    param: "name",
    accepted: same("a", "harbor-beacon", "A_b-9", "a".repeat(64), "Concierge", "concierge2", "_x", "-x"),
    rejected: ["", "concierge", "a b", "a:b", "a/b", "a.b", "a".repeat(65), "é", " a", 7, true, null, undefined, { name: "a" }, ["a"]],
    error: (input) => `invalid name: ${describeValue(input)}`,
  },
  {
    rule: "newName (handoff, name rule, optional)",
    method: "agents.handoff",
    param: "newName",
    accepted: [...same("harbor-codex", "a".repeat(64)), [undefined, OMIT], [null, OMIT]],
    rejected: ["", "concierge", "a b", "a".repeat(65), 3],
    error: (input) => `invalid name: ${describeValue(input)}`,
  },
  {
    rule: "host (move target)",
    method: "agents.move",
    param: "host",
    accepted: same("local", "annex", "annex.example.com", "h_1", "a.b-c", "h".repeat(255), "h.", "_h"),
    rejected: ["", ".annex", "-annex", "an..nex", "a..", "a b", "a:b", "a/b", "h".repeat(256), "é", 7, null, undefined, {}, ["annex"]],
    error: (input) => `invalid host: ${describeValue(input)}`,
  },
  {
    rule: "provider",
    method: "agents.create",
    param: "provider",
    accepted: same("claude", "codex", "antigravity"),
    rejected: ["Claude", "", "gemini", " codex", 1, null, undefined],
    error: () => "invalid provider",
  },
  {
    rule: "dir (create, local: / or ~, L(4096))",
    method: "agents.create",
    param: "dir",
    accepted: [...same("/", "/srv/lighthouse", "~", "~/code/lighthouse", "/a b", "/tab\there", "/x y", "/" + "a".repeat(4095), "/" + "€".repeat(1365)), [undefined, OMIT], [null, OMIT]],
    rejected: ["", "relative", "./x", " /x", "/x\ny", "/x\r", "/" + "a".repeat(4096), "/" + "€".repeat(1366), 7, ...CONTROLS.map((c) => `/x${c}`)],
    error: () => "invalid directory",
  },
  {
    rule: "dir (move: absolute only, L(4096))",
    method: "agents.move",
    param: "dir",
    accepted: [...same("/srv/x", "/", "/" + "a".repeat(4095)), [undefined, OMIT], [null, OMIT]],
    rejected: ["~/x", "~", "", "x", "/x\ny", "/" + "a".repeat(4096), false, ...CONTROLS.map((c) => `/x${c}`)],
    error: () => "invalid directory",
  },
  {
    rule: "model (create: optional, L(256), trimmed, not -x)",
    method: "agents.create",
    param: "model",
    accepted: [...same("opus", "gpt-5.1-codex", "m\tx", "a".repeat(256), "x-"), [" opus ", "opus"], [`  ${"a".repeat(256)}  `, "a".repeat(256)], [undefined, OMIT], [null, OMIT]],
    rejected: ["", "   ", "-x", " -x", "a\nb", "a".repeat(257), "€".repeat(86), 7, ["x"], ...CONTROLS.map((c) => `m${c}`)],
    error: () => "invalid model",
  },
  {
    rule: "effort (create: optional, L(64), trimmed, not -x)",
    method: "agents.create",
    param: "effort",
    accepted: [...same("high", "a".repeat(64)), [" low\t", "low"], [undefined, OMIT], [null, OMIT]],
    rejected: ["", " ", "-high", "a".repeat(65), "a\rb", 2, ...CONTROLS.map((c) => `e${c}`)],
    error: () => "invalid effort",
  },
  {
    rule: "model (model change: required, null = provider default)",
    method: "agents.model",
    param: "model",
    accepted: [...same("opus", null, "a".repeat(256)), [" sonnet ", "sonnet"]],
    rejected: [undefined, "", "  ", "-opus", "a".repeat(257), "a\nb", 5, false],
    error: () => "invalid model",
  },
  {
    rule: "effort (model change: optional, null = provider default)",
    method: "agents.model",
    param: "effort",
    accepted: [...same("high", null), [undefined, OMIT], [" max ", "max"]],
    rejected: ["", "-high", "a".repeat(65), "a\nb", 5],
    error: () => "invalid effort",
  },
  {
    rule: "createdAt (L(128), non-empty, sent as given)",
    method: "agents.model",
    param: "createdAt",
    accepted: same("2026-11-01T09:00:00.000Z", "a".repeat(128), " x ", "x\ty"),
    rejected: ["", "a".repeat(129), "a\nb", "a\u0000", 7, null, undefined],
    error: () => "invalid createdAt",
  },
  {
    rule: "status (running statuses only)",
    method: "agents.model",
    param: "status",
    accepted: same("starting", "idle", "waiting", "working", "needs-attention"),
    rejected: ["exited", "dead", "Idle", "", "idle ", null, undefined, 1],
    error: () => "invalid status",
  },
  {
    rule: "to (handoff target)",
    method: "agents.handoff",
    param: "to",
    accepted: same("claude", "codex"),
    rejected: ["antigravity", "", "Claude", null, undefined, 1],
    error: () => "invalid to",
  },
  {
    rule: "full (handoff, optional boolean)",
    method: "agents.handoff",
    param: "full",
    accepted: [...same(true, false), [undefined, OMIT], [null, OMIT]],
    rejected: ["true", 1, 0, "", {}],
    error: () => "invalid full",
  },
  {
    rule: "task (T(100000), trimmed, non-empty)",
    method: "agents.create",
    param: "task",
    accepted: [...same("Chart the tides", "a".repeat(100_000), "€".repeat(33_333), "a\tb\r\nc"), ["  line\n\tnext  \n", "line\n\tnext"], [`  ${"a".repeat(100_000)}\n`, "a".repeat(100_000)]],
    rejected: ["", " \n ", "a".repeat(100_001), "€".repeat(33_334), 7, null, undefined, ...CONTROLS.map((c) => `x${c}`)],
    error: () => "invalid task",
  },
  {
    rule: "role (optional, name chars, not concierge)",
    method: "agents.create",
    param: "role",
    accepted: [...same("engineer", "a".repeat(64), "Concierge"), [undefined, OMIT], [null, OMIT]],
    rejected: ["concierge", "", "a b", "a".repeat(65), "a.b", 3],
    error: () => "invalid role",
  },
  {
    rule: "permission id (ULID)",
    method: "permissions.answer",
    param: "id",
    inPath: true,
    accepted: same(ULID, "0".repeat(26), "Z".repeat(26)),
    rejected: [ULID.toLowerCase(), ULID.slice(1), ULID + "0", "I".repeat(26), "L".repeat(26), "O".repeat(26), "U".repeat(26), "", null, 26],
    error: () => "invalid id",
  },
  {
    rule: "permission optionId",
    method: "permissions.answer",
    param: "optionId",
    accepted: same("accept", "answer-0", "suggestion_1", "a".repeat(64), "acceptWithExecpolicyAmendment"),
    rejected: ["", "a b", "a".repeat(65), "a/b", "a.b", 1, null],
    error: () => "invalid optionId",
  },
  {
    rule: "prompt id (32 lowercase hex)",
    method: "prompt.answer",
    param: "id",
    accepted: same(PROMPT_ID, "f".repeat(32)),
    rejected: [PROMPT_ID.toUpperCase(), PROMPT_ID.slice(1), PROMPT_ID + "0", "g".repeat(32), "", null],
    error: () => "invalid id",
  },
  {
    rule: "prompt optionId (1-9)",
    method: "prompt.answer",
    param: "optionId",
    accepted: same("1", "5", "9"),
    rejected: ["0", "10", "a", "", " 1", 1, null],
    error: () => "invalid optionId",
  },
  {
    rule: "prompt text (optional, L(2000), non-empty, sent as given)",
    method: "prompt.answer",
    param: "text",
    accepted: [...same("x", " x ", " ", "a".repeat(2000), "a\tb", "€".repeat(666), "a b"), [undefined, OMIT], [null, OMIT]],
    rejected: ["", "a\nb", "a\rb", "a".repeat(2001), "€".repeat(667), 7, ...CONTROLS.map((c) => `x${c}`)],
    error: () => "invalid text",
  },
  {
    rule: "upload type",
    method: "files.upload",
    param: "type",
    accepted: [],
    rejected: ["image/svg+xml", "IMAGE/PNG", "image/png; charset=x", "", null, undefined],
    error: () => "invalid type",
  },
  {
    rule: "search query (L(256), trimmed, at least 2 code points)",
    method: "search.query",
    param: "query",
    accepted: [...same("ab", "a".repeat(256), "😀😀", "a\tb"), ["  ab  ", "ab"]],
    rejected: ["", "a", " a ", "😀", "a".repeat(257), "a\nb", 7, null, undefined, ...CONTROLS.map((c) => `ab${c}`)],
    error: () => "invalid query",
  },
];

describe("action policy: value rules", () => {
  for (const rule of RULES) {
    test(rule.rule, () => {
      const key = rule.param;
      for (const [input, sentAs] of rule.accepted) {
        if (rule.inPath) {
          expect(request(rule.method, { [rule.param]: input }).path.endsWith(`/${sentAs}`)).toBe(true);
          continue;
        }
        const body = bodyOf(rule.method, { [rule.param]: input }) as Record<string, unknown>;
        if (sentAs === OMIT) expect(Object.hasOwn(body, key)).toBe(false);
        else expect(body[key]).toEqual(sentAs);
      }
      for (const input of rule.rejected) expect(build(rule.method, { [rule.param]: input })).toEqual({ ok: false, error: rule.error(input) });
    });
  }

  test("agent is checked first, with the message rule, for every agent method", () => {
    for (const method of ACTION_METHODS) {
      if (method === "agents.create" || method === "concierge.ensure" || method === "search.query") continue;
      for (const agent of ["a/b", "an..nex:x", "", null]) expect(build(method, { agent })).toEqual({ ok: false, error: `invalid agent: ${describeValue(agent)}` });
      // Even when every other param is wrong too.
      const allBad = Object.fromEntries(Object.keys(BASE[method]!).map((key) => [key, 42]));
      expect(build(method, allBad)).toEqual({ ok: false, error: "invalid agent: 42" });
    }
  });

  test("unknown methods, including side doors, are refused", () => {
    for (const method of ["agents.messages", "messages.interrupt", "agents.terminal", "api.post", "auth.login", "agents.Stop", "", 7, null])
      expect(buildAction(method, {})).toEqual({ ok: false, error: `unknown method: ${describeValue(method)}` });
  });
});

describe("action policy: validation order", () => {
  test("params are checked in the order listed in the contract", () => {
    expect(build("agents.model", { model: "-x", effort: "-y", createdAt: "", status: "dead" })).toEqual({ ok: false, error: "invalid model" });
    expect(build("agents.model", { effort: "-y", createdAt: "", status: "dead" })).toEqual({ ok: false, error: "invalid effort" });
    expect(build("agents.model", { createdAt: "", status: "dead" })).toEqual({ ok: false, error: "invalid createdAt" });
    expect(build("agents.move", { host: "-x", dir: "~" })).toEqual({ ok: false, error: "invalid host: -x" });
    expect(build("agents.handoff", { to: "x", newName: "concierge", full: 1 })).toEqual({ ok: false, error: "invalid to" });
    expect(build("agents.handoff", { newName: "concierge", full: 1 })).toEqual({ ok: false, error: "invalid name: concierge" });
    expect(build("permissions.answer", { id: "x", optionId: "" })).toEqual({ ok: false, error: "invalid id" });
    expect(build("prompt.answer", { id: "x", optionId: "0", text: "" })).toEqual({ ok: false, error: "invalid id" });
    expect(build("prompt.answer", { optionId: "0", text: "" })).toEqual({ ok: false, error: "invalid optionId" });
    expect(build("files.upload", { type: "image/bmp", data: "!" })).toEqual({ ok: false, error: "invalid type" });
    expect(build("agents.create", { name: "concierge", task: "", provider: "x" })).toEqual({ ok: false, error: "invalid name: concierge" });
    expect(build("agents.create", { task: "", provider: "x" })).toEqual({ ok: false, error: "invalid task" });
    expect(build("agents.create", { provider: "x", dir: "rel" })).toEqual({ ok: false, error: "invalid provider" });
    expect(build("agents.create", { dir: "rel", host: "-x" })).toEqual({ ok: false, error: "invalid directory" });
    expect(build("agents.create", { host: "-x", model: "-m" })).toEqual({ ok: false, error: "invalid host: -x" });
    expect(build("agents.create", { model: "-m", effort: "-e", role: "concierge" })).toEqual({ ok: false, error: "invalid model" });
    expect(build("agents.create", { effort: "-e", role: "concierge" })).toEqual({ ok: false, error: "invalid effort" });
  });

  test("create: a remote host needs an absolute dir, checked after the host", () => {
    expect(build("agents.create", { dir: "~/x", host: "annex" })).toEqual({ ok: false, error: "invalid directory" });
    expect(build("agents.create", { dir: "~/x", host: "an..nex" })).toEqual({ ok: false, error: "invalid host: an..nex" });
    expect(build("agents.create", { dir: "~/x", host: "local" }).ok).toBe(true);
    expect(build("agents.create", { dir: "~/x" }).ok).toBe(true);
  });
});

describe("action policy: requests", () => {
  const TABLE: [method: string, overrides: Record<string, unknown>, expected: Omit<ActionRequest, "confirm"> & { confirm?: unknown }][] = [
    ["agents.resume", {}, { method: "POST", path: "/api/agents/harbor-lights/resume", body: {}, contentType: "application/json", timeoutMs: 60_000 }],
    ["agents.restart", { agent: "annex:kelp-forest" }, { method: "POST", path: "/api/agents/annex%3Akelp-forest/restart", body: {}, contentType: "application/json", timeoutMs: 60_000, precheckPath: "/api/agents/annex%3Akelp-forest" }],
    ["agents.interrupt", {}, { method: "POST", path: "/api/agents/harbor-lights/interrupt", body: {}, contentType: "application/json", timeoutMs: 60_000, precheckPath: "/api/agents/harbor-lights" }],
    ["agents.stop", {}, { method: "POST", path: "/api/agents/harbor-lights/stop", body: {}, contentType: "application/json", timeoutMs: 60_000, precheckPath: "/api/agents/harbor-lights" }],
    ["agents.remove", {}, { method: "DELETE", path: "/api/agents/harbor-lights", timeoutMs: 60_000, precheckPath: "/api/agents/harbor-lights" }],
    ["agents.rename", {}, { method: "POST", path: "/api/agents/harbor-lights/rename", body: { name: "harbor-beacon" }, contentType: "application/json", timeoutMs: 60_000 }],
    ["agents.move", { dir: "/srv/x" }, { method: "POST", path: "/api/agents/harbor-lights/move", body: { host: "annex", dir: "/srv/x" }, contentType: "application/json", timeoutMs: 600_000, precheckPath: "/api/agents/harbor-lights" }],
    ["agents.move", { agent: "annex:kelp-forest", host: "local" }, { method: "POST", path: "/api/agents/annex%3Akelp-forest/move", body: { host: "local" }, contentType: "application/json", timeoutMs: 600_000, precheckPath: "/api/agents/annex%3Akelp-forest" }],
    ["agents.model", { effort: "high" }, { method: "POST", path: "/api/agents/harbor-lights/model", body: { model: "opus", effort: "high", createdAt: "2026-11-01T09:00:00.000Z", status: "idle" }, contentType: "application/json", timeoutMs: 120_000, precheckPath: "/api/agents/harbor-lights" }],
    ["agents.model", { model: null, effort: null }, { method: "POST", path: "/api/agents/harbor-lights/model", body: { model: null, effort: null, createdAt: "2026-11-01T09:00:00.000Z", status: "idle" }, contentType: "application/json", timeoutMs: 120_000, precheckPath: "/api/agents/harbor-lights" }],
    ["agents.handoff", { newName: "harbor-codex", full: true }, { method: "POST", path: "/api/agents/harbor-lights/handoff", body: { to: "codex", newName: "harbor-codex", full: true }, contentType: "application/json", timeoutMs: 150_000 }],
    ["agents.handoff", {}, { method: "POST", path: "/api/agents/harbor-lights/handoff", body: { to: "codex" }, contentType: "application/json", timeoutMs: 150_000 }],
    ["agents.create", {}, { method: "POST", path: "/api/agents", body: { name: "tide-tables", task: "Chart the tides", provider: "claude" }, contentType: "application/json", timeoutMs: 150_000 }],
    ["agents.create", { dir: "~/code/tides", host: "local", model: "opus", effort: "high", role: "engineer" }, { method: "POST", path: "/api/agents", body: { name: "tide-tables", task: "Chart the tides", provider: "claude", dir: "~/code/tides", model: "opus", effort: "high", role: "engineer" }, contentType: "application/json", timeoutMs: 150_000 }],
    ["agents.create", { dir: "/srv/tides", host: "annex" }, { method: "POST", path: "/api/agents", body: { name: "tide-tables", task: "Chart the tides", provider: "claude", remoteDir: "/srv/tides", host: "annex" }, contentType: "application/json", timeoutMs: 150_000 }],
    ["agents.create", { host: "annex" }, { method: "POST", path: "/api/agents", body: { name: "tide-tables", task: "Chart the tides", provider: "claude", host: "annex" }, contentType: "application/json", timeoutMs: 150_000 }],
    ["permissions.answer", { agent: "annex:fog-signal" }, { method: "POST", path: `/api/agents/annex%3Afog-signal/permissions/${ULID}`, body: { optionId: "accept" }, contentType: "application/json", timeoutMs: 45_000 }],
    ["prompt.answer", {}, { method: "POST", path: "/api/agents/origami-docs/prompt", body: { id: PROMPT_ID, optionId: "2" }, contentType: "application/json", timeoutMs: 45_000 }],
    ["prompt.answer", { optionId: "4", text: "Use the tide tables" }, { method: "POST", path: "/api/agents/origami-docs/prompt", body: { id: PROMPT_ID, optionId: "4", text: "Use the tide tables" }, contentType: "application/json", timeoutMs: 45_000 }],
    ["files.upload", {}, { method: "POST", path: "/api/agents/harbor-lights/files", body: Uint8Array.from(PNG), contentType: "image/png", timeoutMs: 120_000 }],
    ["concierge.ensure", {}, { method: "POST", path: "/api/concierge", body: {}, contentType: "application/json", timeoutMs: 120_000 }],
    ["search.query", { query: "  lighthouse " }, { method: "POST", path: "/api/search", body: { query: "lighthouse" }, contentType: "application/json", timeoutMs: 30_000 }],
  ];

  test("exact method, path, body, content type and timeout", () => {
    for (const [method, overrides, expected] of TABLE) {
      const { confirm, ...rest } = request(method, overrides);
      expect([method, rest]).toEqual([method, expected]);
      expect(confirm !== undefined).toBe((CONFIRM_METHODS as readonly string[]).includes(method));
    }
  });

  test("bodies never carry keys outside the contract", () => {
    const allowed: Record<string, string[]> = {
      "agents.create": ["name", "task", "provider", "dir", "remoteDir", "host", "model", "effort", "role"],
      "agents.handoff": ["to", "newName", "full"],
      "agents.model": ["model", "effort", "createdAt", "status"],
      "agents.move": ["host", "dir"],
      "agents.interrupt": [],
    };
    const extras = { inPlace: true, codex: true, text: "sneak", ifIdle: true, messageId: "x", path: "/api/x", method: "GET" };
    for (const [method, keys] of Object.entries(allowed)) {
      const body = bodyOf(method, { ...extras, dir: method === "agents.move" ? "/srv" : "~/x", newName: "n", full: false, effort: "high" }) as Record<string, unknown>;
      for (const key of Object.keys(body)) expect(keys).toContain(key);
    }
    expect(bodyOf("agents.interrupt", { text: "stop now" })).toEqual({});
  });

  test("an encoded agent key stays one path segment under /api/", () => {
    for (const method of ACTION_METHODS) {
      if (method === "agents.create" || method === "concierge.ensure" || method === "search.query") continue;
      const req = request(method, { agent: "host.example:a_b-1" });
      expect(req.path.startsWith("/api/agents/host.example%3Aa_b-1")).toBe(true);
      expect(validateApiPath(req.path)).toBeNull();
    }
  });
});

describe("action policy: confirmation text", () => {
  const CONFIRMS: [method: string, overrides: Record<string, unknown>, title: string, body: string, button: string, defaultIsCancel: boolean][] = [
    ["agents.restart", {}, "Restart harbor-lights?", "This interrupts its current turn and reopens the conversation. Status: working.", "Restart", false],
    ["agents.interrupt", {}, "Interrupt harbor-lights?", "This interrupts its current work. Status: working.", "Interrupt", false],
    ["agents.stop", {}, "Stop harbor-lights?", "This interrupts its current work and ends its session. It can be resumed later. Status: working.", "Stop", false],
    ["agents.remove", {}, "Remove harbor-lights?", "Its session will stop and the agent will be removed, along with its queued messages. The worktree is kept. Status: working.", "Remove", true],
    ["agents.move", {}, "Move harbor-lights to annex?", "The source will stop; workspace files are not copied. Status: working.", "Move", false],
    ["agents.move", { agent: "annex:kelp-forest", host: "local" }, "Move annex:kelp-forest to local?", "The source will stop; workspace files are not copied. Status: working.", "Move", false],
    ["agents.model", {}, "Change the model for harbor-lights?", "This restarts the agent and interrupts its current turn. The conversation and queued messages are kept. Status: working.", "Change model", false],
  ];
  test("title, body, button and default per method", () => {
    for (const [method, overrides, title, body, button, defaultIsCancel] of CONFIRMS) {
      const spec = request(method, overrides).confirm!;
      expect({ title: spec.title, body: spec.body("working"), button: spec.button, defaultIsCancel: spec.defaultIsCancel }).toEqual({ title, body, button, defaultIsCancel });
    }
  });
  test("window.confirm text joins title, body and server line with blank lines", () => {
    expect(confirmMessage("Stop harbor-lights?", "Body. Status: idle.", "Fixture motel")).toBe("Stop harbor-lights?\n\nBody. Status: idle.\n\nServer: Fixture motel");
  });
  test("the server line is cleaned like the status", () => {
    const SERVER: [name: string, shown: string][] = [
      ["Fixture motel", "Fixture motel"],
      ["Fixture\n\nStop everything?", "FixtureStop everything?"],
      ["Fix\rture\u001b[31m", "Fixture[31m"],
      ["\u202eletom erutxiF", "letom erutxiF"],
      ["a\u202ab\u202bc\u202cd\u202de\u2066f\u2067g\u2068h\u2069i\u200ej\u200fk", "abcdefghijk"],
      ["\u200f \u2069", "unknown"],
      ["m".repeat(80), "m".repeat(64)],
    ];
    for (const [name, shown] of SERVER) expect(confirmMessage("T", "B", name)).toBe(`T\n\nB\n\nServer: ${shown}`);
    for (const [name, shown] of SERVER) expect(displayText(name)).toBe(shown);
  });
});

describe("action policy: files.upload data", () => {
  test("each type needs its own magic bytes", () => {
    const images: [type: string, bytes: number[]][] = [["image/png", PNG], ["image/jpeg", JPEG], ["image/gif", GIF], ["image/webp", WEBP]];
    for (const [type, bytes] of images) {
      for (const [otherType, otherBytes] of images) {
        const result = build("files.upload", { type, data: b64(otherBytes) });
        if (type === otherType) expect(result).toEqual({ ok: true, value: expect.objectContaining({ body: Uint8Array.from(bytes), contentType: type }) });
        else expect(result).toEqual({ ok: false, error: `File is not a valid ${type} image` });
      }
    }
    expect(build("files.upload", { type: "image/gif", data: b64([...new TextEncoder().encode("GIF7")]) })).toEqual({ ok: false, error: "File is not a valid image/gif image" });
    expect(build("files.upload", { type: "image/webp", data: b64([...new TextEncoder().encode("RIFF0000WEBQ")]) })).toEqual({ ok: false, error: "File is not a valid image/webp image" });
    expect(build("files.upload", { type: "image/png", data: b64([0x89]) })).toEqual({ ok: false, error: "File is not a valid image/png image" });
  });

  test("standard padded base64, 1 byte to 10 MiB decoded", () => {
    for (const data of ["", "iVBORw0KGgo", "iVBO\nRw0KGgo=", "iVBORw0KGgo=\n", "iVBORw0K-_go=", "iVBORw0KGg==o", "iVB=ORw0KGgo", "====", "=", "a===", 7, null, undefined, ["iVBO"]])
      expect(build("files.upload", { data })).toEqual({ ok: false, error: "invalid data" });
    const max = new Uint8Array(10 * 1024 * 1024);
    max.set(PNG);
    expect(build("files.upload", { data: Buffer.from(max).toString("base64") }).ok).toBe(true);
    const over = new Uint8Array(10 * 1024 * 1024 + 1);
    over.set(PNG);
    expect(build("files.upload", { data: Buffer.from(over).toString("base64") })).toEqual({ ok: false, error: "invalid data" });
    // A one-byte JPEG is valid base64 but fails the magic check, not the size check.
    expect(build("files.upload", { type: "image/jpeg", data: "/w==" })).toEqual({ ok: false, error: "File is not a valid image/jpeg image" });
  });
});

describe("action policy: pre-check status", () => {
  // Agrees with ActionPolicy.status(fromDetail:) in macos/Sources/MessagePolicy.swift.
  const STATUS: [body: unknown, shown: string][] = [
    [{ status: "working" }, "working"],
    [{ status: "needs-attention" }, "needs-attention"],
    [{ status: "  idle \n" }, "idle"],
    [{ status: "wor\u001bking\r\n" }, "working"],
    [{ status: "a\u0085b\u009fc\u007fd" }, "abcd"],
    [{ status: "\u202eidle\u202c\u200e" }, "idle"],
    [{ status: "s".repeat(80) }, "s".repeat(64)],
    [{ status: "é".repeat(70) }, "é".repeat(64)],
    [{ status: "e\u0301".repeat(70) }, "e\u0301".repeat(64)],
    [{ status: "" }, "unknown"],
    [{ status: " \u001b " }, "unknown"],
    [{ status: 3 }, "unknown"],
    [{}, "unknown"],
    [null, "unknown"],
    [["working"], "unknown"],
    ["working", "unknown"],
  ];
  test("status shown in the confirmation", () => {
    for (const [body, shown] of STATUS) expect(precheckStatus(body)).toBe(shown);
  });
});

// Vectors that macos/Tests/main.swift uses and the tables above do not, so the
// two implementations are checked against each other's inputs.
describe("action policy: Swift test vectors", () => {
  test("same verdicts and strings as ActionPolicy", () => {
    expect(build("agents.move", { host: "box.tail1234.ts.net" }).ok).toBe(true);
    expect(build("agents.move", { host: undefined })).toEqual({ ok: false, error: "invalid host: null" });
    expect(build("agents.move", { dir: "relative/x" })).toEqual({ ok: false, error: "invalid directory" });
    expect(build("agents.create", { dir: "x", host: "a..b" })).toEqual({ ok: false, error: "invalid directory" });
    expect(build("agents.create", { name: "bad name", task: "" })).toEqual({ ok: false, error: "invalid name: bad name" });
    expect(build("agents.create", { name: undefined })).toEqual({ ok: false, error: "invalid name: null" });
    expect(build("agents.rename", { name: true })).toEqual({ ok: false, error: "invalid name: true" });
    expect(build("agents.model", { model: "-x", status: "bad" })).toEqual({ ok: false, error: "invalid model" });
    expect(build("agents.model", { effort: true })).toEqual({ ok: false, error: "invalid effort" });
    for (const id of ["01JABCDEFGHIKMNPQRSTVWXYZ0", "01JABCDEFGHJKLNPQRSTVWXYZ0", "01JABCDEFGHJKMNOQRSTVWXYZ0", "01JABCDEFGHJKMNPQRSTUWXYZ0", "../x"])
      expect(build("permissions.answer", { id })).toEqual({ ok: false, error: "invalid id" });
    expect(build("prompt.answer", { text: "é".repeat(1001) })).toEqual({ ok: false, error: "invalid text" });
    expect(build("prompt.answer", { text: " Use\tthe atlas " })).toMatchObject({ ok: true, value: { body: { text: " Use\tthe atlas " } } });
    expect(build("files.upload", { data: b64([...new TextEncoder().encode("PNG")]) })).toEqual({ ok: false, error: "File is not a valid image/png image" });
    for (const data of ["abc", "!!!!", "iVBO\nRw==", "iVBORw", "iVBORw=", "AA=A", " iVBORw0KGgo="])
      expect(build("files.upload", { data })).toEqual({ ok: false, error: "invalid data" });
    expect(build("files.upload", { data: "A".repeat(13_981_016 + 4) })).toEqual({ ok: false, error: "invalid data" });
    expect(build("search.query", { query: "é☃" }).ok).toBe(true);
    expect(build("search.query", { query: "é".repeat(129) })).toEqual({ ok: false, error: "invalid query" });
    expect(build("search.query", { query: "a\u0000b" })).toEqual({ ok: false, error: "invalid query" });
    expect(build("agents.create", { task: " \n\t " })).toEqual({ ok: false, error: "invalid task" });
    expect(precheckStatus({ status: "wo\u001brking\n" })).toBe("working");
    expect(build("agents.rename", { name: { name: "a" } })).toEqual({ ok: false, error: "invalid name: [object]" });
    expect(build("agents.rename", { name: ["a", "b"] })).toEqual({ ok: false, error: "invalid name: [object]" });
    expect(build("agents.move", { host: { host: "annex" } })).toEqual({ ok: false, error: "invalid host: [object]" });
    expect(build("agents.stop", { agent: ["harbor-lights"] })).toEqual({ ok: false, error: "invalid agent: [object]" });
    expect(build("agents.rename", { name: 1.5 })).toEqual({ ok: false, error: "invalid name: 1.5" });
    expect(precheckStatus({ status: "id\u202ele\u2066\u200f" })).toBe("idle");
    expect(confirmMessage("T", "B", "Fixture\u202e\nStatus: idle")).toBe("T\n\nB\n\nServer: FixtureStatus: idle");
  });
});
