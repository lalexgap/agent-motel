import { afterEach, describe, expect, test } from "bun:test";
import { createWebAuth } from "../src/webAuth";
import { startApiServer, type ApiServerHandle } from "../src/server";
const origin = "https://am.example.test";
const token = "test-key-with-at-least-24-characters";
const request = (
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
) =>
  new Request(origin + path, {
    method: "POST",
    headers: { origin, "content-type": "application/json", ...headers },
    body: JSON.stringify(body ?? {}),
  });
const login = (auth: ReturnType<typeof createWebAuth>) =>
  auth.route(request("/auth/login", { token }), "/auth/login");
let server: ApiServerHandle | undefined;
afterEach(() => {
  server?.stop();
  server = undefined;
});
describe("browser authentication", () => {
  test("requires HTTPS origin and a strong access key", () => {
    expect(() => createWebAuth("http://am.example.test", token)).toThrow();
    expect(() => createWebAuth(origin + "/", token)).toThrow();
    expect(() => createWebAuth(origin, "short")).toThrow();
  });
  test("rejects invalid credentials and cross-origin login", async () => {
    const auth = createWebAuth(origin, token);
    expect(
      (await auth.route(
        request("/auth/login", { token: "wrong" }),
        "/auth/login",
      ))!.status,
    ).toBe(401);
    expect(
      (await auth.route(
        request("/auth/login", { token }, { origin: "https://evil.test" }),
        "/auth/login",
      ))!.status,
    ).toBe(403);
    expect(
      (await auth.route(
        new Request(origin + "/auth/login", {
          method: "POST",
          body: JSON.stringify({ token }),
        }),
        "/auth/login",
      ))!.status,
    ).toBe(403);
  });
  test("issues a separate secure session, revokes it on logout and restart", async () => {
    const auth = createWebAuth(origin, token);
    const response = (await login(auth))!;
    const setCookie = response.headers.get("set-cookie")!;
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("Secure");
    expect(setCookie).toContain("SameSite=Strict");
    expect(setCookie).not.toContain(token);
    const cookie = setCookie.split(";")[0]!;
    const req = request("/auth/logout", {}, { cookie });
    expect(auth.valid(req)).toBe(true);
    expect(createWebAuth(origin, token).valid(req)).toBe(false);
    await auth.route(req, "/auth/logout");
    expect(auth.valid(req)).toBe(false);
  });
  test("expires sessions after twelve hours", async () => {
    const auth = createWebAuth(origin, token),
      response = (await login(auth))!;
    const req = request(
      "/auth/logout",
      {},
      { cookie: response.headers.get("set-cookie")!.split(";")[0]! },
    );
    const real = Date.now;
    Date.now = () => real() + 13 * 60 * 60 * 1000;
    try {
      expect(auth.valid(req)).toBe(false);
    } finally {
      Date.now = real;
    }
  });
  test("limits password guesses globally, independent of spoofed IP headers", async () => {
    const auth = createWebAuth(origin, token);
    for (let i = 0; i < 10; i++)
      await auth.route(
        request(
          "/auth/login",
          { token: "wrong" },
          { "x-forwarded-for": `1.2.3.${i}` },
        ),
        "/auth/login",
      );
    expect((await login(auth))!.status).toBe(429);
  });
  test("integrates session API access, CSRF protection, headers, and bearer compatibility", async () => {
    server = startApiServer({
      port: 0,
      hostname: "127.0.0.1",
      token,
      webOrigin: origin,
    });
    const root = await fetch(server.url);
    expect(root.status).toBe(200);
    expect(root.headers.get("content-security-policy")).toContain(
      "frame-ancestors 'none'",
    );
    expect(root.headers.get("cache-control")).toBe("no-store");
    expect(await root.text()).not.toContain(token);
    const response = await fetch(server.url + "/auth/login", {
      method: "POST",
      headers: { origin, "content-type": "application/json" },
      body: JSON.stringify({ token }),
    });
    const cookie = response.headers.get("set-cookie")!.split(";")[0]!;
    expect(
      (await fetch(server.url + "/api/health", { headers: { cookie } })).status,
    ).toBe(200);
    expect(
      (
        await fetch(server.url + "/api/agents/x/stop", {
          method: "POST",
          headers: { cookie },
          body: "{}",
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await fetch(server.url + "/api/agents/x/stop", {
          method: "POST",
          headers: { cookie, origin: "https://evil.test" },
          body: "{}",
        })
      ).status,
    ).toBe(403);
    expect(
      (await fetch(server.url + "/api/events", { headers: { cookie } })).status,
    ).toBe(403);
    expect((await fetch(server.url + "/api/health")).status).toBe(401);
    expect(
      (await fetch(server.url + "/api/health?token=" + token)).status,
    ).toBe(401);
    expect(
      (
        await fetch(server.url + "/api/health", {
          headers: { authorization: "Bearer " + token },
        })
      ).status,
    ).toBe(200);
    expect((await fetch(server.url + "/src/server.ts")).status).toBe(404);
    expect(
      (
        await fetch(server.url + "/auth/login", {
          method: "POST",
          headers: { origin },
          body: "a".repeat(300000),
        })
      ).status,
    ).toBe(413);
  });
});
