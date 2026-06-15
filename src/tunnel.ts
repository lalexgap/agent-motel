import { loadConfig } from "./config";

// Reverse SSH tunnel: the roaming side (laptop) — which can always reach the
// always-on server — opens a persistent tunnel so the SERVER can reach BACK to
// the laptop's sshd. This gives the server a route to the laptop while the
// laptop is online (it sleeps/roams → tunnel drops → store-and-forward outbox
// still covers the offline case). Once up, the laptop is just another ssh
// remote: add it to the server's config.remotes and the whole fleet model
// (am ls, am send forwarding, shared agent list) works in both directions.
//
// am stays transport-ignorant — this only manages a plain `ssh -N -R` and keeps
// it alive; ssh does the rest.

export interface TunnelOpts {
  // Port opened ON THE SERVER that forwards back to this machine's sshd.
  port?: number;
  // The local sshd port to expose (the laptop must run sshd on it).
  sshPort?: number;
}

// The ssh argv for the reverse tunnel. Pure, for testing.
// `-R <port>:localhost:<sshPort>` makes server:<port> forward to this host's
// sshd. ExitOnForwardFailure so a port clash fails fast (we reconnect), and
// keepalives so a dead link is detected promptly rather than hanging.
export function reverseTunnelArgs(server: string, port: number, sshPort: number): string[] {
  return [
    "ssh",
    "-N", // no remote command — just the forward
    "-o", "ExitOnForwardFailure=yes",
    "-o", "ServerAliveInterval=15",
    "-o", "ServerAliveCountMax=3",
    "-o", "StreamLocalBindUnlink=yes",
    "-R", `${port}:localhost:${sshPort}`,
    server,
  ];
}

export function tunnelPort(opts: TunnelOpts): number {
  return opts.port ?? loadConfig().tunnelPort;
}

// Backoff for reconnect: grow ×2 from 1s to a 30s cap; a connection that lived
// a while resets it. Pure, for testing.
const RECONNECT_MIN_MS = 1000;
const RECONNECT_MAX_MS = 30_000;
const HEALTHY_MS = 60_000; // a tunnel up this long is "healthy" → reset backoff

export function nextBackoffMs(current: number, lastUptimeMs: number): number {
  if (lastUptimeMs >= HEALTHY_MS) return RECONNECT_MIN_MS;
  return Math.min(current * 2, RECONNECT_MAX_MS);
}

// Supervise the tunnel: spawn ssh, wait for it to exit, reconnect with backoff,
// forever (until SIGINT/SIGTERM). Foreground long-runner — run it under a
// service (systemd/launchd) or `am tunnel <server> &`.
export async function runTunnel(server: string, opts: TunnelOpts = {}): Promise<never> {
  const port = tunnelPort(opts);
  const sshPort = opts.sshPort ?? 22;
  const argv = reverseTunnelArgs(server, port, sshPort);
  console.log(`am tunnel: ${server} can reach this host via localhost:${port} (→ sshd :${sshPort})`);

  let backoff = RECONNECT_MIN_MS;
  let child: ReturnType<typeof Bun.spawn> | null = null;
  let stopping = false;
  const stop = () => {
    stopping = true;
    child?.kill();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  while (!stopping) {
    const startedAt = Date.now();
    child = Bun.spawn(argv, { stdin: "ignore", stdout: "inherit", stderr: "inherit" });
    const code = await child.exited;
    if (stopping) break;
    const uptime = Date.now() - startedAt;
    backoff = nextBackoffMs(backoff, uptime);
    console.error(`am tunnel: ssh exited (code ${code}, up ${Math.round(uptime / 1000)}s) — reconnecting in ${backoff / 1000}s`);
    await Bun.sleep(backoff);
  }
  process.exit(0);
}
