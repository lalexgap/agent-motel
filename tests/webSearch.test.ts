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
