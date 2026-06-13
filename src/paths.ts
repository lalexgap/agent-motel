import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync } from "node:fs";

export function expandHome(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return path;
}

// AGENTMGR_HOME override exists so tests can run against a throwaway dir.
export function baseDir(): string {
  return process.env.AGENTMGR_HOME ?? join(homedir(), ".agent-manager");
}

export function agentsDir(): string {
  return join(baseDir(), "agents");
}

export function queueDir(): string {
  return join(baseDir(), "queue");
}

export function worktreesDir(): string {
  return join(baseDir(), "worktrees");
}

export function lastAttachedFile(): string {
  return join(baseDir(), "last-attached.json");
}

export function hookSettingsFile(): string {
  return join(baseDir(), "hook-settings.json");
}

export function configFile(): string {
  return join(baseDir(), "config.json");
}

export function snapshotsDir(): string {
  return join(baseDir(), "snapshots");
}

// Append-only ledger of inter-agent messages: powers the rate limiter, the
// "did X already report this stint?" backstop check, and `am comms`.
export function commsLogFile(): string {
  return join(baseDir(), "comms.jsonl");
}

// Where files handed to an agent land (am send --file). A dedicated drop so a
// handoff never clobbers the agent's repo/worktree; the note carries the path.
export function inboxDir(name: string): string {
  return join(baseDir(), "inbox", name);
}

// Store-and-forward for sends whose target can't be reached from here (the
// reverse direction: a roaming laptop unreachable from the server). One JSONL
// per target name; a collector with that name local sweeps and removes them.
export function outboxDir(): string {
  return join(baseDir(), "outbox");
}

export function outboxFile(to: string): string {
  return join(outboxDir(), `${to.replace(/[^a-zA-Z0-9_-]/g, "_")}.jsonl`);
}

// Expired outbox entries land here instead of vanishing, so expiry stays
// observable (am outbox) and can be surfaced back to the sender.
export function outboxBouncesFile(): string {
  return join(baseDir(), "outbox-bounces.jsonl");
}

export function handoffsDir(): string {
  return join(baseDir(), "handoffs");
}

export function daemonSocket(): string {
  return join(baseDir(), "daemon.sock");
}

export function daemonPidFile(): string {
  return join(baseDir(), "daemon.pid");
}

// Bearer token for `am serve`'s HTTP API. Kept out of config.json so the secret
// lives in its own 0600 file; AM_API_TOKEN overrides it for ephemeral setups.
export function apiTokenFile(): string {
  return join(baseDir(), "api-token");
}

export function ensureDirs(): void {
  for (const dir of [agentsDir(), queueDir(), worktreesDir(), snapshotsDir(), handoffsDir()]) {
    mkdirSync(dir, { recursive: true });
  }
}
