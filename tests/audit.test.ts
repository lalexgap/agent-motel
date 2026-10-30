import { afterEach, beforeEach, expect, test, spyOn } from "bun:test";
import * as fs from "node:fs";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { auditLogFile, auditOperation, recordAudit, withAuditContext } from "../src/audit";
import { destroyAgent, stopAgent, stopIfIdle } from "../src/commands/rm";
import { acquireLifecycleLock, releaseLifecycleLock } from "../src/lifecycle";
import { readAgent, writeAgent, type AgentState } from "../src/state";

let home: string;
let spawnSpy: ReturnType<typeof spyOn>;
function entries(): any[] { return readFileSync(auditLogFile(), "utf8").trim().split("\n").map(line => JSON.parse(line)); }
function agent(name = "audit-fixture"): AgentState {
  const now = new Date().toISOString();
  const a: AgentState = { name, dir: home, status: "working", tmuxSession: "audit-fixture-never-live", createdAt: now, updatedAt: now };
  writeAgent(a);
  return a;
}
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "am-audit-"));
  process.env.AGENTMGR_HOME = home;
  spawnSpy = spyOn(Bun, "spawnSync").mockImplementation((argv: any) => ({
    exitCode: argv[0] === "tmux" && argv.includes("has-session") ? 1 : 0,
    stdout: Buffer.from(""), stderr: Buffer.from(""),
  }) as any);
});
afterEach(() => {
  spawnSpy.mockRestore();
  delete process.env.AGENTMGR_HOME;
  rmSync(home, { force: true, recursive: true });
});

test("stop writes durable intent and completion with private permissions and survives removal", () => {
  const a = agent();
  withAuditContext({ source: "interactive-hub", route: "stop", actor: "operator" }, () => stopAgent(a));
  const rows = entries();
  expect(rows.map(r => r.phase)).toEqual(["requested", "completed"]);
  expect(rows[0]).toMatchObject({ target: a.name, action: "stop", source: "interactive-hub", actor: "operator", route: "stop" });
  expect(rows[0].requestId).toBe(rows[1].requestId);
  expect(Number.isFinite(Date.parse(rows[0].timestamp))).toBe(true);
  expect(rows[0].host).toBeString();
  expect(rows[0].user).toBeString();
  expect(statSync(auditLogFile()).mode & 0o777).toBe(0o600);
  destroyAgent(a, { clean: false });
  expect(readAgent(a.name)).toBeNull();
  expect(entries().map(r => r.action)).toEqual(["stop", "stop", "remove", "remove"]);
});

test("a locked lifecycle records a failed request without exposing errors", () => {
  const a = agent();
  expect(acquireLifecycleLock(a.name)).toBe(true);
  try { expect(() => stopAgent(a)).toThrow("retry"); }
  finally { releaseLifecycleLock(a.name); }
  expect(entries().map(r => r.phase)).toEqual(["requested", "failed"]);
  expect(readAgent(a.name)?.status).toBe("working");
  expect(readFileSync(auditLogFile(), "utf8")).not.toContain("retry");
});

test("busy conditional stop is distinguishable from an executed stop", async () => {
  const a = agent();
  spawnSpy.mockImplementation(() => ({ exitCode: 0, stdout: Buffer.from(""), stderr: Buffer.from("") }) as any);
  const result = await stopIfIdle(a);
  expect(result.ok).toBe(false);
  expect(entries().map(r => [r.action, r.phase])).toEqual([["stop-if-idle", "requested"], ["stop-if-idle", "refused"]]);
  expect(entries()[1].reason).toBe("busy");
});

test("move, cd and internal cleanup actions are distinct from explicit stop", () => {
  for (const action of ["move", "cd"] as const) stopAgent(agent(action), { auditAction: action });
  for (const action of ["gc", "run-cleanup", "move-cleanup"] as const) destroyAgent(agent(action), { clean: false, auditAction: action });
  expect(entries().filter(r => r.phase === "requested").map(r => r.action)).toEqual(["move", "cd", "gc", "run-cleanup", "move-cleanup"]);
  expect(readAgent("move")?.statusReason).toBe("stopped for move");
});

test("audit failure prevents a stop and symlinks are never followed", () => {
  const a = agent();
  mkdirSync(join(home, "logs"));
  const other = join(home, "private");
  writeFileSync(other, "untouched");
  symlinkSync(other, auditLogFile());
  expect(() => stopAgent(a)).toThrow();
  expect(readAgent(a.name)?.status).toBe("working");
  expect(readFileSync(other, "utf8")).toBe("untouched");
  expect(spawnSpy).not.toHaveBeenCalled();
});

test("an incomplete retained tail blocks stops without appending or acting", () => {
  const a = agent();
  recordAudit(a.name, "stop", "requested");
  const retained = readFileSync(auditLogFile(), "utf8") + '{"partial":';
  writeFileSync(auditLogFile(), retained);
  const lockInode = statSync(auditLogFile() + ".lock").ino;
  expect(() => stopAgent(a)).toThrow("archive the intact trail");
  expect(() => recordAudit(a.name, "stop", "requested")).toThrow("incomplete lifecycle audit tail");
  expect(readFileSync(auditLogFile(), "utf8")).toBe(retained);
  expect(statSync(auditLogFile() + ".lock").ino).toBe(lockInode);
  expect(readAgent(a.name)?.status).toBe("working");
  expect(spawnSpy).not.toHaveBeenCalled();
});

test("a positive short write preserves evidence and blocks subsequent append and stop", () => {
  const a = agent();
  const actualWrite = fs.writeSync;
  const writeSpy = spyOn(fs, "writeSync").mockImplementation((fd: number, buffer: any) => actualWrite(fd, buffer, 0, 12));
  try {
    expect(() => stopAgent(a)).toThrow("incomplete lifecycle audit write");
    expect(writeSpy).toHaveBeenCalledTimes(1);
  } finally { writeSpy.mockRestore(); }
  const retained = readFileSync(auditLogFile());
  expect(retained.length).toBe(12);
  expect(retained.toString()).toBe('{"timestamp"');
  expect(() => recordAudit(a.name, "stop", "requested")).toThrow("incomplete lifecycle audit tail");
  expect(() => stopAgent(a)).toThrow("archive the intact trail");
  expect(readFileSync(auditLogFile())).toEqual(retained);
  expect(readAgent(a.name)?.status).toBe("working");
  expect(spawnSpy).not.toHaveBeenCalled();
});

test("failed termination is never reported completed", () => {
  const a = agent();
  spawnSpy.mockImplementation((argv: any) => ({ exitCode: argv.includes("kill-session") ? 1 : 0, stdout: Buffer.from(""), stderr: Buffer.from("secret-error-content") }) as any);
  expect(() => stopAgent(a)).toThrow("kill-session failed");
  expect(entries().map(r => r.phase)).toEqual(["requested", "failed"]);
  expect(readFileSync(auditLogFile(), "utf8")).not.toContain("secret-error-content");
  expect(readAgent(a.name)?.status).toBe("working");
});

test("async scopes remain separate and unknown fields are never serialized", async () => {
  await Promise.all(["one", "two"].map((actor, i) => withAuditContext({ actor, source: "test", token: "secret-token" } as any, async () => {
    await Bun.sleep(i ? 1 : 10);
    recordAudit(actor, "stop", "requested", { body: "private-body" } as any);
  })));
  expect(entries().map(r => [r.target, r.actor])).toEqual([["two", "two"], ["one", "one"]]);
  auditOperation("after", "stop", () => {});
  expect(entries().at(-1).actor).not.toBe("one");
  const raw = readFileSync(auditLogFile(), "utf8");
  expect(raw).not.toContain("secret-token");
  expect(raw).not.toContain("private-body");
});

test("concurrent processes append complete JSON lines without losing entries", async () => {
  const actualSpawn = Bun.spawn;
  const module = new URL("../src/audit.ts", import.meta.url).pathname;
  const processes = Array.from({ length: 4 }, (_, i) => actualSpawn([process.execPath, "-e", `import { recordAudit } from ${JSON.stringify(module)}; for(let n=0;n<10;n++)recordAudit('worker-${i}', 'stop', 'requested');`], { env: { ...process.env }, stdout: "pipe", stderr: "pipe" }));
  expect(await Promise.all(processes.map(p => p.exited))).toEqual([0, 0, 0, 0]);
  expect(entries()).toHaveLength(40);
  expect(new Set(entries().map(r => r.requestId)).size).toBe(40);
});
