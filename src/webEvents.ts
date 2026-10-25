import { statSync, watch, type FSWatcher } from "node:fs";
import { basename, dirname } from "node:path";
import { watchDaemonEvents } from "./daemon";
import { splitAddr } from "./comms";
import { CONCIERGE_NAME } from "./providers";
import { agentProvider, readAgent } from "./state";
import { readSubagents, subagentTranscriptFile } from "./subagents";
import { locateTranscript } from "./transcript";

export interface WebEventsCallbacks {
  // Required even after route authentication; must check the live session.
  isSessionValid: () => boolean;
  onRevoke?: (close: () => void) => (() => void);
  signal?: AbortSignal;
}

const encoder = new TextEncoder();
const safeName = /^[a-zA-Z0-9_-]{1,128}$/;

/** Call only after server session authentication and same-origin validation. */
export function startWebEvents(req: Request, callbacks?: WebEventsCallbacks): Response {
  const valid = () => {
    try { return callbacks?.isSessionValid() === true; } catch { return false; }
  };
  if (!valid() || req.signal.aborted || callbacks?.signal?.aborted) {
    return new Response(null, { status: 401 });
  }
  const url = new URL(req.url);
  const selected = splitAddr(url.searchParams.get("agent") ?? "");
  const subagent = url.searchParams.get("subagent");
  if ((selected.name && !safeName.test(selected.name)) || (subagent !== null && !safeName.test(subagent))) {
    return new Response(null, { status: 400 });
  }

  let stopped = false;
  let controller: ReadableStreamDefaultController<Uint8Array>;
  let stopDaemon: (() => void) | undefined;
  let stopRevoke: (() => void) | undefined;
  let debounce: ReturnType<typeof setTimeout> | undefined;
  let retry: ReturnType<typeof setInterval> | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  const watchers = new Map<string, { watcher?: FSWatcher; stamp: string }>();
  const pending = new Set<string>();
  let wired = false;
  const signals = [req.signal, callbacks?.signal].filter((s): s is AbortSignal => !!s);

  function close() {
    if (stopped) return;
    stopped = true;
    clearTimeout(debounce);
    clearInterval(retry);
    clearInterval(heartbeat);
    for (const { watcher } of watchers.values()) watcher?.close();
    watchers.clear();
    pending.clear();
    for (const signal of signals) signal.removeEventListener("abort", close);
    stopDaemon?.();
    stopRevoke?.();
    try { controller.close(); } catch { /* Reader cancellation already closed it. */ }
  }

  function emit(event: string, data: object) {
    if (stopped) return;
    if (!valid()) { close(); return; }
    // A slow/disconnected browser must not accumulate an unbounded event queue.
    if ((controller.desiredSize ?? 0) <= 0) { close(); return; }
    controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
  }

  function changed(scope: string) {
    if (stopped) return;
    pending.add(scope);
    if (debounce) return;
    // Leading bounded window: continuous token appends cannot starve refreshes.
    debounce = setTimeout(() => {
      debounce = undefined;
      const scopes = [...pending];
      pending.clear();
      emit("changed", { scopes });
    }, 100);
  }

  function paths(): Set<string> {
    const result = new Set<string>();
    const names = new Set([CONCIERGE_NAME, ...(!selected.host && selected.name ? [selected.name] : [])]);
    for (const name of names) {
      const agent = readAgent(name);
      if (!agent) continue;
      let main = agent.transcriptPath;
      if (!main) {
        try { main = locateTranscript(agent); } catch { /* Retry when session appears. */ }
      }
      if (main) result.add(main);
      if (name === selected.name && !selected.host && subagent) {
        const record = readSubagents(name).find((record) => record.id === subagent);
        if (!record) continue;
        const file = record.transcriptPath ?? (agentProvider(agent) === "claude" ? subagentTranscriptFile(agent, record.id) : null);
        if (file) result.add(file);
      }
    }
    return result;
  }

  function stamp(file: string): string {
    try {
      const s = statSync(file);
      return `${s.ino}:${s.size}:${s.mtimeMs}:${s.ctimeMs}`;
    } catch { return "missing"; }
  }

  function rewire() {
    if (stopped) return;
    if (!valid()) { close(); return; }
    const files = paths();
    for (const [file, entry] of watchers) {
      if (!files.has(file)) { entry.watcher?.close(); watchers.delete(file); changed("transcript"); }
    }
    for (const file of files) {
      let entry = watchers.get(file);
      const current = stamp(file);
      if (!entry) {
        entry = { stamp: current };
        watchers.set(file, entry);
        if (wired) changed("transcript");
      } else if (entry.stamp !== current) {
        entry.stamp = current;
        changed("transcript");
      }
      if (entry.watcher) continue;
      try {
        // Watch only the immediate directory, surviving file creation/rotation.
        const watcher = watch(dirname(file), (_event, filename) => {
          if (!filename || filename.toString() === basename(file)) {
            entry!.stamp = stamp(file);
            changed("transcript");
          }
        });
        entry.watcher = watcher;
        watcher.on("error", () => { watcher.close(); entry!.watcher = undefined; });
      } catch { /* Missing directories are retried without recursive watches. */ }
    }
    wired = true;
  }

  const body = new ReadableStream<Uint8Array>({
    start(streamController) {
      controller = streamController;
      for (const signal of signals) signal.addEventListener("abort", close, { once: true });
      if (signals.some((signal) => signal.aborted)) { close(); return; }
      try {
        stopRevoke = callbacks?.onRevoke?.(close);
        if (stopped) { stopRevoke?.(); return; }
        rewire();
        if (stopped) return;
        stopDaemon = watchDaemonEvents(() => {
          try { rewire(); changed("fleet"); } catch { close(); }
        });
        retry = setInterval(() => { try { rewire(); } catch { close(); } }, 500);
        heartbeat = setInterval(() => emit("heartbeat", {}), 15_000);
        emit("ready", { pollingFallback: !!selected.host, pollIntervalMs: selected.host ? 4000 : null });
      } catch {
        close();
      }
    },
    cancel() { close(); },
  }, { highWaterMark: 8 });

  return new Response(body, { headers: {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-store, no-transform",
    "X-Accel-Buffering": "no",
  } });
}
