import { AsyncLocalStorage } from "node:async_hooks";
import { constants, openSync, closeSync, writeSync, fsyncSync, fchmodSync, mkdirSync } from "node:fs";
import { hostname, userInfo } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { logsDir } from "./paths";

export interface AuditContext {
  source?: string;
  route?: string;
  actor?: string;
  auth?: string;
  peer?: string;
}
export type AuditPhase = "requested" | "completed" | "failed" | "refused" | "observed";
interface AuditDetails { requestId?: string; targetHost?: string; reason?: string }
const context = new AsyncLocalStorage<AuditContext>();

export function auditLogFile(): string { return join(logsDir(), "lifecycle-audit.jsonl"); }

export function withAuditContext<T>(value: AuditContext, fn: () => T): T {
  return context.run({ ...context.getStore(), ...value }, fn);
}

function field(value: string | undefined): string | undefined {
  return value?.replace(/[\x00-\x1f\x7f]/g, " ").slice(0, 256);
}

// Explicit fields only: never serialize argv, request headers/bodies, or errors.
export function recordAudit(target: string, action: string, phase: AuditPhase, details: AuditDetails = {}): string {
  const scoped = context.getStore();
  const sshPeer = process.env.SSH_CONNECTION?.split(/\s+/)[0];
  const requestId = details.requestId ?? randomUUID();
  const entry = {
    timestamp: new Date().toISOString(), requestId, host: hostname(), pid: process.pid,
    uid: process.getuid?.(), user: userInfo().username,
    target: field(target), action: field(action), phase,
    source: field(scoped?.source ?? (sshPeer ? "ssh-cli" : "internal")),
    route: field(scoped?.route), actor: field(scoped?.actor ?? process.env.AGENTMGR_AGENT ?? userInfo().username),
    auth: field(scoped?.auth ?? (sshPeer ? "ssh" : "local-os")),
    peer: field(scoped?.peer ?? sshPeer),
    targetHost: field(details.targetHost), reason: field(details.reason),
  };
  mkdirSync(logsDir(), { recursive: true, mode: 0o700 });
  const fd = openSync(auditLogFile(), constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW, 0o600);
  try {
    fchmodSync(fd, 0o600);
    const bytes = Buffer.from(JSON.stringify(entry) + "\n");
    if (writeSync(fd, bytes) !== bytes.length) throw new Error("incomplete lifecycle audit write");
    fsyncSync(fd);
  } finally { closeSync(fd); }
  // Persist a newly created log's directory entry as well as its contents.
  const directory = openSync(logsDir(), constants.O_RDONLY);
  try { fsyncSync(directory); } finally { closeSync(directory); }
  return requestId;
}

// Persist intent before a destructive operation; an unavailable audit fails closed.
export function auditOperation<T>(target: string, action: string, fn: () => T): T {
  const requestId = recordAudit(target, action, "requested");
  try {
    const value = fn();
    recordAudit(target, action, "completed", { requestId });
    return value;
  } catch (error) {
    recordAudit(target, action, "failed", { requestId });
    throw error;
  }
}
