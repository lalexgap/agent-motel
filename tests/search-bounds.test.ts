import { afterEach, beforeEach, expect, test } from "bun:test";
import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { search } from "../src/search";
import { writeAgent } from "../src/state";

let root: string;
let saved: NodeJS.ProcessEnv;
beforeEach(() => {
  saved = { ...process.env };
  root = mkdtempSync(join(tmpdir(), "am-search-bounds-"));
  process.env.AGENTMGR_HOME = root;
});
afterEach(() => {
  process.env = saved;
  rmSync(root, { recursive: true, force: true });
});
function line(text: string) { return JSON.stringify({ type: "user", message: { content: text } }) + "\n"; }
function transcript() {
  const file = join(root, "chat.jsonl");
  writeFileSync(file, "");
  writeAgent({ name: "fixture", status: "exited", dir: root, tmuxSession: "fixture", transcriptPath: file, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
  return file;
}
function metadata(results: ReturnType<typeof search>) { return (results as any).metadata; }

test("large JSONL records are skipped with bounded buffering and scanning continues", () => {
  const file = transcript();
  appendFileSync(file, '{"type":"user","message":{"content":"needle ');
  for (let i = 0; i < 64; i++) appendFileSync(file, "x".repeat(64 * 1024));
  appendFileSync(file, '"}}\n' + line("needle after oversized record"));
  const result = search("needle", { budgets: { maxLineBytes: 1024 } } as any);
  expect(result[0]?.snippets[0]?.text).toContain("after oversized");
  expect(metadata(result)?.partial).toBe(true);
  expect(metadata(result)?.local.reasons).toContain("line-bytes");
  expect(metadata(result)?.local.peakLineBytes).toBeLessThanOrEqual(1024);
});

test("scan byte and line budgets stop before reading the full file", () => {
  const file = transcript();
  appendFileSync(file, line("needle first") + line("nothing").repeat(1000));
  const result = search("needle", { budgets: { maxBytes: 256 } } as any);
  expect(result).toHaveLength(1);
  expect(metadata(result)?.local.bytesRead).toBeLessThanOrEqual(256);
  expect(metadata(result)?.local.reasons).toContain("bytes");
  const lines = search("needle", { budgets: { maxLines: 2 } } as any);
  expect(metadata(lines)?.local.linesRead).toBe(2);
  expect(metadata(lines)?.local.reasons).toContain("lines");
});

test("fleet failures identify the host instead of silently reporting an empty search", () => {
  mkdirSync(join(root, "bin"));
  const ssh = join(root, "bin", "ssh");
  writeFileSync(ssh, "#!/bin/sh\nexit 255\n");
  chmodSync(ssh, 0o755);
  process.env.PATH = join(root, "bin") + ":" + saved.PATH;
  writeFileSync(join(root, "config.json"), JSON.stringify({ remotes: ["fixture-offline"] }));
  const result = search("needle", { fleet: true });
  expect(result).toHaveLength(0);
  expect(metadata(result)?.partial).toBe(true);
  expect(metadata(result)?.hosts).toEqual([expect.objectContaining({ host: "fixture-offline", partial: true, reasons: ["remote-error"] })]);
  expect(Array.isArray(JSON.parse(JSON.stringify(result)))).toBe(true);
});
