import { randomBytes, timingSafeEqual } from "node:crypto";

const COOKIE = "__Host-am_session";
const TTL = 12 * 60 * 60 * 1000;
export function createWebAuth(origin: string, token: string) {
  if (token.length < 24)
    throw new Error(
      "Web access requires an access key of at least 24 characters; run am token --reset",
    );
  const parsed = new URL(origin);
  if (parsed.protocol !== "https:" || parsed.origin !== origin)
    throw new Error(
      "webOrigin must be an HTTPS origin without a trailing slash",
    );
  const sessions = new Map<string, number>();
  const subscribers = new Map<string, Set<() => void>>();
  function revoke(id: string) {
    sessions.delete(id);
    for (const invalidate of [...(subscribers.get(id) ?? [])]) invalidate();
  }
  let attempts: number[] = [];
  const cookie = (value: string, age: number) =>
    `${COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${age}`;
  const session = (req: Request) =>
    req.headers
      .get("cookie")
      ?.split(";")
      .map((s) => s.trim())
      .find((s) => s.startsWith(COOKIE + "="))
      ?.slice(COOKIE.length + 1);
  function valid(req: Request) {
    const id = session(req);
    return !!id && (sessions.get(id) ?? 0) > Date.now();
  }
  function sameOrigin(req: Request) {
    return req.headers.get("origin") === origin;
  }
  return {
    valid,
    sameOrigin,
    subscribe(req: Request, onInvalidate: () => void): () => void {
      const id = session(req);
      if (!id || !valid(req)) {
        onInvalidate();
        return () => {};
      }
      let active = true;
      const cleanup = () => {
        active = false;
        clearTimeout(timer);
        subscribers.get(id)?.delete(invalidate);
        if (!subscribers.get(id)?.size) subscribers.delete(id);
      };
      const invalidate = () => {
        if (!active) return;
        cleanup();
        onInvalidate();
      };
      const timer = setTimeout(() => revoke(id), Math.max(0, sessions.get(id)! - Date.now()));
      timer.unref();
      if (!subscribers.has(id)) subscribers.set(id, new Set());
      subscribers.get(id)!.add(invalidate);
      return cleanup;
    },
    dispose() {
      for (const id of sessions.keys()) revoke(id);
    },
    async route(req: Request, path: string): Promise<Response | null> {
      if (path !== "/auth/login" && path !== "/auth/logout") return null;
      if (req.method !== "POST")
        return Response.json({ error: "method not allowed" }, { status: 405 });
      if (!sameOrigin(req))
        return Response.json({ error: "origin rejected" }, { status: 403 });
      if (path === "/auth/logout") {
        const id = session(req);
        if (id) revoke(id);
        return Response.json(
          { ok: true },
          { headers: { "set-cookie": cookie("", 0) } },
        );
      }
      const now = Date.now();
      attempts = attempts.filter((t) => now - t < 60_000);
      if (attempts.length >= 10)
        return Response.json(
          { error: "Too many attempts. Wait a minute." },
          { status: 429, headers: { "retry-after": "60" } },
        );
      attempts.push(now);
      const body = await req.json().catch(() => null) as { token?: unknown } | null;
      const supplied =
        typeof body?.token === "string"
          ? Buffer.from(body.token)
          : Buffer.alloc(0);
      const expected = Buffer.from(token);
      if (
        supplied.length !== expected.length ||
        !timingSafeEqual(supplied, expected)
      )
        return Response.json({ error: "Invalid access key" }, { status: 401 });
      for (const [id, expiry] of sessions)
        if (expiry <= now) revoke(id);
      if (sessions.size >= 100) revoke(sessions.keys().next().value!);
      const old = session(req);
      if (old) revoke(old);
      const id = randomBytes(32).toString("base64url");
      sessions.set(id, now + TTL);
      return Response.json(
        { ok: true },
        { headers: { "set-cookie": cookie(id, TTL / 1000) } },
      );
    },
  };
}

export function secureWebResponse(response: Response): Response {
  response.headers.set("cache-control", "no-store");
  // xterm generates styles at runtime; script execution remains self-only.
  response.headers.set(
    "content-security-policy",
    "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; font-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  );
  response.headers.set("x-content-type-options", "nosniff");
  response.headers.set("referrer-policy", "no-referrer");
  response.headers.set("x-frame-options", "DENY");
  response.headers.set(
    "permissions-policy",
    "camera=(), microphone=(), geolocation=()",
  );
  return response;
}
