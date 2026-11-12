// Dev server: serves desktop/dist with the app's CSP and implements the bridge
// over HTTP so the frontend runs in a plain browser.
//   bun desktop/dev.ts [--port 5199] [--fixture] [--fixture-url http://127.0.0.1:8791] [--watch]
// /__bridge has no secret: its Host/Origin checks stop browsers, not other local
// processes, which can drive it and use any saved token (including terminal.open, which
// types into an agent's pane). Run it on a single-user machine with fixture or throwaway
// tokens, never a production token on a shared host. Closing the page's /__bridge/events
// stream (a reload) closes every terminal the bridge holds.
import { watch } from "node:fs";
import { join, normalize, resolve, sep } from "node:path";
import { build, desktopDir, distDir } from "./build";
import { bridgeRequestAllowed, DevBridge } from "./devBridge";
import { FIXTURE_TOKEN, startFixtureServer } from "./fixtures/server";
import pkg from "../package.json";

// Same policy as the app, except connect-src: the dev bridge lives on this origin.
export const DEV_CSP =
  "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'";
const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};

// /__bridge bodies are small JSON, except files.upload, which carries up to
// 10 MiB of image as base64 (13,981,016 characters) plus the other params.
export const BRIDGE_BODY_MAX = 1 << 20;
export const BRIDGE_UPLOAD_BODY_MAX = 14 << 20;

// Reads at most `max` bytes, refusing early on a declared or streamed overrun.
async function readBody(req: Request, max: number): Promise<Uint8Array | null> {
  if (Number(req.headers.get("content-length") ?? 0) > max) return null;
  if (!req.body) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = req.body.getReader();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > max) {
      reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index > 0 ? process.argv[index + 1] : undefined;
}

export function startDevServer(options: { port: number; bridge: DevBridge; root?: string }) {
  const root = resolve(options.root ?? distDir);
  // Each page's event stream: write(text) queues a chunk and resolves once the stream has handed it on.
  const sse = new Set<(text: string) => Promise<void>>();
  const encoder = new TextEncoder();
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
  let port = options.port;

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: options.port,
    idleTimeout: 0,
    maxRequestBodySize: BRIDGE_UPLOAD_BODY_MAX,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/__bridge" || url.pathname === "/__bridge/events") {
        if (!bridgeRequestAllowed(req.headers, port)) return json({ error: "cross-origin bridge request refused" }, 403);
        if (url.pathname === "/__bridge") {
          if (req.method !== "POST") return json({ error: "method not allowed" }, 405);
          if (!(req.headers.get("content-type") ?? "").startsWith("application/json")) return json({ error: "expected application/json" }, 415);
          const raw = await readBody(req, BRIDGE_UPLOAD_BODY_MAX);
          if (!raw) return json({ error: "request body too large" }, 413);
          let body: { method?: unknown; params?: unknown } | null = null;
          try {
            body = JSON.parse(new TextDecoder().decode(raw));
          } catch {}
          if (!body || typeof body !== "object") return json({ error: "expected {method, params}" }, 400);
          if (raw.length > BRIDGE_BODY_MAX && body.method !== "files.upload") return json({ error: "request body too large" }, 413);
          try {
            return json({ result: await options.bridge.handle(body.method, body.params) });
          } catch (error) {
            return json({ error: error instanceof Error ? error.message : String(error) });
          }
        }
        if (req.method !== "GET") return json({ error: "method not allowed" }, 405);
        // Pull-based, so an event counts as delivered only once the response has taken it:
        // terminal output the page is not reading stays undelivered and hits the backlog cap.
        const queue: { bytes: Uint8Array; delivered: () => void }[] = [];
        let wake: (() => void) | null = null;
        let closed = false;
        let unsubscribe = () => {};
        const write = (text: string) =>
          new Promise<void>((delivered) => {
            if (closed) return delivered();
            queue.push({ bytes: encoder.encode(text), delivered });
            wake?.();
          });
        // The page reloaded or closed: the terminals it opened are unreachable now.
        const finish = () => {
          if (closed) return;
          closed = true;
          unsubscribe();
          sse.delete(write);
          for (const item of queue.splice(0)) item.delivered();
          wake?.();
          options.bridge.closeAllTerminals();
        };
        sse.add(write);
        void write(": bridge\n\n");
        unsubscribe = options.bridge.subscribe((name, payload) => write(`data: ${JSON.stringify({ name, payload })}\n\n`));
        const stream = new ReadableStream<Uint8Array>(
          {
            async pull(controller) {
              while (!queue.length && !closed) await new Promise<void>((resolve) => (wake = resolve));
              wake = null;
              const item = queue.shift();
              if (!item) return;
              controller.enqueue(item.bytes);
              item.delivered();
            },
            cancel: finish,
          },
          { highWaterMark: 0 },
        );
        req.signal.addEventListener("abort", finish);
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
    for (const write of sse) void write(": keepalive\n\n");
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
