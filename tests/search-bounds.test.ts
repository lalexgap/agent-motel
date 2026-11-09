import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { antigravityTranscriptPath } from "../src/antigravity";
import { readAgent } from "../src/state";
import { search, SEARCH_BUDGETS, type SearchResult } from "../src/search";
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
function transcript(name = "fixture") {
  const file = join(root, `${name}.jsonl`);
  writeFileSync(file, "");
  writeAgent({ name, status: "exited", dir: root, tmuxSession: name, transcriptPath: file, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
  return file;
}
function metadata(results: ReturnType<typeof search>) { return results.metadata; }

test("large JSONL records are skipped with bounded buffering and scanning continues", () => {
  const file = transcript();
  appendFileSync(file, '{"type":"user","message":{"content":"needle ');
  for (let i = 0; i < 64; i++) appendFileSync(file, "x".repeat(64 * 1024));
  appendFileSync(file, '"}}\n' + line("needle after oversized record"));
  const result = search("needle", { budgets: { maxLineBytes: 1024 } });
  expect(result[0]?.snippets[0]?.text).toContain("after oversized");
  expect(metadata(result)?.partial).toBe(true);
  expect(metadata(result)?.local.reasons).toContain("line-bytes");
  expect(metadata(result)?.local.peakLineBytes).toBeLessThanOrEqual(1024);
});

test("scan byte and line budgets stop before reading the full file", () => {
  const file = transcript();
  appendFileSync(file, line("needle first") + line("nothing").repeat(1000));
  const result = search("needle", { budgets: { maxBytes: 256 } });
  expect(result).toHaveLength(1);
  expect(metadata(result)?.local.bytesRead).toBeLessThanOrEqual(256);
  expect(metadata(result)?.local.reasons).toContain("bytes");
  const lines = search("needle", { budgets: { maxLines: 2 } });
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

function sshFixture(body: string, hosts = ["fixture-remote"]) {
  const bin = join(root, "bin");
  mkdirSync(bin, { recursive: true });
  const ssh = join(bin, "ssh");
  writeFileSync(ssh, `#!${process.execPath}\nimport { writeFileSync, writeSync } from "node:fs";\nwriteFileSync(${JSON.stringify(join(root, "ssh-args.json"))}, JSON.stringify(process.argv.slice(2)));\n${body}\n`);
  chmodSync(ssh, 0o755);
  process.env.PATH = bin + ":" + saved.PATH;
  writeFileSync(join(root, "config.json"), JSON.stringify({ remotes: hosts }));
}

function remoteRow(extra: Partial<SearchResult> = {}): SearchResult {
  return { agentName: "remote-agent", provider: "claude", scope: "agent", action: "resume",
    command: "am resume remote-agent", matchCount: 1, updatedAt: 123,
    snippets: [{ kind: "user", text: "needle reply", matchStart: 0, matchLen: 6 }], ...extra };
}

function reply(payload: unknown) {
  sshFixture(`writeSync(1, ${JSON.stringify(JSON.stringify(payload))});`);
}

function cli(...args: string[]) {
  const child = Bun.spawnSync([process.execPath, join(import.meta.dir, "../src/index.ts"), "search", ...args], {
    env: { ...process.env }, stdout: "pipe", stderr: "pipe", timeout: 3000,
  });
  expect(child.exitCode).toBe(0);
  return { stdout: child.stdout.toString(), stderr: child.stderr.toString() };
}

test("SSH envelope preserves results, host commands, literal query and requested options", () => {
  reply({ results: [remoteRow(), remoteRow({ agentName: undefined, scope: "history", action: "adopt", command: "am new <name> --resume sid" })], metadata: { partial: false } });
  const result = search("--needle 'quoted'", { fleet: true, all: true, limit: 7 });
  expect(result.map(row => row.command)).toEqual(["am -H fixture-remote resume remote-agent", "am -H fixture-remote new <name> --resume sid"]);
  expect(result.every(row => row.host === "fixture-remote")).toBe(true);
  expect(result.metadata.partial).toBe(false);
  const args = JSON.parse(readFileSync(join(root, "ssh-args.json"), "utf8")) as string[];
  expect(args).toContain("fixture-remote");
  const command = args.at(-1)!;
  const decoded = Bun.spawnSync(["python3", "-c", "import json,shlex,sys; print(json.dumps(shlex.split(shlex.split(sys.argv[1])[2])))", command]);
  expect(decoded.exitCode).toBe(0);
  expect(JSON.parse(decoded.stdout.toString())).toEqual([
    "am", "search", "--json", "--metadata", "--local-only", "--limit", "7", "--all", "--", "--needle 'quoted'",
  ]);
});

test("near-limit results survive the actual CLI metadata envelope and newline over SSH", () => {
  writeFileSync(transcript("large"), line("needle large"));
  writeFileSync(transcript("small"), line("needle small"));
  const agent = readAgent("large")!;
  writeAgent({ ...agent, dir: "" });
  const targetBytes = SEARCH_BUDGETS.maxOutputBytes - 128;
  const padding = targetBytes - Buffer.byteLength(JSON.stringify(search("needle")));
  writeAgent({ ...agent, dir: "x".repeat(padding) });
  const peer = cli("needle", "--local-only", "--limit", "1000", "--json", "--metadata");
  const payload = JSON.parse(peer.stdout);
  expect(payload.results).toHaveLength(2);
  expect(Buffer.byteLength(JSON.stringify(payload.results))).toBe(targetBytes);
  expect(payload.metadata.partial).toBe(false);
  expect(peer.stdout.endsWith("\n")).toBe(true);
  expect(Buffer.byteLength(peer.stdout)).toBeGreaterThan(SEARCH_BUDGETS.maxOutputBytes);
  expect(peer.stderr).toBe("");
  const wireFile = join(root, "peer-wire.json");
  writeFileSync(wireFile, peer.stdout);
  if (process.env.AM_SEARCH_EVIDENCE_DIR) {
    writeFileSync(join(process.env.AM_SEARCH_EVIDENCE_DIR, "f1-peer-wire.json"), peer.stdout);
    writeFileSync(join(process.env.AM_SEARCH_EVIDENCE_DIR, "f1-wire-bytes.json"), JSON.stringify({
      arrayBytes: targetBytes, wireBytes: Buffer.byteLength(peer.stdout), resultBudget: SEARCH_BUDGETS.maxOutputBytes,
    }));
  }
  sshFixture(`import { readFileSync } from "node:fs"; writeSync(1, readFileSync(${JSON.stringify(wireFile)}));`);
  process.env.AGENTMGR_HOME = join(root, "caller");
  mkdirSync(process.env.AGENTMGR_HOME);
  writeFileSync(join(process.env.AGENTMGR_HOME, "config.json"), JSON.stringify({ remotes: ["fixture-remote"] }));
  const result = search("needle", { fleet: true, limit: 1000 });
  expect(result.metadata.hosts).toEqual([{ host: "fixture-remote", partial: false, reasons: [] }]);
  expect(result).toHaveLength(2);
  expect(result.every(row => row.host === "fixture-remote")).toBe(true);
  expect(result.metadata.partial).toBe(false);
  expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(SEARCH_BUDGETS.maxOutputBytes);
});

for (const fd of [1, 2]) test(`SSH caps ${fd === 1 ? "stdout" : "stderr"} beyond the envelope allowance`, () => {
  const budget = 4096;
  sshFixture(`writeSync(${fd}, Buffer.alloc(${budget + 4096 + 1}, 120));`);
  const result = search("needle", { fleet: true, budgets: { maxOutputBytes: budget } });
  expect(result).toHaveLength(0);
  expect(result.metadata.hosts[0]?.reasons).toEqual(["output-bytes"]);
  expect(result.metadata.partial).toBe(true);
});

test("legacy arrays preserve usable matches with an explicit completeness warning", () => {
  reply([remoteRow()]);
  const result = search("needle", { fleet: true });
  expect(result).toHaveLength(1);
  expect(result.metadata.hosts).toEqual([{ host: "fixture-remote", partial: true, reasons: ["legacy-completeness-unknown"] }]);
  expect(result.metadata.partial).toBe(true);
});

test("partial remote envelopes keep matches and identify the incomplete host", () => {
  reply({ results: [remoteRow()], metadata: { partial: true } });
  const result = search("needle", { fleet: true });
  expect(result).toHaveLength(1);
  expect(result.metadata.hosts[0]?.reasons).toEqual(["remote-partial"]);
  expect(result.metadata.partial).toBe(true);
});

for (const [label, payload] of [
  ["missing metadata", { results: [remoteRow()] }],
  ["nonboolean partial", { results: [], metadata: { partial: "false" } }],
  ["nonarray results", { results: {}, metadata: { partial: false } }],
  ["invalid row", { results: [{ ...remoteRow(), snippets: [{ text: "needle" }] }], metadata: { partial: false } }],
  ["null", null],
] as const) test(`malformed SSH reply: ${label}`, () => {
  reply(payload);
  const result = search("needle", { fleet: true });
  expect(result).toHaveLength(0);
  expect(result.metadata.hosts[0]?.reasons).toEqual(["invalid-response"]);
  expect(result.metadata.partial).toBe(true);
});

test("invalid JSON from SSH is classified as an invalid response", () => {
  sshFixture('writeSync(1, "not json");');
  const result = search("needle", { fleet: true });
  expect(result.metadata.hosts[0]?.reasons).toEqual(["invalid-response"]);
});

for (const fd of [1, 2]) test(`SSH bounds huge ${fd === 1 ? "stdout" : "stderr"}`, () => {
  sshFixture(`const chunk = Buffer.alloc(65536, 120); for (let i = 0; i < 128; i++) writeSync(${fd}, chunk);`);
  const result = search("needle", { fleet: true, budgets: { maxOutputBytes: 4096 } });
  expect(result).toHaveLength(0);
  expect(result.metadata.hosts[0]?.reasons).toEqual(["output-bytes"]);
  expect(result.metadata.partial).toBe(true);
});

test("SSH deadline kills the blocked peer and marks remaining hosts without starting them", () => {
  sshFixture('Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5000);', ["slow", "unstarted"]);
  const start = performance.now();
  const result = search("needle", { fleet: true, budgets: { maxMs: 150 } });
  expect(performance.now() - start).toBeLessThan(2000);
  expect(result.metadata.hosts).toEqual([
    { host: "slow", partial: true, reasons: ["time"] },
    { host: "unstarted", partial: true, reasons: ["time"] },
  ]);
  const args = JSON.parse(readFileSync(join(root, "ssh-args.json"), "utf8"));
  expect(args).toContain("slow");
  expect(args).not.toContain("unstarted");
});

test("local search needs no rg and consumes an unterminated final record", () => {
  const file = transcript();
  writeFileSync(file, line("needle final").trimEnd());
  const child = Bun.spawnSync([process.execPath, "--eval", `
    import { search } from ${JSON.stringify(join(import.meta.dir, "../src/search.ts"))};
    const result = search("needle");
    console.log(JSON.stringify({ rg: Bun.which("rg"), results: result, metadata: result.metadata }));
  `], { env: { ...process.env, PATH: root }, timeout: 3000 });
  expect(child.exitCode).toBe(0);
  const result = JSON.parse(child.stdout.toString());
  expect(result.rg).toBeNull();
  expect(result.results[0]?.snippets[0]?.text).toBe("needle final");
  expect(result.metadata.partial).toBe(false);
  expect(result.metadata.local.linesRead).toBe(1);
});

test("UTF-8 characters split across the 64 KiB read boundary remain intact", () => {
  const file = transcript();
  const prefix = '{"type":"user","message":{"content":"';
  const padding = "x".repeat(65535 - Buffer.byteLength(prefix));
  writeFileSync(file, prefix + padding + '🧭 needle café"}}\n');
  const result = search("🧭 needle");
  const snippet = result[0]!.snippets[0]!;
  expect(snippet.text).toContain("🧭 needle café");
  expect(snippet.text).not.toContain("�");
  expect(snippet.text.slice(snippet.matchStart, snippet.matchStart + snippet.matchLen)).toBe("🧭 needle");
  expect(result.metadata.partial).toBe(false);
});

test("a byte budget ending exactly at EOF preserves the final unterminated match", () => {
  const file = transcript();
  const content = line("needle final").trimEnd();
  writeFileSync(file, content);
  const result = search("needle", { budgets: { maxBytes: Buffer.byteLength(content) } });
  expect(result[0]?.snippets[0]?.text).toBe("needle final");
  expect(result.metadata.local.bytesRead).toBe(Buffer.byteLength(content));
  expect(result.metadata.partial).toBe(false);
});

test("local time budget stops discovery and reports partial instead of complete empty results", () => {
  writeFileSync(transcript(), line("needle"));
  let now = 0;
  const clock = spyOn(performance, "now").mockImplementation(() => now++ * 10);
  try {
    const result = search("needle", { budgets: { maxMs: 1 } });
    expect(result).toHaveLength(0);
    expect(result.metadata.local.reasons).toContain("time");
    expect(result.metadata.local.bytesRead).toBe(0);
    expect(result.metadata.partial).toBe(true);
  } finally { clock.mockRestore(); }
});

test("file budget bounds discovery and still returns searched matches", () => {
  for (let i = 0; i < 3; i++) writeFileSync(transcript(`fixture-${i}`), line(`needle ${i}`));
  const result = search("needle", { budgets: { maxFiles: 1 } });
  expect(result).toHaveLength(1);
  expect(result.metadata.local.filesScanned).toBe(1);
  expect(result.metadata.local.reasons).toContain("files");
});

test("per-file match budget preserves early matches and makes truncation visible", () => {
  writeFileSync(transcript(), line("needle first") + line("needle second") + line("needle omitted"));
  const result = search("needle", { perFileCap: 2 });
  expect(result[0]?.matchCount).toBe(2);
  expect(result[0]?.snippets.map(snippet => snippet.text)).toEqual(["needle first", "needle second"]);
  expect(result.metadata.local.linesRead).toBe(2);
  expect(result.metadata.local.reasons).toContain("per-file-matches");
});

test("output budget accepts an exact-fit array and warns when one byte short", () => {
  writeFileSync(transcript(), line("needle result"));
  const complete = search("needle");
  const bytes = Buffer.byteLength(JSON.stringify(complete));
  const exact = search("needle", { budgets: { maxOutputBytes: bytes } });
  expect(exact).toHaveLength(1);
  expect(exact.metadata.partial).toBe(false);
  const short = search("needle", { budgets: { maxOutputBytes: bytes - 1 } });
  expect(short).toHaveLength(0);
  expect(short.metadata.reasons).toContain("output-bytes");
  expect(Buffer.byteLength(JSON.stringify(short))).toBeLessThanOrEqual(bytes - 1);
});

test("CLI JSON stays an array with stderr warnings; --metadata opts into the envelope", () => {
  reply({ results: [remoteRow()], metadata: { partial: true } });
  const plain = cli("needle", "--fleet", "--json");
  expect(Array.isArray(JSON.parse(plain.stdout))).toBe(true);
  expect(JSON.parse(plain.stdout)).toHaveLength(1);
  expect(plain.stderr).toContain("Partial search results (fixture-remote: remote-partial)");
  const envelope = cli("needle", "--fleet", "--json", "--metadata");
  const payload = JSON.parse(envelope.stdout);
  expect(payload.results).toEqual(JSON.parse(plain.stdout));
  expect(payload.metadata.partial).toBe(true);
  expect(payload.metadata.hosts[0].host).toBe("fixture-remote");
  expect(envelope.stderr).toContain("Partial search results");
});

test("CLI text distinguishes incomplete empty scans from complete no matches", () => {
  reply({ results: [], metadata: { partial: true } });
  const partial = cli("needle", "--fleet");
  expect(partial.stdout).toContain("no matches in the searched portion");
  expect(partial.stderr).toContain("fixture-remote: remote-partial");
  const complete = cli("needle", "--local-only", "--json", "--metadata");
  expect(JSON.parse(complete.stdout).metadata.partial).toBe(false);
  expect(complete.stderr).toBe("");
});

function legacyTranscript() {
  const createdAt = "2026-01-01T00:00:00.000Z";
  const sessionId = "fixture-conversation";
  const file = antigravityTranscriptPath("legacy", createdAt, sessionId);
  mkdirSync(dirname(file), { recursive: true });
  const record = { kind: "user", text: "needle legacy", createdAt, sessionId };
  writeFileSync(file, JSON.stringify(record) + "\n");
  writeAgent({ name: "legacy", provider: "antigravity", status: "exited", dir: root,
    tmuxSession: "fixture", createdAt, updatedAt: createdAt, sessionId, transcriptPath: file });
  return { file, record };
}

test("oversized legacy Antigravity lookup is skipped explicitly before whole-file provenance parsing", () => {
  const { file, record } = legacyTranscript();
  for (let i = 0; i < 32; i++) appendFileSync(file, JSON.stringify({ ...record, text: "x".repeat(65536) }) + "\n");
  const result = search("needle");
  expect(result).toHaveLength(0);
  expect(result.metadata.partial).toBe(true);
  expect(result.metadata.local.reasons).toContain("lookup-bytes");
  expect(result.metadata.local.filesScanned).toBe(0);
});

test("bounded legacy lookup preserves valid hits and rejects foreign provenance even after a valid hit", () => {
  const { file, record } = legacyTranscript();
  const valid = search("needle");
  expect(valid[0]?.snippets[0]?.text).toBe("needle legacy");
  expect(valid.metadata.partial).toBe(false);
  for (const mismatch of [{ sessionId: "foreign" }, { createdAt: "old" }]) {
    writeFileSync(file, JSON.stringify(record) + "\n" + JSON.stringify({ ...record, ...mismatch }) + "\n");
    const invalid = search("needle");
    expect(invalid).toHaveLength(0);
    expect(invalid.metadata.local.reasons).toContain("transcript-unavailable");
    expect(invalid.metadata.partial).toBe(true);
  }
});

test("known missing transcripts are partial while agents without a first session are not", () => {
  const file = transcript();
  rmSync(file);
  const missing = search("needle");
  expect(missing.metadata.local.reasons).toContain("transcript-unavailable");
  expect(missing.metadata.partial).toBe(true);
  const agent = readAgent("fixture")!;
  delete agent.transcriptPath;
  writeAgent(agent);
  expect(search("needle").metadata.partial).toBe(false);
  writeAgent({ ...agent, sessionId: "missing-session" });
  expect(search("needle").metadata.local.reasons).toContain("transcript-unavailable");
});

test("explicit FIFO transcripts cannot block the locator before the scanner", () => {
  const file = transcript();
  rmSync(file);
  expect(Bun.spawnSync(["mkfifo", file]).exitCode).toBe(0);
  const result = cli("needle", "--json", "--metadata");
  const payload = JSON.parse(result.stdout);
  expect(payload.results).toEqual([]);
  expect(payload.metadata.partial).toBe(true);
  expect(payload.metadata.local.reasons).toContain("unreadable-file");
});
