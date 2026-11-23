import { closeSync } from "node:fs";
import { openLogFd } from "./fsutil";
import { notify } from "./notify";
import { flushIdleNotifications, type IdleNotification } from "./notificationPolicy";
import { DAEMON_LOG_MAX_BYTES, daemonLogFile } from "./paths";
import { cliEntrypoint } from "./settings";

const MAX_FALLBACK_WAIT_MS = 86_400_000;

interface IdleFallbackDeps {
  now: () => number;
  sleep: (milliseconds: number) => Promise<unknown>;
  flush: () => IdleNotification[];
  deliver: (notification: IdleNotification) => void;
}

const defaultDeps: IdleFallbackDeps = {
  now: Date.now,
  sleep: Bun.sleep,
  flush: flushIdleNotifications,
  deliver: (notification) => notify(notification.title, notification.message, notification.meta),
};

export async function runIdleNotificationFallback(
  dueAt: string,
  deps: IdleFallbackDeps = defaultDeps,
): Promise<void> {
  const deadline = Date.parse(dueAt);
  if (!Number.isFinite(deadline)) throw new Error("invalid idle notification deadline");
  const wait = Math.min(Math.max(0, deadline - deps.now()), MAX_FALLBACK_WAIT_MS);
  if (wait > 0) await deps.sleep(wait);
  for (const notification of deps.flush()) deps.deliver(notification);
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
  await runIdleNotificationFallback(dueAt);
}
