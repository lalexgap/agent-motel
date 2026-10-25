import { ensureConcierge } from "./concierge";
import { loadConfig } from "../config";
import { apiTokenFile } from "../paths";
import { createApiToken, loadOrCreateApiToken, startApiServer } from "../server";
import { ensureDaemon } from "../daemon";
import { startFleetEventWatch } from "../fleet";

// `am token` — print the API bearer token (creating one on first use).
export function tokenCommand(opts: { reset?: boolean }): void {
  const token = opts.reset ? createApiToken() : loadOrCreateApiToken();
  console.log(token);
  if (!process.env.AM_API_TOKEN) console.error(`(stored in ${apiTokenFile()})`);
}

// `am serve` — start the HTTP API for phone/remote clients. Foreground; meant
// to run under systemd/tmux on the box the fleet lives on.
export async function serveCommand(opts: { port?: number; bind?: string }): Promise<void> {
  const config = loadConfig();
  const token = loadOrCreateApiToken();
  if (!(await ensureDaemon())) throw new Error("daemon failed to start");
  // Keep the fleet cache hot from remote push events, so /api/agents and
  // /api/summary serve fresh rows instead of whatever the last request-time
  // poll happened to leave behind.
  startFleetEventWatch();

  const handle = startApiServer({
    port: opts.port ?? config.apiPort,
    hostname: opts.bind ?? config.apiBind,
    token,
    webOrigin: config.webOrigin,
  });

  console.log(`am serve listening on ${handle.url}`);
  console.log(`  API:   bearer-token gated under ${handle.url}/api`);
  console.log("  access key: run am token locally");
  if (config.conciergeAutoStart ?? !!config.webOrigin) {
    void ensureConcierge(undefined, { quiet: true }).catch(error => console.error(`concierge startup failed: ${error.message}`));
  }
  if (handle.hostname === "127.0.0.1") {
    console.log(
      `  note:  bound to loopback — set config.apiBind to a tailnet IP, or front it with Caddy/tailscale serve (see docs/ios-app-exploration.md §4e)`,
    );
  }

  const shutdown = () => {
    handle.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
