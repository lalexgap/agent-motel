// Dev server: serves desktop/dist with the app's CSP and implements the bridge
// over HTTP so the frontend runs in a plain browser.
//   bun desktop/dev.ts [--port 5199] [--fixture] [--fixture-url http://127.0.0.1:8791] [--watch]
import { watch } from "node:fs";
import { join, normalize, resolve, sep } from "node:path";
import { build, desktopDir, distDir } from "./build";
import { bridgeRequestAllowed, DevBridge } from "./devBridge";
import { FIXTURE_TOKEN, startFixtureServer } from "./fixtures/server";
import pkg from "../package.json";

// Same policy as the app, except connect-src: the dev bridge lives on this origin.
export const DEV_CSP =
  "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'";
const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index > 0 ? process.argv[index + 1] : undefined;
}

export function startDevServer(options: { port: number; bridge: DevBridge; root?: string }) {
  const root = resolve(options.root ?? distDir);
  const sse = new Set<ReadableStreamDefaultController<Uint8Array>>();
  const encoder = new TextEncoder();
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
  let port = options.port;

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: options.port,
    idleTimeout: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/__bridge" || url.pathname === "/__bridge/events") {
        if (!bridgeRequestAllowed(req.headers, port)) return json({ error: "cross-origin bridge request refused" }, 403);
        if (url.pathname === "/__bridge") {
          if (req.method !== "POST") return json({ error: "method not allowed" }, 405);
          if (!(req.headers.get("content-type") ?? "").startsWith("application/json")) return json({ error: "expected application/json" }, 415);
          const body = (await req.json().catch(() => null)) as { method?: unknown; params?: unknown } | null;
          if (!body || typeof body !== "object") return json({ error: "expected {method, params}" }, 400);
          try {
            return json({ result: await options.bridge.handle(body.method, body.params) });
          } catch (error) {
            return json({ error: error instanceof Error ? error.message : String(error) });
          }
        }
        if (req.method !== "GET") return json({ error: "method not allowed" }, 405);
        let self: ReadableStreamDefaultController<Uint8Array>;
        let unsubscribe = () => {};
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            self = controller;
            sse.add(controller);
            controller.enqueue(encoder.encode(": bridge\n\n"));
            unsubscribe = options.bridge.subscribe((name, payload) => {
              try {
                controller.enqueue(encoder.encode(`data: ${JSON.stringify({ name, payload })}\n\n`));
              } catch {
                unsubscribe();
              }
            });
          },
          cancel() {
            unsubscribe();
            sse.delete(self);
          },
        });
        req.signal.addEventListener("abort", () => {
          unsubscribe();
          sse.delete(self);
        });
        return new Response(stream, { headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache" } });
      }
      if (req.method !== "GET" && req.method !== "HEAD") return new Response("method not allowed", { status: 405 });
      let pathname: string;
      try {
        pathname = decodeURIComponent(url.pathname);
      } catch {
        return new Response("bad request", { status: 400 });
      }
      if (pathname === "/") pathname = "/index.html";
      const file = normalize(join(root, pathname));
      if (!file.startsWith(root + sep)) return new Response("not found", { status: 404 });
      const blob = Bun.file(file);
      if (!(await blob.exists())) return new Response("not found", { status: 404 });
      const ext = file.slice(file.lastIndexOf("."));
      return new Response(blob, {
        headers: {
          "content-type": TYPES[ext] ?? "application/octet-stream",
          "content-security-policy": DEV_CSP,
          "x-content-type-options": "nosniff",
          "cache-control": "no-store",
        },
      });
    },
  });
  port = server.port ?? options.port;
  const keepalive = setInterval(() => {
    for (const controller of sse) {
      try {
        controller.enqueue(encoder.encode(": keepalive\n\n"));
      } catch {
        sse.delete(controller);
      }
    }
  }, 15000);
  return {
    port,
    url: `http://127.0.0.1:${port}`,
    stop() {
      clearInterval(keepalive);
      server.stop(true);
    },
  };
}

if (import.meta.main) {
  const port = Number(arg("--port") ?? 5199);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    console.error("usage: bun desktop/dev.ts [--port 5199] [--fixture] [--fixture-url URL] [--watch]");
    process.exit(2);
  }
  try {
    await build();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
  const bridge = new DevBridge({ version: pkg.version, build: "dev" });
  if (process.argv.includes("--fixture")) {
    const fixture = startFixtureServer({ port: Number(arg("--fixture-port") ?? 8791) });
    bridge.addConnection("Fixture motel", fixture.url, FIXTURE_TOKEN);
    console.log(`fixture am server on ${fixture.url}`);
  } else if (arg("--fixture-url")) {
    bridge.addConnection("Fixture motel", arg("--fixture-url")!, FIXTURE_TOKEN);
  }
  const dev = startDevServer({ port, bridge });
  console.log(`desktop dev server on ${dev.url}`);
  if (process.argv.includes("--watch")) {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const rebuild = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        build().then(() => console.log("rebuilt"), (error: unknown) => console.error(error instanceof Error ? error.message : error));
      }, 100);
    };
    for (const dir of [join(desktopDir, "src"), resolve(desktopDir, "..", "web")]) watch(dir, { recursive: true }, rebuild);
    for (const file of ["index.html", "desktop.css"]) watch(join(desktopDir, file), rebuild);
  }
}
