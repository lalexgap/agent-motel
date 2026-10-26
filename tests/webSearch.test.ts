import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { scanConversation, validSearchQuery } from "../src/webSearch";

const entry = (text: string) => JSON.stringify({ type: "user", message: { content: text } });
test("conversation scan streams across chunks, ignores metadata, bounds snippets and preserves literal text", async () => {
  const dir = mkdtempSync(join(tmpdir(), "am-search-"));
  try {
    const file = join(dir, "session.jsonl");
    writeFileSync(file, [JSON.stringify({ type: "meta", text: "needle" }), entry("x".repeat(65530) + "needle <script>plain</script> café"), entry("Needle second"), entry("needle third"), entry("needle fourth")].join("\n"));
    const result = await scanConversation(file, "claude", "needle", new AbortController().signal);
    expect(result.partial).toBe(false);
    expect(result.snippets).toHaveLength(3);
    expect(result.snippets[0]!.text).toContain("needle <script>plain</script> café");
    expect(result.snippets[0]!.text.length).toBeLessThan(300);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test("oversized and malformed records do not hide later matches, and aborted scans stop", async () => {
  const dir = mkdtempSync(join(tmpdir(), "am-search-"));
  try {
    const file = join(dir, "session.jsonl");
    writeFileSync(file, "invalid\n" + entry("x".repeat(1100000)) + "\n" + entry("needle last"));
    const result = await scanConversation(file, "claude", "needle", new AbortController().signal);
    expect(result.partial).toBe(true);
    expect(result.snippets).toEqual([{ kind: "user", text: "needle last" }]);
    const controller = new AbortController(); controller.abort();
    await expect(scanConversation(file, "claude", "needle", controller.signal)).rejects.toThrow();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test("query validation keeps flags literal and rejects empty, oversized or NUL inputs", () => {
  for (const query of [null, 42, "a", "   ", "a".repeat(257), "x\0y"]) expect(validSearchQuery(query)).toBe(false);
  expect(validSearchQuery("--last")).toBe(true);
});

test("search scans past nonmatching agents and marks missing recorded transcripts partial", async () => {
  const { writeAgent } = await import("../src/state");
  const { searchConversations } = await import("../src/webSearch");
  const dir = mkdtempSync(join(tmpdir(), "am-search-fleet-"));
  const previous = process.env.AGENTMGR_HOME;
  process.env.AGENTMGR_HOME = dir;
  try {
    const empty = join(dir, "empty.jsonl"), hit = join(dir, "hit.jsonl");
    writeFileSync(empty, entry("no match here")); writeFileSync(hit, entry("needle after the first hundred"));
    for (let i = 0; i <= 100; i++) writeAgent({ name: `agent-${String(i).padStart(3, "0")}`, provider: "claude", status: "exited", dir, tmuxSession: "unused", transcriptPath: i === 100 ? hit : empty, createdAt: "now", updatedAt: "now" });
    const found = await searchConversations("needle");
    expect(found.partial).toBe(false);
    expect(found.matches.map(match => match.name)).toEqual(["agent-100"]);
    writeAgent({ name: "missing", provider: "claude", status: "exited", dir, tmuxSession: "unused", sessionId: "missing-search-session", createdAt: "now", updatedAt: "now" });
    expect((await searchConversations("needle")).partial).toBe(true);
  } finally {
    if (previous === undefined) delete process.env.AGENTMGR_HOME; else process.env.AGENTMGR_HOME = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("isolated search enforces the parent deadline even when the worker blocks synchronously", async () => {
  const { runConversationSearch } = await import("../src/webSearch");
  const dir = mkdtempSync(join(tmpdir(), "am-search-worker-"));
  try {
    const workerPath = join(dir, "blocked.ts");
    writeFileSync(workerPath, "while (true) {}");
    let responsive = false;
    const tick = setTimeout(() => { responsive = true; }, 5);
    const result = await runConversationSearch("needle", { workerPath, timeoutMs: 30 });
    clearTimeout(tick);
    expect(responsive).toBe(true);
    expect(result).toEqual({ matches: [], partial: true });
    writeFileSync(workerPath, "console.log('x'.repeat(2 * 1024 * 1024))");
    expect(await runConversationSearch("needle", { workerPath })).toEqual({ matches: [], partial: true });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("isolated search returns real worker results without exposing query arguments", async () => {
  const { runConversationSearch } = await import("../src/webSearch");
  const dir = mkdtempSync(join(tmpdir(), "am-search-empty-"));
  const previous = process.env.AGENTMGR_HOME;
  process.env.AGENTMGR_HOME = dir;
  try { expect(await runConversationSearch("--needle")).toEqual({ matches: [], partial: false }); }
  finally {
    if (previous === undefined) delete process.env.AGENTMGR_HOME; else process.env.AGENTMGR_HOME = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});
