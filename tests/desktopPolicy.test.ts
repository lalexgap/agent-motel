import { describe, expect, test } from "bun:test";
import {
  checkAgent,
  checkMessageId,
  checkMessageText,
  checkMode,
  externalUrlAllowed,
  MESSAGE_CONTROL,
  messagesPath,
  normalizeServerUrl,
  plainHttpAllowed,
  validateApiPath,
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
    for (const agent of ["harbor-lights", "annex:kelp-forest", "a_b-1", "host.example:agent"]) expect(checkAgent(agent)).toEqual({ ok: true, value: agent });
    for (const agent of ["", "a/b", "a:b:c", "../x", "a b", ":x", "x:", "host:../x", "a%2Fb", "-host:x", "a".repeat(65), "é"])
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
