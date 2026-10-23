import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  claudeGlobalConfigFile,
  claudeTrustKey,
  forgetClaudeTrust,
  paneShowsClaudeTrustPrompt,
  pretrustClaudeDir,
  readClaudeTrustLedger,
} from "../src/claudeTrust";
import { displayStatusReason } from "../src/commands/ls";
import { claudeResumeTrust } from "../src/commands/resume";
import { applyGc, planGc } from "../src/gc";
import { type AgentState } from "../src/state";

let home: string;
let file: string;

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), "am-claude-trust-")));
  process.env.AGENTMGR_HOME = join(home, "am");
  process.env.CLAUDE_CONFIG_DIR = join(home, "claude");
  mkdirSync(process.env.CLAUDE_CONFIG_DIR, { recursive: true });
  file = join(process.env.CLAUDE_CONFIG_DIR, ".claude.json");
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  delete process.env.AGENTMGR_HOME;
  delete process.env.CLAUDE_CONFIG_DIR;
});

const writeConfig = (value: unknown) => writeFileSync(file, JSON.stringify(value, null, 2), { mode: 0o600 });
const readConfig = () => JSON.parse(readFileSync(file, "utf8"));

function claudeAgent(name: string, extra: Partial<AgentState> = {}): AgentState {
  const now = new Date().toISOString();
  return { name, status: "exited", dir: "/work/a", tmuxSession: `agentmgr-claude-trust-test-${name}`, provider: "claude", createdAt: now, updatedAt: now, ...extra };
}

function git(dir: string, ...args: string[]) {
  expect(Bun.spawnSync(["git", "-C", dir, ...args], { stderr: "ignore" }).exitCode).toBe(0);
}

describe("claudeGlobalConfigFile", () => {
  test("follows CLAUDE_CONFIG_DIR", () => {
    expect(claudeGlobalConfigFile()).toBe(file);
  });
});

describe("claudeTrustKey", () => {
  test("is the dir outside git, the repo root inside it, and the main checkout from a worktree", () => {
    const plain = join(home, "plain");
    const repo = join(home, "repo");
    mkdirSync(plain);
    mkdirSync(join(repo, "sub"), { recursive: true });
    git(repo, "init", "-q");
    git(repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "init");
    git(repo, "worktree", "add", "-q", join(home, "wt"), "-b", "wt");
    expect(claudeTrustKey(plain)).toBe(plain);
    expect(claudeTrustKey(join(repo, "sub"))).toBe(repo);
    expect(claudeTrustKey(join(home, "wt"))).toBe(repo);
  });
});

describe("pretrustClaudeDir", () => {
  test("writes only the new project's trust, keeping every other field and the file mode", () => {
    writeConfig({ userID: "u", oauthAccount: { a: 1 }, projects: { "/work/other": { hasTrustDialogAccepted: false, lastCost: 3 } } });
    pretrustClaudeDir("/work/a");
    const config = readConfig();
    expect(config.userID).toBe("u");
    expect(config.oauthAccount).toEqual({ a: 1 });
    expect(config.projects["/work/other"]).toEqual({ hasTrustDialogAccepted: false, lastCost: 3 });
    expect(config.projects["/work/a"].hasTrustDialogAccepted).toBe(true);
    expect(config.projects["/work/a"].allowedTools).toEqual([]);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(Object.keys(readClaudeTrustLedger())).toEqual(["/work/a"]);
    expect(existsSync(`${file}.lock`)).toBe(false);
  });

  test("an entry without an answer keeps its fields", () => {
    writeConfig({ projects: { "/work/a": { lastSessionId: "s" } } });
    pretrustClaudeDir("/work/a");
    expect(readConfig().projects["/work/a"]).toEqual({ lastSessionId: "s", hasTrustDialogAccepted: true });
  });

  test("leaves trust the user granted or withheld, and records neither", () => {
    writeConfig({ projects: { "/work/user": { hasTrustDialogAccepted: true }, "/work/no": { hasTrustDialogAccepted: false } } });
    const before = readFileSync(file, "utf8");
    pretrustClaudeDir("/work/user");
    pretrustClaudeDir("/work/no");
    expect(readFileSync(file, "utf8")).toBe(before);
    expect(readClaudeTrustLedger()).toEqual({});
  });

  test("a second launch in the same dir changes nothing", () => {
    writeConfig({});
    pretrustClaudeDir("/work/a");
    const before = readFileSync(file, "utf8");
    const ledger = readClaudeTrustLedger();
    pretrustClaudeDir("/work/a");
    expect(readFileSync(file, "utf8")).toBe(before);
    expect(readClaudeTrustLedger()).toEqual(ledger);
  });

  test("never creates, repairs or writes through the config", () => {
    pretrustClaudeDir("/work/a");
    expect(existsSync(file)).toBe(false);
    expect(existsSync(`${file}.lock`)).toBe(false);
    writeFileSync(file, "{ torn");
    pretrustClaudeDir("/work/a");
    expect(readFileSync(file, "utf8")).toBe("{ torn");
    const real = join(home, "real.json");
    writeFileSync(real, "{}");
    rmSync(file);
    symlinkSync(real, file);
    pretrustClaudeDir("/work/a");
    expect(readFileSync(real, "utf8")).toBe("{}");
    expect(readClaudeTrustLedger()).toEqual({});
  });

  test("breaks a stale Claude Code lock", () => {
    writeConfig({});
    mkdirSync(`${file}.lock`);
    const old = new Date(Date.now() - 60_000);
    utimesSync(`${file}.lock`, old, old);
    pretrustClaudeDir("/work/a");
    expect(readConfig().projects["/work/a"].hasTrustDialogAccepted).toBe(true);
    expect(existsSync(`${file}.lock`)).toBe(false);
  });

  test("waits on a held lock and gives up without writing", () => {
    writeConfig({});
    mkdirSync(`${file}.lock`);
    pretrustClaudeDir("/work/a");
    expect(readConfig()).toEqual({});
    expect(existsSync(`${file}.lock`)).toBe(true);
  });
});

describe("forgetClaudeTrust", () => {
  test("drops only am's trust flag, keeping what Claude added since", () => {
    writeConfig({});
    pretrustClaudeDir("/work/a");
    const config = readConfig();
    config.projects["/work/a"].lastSessionId = "s";
    config.projects["/work/user"] = { hasTrustDialogAccepted: true };
    writeConfig(config);
    expect(forgetClaudeTrust("/work/a")).toBe(true);
    expect(forgetClaudeTrust("/work/user")).toBe(true);
    const after = readConfig();
    expect(after.projects["/work/a"].lastSessionId).toBe("s");
    expect("hasTrustDialogAccepted" in after.projects["/work/a"]).toBe(false);
    expect(after.projects["/work/user"]).toEqual({ hasTrustDialogAccepted: true });
    expect(readClaudeTrustLedger()).toEqual({});
  });

  test("an unreadable config keeps the ledger entry for gc to retry", () => {
    writeConfig({});
    pretrustClaudeDir("/work/a");
    writeFileSync(file, "{ torn");
    expect(forgetClaudeTrust("/work/a")).toBe(false);
    expect(Object.keys(readClaudeTrustLedger())).toEqual(["/work/a"]);
  });

  test("resuming in a new dir trusts it and keeps the old trust", () => {
    writeConfig({});
    const old = join(home, "old");
    const moved = join(home, "new");
    mkdirSync(old);
    mkdirSync(moved);
    pretrustClaudeDir(old);
    claudeResumeTrust(claudeAgent("mover", { dir: moved }));
    expect(Object.keys(readClaudeTrustLedger()).sort()).toEqual([moved, old].sort());
    expect(readConfig().projects[old].hasTrustDialogAccepted).toBe(true);
    expect(readConfig().projects[moved].hasTrustDialogAccepted).toBe(true);
  });

  test("gc prunes am's entries for dirs that are gone", () => {
    writeConfig({});
    pretrustClaudeDir(home);
    pretrustClaudeDir(join(home, "gone"));
    const plan = planGc({ agentDays: 7, trashDays: 30 });
    expect(plan.claudeTrust).toEqual([join(home, "gone")]);
    expect(applyGc(plan)).toContain(`removed claude trust entry for ${join(home, "gone")}`);
    expect(Object.keys(readClaudeTrustLedger())).toEqual([home]);
  });
});

describe("trust prompt status", () => {
  const PANE = [
    "─".repeat(40),
    " Accessing workspace:",
    " /work/a",
    " Quick safety check: Is this a project you created or one you trust? (Like your own code, a well-known open source project, or",
    " ❯ No, exit",
    "   Yes, I trust this folder",
    " Enter to confirm · Esc to cancel",
  ];

  test("recognizes Claude Code's trust prompt", () => {
    expect(paneShowsClaudeTrustPrompt(PANE)).toBe(true);
    expect(paneShowsClaudeTrustPrompt(["❯ ", "  ⏵⏵ bypass permissions on"])).toBe(false);
  });

  test("a starting agent shown as needs-attention gets the trust reason", () => {
    const agent = claudeAgent("a", { status: "starting", statusReason: "launching" });
    expect(displayStatusReason(agent, "needs-attention")).toBe("Claude is asking to trust this folder");
    expect(displayStatusReason(agent, "starting")).toBe("launching");
  });
});
