import { createHash } from "node:crypto";

// Codex keeps a durable per-thread input queue ($CODEX_HOME/queue_1.sqlite)
// that whichever process owns the thread drains — including the embedded app
// server inside an agent's TUI. An idle agent starts the queued message as a
// turn within a fraction of a second; a busy one runs it next; a dead one on
// resume. A one-shot stdio app-server writes to it without touching the
// shared Codex daemon. Experimental upstream API: any error means "type it".

const TIMEOUT_MS = 10_000;

// Stable per am queue entry, so a retried add is recognisably the same input.
export function clientMessageId(entryId: string): string {
  const h = createHash("sha1").update(`am:${entryId}`).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

export async function queueCodexMessage(threadId: string, text: string, clientId: string): Promise<void> {
  // Resolve against the live PATH; Bun.spawn's own lookup may not see it.
  const codex = Bun.which("codex", { PATH: process.env.PATH ?? "" });
  if (!codex) throw new Error("codex executable not found in PATH");
  const proc = Bun.spawn([codex, "app-server", "--listen", "stdio://"], {
    env: { ...process.env },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "ignore",
  });
  const timer = setTimeout(() => proc.kill(), TIMEOUT_MS);
  const send = (msg: object) => {
    proc.stdin.write(`${JSON.stringify(msg)}\n`);
    proc.stdin.flush();
  };
  const reader = proc.stdout.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
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
  try {
    send({
      id: 1,
      method: "initialize",
      params: { clientInfo: { name: "am", title: null, version: "1" }, capabilities: { experimentalApi: true } },
    });
    await response(1);
    send({ method: "initialized" });
    send({
      id: 2,
      method: "thread/queue/add",
      params: { threadId, clientUserMessageId: clientId, input: [{ type: "text", text, text_elements: [] }] },
    });
    const added = await response(2);
    if (!(added.result as Record<string, unknown> | undefined)?.queuedSubmission) {
      throw new Error("codex app-server did not confirm the queued message");
    }
  } finally {
    clearTimeout(timer);
    proc.kill();
  }
}
