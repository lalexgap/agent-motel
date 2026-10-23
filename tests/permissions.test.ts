import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureDirs } from "../src/paths";
import { writeAgent } from "../src/state";
import {
  PermissionOptionError,
  answerPermission,
  claimAnswer,
  claudePermissionOptions,
  claudePermissionSummary,
  claudeToolCallStates,
  createPermission,
  listPermissions,
  pendingPermissions,
  readPermission,
  refreshPermissions,
  type PermissionRecord,
} from "../src/permissions";

const CLI = join(import.meta.dir, "../src/index.ts");
let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "am-permissions-"));
  process.env.AGENTMGR_HOME = home;
  ensureDirs();
  writeFileSync(join(home, "config.json"), JSON.stringify({ notifyCommand: "true", permissionWaitSeconds: 4 }));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  delete process.env.AGENTMGR_HOME;
});

const SUGGESTIONS = [
  { type: "addRules", rules: [{ toolName: "Bash", ruleContent: "npm test" }], behavior: "allow", destination: "localSettings" },
  { type: "setMode", mode: "acceptEdits", destination: "session" },
  { type: "somethingNew", destination: "session" },
];

function seedRecord(over: Partial<PermissionRecord> = {}): PermissionRecord {
  const { options, decisions } = claudePermissionOptions(SUGGESTIONS);
  return createPermission({
    agent: "api",
    provider: "claude",
    tool: "Bash",
    summary: "Bash: npm test",
    input: { command: "npm test" },
    options,
    decisions,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    pid: process.pid,
    ...over,
  });
}

// Plays the hook: hands an answered request to the "provider".
function answerer(): () => void {
  const timer = setInterval(() => {
    for (const r of listPermissions()) if (r.state === "answered") claimAnswer(r.id);
  }, 20);
  return () => clearInterval(timer);
}

describe("claude options", () => {
  test("allow once, one allow_always per describable suggestion, deny", () => {
    const { options, decisions } = claudePermissionOptions(SUGGESTIONS);
    expect(options).toEqual([
      { id: "allow", label: "Yes", kind: "allow" },
      { id: "suggestion-0", label: "Yes, and always allow Bash(npm test) (saved to .claude/settings.local.json)", kind: "allow_always" },
      { id: "suggestion-1", label: "Yes, and switch to acceptEdits mode for this session", kind: "allow_always" },
      { id: "deny", label: "No", kind: "deny" },
    ]);
    // The provider's own suggestion goes back verbatim: Claude persists it, or not.
    expect(decisions["suggestion-0"]).toEqual({ behavior: "allow", updatedPermissions: [SUGGESTIONS[0]] });
    expect(decisions.allow).toEqual({ behavior: "allow" });
    expect(decisions.deny).toMatchObject({ behavior: "deny" });
    expect(claudePermissionOptions(undefined).options.map((o) => o.id)).toEqual(["allow", "deny"]);
  });

  test("summaries name the tool and its main argument on one line", () => {
    expect(claudePermissionSummary("Bash", { command: "rm -rf\n node_modules", description: "x" })).toBe("Bash: rm -rf node_modules");
    expect(claudePermissionSummary("Write", { file_path: "/a/b.ts", content: "..." })).toBe("Write: /a/b.ts");
    expect(claudePermissionSummary("mcp__x__y", { q: 1 })).toBe('mcp__x__y: {"q":1}');
  });

  test("the transcript tells which calls already have a result", () => {
    const file = join(home, "t.jsonl");
    const use = (id: string, command: string) =>
      JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id, name: "Bash", input: { description: "d", command } }] } });
    const result = (id: string) => JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content: "ok" }] } });
    writeFileSync(file, [use("t1", "ls"), result("t1"), use("t2", "ls"), use("t3", "pwd"), "garbage"].join("\n") + "\n");
    // Key order doesn't matter.
    expect(claudeToolCallStates(file, "Bash", { command: "ls", description: "d" })).toEqual({ uses: ["t1", "t2"], answered: ["t1"] });
    appendFileSync(file, result("t2") + "\n");
    expect(claudeToolCallStates(file, "Bash", { command: "ls", description: "d" }).answered).toEqual(["t1", "t2"]);
    expect(claudeToolCallStates(join(home, "missing"), "Bash", {})).toEqual({ uses: [], answered: [] });
  });
});

describe("answering", () => {
  test("pending → answered → applied once the holder takes it", async () => {
    const record = seedRecord();
    const stop = answerer();
    try {
      expect(await answerPermission(["api"], record.id, "suggestion-0")).toEqual({ ok: true, id: record.id, optionId: "suggestion-0" });
    } finally {
      stop();
    }
    expect(readPermission(record.id)).toMatchObject({ state: "applied", optionId: "suggestion-0" });
    expect(pendingPermissions(["api"])).toEqual([]);
    expect(await answerPermission(["api"], record.id, "allow")).toMatchObject({ ok: false, reason: "already_resolved" });
  });

  test("an answer nobody takes is withdrawn: not_pending", async () => {
    const record = seedRecord();
    expect(await answerPermission(["api"], record.id, "allow", { ackMs: 100, pollMs: 10 })).toMatchObject({ ok: false, reason: "not_pending" });
    expect(readPermission(record.id)!.state).toBe("stale");
  });

  test("expired, stale, unknown, other agent's, and bad options", async () => {
    const expired = seedRecord({ expiresAt: new Date(Date.now() - 1).toISOString() });
    expect(await answerPermission(["api"], expired.id, "allow")).toMatchObject({ ok: false, reason: "expired" });
    const orphan = seedRecord();
    expect(await answerPermission(["api"], orphan.id, "allow", { alive: () => false })).toMatchObject({ ok: false, reason: "not_pending" });
    expect(await answerPermission(["api"], "01ARZ3NDEKTSV4RRFFQ69G5FAV", "allow")).toBeNull();
    expect(await answerPermission(["api"], "../../etc", "allow")).toBeNull();
    const other = seedRecord();
    expect(await answerPermission(["web"], other.id, "allow")).toBeNull();
    // Only the provider's own options: nothing am made up, nothing stale.
    expect(answerPermission(["api"], other.id, "allow-everything")).rejects.toBeInstanceOf(PermissionOptionError);
    expect(readPermission(other.id)!.state).toBe("pending");
  });

  test("refresh expires and drops dead holders; a deadline-less request stays", () => {
    const expired = seedRecord({ expiresAt: new Date(Date.now() - 1).toISOString() });
    const dead = seedRecord({ pid: 999_999_999 });
    const codex = seedRecord({ provider: "codex", expiresAt: null });
    expect(refreshPermissions().sort()).toEqual([expired.id, dead.id].sort());
    expect(readPermission(expired.id)!.state).toBe("expired");
    expect(readPermission(dead.id)!.state).toBe("stale");
    expect(pendingPermissions(["api"]).map((r) => r.id)).toEqual([codex.id]);
  });
});

describe("the PermissionRequest hook", () => {
  const transcript = () => join(home, "session.jsonl");
  const toolUse = (id: string) =>
    JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id, name: "Bash", input: { command: "npm test" } }] } }) + "\n";
  const toolResult = (id: string) =>
    JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content: "ok" }] } }) + "\n";

  beforeEach(() => {
    const now = new Date().toISOString();
    writeAgent({ name: "api", provider: "claude", status: "working", dir: home, tmuxSession: "agentmgr-api-none", createdAt: now, updatedAt: now });
    writeFileSync(transcript(), toolUse("toolu_1"));
  });

  function startHook(event = "permission-request", payload: Record<string, unknown> = {}) {
    const { AGENTMGR_PEER_INBOX: _ambient, ...env } = process.env;
    return Bun.spawn([process.execPath, CLI, "hook", event], {
      env: { ...env, AGENTMGR_AGENT: "api" },
      stdin: new Blob([
        JSON.stringify({
          hook_event_name: "PermissionRequest",
          session_id: "s1",
          transcript_path: transcript(),
          tool_name: "Bash",
          tool_input: { command: "npm test" },
          permission_suggestions: SUGGESTIONS,
          ...payload,
        }),
      ]),
      stdout: "pipe",
      stderr: "pipe",
    });
  }

  async function pending(): Promise<PermissionRecord> {
    for (let i = 0; i < 200; i++) {
      const found = listPermissions().find((r) => r.state === "pending");
      if (found) return found;
      await Bun.sleep(25);
    }
    throw new Error("the hook never recorded the request");
  }

  test("pending → answered → Claude's decision on stdout", async () => {
    const proc = startHook();
    const record = await pending();
    expect(record).toMatchObject({ agent: "api", provider: "claude", tool: "Bash", summary: "Bash: npm test", pid: proc.pid });
    expect(Date.parse(record.expiresAt!) - Date.parse(record.createdAt)).toBeGreaterThan(3000);
    expect(await answerPermission(["api"], record.id, "suggestion-0")).toMatchObject({ ok: true });
    expect(await proc.exited).toBe(0);
    expect(JSON.parse(await new Response(proc.stdout).text())).toEqual({
      hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        decision: { behavior: "allow", updatedPermissions: [SUGGESTIONS[0]] },
      },
    });
    expect(readPermission(record.id)!.state).toBe("applied");
  }, 20_000);

  test("deny goes back as Claude's deny", async () => {
    const proc = startHook();
    const record = await pending();
    await answerPermission(["api"], record.id, "deny");
    await proc.exited;
    expect(JSON.parse(await new Response(proc.stdout).text()).hookSpecificOutput.decision).toMatchObject({ behavior: "deny" });
  }, 20_000);

  test("nobody answers: no decision (Claude's prompt carries on), and the request can't be answered late", async () => {
    writeFileSync(join(home, "config.json"), JSON.stringify({ notifyCommand: "true", permissionWaitSeconds: 1 }));
    const started = Date.now();
    const proc = startHook();
    const record = await pending();
    expect(await proc.exited).toBe(0);
    expect(Date.now() - started).toBeLessThan(8000);
    expect(await new Response(proc.stdout).text()).toBe("");
    expect(readPermission(record.id)!.state).toBe("expired");
    expect(await answerPermission(["api"], record.id, "allow")).toMatchObject({ ok: false, reason: "expired" });
  }, 20_000);

  test("answered in the pane: the transcript gets the result, the request goes stale", async () => {
    const proc = startHook();
    const record = await pending();
    appendFileSync(transcript(), toolResult("toolu_1"));
    expect(await proc.exited).toBe(0);
    expect(await new Response(proc.stdout).text()).toBe("");
    expect(readPermission(record.id)).toMatchObject({ state: "stale", resolution: "answered in the pane" });
    expect(await answerPermission(["api"], record.id, "allow")).toMatchObject({ ok: false, reason: "not_pending" });
  }, 20_000);

  test("an earlier identical call's result doesn't count as this one's answer", async () => {
    writeFileSync(transcript(), toolUse("toolu_0") + toolResult("toolu_0") + toolUse("toolu_1"));
    const proc = startHook();
    const record = await pending();
    await Bun.sleep(600);
    expect(readPermission(record.id)!.state).toBe("pending");
    await answerPermission(["api"], record.id, "allow");
    await proc.exited;
    expect(await new Response(proc.stdout).text()).toContain('"behavior":"allow"');
  }, 20_000);

  test("the call running (PostToolUse) or the turn ending retires it", async () => {
    const proc = startHook();
    const record = await pending();
    const post = startHook("post-tool-use", { hook_event_name: "PostToolUse", tool_input: { command: "npm test" } });
    expect(await post.exited).toBe(0);
    expect(await proc.exited).toBe(0);
    expect(await new Response(proc.stdout).text()).toBe("");
    expect(readPermission(record.id)).toMatchObject({ state: "stale", resolution: "answered in the pane" });

    const second = startHook();
    const next = await pending();
    const stop = startHook("stop", { hook_event_name: "Stop" });
    await stop.exited;
    await second.exited;
    expect(readPermission(next.id)).toMatchObject({ state: "stale", resolution: "the turn ended" });
  }, 30_000);

  test("permissionWaitSeconds: 0 records nothing and returns at once", async () => {
    writeFileSync(join(home, "config.json"), JSON.stringify({ notifyCommand: "true", permissionWaitSeconds: 0 }));
    const proc = startHook();
    expect(await proc.exited).toBe(0);
    expect(await new Response(proc.stdout).text()).toBe("");
    expect(listPermissions()).toEqual([]);
  }, 20_000);

  test("a codex agent's permission-request hook never waits", async () => {
    const now = new Date().toISOString();
    writeAgent({ name: "api", provider: "codex", status: "working", dir: home, tmuxSession: "agentmgr-api-none", createdAt: now, updatedAt: now });
    const proc = startHook();
    expect(await proc.exited).toBe(0);
    expect(listPermissions()).toEqual([]);
  }, 20_000);
});

describe("the remote end (__permissions / __permission)", () => {
  const am = (...args: string[]) => {
    const r = Bun.spawnSync([process.execPath, CLI, ...args, "--local", "--exact"], { env: { ...process.env, AGENTMGR_AGENT: "" } });
    return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
  };

  test("lists pending requests and answers them, with the same errors", async () => {
    const now = new Date().toISOString();
    writeAgent({ name: "api", provider: "claude", status: "working", dir: home, tmuxSession: "agentmgr-api-none", createdAt: now, updatedAt: now });
    const record = seedRecord();
    const listed = am("__permissions", "api");
    expect(listed.code).toBe(0);
    expect(JSON.parse(listed.out).requests.map((r: { id: string }) => r.id)).toEqual([record.id]);
    expect(JSON.parse(listed.out).requests[0].decisions).toBeUndefined();

    const stop = answerer();
    let answered;
    try {
      answered = await Bun.spawn([process.execPath, CLI, "__permission", "api", record.id, "deny", "--local", "--exact"], {
        env: { ...process.env, AGENTMGR_AGENT: "" },
        stdout: "pipe",
      });
      await answered.exited;
    } finally {
      stop();
    }
    expect(JSON.parse(await new Response(answered.stdout).text())).toEqual({ ok: true, id: record.id, optionId: "deny" });
    expect(JSON.parse(am("__permission", "api", record.id, "allow").out)).toMatchObject({ ok: false, reason: "already_resolved" });
    expect(am("__permission", "api", "01ARZ3NDEKTSV4RRFFQ69G5FAV", "allow").err).toContain('no permission request "01ARZ3NDEKTSV4RRFFQ69G5FAV"');
    expect(am("__permission", "api", seedRecord().id, "nope").err).toContain("unknown permission option");
    expect(am("__permissions", "ghost").err).toContain('no local agent "ghost"');
  }, 30_000);
});
