import { rmSync } from "node:fs";
import { join } from "node:path";
import { baseDir } from "./paths";
import { readJsonOrNull, writeJsonAtomic } from "./fsutil";
import { tryAcquireFileLock, withFileLock } from "./filelock";

const heldLocks = new Map<string, () => void>();
export const HANDOFF_LEASE_MS = 180_000;

interface HandoffLease { token: string; expiresAt: number }

export function mailboxLockPath(name: string): string {
  return join(baseDir(), "locks", `delivery.${name}.lock`);
}

export function handoffPath(name: string): string {
  return `${mailboxLockPath(name)}.handoff`;
}

function activeHandoff(name: string): HandoffLease | null {
  const lease = readJsonOrNull<HandoffLease>(handoffPath(name));
  if (!lease) return null;
  if (lease.expiresAt > Date.now()) return lease;
  rmSync(handoffPath(name), { force: true });
  return null;
}

export function acquireMailboxLock(name: string, allowHandoff = false): boolean {
  const path = mailboxLockPath(name);
  if (heldLocks.has(path)) return false;
  const release = tryAcquireFileLock(path);
  if (!release) return false;
  if (!allowHandoff && activeHandoff(name)) { release(); return false; }
  heldLocks.set(path, release);
  return true;
}

export function releaseMailboxLock(name: string): void {
  const release = heldLocks.get(mailboxLockPath(name));
  if (!release) return;
  heldLocks.delete(mailboxLockPath(name));
  release();
}

export function withMailboxWrite<T>(name: string, fn: () => T): T {
  const check = () => {
    if (activeHandoff(name)) throw new Error(`agent "${name}" is being moved — retry the message`);
    return fn();
  };
  if (heldLocks.has(mailboxLockPath(name))) throw new Error(`agent "${name}" mailbox is busy — retry the message`);
  return withFileLock(mailboxLockPath(name), check);
}

export function mailboxHandoffActive(name: string): boolean {
  return withFileLock(mailboxLockPath(name), () => activeHandoff(name) !== null);
}

export function beginHandoff(name: string, token: string): void {
  if (!heldLocks.has(mailboxLockPath(name))) throw new Error("handoff requires delivery lock");
  const current = activeHandoff(name);
  if (current && current.token !== token) throw new Error(`agent "${name}" already has an active handoff`);
  writeJsonAtomic(handoffPath(name), { token, expiresAt: Date.now() + HANDOFF_LEASE_MS });
}

export function renewHandoff(name: string, token: string): boolean {
  return withFileLock(mailboxLockPath(name), () => {
    const current = activeHandoff(name);
    if (!current || current.token !== token) return false;
    writeJsonAtomic(handoffPath(name), { token, expiresAt: Date.now() + HANDOFF_LEASE_MS });
    return true;
  });
}

export function endHandoff(name: string, token: string): boolean {
  return withFileLock(mailboxLockPath(name), () => {
    if (readJsonOrNull<HandoffLease>(handoffPath(name))?.token !== token) return false;
    rmSync(handoffPath(name), { force: true });
    return true;
  });
}
