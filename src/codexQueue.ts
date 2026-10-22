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

// The app server answered with an error, so the request had no effect.
export class CodexRpcError extends Error {}

// The request went out but no answer came back (the app server exited or was
// killed on timeout): Codex may or may not have applied it.
export class CodexOutcomeUnknown extends Error {}

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
        if (msg.error) throw new CodexRpcError(`codex app-server: ${JSON.stringify(msg.error)}`);
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
  let sent = false;
  try {
    await withAppServer(TIMEOUT_MS, async (request) => {
      sent = true;
      const added = await request("thread/queue/add", {
        threadId,
        clientUserMessageId: clientId,
        input: [{ type: "text", text, text_elements: [] }],
      });
      if (!added.queuedSubmission) throw new CodexRpcError("codex app-server did not confirm the queued message");
    });
  } catch (error) {
    if (!sent || error instanceof CodexRpcError) throw error;
    throw new CodexOutcomeUnknown(error instanceof Error ? error.message : String(error));
  }
}

interface QueuedSubmission {
  id: string;
  clientUserMessageId: string;
}

// Each step runs as soon as Codex has answered for it, before the next
// request, so a failure part way leaves every earlier step done.
export interface ReclaimSteps {
  // After the listing: the given client ids not waiting at all.
  gone(clientIds: string[]): void;
  // Before its delete goes out.
  claiming(clientId: string): void;
  // Codex's answer: deleted, so it can no longer start, or not (it started).
  claimed(clientId: string, deleted: boolean): void;
}

// Take back, oldest first, the given submissions still waiting in the thread's
// queue. Codex's delete is the claim: one it reports deleted can no longer
// start, so am may hand it over again. It stops at the first it could not
// delete (it started meanwhile, so Codex drains the rest itself), and on any
// error, which leaves the claim in flight then unknown.
export async function reclaimCodexMessages(threadId: string, clientIds: string[], steps: ReclaimSteps): Promise<void> {
  await withAppServer(RECLAIM_TIMEOUT_MS, async (request) => {
    const waiting = new Map<string, string>();
    let cursor: string | null = null;
    do {
      const page = await request("thread/queue/list", { threadId, cursor });
      for (const s of (page.data as QueuedSubmission[] | undefined) ?? []) waiting.set(s.clientUserMessageId, s.id);
      cursor = typeof page.nextCursor === "string" ? page.nextCursor : null;
    } while (cursor);
    steps.gone(clientIds.filter((id) => !waiting.has(id)));
    for (const clientId of clientIds) {
      const submission = waiting.get(clientId);
      if (!submission) continue;
      steps.claiming(clientId);
      const result = await request("thread/queue/delete", { threadId, queuedSubmissionId: submission });
      steps.claimed(clientId, result.deleted === true);
      if (result.deleted !== true) break;
    }
  });
}
