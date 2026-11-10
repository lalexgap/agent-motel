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

export function rolesDir(): string {
  return join(baseDir(), "roles");
}

export function queueDir(): string {
  return join(baseDir(), "queue");
}

export function worktreesDir(): string {
  return join(baseDir(), "worktrees");
}

// Claude's transcript store. Reads process.env.HOME live rather than
// os.homedir() — Bun caches homedir() at startup, so a runtime HOME override
// (tests sandboxing the search corpus) wouldn't otherwise apply. In normal use
// HOME is the real home, so this is unchanged behavior.
export function claudeProjectsDir(): string {
  return join(process.env.HOME ?? homedir(), ".claude", "projects");
}

// Claude Code's live-session registry (one <pid>.json per interactive
// session), read to find a session's cross-session inbox socket.
export function claudeSessionsDir(): string {
  const config = process.env.CLAUDE_CONFIG_DIR ?? join(process.env.HOME ?? homedir(), ".claude");
  return join(config, "sessions");
}

// Removed agents' state files are snapshotted here so an accidental `am rm`
// is undoable with `am restore`.
export function trashDir(): string {
  return join(baseDir(), "trash");
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

// Per-agent ledgers of the in-session subagents a provider fanned out to
// (Claude Code's Task tool, Codex's subagents). They have no tmux session of
// their own, so the SubagentStart/SubagentStop hooks are the only way to see
// them; `am subagents` and the sidebar read these files.
export function subagentsDir(): string {
  return join(baseDir(), "subagents");
}

export function subagentsFile(name: string): string {
  return join(subagentsDir(), `${name}.jsonl`);
}

// Append-only ledger of inter-agent messages: powers the rate limiter, the
// "did X already report this stint?" backstop check, and `am comms`.
export function commsLogFile(): string {
  return join(baseDir(), "comms.jsonl");
}

// Where files handed to an agent land (am send --file). A dedicated drop so a
// handoff never clobbers the agent's repo/worktree; the note carries the path.
export function inboxRootDir(): string {
  return join(baseDir(), "inbox");
}

export function inboxDir(name: string): string {
  return join(inboxRootDir(), name);
}

export function sharedRootDir(): string {
  return join(baseDir(), "shared");
}

export function sharedDir(name: string): string {
  return join(sharedRootDir(), name);
}

export function artifactsCacheDir(): string {
  return join(baseDir(), "artifacts-cache");
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

// One running plan per agent (see plan.ts): what it is working on, kept
// current by the agent itself so the operator always has a readable status.
export function plansDir(): string {
  return join(baseDir(), "plans");
}

export function planFile(name: string): string {
  return join(plansDir(), `${name}.md`);
}

export function usageDir(): string {
  return join(baseDir(), "usage");
}

export function usageLedgerFile(): string {
  return join(usageDir(), "ledger.json");
}

export function usageMessageIdsFile(): string {
  return join(usageDir(), "message-ids.log");
}

export function handoffsDir(): string {
  return join(baseDir(), "handoffs");
}

// The daemon runs detached; its output lands here (size-capped, rotated to
// .old) instead of being discarded — otherwise collector/delivery failures
// are invisible.
export function logsDir(): string {
  return join(baseDir(), "logs");
}

export function daemonLogFile(): string {
  return join(logsDir(), "daemon.log");
}

// Cap shared by everything appending to the daemon log (the daemon itself and
// the detached one-shot deliverers that fall back when it's down).
export const DAEMON_LOG_MAX_BYTES = 5_000_000;

// One gc at a time, manual or scheduled: both take this lock.
export function gcLockFile(): string {
  return join(baseDir(), "locks", "gc.lock");
}

// What gc did and what a dry run would have done, one JSON object per line.
// A removed worktree's entry keeps its branch and commit, for `am gc --restore`.
export function gcLogFile(): string {
  return join(logsDir(), "gc.jsonl");
}

// Scheduled gc: pause flag, whether its first (dry) run has happened, last run.
export function gcStateFile(): string {
  return join(baseDir(), "gc", "state.json");
}

// What gc last found in each unowned worktree it had to keep, so the next run
// does not pay for a `git status` that cannot have changed.
export function gcInspectedFile(): string {
  return join(baseDir(), "gc", "inspected.json");
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
  for (const dir of [agentsDir(), rolesDir(), queueDir(), worktreesDir(), snapshotsDir(), handoffsDir(), plansDir()]) {
    mkdirSync(dir, { recursive: true });
  }
}
