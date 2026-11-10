import { describe, expect, test } from "bun:test";
import { externalUrlAllowed, normalizeServerUrl, plainHttpAllowed, validateApiPath } from "../desktop/src/policy";

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
