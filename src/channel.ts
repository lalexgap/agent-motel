import { existsSync, mkdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { baseDir } from "./paths";

// When an agent runs the `am` MCP server as a Claude Code CHANNEL (config.channels),
// the channel pushes peer messages straight into the session — so the tmux/hook
// delivery must stand down for that agent to avoid double-delivery. The channel
// server heartbeats this marker; deliverNext and the inbox hooks skip an agent
// whose marker is fresh. A stale marker (channel crashed) lets delivery resume.
const STALE_MS = 5000;

function channelsDir(): string {
  return join(baseDir(), "channels");
}

export function channelMarkerFile(name: string): string {
  return join(channelsDir(), `${name.replace(/[^a-zA-Z0-9_-]/g, "_")}.active`);
}

// Heartbeat: create or touch the marker (called on each channel tick).
export function markChannelActive(name: string): void {
  mkdirSync(channelsDir(), { recursive: true });
  const file = channelMarkerFile(name);
  try {
    if (existsSync(file)) {
      const now = Date.now() / 1000;
      utimesSync(file, now, now);
    } else {
      writeFileSync(file, String(process.pid));
    }
  } catch {
    // best-effort; a missed heartbeat just lets tmux delivery resume briefly
  }
}

export function clearChannelActive(name: string): void {
  rmSync(channelMarkerFile(name), { force: true });
}

// Is a live channel currently owning this agent's inbound delivery?
export function channelActive(name: string): boolean {
  try {
    return Date.now() - statSync(channelMarkerFile(name)).mtimeMs < STALE_MS;
  } catch {
    return false;
  }
}
