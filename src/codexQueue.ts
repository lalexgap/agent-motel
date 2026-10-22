import { createHash } from "node:crypto";

// Codex's durable per-thread input queue is drained by whichever process owns
// the thread (including the TUI's embedded app server). A one-shot stdio
// app-server writes to it without touching the shared Codex daemon.
// Experimental upstream API: any error means "type it".

const TIMEOUT_MS = 10_000;
const RECLAIM_TIMEOUT_MS = 5_000;

// Stable per am queue entry, so a retried add is recognisably the same input.
export function clientMessageId(entryId: string): string {
  const h = createHash("sha1").update(`am:${entryId}`).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

type Request = (method: string, params: object) => Promise<Record<string, unknown>>;

async function withAppServer<T>(timeoutMs: number, fn: (request: Request) => Promise<T>): Promise<T> {
  // Resolve against the live PATH; Bun.spawn's own lookup may not see it.
  const codex = Bun.which("codex", { PATH: process.env.PATH ?? "" });
  if (!codex) throw new Error("codex executable not found in PATH");
  const proc = Bun.spawn([codex, "app-server", "--listen", "stdio://"], {
    env: { ...process.env },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "ignore",
  });
  const timer = setTimeout(() => proc.kill(), timeoutMs);
  const send = (msg: object) => {
    proc.stdin.write(`${JSON.stringify(msg)}\n`);
    proc.stdin.flush();
  };
  const reader = proc.stdout.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  let nextId = 1;
  const response = async (id: number): Promise<Record<string, unknown>> => {
    for (;;) {
      let newline: number;
      while ((newline = buffered.indexOf("\n")) >= 0) {
        const line = buffered.slice(0, newline);
        buffered = buffered.slice(newline + 1);
        let msg: Record<string, unknown>;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (msg.id !== id) continue;
        if (msg.error) throw new Error(`codex app-server: ${JSON.stringify(msg.error)}`);
        return msg;
      }
      const chunk = await reader.read();
      if (chunk.done) throw new Error("codex app-server exited before replying");
      buffered += decoder.decode(chunk.value, { stream: true });
    }
  };
  const request: Request = async (method, params) => {
    const id = nextId++;
    send({ id, method, params });
    return ((await response(id)).result as Record<string, unknown> | undefined) ?? {};
  };
  try {
    await request("initialize", { clientInfo: { name: "am", title: null, version: "1" }, capabilities: { experimentalApi: true } });
    send({ method: "initialized" });
    return await fn(request);
  } finally {
    clearTimeout(timer);
    proc.kill();
  }
}

export async function queueCodexMessage(threadId: string, text: string, clientId: string): Promise<void> {
  await withAppServer(TIMEOUT_MS, async (request) => {
    const added = await request("thread/queue/add", {
      threadId,
      clientUserMessageId: clientId,
      input: [{ type: "text", text, text_elements: [] }],
    });
    if (!added.queuedSubmission) throw new Error("codex app-server did not confirm the queued message");
  });
}

interface QueuedSubmission {
  id: string;
  clientUserMessageId: string;
}

// Take back, oldest first, the given submissions still waiting in the thread's
// queue. Codex's delete is the claim: one it reports deleted can no longer
// start, so am may hand it over again. It stops at the first it could not
// delete (it started meanwhile, so Codex drains the rest itself). Returns the
// client ids deleted, and those no longer waiting at all.
export async function reclaimCodexMessages(
  threadId: string,
  clientIds: string[],
): Promise<{ deleted: string[]; gone: string[] }> {
  return withAppServer(RECLAIM_TIMEOUT_MS, async (request) => {
    const waiting = new Map<string, string>();
    let cursor: string | null = null;
    do {
      const page = await request("thread/queue/list", { threadId, cursor });
      for (const s of (page.data as QueuedSubmission[] | undefined) ?? []) waiting.set(s.clientUserMessageId, s.id);
      cursor = typeof page.nextCursor === "string" ? page.nextCursor : null;
    } while (cursor);
    const deleted: string[] = [];
    for (const clientId of clientIds) {
      const submission = waiting.get(clientId);
      if (!submission) continue;
      const result = await request("thread/queue/delete", { threadId, queuedSubmissionId: submission });
      if (result.deleted !== true) break;
      deleted.push(clientId);
    }
    return { deleted, gone: clientIds.filter((id) => !waiting.has(id)) };
  });
}
