import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanupAgent, planCleanup } from "../src/cleanup";
import { reviveAgent } from "../src/commands/resume";
import { codexDaemonSocket } from "../src/codexDaemon";
import { startDaemonServer, type DaemonHandle } from "../src/daemon";
import { ensurePlan } from "../src/plan";
import { agentsDir } from "../src/paths";
import { queueAppend, queueDepth } from "../src/queue";
import { readAgent, writeAgent, type AgentState } from "../src/state";

let home: string;
let repo: string;
let worktree: string;

function git(dir: string, ...args: string[]): string {
  const result = Bun.spawnSync(["git", "-C", dir, ...args]);
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return result.stdout.toString().trim();
}

function makeAgent(name = "cleanup"): AgentState {
  const now = new Date().toISOString();
  const state: AgentState = {
    name,
    status: "exited",
    dir: worktree,
    tmuxSession: `am-cleanup-test-${name}`,
    provider: "claude",
    sessionId: `session-${name}`,
    worktreePath: worktree,
    worktreeBranch: "fixture",
    repoRoot: repo,
    createdAt: now,
    updatedAt: now,
  };
  writeAgent(state);
  return state;
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "am-cleanup-"));
  process.env.AGENTMGR_HOME = home;
  process.env.DEV_POOL_ROOT = join(home, "pool");
  repo = join(home, "repo");
  worktree = join(home, "worktrees", "repo", "cleanup");
  mkdirSync(repo, { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.name", "Fixture");
  git(repo, "config", "user.email", "fixture@example.test");
  git(repo, "commit", "-q", "--allow-empty", "-m", "initial");
  mkdirSync(join(home, "worktrees", "repo"), { recursive: true });
  git(repo, "worktree", "add", "-q", "-b", "fixture", worktree);
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  delete process.env.AGENTMGR_HOME;
  delete process.env.DEV_POOL_ROOT;
});

describe("cleanup", () => {
  test("removes a clean owned worktree and queued messages while retaining recovery state", async () => {
    const agent = makeAgent();
    ensurePlan(agent.name, "retain this plan");
    queueAppend(agent.name, "pending");

    const preview = await planCleanup(agent);
    expect(preview.remove).toContain(worktree);
    expect(preview.remove).toContain("1 queued message");
    expect(preview.branch).toBe("fixture");
    expect(preview.blockers).toEqual([]);

    const result = await cleanupAgent(agent, { expectedCreatedAt: agent.createdAt });
    expect(result.applied).toBe(true);
    expect(existsSync(worktree)).toBe(false);
    expect(queueDepth(agent.name)).toBe(0);
    expect(readAgent(agent.name)).toMatchObject({
      status: "exited",
      statusReason: "cleaned; resume recreates the worktree",
      worktreeBranch: "fixture",
      sessionId: "session-cleanup",
      cleanedAt: expect.any(String),
    });
    expect(existsSync(join(home, "plans", `${agent.name}.md`))).toBe(true);
  });

  test("reports ignored and uncommitted files separately and force can remove them", async () => {
    const agent = makeAgent();
    writeFileSync(join(worktree, ".gitignore"), ".env\n");
    git(worktree, "add", ".gitignore");
    git(worktree, "commit", "-qm", "ignore local env");
    writeFileSync(join(worktree, ".env"), "secret fixture");
    writeFileSync(join(worktree, "wip.txt"), "unfinished");

    const preview = await planCleanup(agent);
    expect(preview.blockers).toEqual(expect.arrayContaining([
      expect.objectContaining({ reason: expect.stringContaining("uncommitted files: wip.txt"), forceable: true }),
      expect.objectContaining({ reason: expect.stringContaining("ignored files: .env"), forceable: true }),
    ]));
    await expect(cleanupAgent(agent)).rejects.toThrow(/cleanup blocked/);
    expect(existsSync(worktree)).toBe(true);
    await cleanupAgent(readAgent(agent.name)!, { force: true });
    expect(existsSync(worktree)).toBe(false);
  });

  test("never force-removes a nested repository", async () => {
    const agent = makeAgent();
    const nested = join(worktree, "vendor", "nested");
    mkdirSync(nested, { recursive: true });
    git(nested, "init", "-q");

    const preview = await planCleanup(agent);
    expect(preview.blockers).toContainEqual(expect.objectContaining({ reason: "contains a nested git repository", forceable: false }));
    await expect(cleanupAgent(agent, { force: true })).rejects.toThrow(/nested git repository/);
    expect(existsSync(nested)).toBe(true);
  });

  test("rejects a stale creation identity before side effects", async () => {
    const agent = makeAgent();
    await expect(cleanupAgent(agent, { expectedCreatedAt: "older-incarnation" })).rejects.toThrow(/preview cleanup again/);
    expect(existsSync(worktree)).toBe(true);
    expect(readAgent(agent.name)?.cleanedAt).toBeUndefined();
  });

  test("reports unpushed commits and only force overrides them", async () => {
    const agent = makeAgent();
    const remote = join(home, "remote.git");
    mkdirSync(remote);
    git(remote, "init", "-q", "--bare");
    git(worktree, "remote", "add", "origin", remote);
    git(worktree, "push", "-q", "-u", "origin", "fixture");
    git(worktree, "commit", "-q", "--allow-empty", "-m", "local only");

    const preview = await planCleanup(agent);
    expect(preview.blockers).toContainEqual(expect.objectContaining({ reason: "unpushed commits", forceable: true }));
    await expect(cleanupAgent(agent)).rejects.toThrow(/unpushed commits/);
    await cleanupAgent(readAgent(agent.name)!, { force: true });
    expect(existsSync(worktree)).toBe(false);
  });

  test("records the checked-out branch for recovery instead of stale state metadata", async () => {
    const agent = makeAgent();
    git(worktree, "switch", "-q", "-c", "actual-cleanup-branch");

    const preview = await planCleanup(agent);
    expect(preview.branch).toBe("actual-cleanup-branch");
    await cleanupAgent(agent);
    expect(readAgent(agent.name)?.worktreeBranch).toBe("actual-cleanup-branch");
    expect(existsSync(worktree)).toBe(false);
  });

  test("refuses cleanup from a detached HEAD", async () => {
    const agent = makeAgent();
    git(worktree, "checkout", "--detach", "-q");
    const preview = await planCleanup(agent);
    expect(preview.blockers).toContainEqual(expect.objectContaining({ reason: expect.stringContaining("HEAD is detached"), forceable: false }));
    await expect(cleanupAgent(agent, { force: true })).rejects.toThrow(/HEAD is detached/);
    expect(existsSync(worktree)).toBe(true);
  });

  test("rejects a force confirmation after tracked work changes", async () => {
    const agent = makeAgent();
    writeFileSync(join(worktree, "tracked.txt"), "before\n");
    git(worktree, "add", "tracked.txt");
    git(worktree, "commit", "-qm", "tracked fixture");
    const preview = await planCleanup(agent);
    writeFileSync(join(worktree, "tracked.txt"), "after\n");

    await expect(cleanupAgent(agent, { force: true, expectedToken: preview.token })).rejects.toThrow(/plan changed/);
    expect(existsSync(worktree)).toBe(true);
    expect(readAgent(agent.name)?.statusReason).toBeUndefined();
  });

  test("retains the checkout and messages when dev-pool cleanup changes the confirmed git snapshot", async () => {
    const oldPath = process.env.PATH;
    const bin = join(home, "bin");
    mkdirSync(bin);
    try {
      const agent = makeAgent();
      queueAppend(agent.name, "still pending");
      const stateDir = join(process.env.DEV_POOL_ROOT!, "state");
      mkdirSync(stateDir, { recursive: true });
      const slot = join(stateDir, "slot-1.json");
      writeFileSync(slot, JSON.stringify({ lease: { worktree, agentName: agent.name } }));
      writeFileSync(join(bin, "dev-pool"), `#!/bin/sh\nprintf '%s' changed > '${join(worktree, "late.txt")}'\nprintf '%s' '{"lease":null}' > '${slot}'\n`);
      chmodSync(join(bin, "dev-pool"), 0o755);
      process.env.PATH = `${bin}:${oldPath}`;

      const preview = await planCleanup(agent);
      await expect(cleanupAgent(agent, { force: true, expectedToken: preview.token })).rejects.toThrow(/partially completed.*slot-1.*worktree and messages retained/);
      expect(existsSync(join(worktree, "late.txt"))).toBe(true);
      expect(queueDepth(agent.name)).toBe(1);
      expect(readAgent(agent.name)?.cleanedAt).toBeUndefined();
      expect(readAgent(agent.name)?.statusReason).toContain("removed dev-pool slot-1 lease");
    } finally {
      process.env.PATH = oldPath;
    }
  });

  test("rejects a managed agent directory outside its worktree", async () => {
    const agent = makeAgent();
    agent.dir = join(home, "external");
    mkdirSync(agent.dir);
    writeAgent(agent);

    const preview = await planCleanup(agent);
    expect(preview.blockers).toContainEqual(expect.objectContaining({ reason: "agent directory is outside its managed worktree", forceable: false }));
    await expect(cleanupAgent(agent, { force: true })).rejects.toThrow(/outside its managed worktree/);
    expect(existsSync(worktree)).toBe(true);
  });

  for (const mutation of ["same-metadata", "database-marker"]) {
    test(`refuses forced deletion after dev-pool ${mutation} mutation`, async () => {
      const oldPath = process.env.PATH;
      const bin = join(home, "bin");
      mkdirSync(bin);
      try {
        const agent = makeAgent();
        writeFileSync(join(worktree, ".gitignore"), "tmp/\n");
        git(worktree, "add", ".gitignore");
        git(worktree, "commit", "-qm", "ignore dev-pool marker");
        mkdirSync(join(worktree, "tmp"));
        const marker = join(worktree, "tmp", ".dev-stack-db");
        const database = join(home, "database-exists");
        if (mutation === "database-marker") {
          writeFileSync(join(worktree, ".env"), "DATABASE_URL=postgres://fixture@localhost/producthunt_development\n");
          writeFileSync(marker, "DB_NAME=producthunt_dev_fixture\nDATABASE_URL=postgres://fixture@localhost/producthunt_dev_fixture\n");
          writeFileSync(database, "1");
        }
        const loose = join(worktree, "loose.txt");
        writeFileSync(loose, "before");
        utimesSync(loose, 1700000000, 1700000000);
        const stateDir = join(process.env.DEV_POOL_ROOT!, "state");
        mkdirSync(stateDir, { recursive: true });
        const slot = join(stateDir, "slot-1.json");
        writeFileSync(slot, JSON.stringify({ lease: { worktree, agentName: agent.name } }));
        const rewrite = mutation === "same-metadata"
          ? `printf '%s' afterx > '${loose}'\ntouch -d @1700000000 '${loose}'`
          : `/bin/rm '${database}' '${marker}'\nprintf '%s' unconfirmed > '${marker}'`;
        writeFileSync(join(bin, "dev-pool"), `#!/bin/sh\nprintf '%s' '{"lease":null}' > '${slot}'\n${rewrite}\n`);
        writeFileSync(join(bin, "psql"), `#!/bin/sh\nif [ -f '${database}' ]; then echo 1; fi\n`);
        chmodSync(join(bin, "dev-pool"), 0o755);
        chmodSync(join(bin, "psql"), 0o755);
        process.env.PATH = `${bin}:${oldPath}`;
        const preview = await planCleanup(agent);
        await expect(cleanupAgent(agent, { force: true, expectedToken: preview.token })).rejects.toThrow(
          mutation === "same-metadata" ? /worktree changed after cleanup confirmation/ : /database marker reappeared/,
        );
        expect(existsSync(worktree)).toBe(true);
        expect(readFileSync(mutation === "same-metadata" ? loose : marker, "utf8")).toBe(mutation === "same-metadata" ? "afterx" : "unconfirmed");
      } finally {
        process.env.PATH = oldPath;
      }
    });
  }

  test("refuses deletion when a Codex daemon turn cannot be stopped", async () => {
    const oldCodexHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = join(home, "codex-home");
    try {
      const agent = makeAgent();
      agent.provider = "codex";
      agent.codexDaemon = true;
      writeAgent(agent);
      mkdirSync(join(process.env.CODEX_HOME, "app-server-control"), { recursive: true });
      writeFileSync(codexDaemonSocket(), "not a socket");

      await expect(cleanupAgent(agent)).rejects.toThrow(/could not stop.*Codex daemon turn/);
      expect(existsSync(worktree)).toBe(true);
      expect(readAgent(agent.name)?.cleanedAt).toBeUndefined();
    } finally {
      if (oldCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = oldCodexHome;
    }
  });

  test("resume recreates a cleaned worktree from its retained branch", async () => {
    const oldPath = process.env.PATH;
    let daemon: DaemonHandle | undefined;
    try {
      const agent = makeAgent();
      await cleanupAgent(agent);
      writeFileSync(join(home, "tmux"), `#!/bin/sh\ncase " $* " in *" has-session "*) exit 1;; *" new-session "*) printf '%s\\n' "$@" > "$AGENTMGR_HOME/resume-launch";; esac\n`);
      writeFileSync(join(home, "claude"), "#!/bin/sh\nexit 0\n");
      chmodSync(join(home, "tmux"), 0o755);
      chmodSync(join(home, "claude"), 0o755);
      process.env.PATH = `${home}:${oldPath}`;
      daemon = startDaemonServer();

      await reviveAgent(readAgent(agent.name)!);
      expect(existsSync(worktree)).toBe(true);
      expect(readAgent(agent.name)?.cleanedAt).toBeUndefined();
      expect(readAgent(agent.name)?.status).toBe("starting");
    } finally {
      daemon?.stop();
      process.env.PATH = oldPath;
    }
  });

  for (const committed of [true, false]) test(`resume recreates a cleaned worktree with a ${committed ? "committed" : "untracked-only"} cwd`, async () => {
    const oldPath = process.env.PATH;
    let daemon: DaemonHandle | undefined;
    try {
      mkdirSync(join(worktree, "packages", "app"), { recursive: true });
      writeFileSync(join(worktree, "packages", "app", "README.md"), "fixture\n");
      if (committed) {
        git(worktree, "add", ".");
        git(worktree, "commit", "-qm", "add app directory");
      }
      const agent = makeAgent("cleanup-subdir");
      agent.dir = join(worktree, "packages", "app");
      writeAgent(agent);
      await cleanupAgent(agent, { force: !committed });
      writeFileSync(join(home, "tmux"), `#!/bin/sh\ncase " $* " in *" has-session "*) exit 1;; *" new-session "*) exit 0;; esac\n`);
      writeFileSync(join(home, "claude"), "#!/bin/sh\nexit 0\n");
      chmodSync(join(home, "tmux"), 0o755);
      chmodSync(join(home, "claude"), 0o755);
      process.env.PATH = `${home}:${oldPath}`;
      daemon = startDaemonServer();

      await reviveAgent(readAgent(agent.name)!);
      expect(existsSync(join(worktree, "packages", "app"))).toBe(true);
      expect(readAgent(agent.name)?.cleanedAt).toBeUndefined();
    } finally {
      daemon?.stop();
      process.env.PATH = oldPath;
    }
  });

  test("resume rejects a restored cwd symlink escaping the checkout", async () => {
    const external = join(home, "external");
    mkdirSync(external);
    symlinkSync(external, join(worktree, "escape"));
    git(worktree, "add", "escape");
    git(worktree, "commit", "-qm", "add symlink fixture");
    const agent = makeAgent();
    await cleanupAgent(agent);
    const cleaned = readAgent(agent.name)!;
    cleaned.dir = join(worktree, "escape", "new-cwd");
    writeFileSync(join(agentsDir(), `${cleaned.name}.json`), JSON.stringify(cleaned));
    await expect(reviveAgent(cleaned)).rejects.toThrow(/cannot be recreated safely/);
    expect(existsSync(join(external, "new-cwd"))).toBe(false);
    expect(readAgent(agent.name)?.cleanedAt).toBeDefined();
  });
});
