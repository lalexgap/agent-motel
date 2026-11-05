import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as parser from "../src/panePrompts";
import * as terminal from "../src/tmux";
import { acquireLifecycleLock, lifecycleLockHeld, releaseLifecycleLock } from "../src/lifecycle";
import { setRemoteRunnersForTests } from "../src/remoteAgents";
import { startApiServer, type ApiServerHandle } from "../src/server";
import { readAgent, writeAgent, type AgentState } from "../src/state";
import { agentPanePrompt, answerPanePrompt, validPromptAnswer } from "../src/webPrompts";

const NAME = "prompt-test";
const TOKEN = "prompt-test-token-with-at-least-24-characters";
const ORIGIN = "https://am.example.test";
const parsed: parser.ClaudePrompt = {
  id: "parser-id", kind: "question", title: "Which color?", selected: "1", raw: "screen",
  options: [{ id: "1", label: "Blue" }, { id: "2", label: "Green" }, { id: "3", label: "Other", other: true }],
};
let home: string;
let previousHome: string | undefined;
let screen: string;
let identity: string;
let sent: string[][];
let failSend: number;
let server: ApiServerHandle | undefined;
let tmuxSpy: ReturnType<typeof spyOn<typeof terminal, "tmux">>;
let detectSpy: ReturnType<typeof spyOn<typeof parser, "detectClaudePrompt">>;
let keysSpy: ReturnType<typeof spyOn<typeof parser, "buildPromptKeys">>;

function seedAgent(extra: Partial<AgentState> = {}) {
  writeAgent({
    name: NAME, status: "needs-attention", provider: "claude", dir: "/tmp",
    tmuxSession: "agentmgr-prompt-test", createdAt: "2026-11-05T00:00:00.000Z",
    updatedAt: "2026-11-05T00:00:00.000Z", ...extra,
  });
}

beforeEach(() => {
  previousHome = process.env.AGENTMGR_HOME;
  home = mkdtempSync(join(tmpdir(), "am-web-prompts-"));
  process.env.AGENTMGR_HOME = home;
  screen = "Question on the current screen";
  identity = "%42:1000";
  sent = [];
  failSend = 0;
  seedAgent();
  tmuxSpy = spyOn(terminal, "tmux").mockImplementation((...args) => {
    if (args[0] === "display-message") return { exitCode: 0, stdout: identity, stderr: "" };
    if (args[0] === "capture-pane") return { exitCode: 0, stdout: screen, stderr: "" };
    if (args[0] === "send-keys") {
      sent.push(args);
      return { exitCode: sent.length === failSend ? 1 : 0, stdout: "", stderr: "" };
    }
    throw new Error(`Unexpected tmux invocation: ${JSON.stringify(args)}`);
  });
  // Parsing and navigation have their own tests; these fixtures isolate delivery guards.
  detectSpy = spyOn(parser, "detectClaudePrompt").mockImplementation(() => structuredClone(parsed));
  keysSpy = spyOn(parser, "buildPromptKeys").mockReturnValue([{ key: "Down" }, { key: "Enter" }]);
});

afterEach(() => {
  server?.stop();
  server = undefined;
  releaseLifecycleLock(NAME);
  setRemoteRunnersForTests();
  keysSpy.mockRestore();
  detectSpy.mockRestore();
  tmuxSpy.mockRestore();
  rmSync(home, { recursive: true, force: true });
  if (previousHome === undefined) delete process.env.AGENTMGR_HOME;
  else process.env.AGENTMGR_HOME = previousHome;
});

function answer(optionId = "2") {
  const prompt = agentPanePrompt(NAME);
  expect(prompt).not.toBeNull();
  return { id: prompt!.id, optionId };
}

describe("pane prompt transport guard", () => {
  test("keeps the token stable during polling and delivers only to the captured pane", () => {
    const response = answer();
    expect(response.id).toMatch(/^[a-f0-9]{32}$/);
    expect(agentPanePrompt(NAME)?.id).toBe(response.id);
    expect(answerPanePrompt(NAME, response)).toEqual({ ok: true });
    expect(tmuxSpy).toHaveBeenCalledWith("display-message", "-p", "-t", "=agentmgr-prompt-test:", "#{pane_id}:#{pane_pid}");
    expect(tmuxSpy).toHaveBeenCalledWith("capture-pane", "-p", "-t", "%42");
    expect(sent).toEqual([["send-keys", "-t", "%42", "Down"], ["send-keys", "-t", "%42", "Enter"]]);
    expect(lifecycleLockHeld(NAME)).toBe(false);
  });

  test("rejects a stale screen even when the parser returns identical options", () => {
    const response = answer();
    screen += "\nUnrelated new terminal output";
    expect(answerPanePrompt(NAME, response).ok).toBe(false);
    expect(sent).toEqual([]);
    expect(keysSpy).not.toHaveBeenCalled();
    const refreshed = answer();
    expect(refreshed.id).not.toBe(response.id);
    expect(answerPanePrompt(NAME, refreshed)).toEqual({ ok: true });
  });

  test("rejects duplicate answers and hides a consumed prompt on subsequent polls", () => {
    const response = answer();
    expect(answerPanePrompt(NAME, response)).toEqual({ ok: true });
    const delivered = sent.length;
    expect(answerPanePrompt(NAME, response).ok).toBe(false);
    expect(agentPanePrompt(NAME)).toBeNull();
    expect(sent).toHaveLength(delivered);
    expect(keysSpy).toHaveBeenCalledTimes(1);
  });

  test.each(["createdAt", "tmuxSession", "paneId", "panePid"])("invalidates an answer after %s changes", (field) => {
    const response = answer();
    if (field === "paneId") identity = "%43:1000";
    else if (field === "panePid") identity = "%42:1001";
    else {
      const current = readAgent(NAME)!;
      writeAgent({ ...current, [field]: field === "createdAt" ? "2026-11-05T01:00:00.000Z" : "agentmgr-replacement" });
    }
    expect(answerPanePrompt(NAME, response).ok).toBe(false);
    expect(sent).toEqual([]);
    expect(agentPanePrompt(NAME)?.id).not.toBe(response.id);
  });

  test("blocks delivery during lifecycle changes without consuming the answer", () => {
    const response = answer();
    expect(acquireLifecycleLock(NAME)).toBe(true);
    expect(answerPanePrompt(NAME, response).ok).toBe(false);
    expect(sent).toEqual([]);
    expect(lifecycleLockHeld(NAME)).toBe(true);
    releaseLifecycleLock(NAME);
    expect(answerPanePrompt(NAME, response)).toEqual({ ok: true });
  });

  test.each(["\n", "\r", "\t", "\0", "\x1b", "\x7f"])("rejects Other text containing control %j before accessing tmux", (control) => {
    const response = { ...answer("3"), text: `before${control}after` };
    tmuxSpy.mockClear();
    expect(validPromptAnswer(response)).toBe(false);
    expect(answerPanePrompt(NAME, response).ok).toBe(false);
    expect(tmuxSpy).not.toHaveBeenCalled();
    expect(keysSpy).not.toHaveBeenCalled();
    expect(agentPanePrompt(NAME)?.id).toBe(response.id);
  });

  test("does not consume an answer rejected by the key builder", () => {
    const response = answer();
    keysSpy.mockImplementationOnce(() => { throw new Error("Unknown prompt option"); });
    expect(answerPanePrompt(NAME, { ...response, optionId: "99" })).toEqual({ ok: false, error: "Unknown prompt option" });
    expect(sent).toEqual([]);
    expect(lifecycleLockHeld(NAME)).toBe(false);
    expect(agentPanePrompt(NAME)?.id).toBe(response.id);
    expect(answerPanePrompt(NAME, response)).toEqual({ ok: true });
  });

  test("sends Other text literally with a separate Enter", () => {
    const response = { ...answer("3"), text: "--literal 'quoted' $(command); 雪" };
    keysSpy.mockReturnValue([{ key: "Down" }, { text: response.text }, { key: "Enter" }]);
    expect(answerPanePrompt(NAME, response)).toEqual({ ok: true });
    expect(keysSpy).toHaveBeenCalledWith(parsed, response);
    expect(sent).toEqual([
      ["send-keys", "-t", "%42", "Down"],
      ["send-keys", "-t", "%42", "-l", "--", response.text],
      ["send-keys", "-t", "%42", "Enter"],
    ]);
  });

  test.each([1, 2])("consumes the token even when send step %i fails", (step) => {
    const response = answer();
    failSend = step;
    expect(answerPanePrompt(NAME, response)).toEqual({ ok: false, error: "Terminal input failed; inspect the terminal before continuing" });
    expect(sent).toHaveLength(step);
    expect(answerPanePrompt(NAME, response).ok).toBe(false);
    expect(sent).toHaveLength(step);
    expect(agentPanePrompt(NAME)).toBeNull();
    expect(lifecycleLockHeld(NAME)).toBe(false);
  });

  test("rejects an answer when the prompt has disappeared", () => {
    const response = answer();
    detectSpy.mockReturnValue(null);
    expect(answerPanePrompt(NAME, response).ok).toBe(false);
    expect(sent).toEqual([]);
  });

  test.each([{ provider: "codex" }, { status: "exited" } ] as Partial<AgentState>[])("rejects an agent that is no longer eligible: %j", (change) => {
    const response = answer();
    writeAgent({ ...readAgent(NAME)!, ...change });
    tmuxSpy.mockClear();
    expect(answerPanePrompt(NAME, response).ok).toBe(false);
    expect(agentPanePrompt(NAME)).toBeNull();
    expect(tmuxSpy).not.toHaveBeenCalled();
  });
});

describe("pane prompt API", () => {
  beforeEach(() => {
    server = startApiServer({ port: 0, hostname: "127.0.0.1", token: TOKEN, webOrigin: ORIGIN });
    writeFileSync(join(home, "config.json"), JSON.stringify({ remotes: ["prompt-remote"] }));
  });

  function post(name: string, body: unknown, headers: Record<string, string> = { authorization: `Bearer ${TOKEN}` }) {
    return fetch(`${server!.url}/api/agents/${encodeURIComponent(name)}/prompt`, {
      method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body),
    });
  }

  test("requires local route authentication and maps consumed answers to conflict", async () => {
    const response = answer();
    tmuxSpy.mockClear();
    expect((await post(NAME, response, {})).status).toBe(401);
    expect((await post(NAME, response, { authorization: "Bearer wrong" })).status).toBe(401);
    expect(tmuxSpy).not.toHaveBeenCalled();
    const accepted = await post(NAME, response);
    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toEqual({ ok: true });
    expect((await post(NAME, response)).status).toBe(409);
    expect(sent).toHaveLength(2);
  });

  test("requires the matching Origin for browser session answers", async () => {
    const response = answer();
    const login = await fetch(`${server!.url}/auth/login`, {
      method: "POST", headers: { origin: ORIGIN, "content-type": "application/json" }, body: JSON.stringify({ token: TOKEN }),
    });
    const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
    expect((await post(NAME, response, { cookie })).status).toBe(403);
    expect((await post(NAME, response, { cookie, origin: "https://evil.test" })).status).toBe(403);
    expect(sent).toEqual([]);
    expect((await post(NAME, response, { cookie, origin: ORIGIN })).status).toBe(200);
  });

  test("validates answer bodies and rejects missing agents before delivery", async () => {
    const response = answer();
    for (const body of [null, {}, { ...response, id: "bad" }, { ...response, text: "bad\ntext" }, { ...response, text: "x".repeat(2001) }]) {
      expect((await post(NAME, body)).status).toBe(400);
    }
    expect((await post("missing", response)).status).toBe(404);
    expect(sent).toEqual([]);
  });

  test("forwards remote answers as JSON stdin with exact local targeting", async () => {
    const calls: { host: string; args: string[]; stdin?: string }[] = [];
    let result = { ok: true } as { ok: boolean; error?: string };
    setRemoteRunnersForTests({ am: async (host, args, opts) => {
      calls.push({ host, args, stdin: opts?.stdin });
      return { exitCode: 0, stdout: JSON.stringify(result), stderr: "" };
    } });
    const response = { id: "a".repeat(32), optionId: "3", text: "--literal 'quoted' $(command); 雪" };
    expect((await post(`prompt-remote:${NAME}`, response, {})).status).toBe(401);
    expect((await post(`prompt-remote:${NAME}`, { ...response, text: "bad\ntext" })).status).toBe(400);
    expect((await post(`unconfigured:${NAME}`, response)).status).toBe(404);
    expect(calls).toEqual([]);
    expect((await post(`prompt-remote:${NAME}`, response)).status).toBe(200);
    expect(calls).toEqual([{
      host: "prompt-remote", args: ["__prompt-answer", NAME, "--local", "--exact"], stdin: JSON.stringify(response),
    }]);
    expect(tmuxSpy).not.toHaveBeenCalled();
    result = { ok: false, error: "Prompt changed" };
    const rejected = await post(`prompt-remote:${NAME}`, response);
    expect(rejected.status).toBe(409);
    expect(await rejected.json()).toEqual(result);
  });
});
