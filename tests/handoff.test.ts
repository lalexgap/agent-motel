import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as creation from "../src/commands/new";
import { handoffAgent } from "../src/commands/handoff";
import { readAgent, writeAgent } from "../src/state";

let home: string;
let spawn: ReturnType<typeof spyOn>;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "am-handoff-"));
  process.env.AGENTMGR_HOME = home;
  spawn = spyOn(creation, "newCommand").mockResolvedValue(undefined);
  const transcriptPath = join(home, "source.jsonl");
  writeFileSync(transcriptPath, JSON.stringify({ type: "user", message: { role: "user", content: "Continue this task" } }) + "\n");
  writeAgent({ name: "source-long", provider: "claude", status: "idle", dir: home, tmuxSession: "unused", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), transcriptPath });
});
afterEach(() => { spawn.mockRestore(); delete process.env.AGENTMGR_HOME; rmSync(home, { recursive: true, force: true }); });

test("exact handover exports context privately and starts a new provider without changing the source", async () => {
  const original = readAgent("source-long");
  const result = await handoffAgent("source-long", { to: "codex", newName: "replacement", exact: true, jump: false, quiet: true });
  expect(result).toMatchObject({ name: "replacement", target: "codex" });
  expect(readFileSync(result.file, "utf8")).toContain("Continue this task");
  expect(statSync(result.file).mode & 0o777).toBe(0o600);
  expect(spawn).toHaveBeenCalledWith(expect.objectContaining({ name: "replacement", provider: "codex", dir: home, jump: false, quiet: true }));
  expect(readAgent("source-long")).toEqual(original);
});

test("exact lookup never hands over a prefix match", async () => {
  await expect(handoffAgent("source", { to: "codex", exact: true })).rejects.toThrow('no local agent "source"');
  expect(spawn).not.toHaveBeenCalled();
});

test("ordinary CLI handoff keeps prefix matching", async () => {
  expect((await handoffAgent("source", { to: "codex", jump: false })).name).toBe("source-long-codex");
});

test("invalid provider and empty transcripts do not create agents", async () => {
  await expect(handoffAgent("source-long", { to: "invalid", exact: true })).rejects.toThrow("--to must be");
  writeFileSync(join(home, "source.jsonl"), "");
  await expect(handoffAgent("source-long", { to: "codex", exact: true })).rejects.toThrow();
  expect(spawn).not.toHaveBeenCalled();
});

test("handover bases the new worktree on the source commit", async () => {
  const git = (...args: string[]) => {
    const result = Bun.spawnSync(["git", "-C", home, ...args]);
    if (result.exitCode) throw new Error(result.stderr.toString());
    return result.stdout.toString().trim();
  };
  git("init", "-b", "main"); git("config", "user.email", "test@example.test"); git("config", "user.name", "Test");
  git("commit", "--allow-empty", "-m", "base"); git("switch", "-c", "feature"); git("commit", "--allow-empty", "-m", "source work");
  const head = git("rev-parse", "HEAD");
  await handoffAgent("source-long", { to: "codex", exact: true, quiet: true });
  expect(spawn).toHaveBeenCalledWith(expect.objectContaining({ base: head }));
});

test("hidden handover CLI consumes and validates --new-name as a string", () => {
  const run = (name: string) => Bun.spawnSync(["bun", "src/index.ts", "__handoff", "missing", "--to", "codex", "--new-name", name, "--local"], { env: process.env });
  const valid = run("replacement");
  expect(valid.stderr.toString()).toContain('no local agent "missing"');
  expect(valid.stderr.toString()).not.toContain("--new-name must");
  expect(run("../invalid").stderr.toString()).toContain("--new-name must");
});
