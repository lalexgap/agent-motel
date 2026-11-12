import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureDirs } from "../src/paths";
import { queueAppend, queueDepth } from "../src/queue";
import { createPermission, readPermission, resolvePending } from "../src/permissions";
import {
  PROMPT_ACTIVITY_TTL_MS,
  claudePaneView,
  codexPaneView,
  isPromptAttention,
  newPromptWatch,
  promptHeld,
  promptStillWaiting,
  promptVerdict,
  settlePrompt,
  startPromptWatcher,
  type PromptSample,
} from "../src/promptStatus";
import { readAgent, updateAgentStatus, writeAgent, type AgentState } from "../src/state";

const RULE = "─".repeat(80);
const DASH = "╌".repeat(80);

// Captured from Claude Code 2.1.322.
const CLAUDE_DIALOG = [
  "  Sleeping 40 seconds then printing ok",
  "  ⎿  $ python3 -c \"import time; time.sleep(40); print('ok')\"",
  "",
  RULE,
  " Bash command",
  " Sleep 40 seconds then print ok",
  DASH,
  " python3 -c \"import time; time.sleep(40); print('ok')\"",
  DASH,
  " This command requires approval",
  "",
  " Do you want to proceed?",
  " ❯ 1. Yes",
  "   2. Yes, and don’t ask again for: python3 *",
  "   3. No",
  "",
  " Esc to cancel · Tab to amend",
];

const CLAUDE_SUBAGENT_DIALOG = [
  "✻ Waiting for 1 background agent to finish",
  RULE,
  " Bash command · from the general-purpose agent",
  " Sleep 30 seconds then print a word",
  DASH,
  " python3 -c \"import time; time.sleep(30); print('three')\"",
  DASH,
  " This command requires approval",
  " Do you want to proceed?",
  "   1. Yes",
  " ❯ 2. Yes, and don’t ask again for: python3 *",
  "   3. No",
  " Esc to cancel · Tab to amend · ctrl+x ctrl+k twice to stop background agents",
];

const CLAUDE_QUESTION = [
  RULE,
  " ☐ Scope",
  "",
  " Which scope should this cover?",
  "",
  " ❯ 1. Everything",
  "   2. Just the API",
  "   3. Type something.",
  RULE,
  "   4. Chat about this",
  "",
  " Enter to select · ↑/↓ to navigate · Esc to cancel",
];

const CLAUDE_TRUST = [
  RULE,
  " Accessing workspace:",
  " /home/me/project",
  " ❯ No, exit",
  "   Yes, I trust this folder",
  "",
  " Enter to confirm · Esc to cancel",
];

const CLAUDE_RUNNING = [
  "● Sleeping 40 seconds then printing ok · 11s",
  "  ⎿  $ python3 -c \"import time; time.sleep(40); print('ok')\" (12s)",
  "",
  "· Pollinating… (14s · ↓ 103 tokens)",
  RULE,
  "❯ ",
  RULE,
  "  ⏸ manual mode on · esc to interrupt · ← 1 agent",
];

const CLAUDE_IDLE_WITH_SUBAGENTS = [
  "● I've launched the background subagent.",
  "",
  "✻ Waiting for 1 background agent to finish",
  RULE,
  "❯ ",
  RULE,
  "  ⏸ manual mode on · ? for shortcuts · ← 1 agent · ↓ to manage",
  "  ● main",
  "  ◯ general-purpose  Run sleep-and-print command          27s · ↓ 46.2k tokens",
];

// Captured from Codex 0.167.2.
const CODEX_DIALOG = [
  "• Running touch /home/me/outside-probe",
  "",
  "  Would you like to run the following command?",
  "",
  "  Reason: Do you approve running this exact touch command outside the sandbox?",
  "",
  "  $ touch /home/me/outside-probe",
  "",
  "› 1. Yes, proceed (y)",
  "  2. Yes, and don't ask again for commands that start with `touch` (p)",
  "  3. No, and tell Codex what to do differently (esc)",
  "",
  "  Press enter to confirm or esc to cancel",
];

const CODEX_COMPOSER = [
  "• Ran touch /home/me/outside-probe",
  "  └ (no output)",
  "",
  "› Ask Codex to do anything",
  "",
  "  GPT-6-Astra medium · ~/work · Request outside-sandbox approval",
  "  ← for agents · ? for shortcuts",
];

describe("pane views", () => {
  test("a Claude dialog, whoever asked and whatever it asks", () => {
    expect(claudePaneView(CLAUDE_DIALOG)).toBe("dialog");
    expect(claudePaneView(CLAUDE_SUBAGENT_DIALOG)).toBe("dialog");
    expect(claudePaneView(CLAUDE_QUESTION)).toBe("dialog");
    expect(claudePaneView(CLAUDE_TRUST)).toBe("dialog");
    expect(claudePaneView(CLAUDE_DIALOG.map((line) => `\x1b[2m${line}\x1b[0m`))).toBe("dialog");
  });

  test("Claude's composer, mid-turn or idle with subagents listed under it", () => {
    expect(claudePaneView(CLAUDE_RUNNING)).toBe("composer");
    expect(claudePaneView(CLAUDE_IDLE_WITH_SUBAGENTS)).toBe("composer");
    expect(claudePaneView([...CLAUDE_RUNNING, "", ""])).toBe("composer");
  });

  test("dialog text in the transcript or the composer is not a dialog", () => {
    const transcript = ["● The footer reads:", " ❯ 1. Yes", " Esc to cancel · Tab to amend", ...CLAUDE_RUNNING];
    expect(claudePaneView(transcript)).toBe("composer");
    const typed = [RULE, "❯ 1. Yes", "  Esc to cancel", RULE, "  ⏸ manual mode on · ? for shortcuts"];
    expect(claudePaneView(typed)).toBe("composer");
  });

  test("neither shape is unknown, never a composer", () => {
    expect(claudePaneView([])).toBe("unknown");
    expect(claudePaneView(["some output", "more output"])).toBe("unknown");
    expect(claudePaneView([RULE, "! ls", RULE, "  bash mode"])).toBe("unknown");
    expect(claudePaneView([RULE, " A form with no options", " Name: ___"])).toBe("unknown");
  });

  test("Codex's approval overlay and its composer", () => {
    expect(codexPaneView(CODEX_DIALOG)).toBe("dialog");
    expect(codexPaneView(CODEX_COMPOSER)).toBe("composer");
    expect(codexPaneView(["• Working (3s • esc to interrupt)"])).toBe("unknown");
    const quoted = ["• The hint reads:", "  Press enter to confirm or esc to cancel", "", ...CODEX_COMPOSER];
    expect(codexPaneView(quoted)).toBe("composer");
  });
});

describe("promptVerdict", () => {
  const sample = (over: Partial<PromptSample> = {}): PromptSample => ({
    view: "composer",
    running: true,
    pane: "p",
    held: false,
    now: 100_000,
    statusAgeMs: 60_000,
    provider: "claude",
    ...over,
  });

  test("a dialog on screen keeps the prompt, however long", () => {
    const watch = newPromptWatch();
    for (let i = 0; i < 100; i++) expect(promptVerdict(watch, sample({ view: "dialog", now: i * 1000 }))).toBe("keep");
  });

  test("the composer with a turn running, seen twice, is working", () => {
    const watch = newPromptWatch();
    expect(promptVerdict(watch, sample())).toBe("keep");
    expect(promptVerdict(watch, sample())).toBe("working");
  });

  test("the composer with no turn running, seen three times, is idle", () => {
    const watch = newPromptWatch();
    expect(promptVerdict(watch, sample({ running: false }))).toBe("keep");
    expect(promptVerdict(watch, sample({ running: false }))).toBe("keep");
    expect(promptVerdict(watch, sample({ running: false }))).toBe("idle");
  });

  test("a dialog seen in between starts the count over", () => {
    const watch = newPromptWatch();
    expect(promptVerdict(watch, sample())).toBe("keep");
    expect(promptVerdict(watch, sample({ view: "dialog" }))).toBe("keep");
    expect(promptVerdict(watch, sample())).toBe("keep");
    expect(promptVerdict(watch, sample({ running: false }))).toBe("keep");
    expect(promptVerdict(watch, sample())).toBe("keep");
    expect(promptVerdict(watch, sample())).toBe("working");
  });

  test("a request the provider still holds, or one just made, is not judged by the pane", () => {
    const watch = newPromptWatch();
    for (let i = 0; i < 5; i++) expect(promptVerdict(watch, sample({ held: true }))).toBe("keep");
    for (let i = 0; i < 5; i++) expect(promptVerdict(watch, sample({ statusAgeMs: 1500 }))).toBe("keep");
    // Codex draws its dialog only after the hook that set the status returns.
    expect(promptVerdict(watch, sample({ provider: "codex", statusAgeMs: 4000 }))).toBe("keep");
    expect(promptVerdict(watch, sample({ provider: "codex", statusAgeMs: 4000 }))).toBe("keep");
    expect(promptVerdict(watch, sample({ provider: "codex", statusAgeMs: 6000 }))).toBe("keep");
    expect(promptVerdict(watch, sample({ provider: "codex", statusAgeMs: 7000 }))).toBe("working");
  });

  test("an unrecognized pane ends the prompt only after the TTL of continuous activity", () => {
    const watch = newPromptWatch();
    let now = 0;
    const active = () => promptVerdict(watch, sample({ view: "unknown", running: false, pane: `frame ${now}`, now: (now += 1000) }));
    for (let i = 0; i < PROMPT_ACTIVITY_TTL_MS / 1000; i++) expect(active()).toBe("keep");
    expect(active()).toBe("keep");
    expect(active()).toBe("working");
  });

  test("an unrecognized pane that sits still is never ended", () => {
    const watch = newPromptWatch();
    for (let i = 0; i < 200; i++) {
      expect(promptVerdict(watch, sample({ view: "unknown", running: false, pane: "still", now: i * 1000 }))).toBe("keep");
    }
    // A pause in the activity starts the TTL over.
    let now = 0;
    const frame = (pane: string) => promptVerdict(watch, sample({ view: "unknown", running: false, pane, now: (now += 20_000) }));
    expect(frame("a")).toBe("keep");
    expect(frame("b")).toBe("keep");
    expect(frame("b")).toBe("keep");
    expect(frame("c")).toBe("keep");
    expect(frame("d")).toBe("keep");
    expect(frame("e")).toBe("working");
  });
});

describe("prompt state", () => {
  let home: string;
  const agent = (over: Partial<AgentState> = {}): AgentState => ({
    name: "api",
    provider: "claude",
    status: "working",
    dir: home,
    tmuxSession: "agentmgr-api",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...over,
  });
  const atPrompt = (over: Partial<AgentState> = {}, at = "2026-01-01T00:00:10.000Z"): AgentState => {
    const state = agent(over);
    updateAgentStatus(state, "needs-attention", "approval requested — Bash", at, "prompt");
    writeAgent(state);
    return readAgent(state.name)!;
  };
  const request = (over: { agent?: string; agentId?: string; provider?: "claude" | "codex" } = {}) =>
    createPermission({
      agent: over.agent ?? "api",
      provider: over.provider ?? "claude",
      tool: "Bash",
      summary: "Bash: ls",
      input: {},
      options: [],
      decisions: {},
      expiresAt: null,
      pid: process.pid,
      ...(over.provider === "codex"
        ? { codex: { threadId: "t", requestId: 1, method: "m" } }
        : { claude: { toolInput: {}, ...(over.agentId ? { agentId: over.agentId } : {}) } }),
    });

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "am-prompt-"));
    process.env.AGENTMGR_HOME = home;
    ensureDirs();
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    delete process.env.AGENTMGR_HOME;
  });

  test("the kind rides the status and goes with the next transition", () => {
    const state = atPrompt();
    expect(state.statusKind).toBe("prompt");
    expect(isPromptAttention(state)).toBe(true);
    updateAgentStatus(state, "working");
    writeAgent(state);
    expect(readAgent("api")!.statusKind).toBeUndefined();
    expect(isPromptAttention(readAgent("api")!)).toBe(false);
  });

  test("another reason to need attention is not a prompt", () => {
    const state = atPrompt();
    updateAgentStatus(state, "needs-attention", "queued input is invalid");
    writeAgent(state);
    expect(readAgent("api")!.statusKind).toBeUndefined();
    expect(isPromptAttention(agent({ status: "needs-attention", statusKind: "prompt", provider: "antigravity" }))).toBe(false);
  });

  test("a stale writer's other fields don't bring the kind back", () => {
    atPrompt();
    const stale = readAgent("api")!;
    const hook = readAgent("api")!;
    updateAgentStatus(hook, "working");
    writeAgent(hook);
    stale.task = "something else";
    writeAgent(stale);
    expect(readAgent("api")).toMatchObject({ status: "working", task: "something else" });
    expect(readAgent("api")!.statusKind).toBeUndefined();
  });

  test("held: a subagent's request, a Codex one, and one that only just ended", () => {
    const state = atPrompt();
    expect(promptHeld(state)).toBe(false);
    const main = request();
    expect(promptHeld(state)).toBe(false);
    const other = request({ agent: "someone-else", agentId: "sub-1" });
    expect(promptHeld(state)).toBe(false);
    const sub = request({ agentId: "sub-1" });
    expect(promptHeld(state)).toBe(true);
    resolvePending(sub.id, "expired", "nobody answered in time");
    expect(promptHeld(state)).toBe(true);
    expect(promptHeld(state, Date.now() + 10_000)).toBe(false);
    const codex = request({ provider: "codex" });
    expect(promptHeld(state, Date.now() + 10_000)).toBe(true);
    resolvePending(codex.id, "stale", "answered in the pane");
    expect(promptHeld(state, Date.now() + 10_000)).toBe(false);
    expect(readPermission(main.id)!.state).toBe("pending");
    expect(readPermission(other.id)!.state).toBe("pending");
  });

  test("an old name's request holds the renamed agent too", () => {
    const state = atPrompt({ aliases: ["old-api"] });
    request({ agent: "old-api", agentId: "sub-1" });
    expect(promptHeld(state)).toBe(true);
  });

  test("promptStillWaiting: a dialog in the pane or a held request, for a prompting agent only", () => {
    const state = atPrompt();
    expect(promptStillWaiting(state, () => CLAUDE_DIALOG)).toBe(true);
    expect(promptStillWaiting(state, () => CLAUDE_RUNNING)).toBe(false);
    expect(promptStillWaiting(state, () => null)).toBe(false);
    expect(promptStillWaiting(state, () => { throw new Error("tmux gone"); })).toBe(false);
    expect(promptStillWaiting(agent({ status: "working" }), () => CLAUDE_DIALOG)).toBe(false);
    request({ agentId: "sub-1" });
    expect(promptStillWaiting(state, () => CLAUDE_RUNNING)).toBe(true);
  });

  test("settlePrompt resumes a turn and ends the main agent's recorded request", () => {
    const state = atPrompt({ workingSince: "2026-01-01T00:00:00.000Z" });
    const main = request();
    const sub = request({ agentId: "sub-1" });
    expect(settlePrompt(state, "working")).toEqual({ status: "working", turnEnded: false, retired: 1 });
    expect(readAgent("api")).toMatchObject({ status: "working", workingSince: "2026-01-01T00:00:00.000Z" });
    expect(readAgent("api")!.statusReason).toBeUndefined();
    expect(readAgent("api")!.statusKind).toBeUndefined();
    expect(readPermission(main.id)).toMatchObject({ state: "stale", resolution: "answered in the pane" });
    expect(readPermission(sub.id)!.state).toBe("pending");
  });

  test("settlePrompt to idle ends the turn the prompt aborted, and only that", () => {
    const denied = atPrompt({ workingSince: "2026-01-01T00:00:00.000Z" });
    expect(settlePrompt(denied, "idle")).toEqual({ status: "idle", turnEnded: true, retired: 0 });
    expect(readAgent("api")!.status).toBe("idle");
    expect(readAgent("api")!.workingSince).toBeUndefined();
    // Idle before a background subagent asked: no turn to end.
    const background = atPrompt({ name: "bg" });
    expect(settlePrompt(background, "idle")).toEqual({ status: "idle", turnEnded: false, retired: 0 });
  });

  test("settlePrompt leaves an agent a hook has moved on, or a later prompt", () => {
    const seen = atPrompt();
    const moved = readAgent("api")!;
    updateAgentStatus(moved, "idle");
    writeAgent(moved);
    expect(settlePrompt(seen, "working")).toBeNull();
    expect(readAgent("api")!.status).toBe("idle");

    const again = readAgent("api")!;
    updateAgentStatus(again, "needs-attention", "approval requested — Edit", "2026-01-01T00:01:00.000Z", "prompt");
    writeAgent(again);
    expect(settlePrompt(seen, "working")).toBeNull();
    expect(readAgent("api")).toMatchObject({ status: "needs-attention", statusReason: "approval requested — Edit" });
  });

  test("settlePrompt leaves a prompt raised again with the same reason", () => {
    const seen = atPrompt();
    const again = readAgent("api")!;
    updateAgentStatus(again, "needs-attention", "approval requested — Bash", "2026-01-01T00:01:00.000Z", "prompt");
    writeAgent(again);
    expect(readAgent("api")!.statusChangedAt).toBe("2026-01-01T00:01:00.000Z");
    expect(settlePrompt(seen, "idle")).toBeNull();
    expect(readAgent("api")).toMatchObject({ status: "needs-attention", statusKind: "prompt" });
  });

  describe("watcher", () => {
    const watcher = (pane: () => string[] | null, clock: { now: number }, settled: string[] = []) =>
      startPromptWatcher({
        tickMs: 3_600_000,
        capture: pane,
        alive: () => true,
        now: () => clock.now,
        onSettled: (a, s) => void settled.push(`${a.name}:${s.status}:${s.turnEnded}:${s.retired}`),
      });
    const T0 = Date.parse("2026-01-01T00:00:10.000Z");

    test("approval: the dialog goes, the turn shows running, the agent is working again", () => {
      atPrompt({ workingSince: "2026-01-01T00:00:00.000Z" });
      request();
      let pane = CLAUDE_DIALOG;
      const clock = { now: T0 + 10_000 };
      const settled: string[] = [];
      const w = watcher(() => pane, clock, settled);
      try {
        w.note("api");
        for (let i = 0; i < 5; i++) w.tick();
        expect(readAgent("api")!.status).toBe("needs-attention");
        pane = CLAUDE_RUNNING;
        w.tick();
        expect(readAgent("api")!.status).toBe("needs-attention");
        w.tick();
        expect(readAgent("api")).toMatchObject({ status: "working", workingSince: "2026-01-01T00:00:00.000Z" });
        expect(settled).toEqual(["api:working:false:1"]);
        w.tick();
        expect(settled).toHaveLength(1);
      } finally {
        w.stop();
      }
    });

    test("denial: the composer comes back with no turn running, the agent is idle", () => {
      atPrompt({ workingSince: "2026-01-01T00:00:00.000Z" });
      const settled: string[] = [];
      const w = watcher(() => CLAUDE_IDLE_WITH_SUBAGENTS, { now: T0 + 10_000 }, settled);
      try {
        w.note("api");
        w.tick();
        w.tick();
        expect(readAgent("api")!.status).toBe("needs-attention");
        w.tick();
        expect(readAgent("api")!.status).toBe("idle");
        expect(settled).toEqual(["api:idle:true:0"]);
      } finally {
        w.stop();
      }
    });

    test("a subagent's request waits out the hook that holds its dialog back", () => {
      atPrompt();
      const sub = request({ agentId: "sub-1" });
      const clock = { now: T0 + 10_000 };
      const w = watcher(() => CLAUDE_IDLE_WITH_SUBAGENTS, clock);
      try {
        w.note("api");
        for (let i = 0; i < 10; i++) w.tick();
        expect(readAgent("api")!.status).toBe("needs-attention");
        // Answered from a client: no dialog ever shows.
        resolvePending(sub.id, "stale", "answered");
        clock.now = Date.now() + 10_000;
        for (let i = 0; i < 3; i++) w.tick();
        expect(readAgent("api")!.status).toBe("idle");
      } finally {
        w.stop();
      }
    });

    test("only agents at a prompt are watched; a hook moving one on ends its watch", () => {
      writeAgent(agent({ name: "busy" }));
      const failing = agent({ name: "broken" });
      updateAgentStatus(failing, "needs-attention", "queued input is invalid");
      writeAgent(failing);
      atPrompt();
      let captures = 0;
      const w = watcher(() => (captures++, CLAUDE_DIALOG), { now: T0 + 10_000 });
      try {
        for (const name of ["busy", "broken", "gone", "api"]) w.note(name);
        w.tick();
        expect(captures).toBe(1);
        const moved = readAgent("api")!;
        updateAgentStatus(moved, "working");
        writeAgent(moved);
        w.tick();
        w.tick();
        expect(captures).toBe(1);
        expect(readAgent("broken")).toMatchObject({ status: "needs-attention", statusReason: "queued input is invalid" });
      } finally {
        w.stop();
      }
    });

    test("Codex: a turn its dialog aborted stays flagged; one that resumes is working", () => {
      atPrompt({ provider: "codex", workingSince: "2026-01-01T00:00:00.000Z" });
      let pane = CODEX_COMPOSER;
      const settled: string[] = [];
      const w = watcher(() => pane, { now: T0 + 10_000 }, settled);
      try {
        w.note("api");
        for (let i = 0; i < 6; i++) w.tick();
        expect(readAgent("api")).toMatchObject({ status: "needs-attention", workingSince: "2026-01-01T00:00:00.000Z" });
        expect(settled).toEqual([]);
        pane = ["• Working (3s • esc to interrupt)", "", ...CODEX_COMPOSER.slice(3)];
        w.tick();
        w.tick();
        expect(readAgent("api")!.status).toBe("working");
      } finally {
        w.stop();
      }
    });

    test("Codex: the approval overlay keeps the prompt, the composer ends it", () => {
      atPrompt({ provider: "codex" });
      let pane = CODEX_DIALOG;
      const w = watcher(() => pane, { now: T0 + 10_000 });
      try {
        w.note("api");
        for (let i = 0; i < 4; i++) w.tick();
        expect(readAgent("api")!.status).toBe("needs-attention");
        pane = CODEX_COMPOSER;
        for (let i = 0; i < 3; i++) w.tick();
        expect(readAgent("api")!.status).toBe("idle");
      } finally {
        w.stop();
      }
    });
  });

  // The real hook, in a child process, against a pane a stand-in tmux serves.
  describe("hooks", () => {
    const CLI = join(import.meta.dir, "../src/index.ts");
    let bin: string;
    let paneFile: string;

    beforeEach(() => {
      bin = join(home, "bin");
      mkdirSync(bin);
      paneFile = join(home, "pane.txt");
      writeFileSync(join(bin, "tmux"), `#!/bin/sh\ncase "$1" in\n  capture-pane) cat "${paneFile}" 2>/dev/null || exit 1 ;;\n  *) exit 0 ;;\nesac\n`);
      chmodSync(join(bin, "tmux"), 0o755);
      writeFileSync(join(home, "config.json"), JSON.stringify({ notifyCommand: "true", notifyOnIdle: false, permissionWaitSeconds: 0 }));
    });

    const showing = (pane: string[]) => writeFileSync(paneFile, pane.join("\n") + "\n");

    function hook(event: string, payload: Record<string, unknown> = {}): void {
      const { AGENTMGR_PEER_INBOX: _inbox, AGENTMGR_SYSTEMD: _systemd, ...env } = process.env;
      const result = Bun.spawnSync([process.execPath, CLI, "hook", event], {
        env: { ...env, AGENTMGR_AGENT: "api", PATH: `${bin}:${process.env.PATH}` },
        stdin: Buffer.from(JSON.stringify(payload)),
      });
      expect(result.exitCode).toBe(0);
    }

    test("a permission request and its notification mark the prompt; other notifications don't", () => {
      writeAgent(agent());
      hook("permission-request", { tool_name: "Bash", tool_input: { command: "ls" } });
      expect(readAgent("api")).toMatchObject({ status: "needs-attention", statusReason: "approval requested — Bash", statusKind: "prompt" });
      hook("notification", { message: "Claude needs your permission", notification_type: "permission_prompt" });
      expect(readAgent("api")).toMatchObject({ statusReason: "Claude needs your permission", statusKind: "prompt" });
      hook("notification", { message: "Claude Code login expired", notification_type: "auth_expired" });
      expect(readAgent("api")).toMatchObject({ status: "needs-attention", statusReason: "Claude Code login expired" });
      expect(readAgent("api")!.statusKind).toBeUndefined();
      hook("notification", { message: "Claude needs your permission to use Bash" });
      expect(readAgent("api")!.statusKind).toBe("prompt");
    }, 30_000);

    test("the call that was approved clears the prompt once it has run", () => {
      atPrompt();
      showing(CLAUDE_RUNNING);
      hook("post-tool-use", { tool_name: "Bash", tool_input: { command: "ls" } });
      expect(readAgent("api")!.status).toBe("working");
      expect(readAgent("api")!.statusKind).toBeUndefined();
    }, 30_000);

    test("another call's hooks, or the turn ending, leave a dialog that is still up", () => {
      atPrompt({ workingSince: "2026-01-01T00:00:00.000Z" });
      showing(CLAUDE_SUBAGENT_DIALOG);
      hook("post-tool-use", { tool_name: "Read", tool_input: { file_path: "/x" } });
      hook("pre-tool-use", { tool_name: "Read", tool_input: { file_path: "/y" } });
      expect(readAgent("api")).toMatchObject({ status: "needs-attention", statusKind: "prompt" });
      hook("stop", {});
      expect(readAgent("api")).toMatchObject({ status: "needs-attention", statusKind: "prompt" });
      expect(readAgent("api")!.workingSince).toBeUndefined();
      // Answered: the next hook moves it on as before.
      showing(CLAUDE_RUNNING);
      hook("user-prompt-submit", { prompt: "go on" });
      expect(readAgent("api")!.status).toBe("working");
    }, 30_000);

    test("a Stop that feeds queued mail back in leaves a dialog that is still up", () => {
      atPrompt({ workingSince: "2026-01-01T00:00:00.000Z" });
      showing(CLAUDE_SUBAGENT_DIALOG);
      queueAppend("api", "hello");
      hook("stop", {});
      expect(queueDepth("api")).toBe(0);
      expect(readAgent("api")).toMatchObject({ status: "needs-attention", statusKind: "prompt" });
    }, 30_000);

    test("a session ending is never held by a prompt", () => {
      atPrompt();
      showing(CLAUDE_DIALOG);
      hook("session-end", {});
      expect(readAgent("api")!.status).toBe("exited");
    }, 30_000);

    test("a subagent's request flags its parent; its other hooks still say nothing", () => {
      writeAgent(agent({ status: "idle" }));
      showing(CLAUDE_IDLE_WITH_SUBAGENTS);
      hook("permission-request", { tool_name: "Bash", tool_input: { command: "ls" }, agent_id: "sub-1" });
      expect(readAgent("api")).toMatchObject({
        status: "needs-attention",
        statusReason: "approval requested — Bash (subagent)",
        statusKind: "prompt",
      });
      showing(CLAUDE_SUBAGENT_DIALOG);
      hook("post-tool-use", { tool_name: "Read", tool_input: {}, agent_id: "sub-2" });
      expect(readAgent("api")!.status).toBe("needs-attention");
    }, 30_000);
  });
});
