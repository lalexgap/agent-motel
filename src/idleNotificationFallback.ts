import { closeSync } from "node:fs";
import { join } from "node:path";
import { tryAcquireFileLock } from "./filelock";
import { openLogFd } from "./fsutil";
import { notify } from "./notify";
import { flushIdleNotifications, nextIdleNotificationWake, type IdleNotification } from "./notificationPolicy";
import { baseDir, DAEMON_LOG_MAX_BYTES, daemonLogFile } from "./paths";
import { cliEntrypoint } from "./settings";

const MAX_FALLBACK_WAIT_MS = 86_400_000;

interface IdleFallbackDeps {
  now: () => number;
  sleep: (milliseconds: number) => Promise<unknown>;
  flush: () => IdleNotification[];
  deliver: (notification: IdleNotification) => void;
  nextWake: () => number | undefined;
}

const defaultDeps: IdleFallbackDeps = {
  now: Date.now,
  sleep: Bun.sleep,
  flush: flushIdleNotifications,
  deliver: (notification) => notify(notification.title, notification.message, notification.meta),
  nextWake: nextIdleNotificationWake,
};

export async function runIdleNotificationFallback(
  dueAt: string,
  deps: IdleFallbackDeps = defaultDeps,
): Promise<void> {
  const deadline = Date.parse(dueAt);
  if (!Number.isFinite(deadline)) throw new Error("invalid idle notification deadline");
  const expiresAt = deps.now() + 2 * MAX_FALLBACK_WAIT_MS + 60_000;
  let next = Math.min(deadline, deps.now() + MAX_FALLBACK_WAIT_MS);
  while (deps.now() < expiresAt) {
    const wait = Math.max(0, next - deps.now());
    if (wait > 0) await deps.sleep(Math.min(wait, 5_000, expiresAt - deps.now()));
    for (const notification of deps.flush()) deps.deliver(notification);
    const wake = deps.nextWake();
    if (wake === undefined) return;
    next = Math.max(wake, deps.now() + 1);
  }
}

export function spawnIdleNotificationFallback(dueAt: string): void {
  let out: number | "ignore" = "ignore";
  try {
    out = openLogFd(daemonLogFile(), DAEMON_LOG_MAX_BYTES);
  } catch {
    // no log — flush silent rather than lose the queued notification
  }
  try {
    Bun.spawn({
      cmd: [process.execPath, cliEntrypoint(), "__flush-idle", dueAt],
      env: { ...process.env },
      stdin: "ignore",
      stdout: out,
      stderr: out,
      detached: true,
    }).unref();
  } finally {
    if (typeof out === "number") closeSync(out);
  }
}

export async function idleNotificationFallbackCommand(dueAt: string): Promise<void> {
  const release = tryAcquireFileLock(join(baseDir(), "idle-notification-fallback.lock"));
  if (!release) return;
  try {
    await runIdleNotificationFallback(dueAt);
  } finally {
    release();
  }
  const next = nextIdleNotificationWake();
  if (next !== undefined) spawnIdleNotificationFallback(new Date(next).toISOString());
}
