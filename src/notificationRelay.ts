import { loadConfig, localHostIdentity } from "./config";
import { isNotificationKind, planRelayDisplay, readRelayCursors, writeRelayCursor, type NotificationBatch } from "./notifications";
import { canShowNotifications, showNotification } from "./notify";
import { sshAmAsync, type SshResult } from "./remote";

// Relayed entries are shown, never re-journaled, so two hosts listing each
// other as remotes can't bounce notifications back.

const WAIT_SECONDS = 25;
const MIN_BACKOFF_MS = 5_000;
const MAX_BACKOFF_MS = 5 * 60_000;
const DISABLED_RECHECK_MS = 60_000;

export interface RelayDeps {
  run: (host: string, args: string[], timeoutMs: number) => Promise<SshResult>;
  show: (title: string, message: string) => void;
  cursor: (host: string) => string | undefined;
  saveCursor: (host: string, cursor: string) => void;
  now: () => number;
}

const defaultDeps: RelayDeps = {
  run: (host, args, timeoutMs) => sshAmAsync(host, args, { timeoutMs }),
  show: showNotification,
  cursor: (host) => readRelayCursors()[host],
  saveCursor: writeRelayCursor,
  now: Date.now,
};

// False (so the caller backs off) when the host is unreachable, its am predates
// __notifications, or the reply has no cursor.
export async function relayOnce(host: string, deps: RelayDeps = defaultDeps, waitSeconds = WAIT_SECONDS): Promise<boolean> {
  const after = deps.cursor(host);
  const args = ["__notifications", ...(after ? ["--after", after] : []), "--wait", String(waitSeconds)];
  const result = await deps.run(host, args, (waitSeconds + 20) * 1000);
  if (result.exitCode !== 0) return false;
  let batch: NotificationBatch;
  try {
    batch = JSON.parse(result.stdout.trim().split("\n").at(-1) ?? "") as NotificationBatch;
  } catch {
    return false;
  }
  if (!Array.isArray(batch?.entries) || typeof batch.cursor !== "string") return false;
  const local = localHostIdentity();
  const entries = batch.entries.filter((e) => e && typeof e.message === "string" && isNotificationKind(e.kind) && e.host !== local);
  for (const display of planRelayDisplay(host, entries, deps.now())) deps.show(display.title, display.message);
  if (batch.cursor !== after) deps.saveCursor(host, batch.cursor);
  return true;
}

export function relayEnabled(): boolean {
  const config = loadConfig();
  return config.relayNotifications !== false && (config.remotes?.length ?? 0) > 0 && canShowNotifications(config);
}

export function startNotificationRelay(log: (message: string) => void): { stop(): void } {
  let stopped = false;
  const running = new Set<string>();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const sleep = (ms: number) => new Promise<void>((resolve) => {
    const timer = setTimeout(() => { timers.delete(timer); resolve(); }, ms);
    timers.add(timer);
  });

  async function loop(host: string): Promise<void> {
    let backoff = MIN_BACKOFF_MS;
    try {
      while (!stopped) {
        let ok = false;
        try {
          if (!(loadConfig().remotes ?? []).includes(host)) return;
          if (!relayEnabled()) {
            await sleep(DISABLED_RECHECK_MS);
            continue;
          }
          ok = await relayOnce(host);
        } catch (error) {
          log(`notification relay from ${host} failed: ${error}`);
        }
        if (ok) {
          backoff = MIN_BACKOFF_MS;
        } else {
          await sleep(backoff);
          backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
        }
      }
    } finally {
      running.delete(host);
    }
  }

  // Pick up remotes added to the config without a daemon restart.
  function supervise(): void {
    if (stopped) return;
    try {
      const local = localHostIdentity();
      for (const host of loadConfig().remotes ?? []) {
        if (host === local || running.has(host)) continue;
        running.add(host);
        void loop(host);
      }
    } catch (error) {
      log(`notification relay: ${error}`);
    }
  }
  supervise();
  const supervisor = setInterval(supervise, DISABLED_RECHECK_MS);

  return {
    stop() {
      stopped = true;
      clearInterval(supervisor);
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
    },
  };
}
