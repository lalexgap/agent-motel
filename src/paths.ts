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

export function daemonSocket(): string {
  return join(baseDir(), "daemon.sock");
}

export function daemonPidFile(): string {
  return join(baseDir(), "daemon.pid");
}

export function ensureDirs(): void {
  for (const dir of [agentsDir(), queueDir(), worktreesDir(), snapshotsDir()]) {
    mkdirSync(dir, { recursive: true });
  }
}
