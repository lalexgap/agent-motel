import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyDevPoolCleanup, planDevPoolCleanup } from "../src/cleanupDevPool";
import type { AgentState } from "../src/state";

let root: string, agent: AgentState;
let saved: NodeJS.ProcessEnv;
beforeEach(() => {
  saved = { ...process.env };
  root = mkdtempSync(join(tmpdir(), "am-cleanup-pool-"));
  process.env.AGENTMGR_HOME = join(root, "am");
  process.env.DEV_POOL_ROOT = join(root, "pool");
  mkdirSync(join(root, "pool", "state"), { recursive: true });
  mkdirSync(join(root, "bin"));
  mkdirSync(join(root, "checkout", "tmp"), { recursive: true });
  process.env.PATH = join(root, "bin");
  agent = { name: "fixture", createdAt: "now", updatedAt: "now", status: "exited", dir: join(root, "checkout"), worktreePath: join(root, "checkout"), tmuxSession: "fixture" };
});
afterEach(() => { process.env = saved; rmSync(root, { recursive: true, force: true }); });
function command(name: string, body: string) {
  const file = join(root, "bin", name); writeFileSync(file, `#!/bin/sh\n${body}\n`); chmodSync(file, 0o755);
}
function slot(lease: unknown, dbName?: string) { writeFileSync(join(root, "pool", "state", "slot-1.json"), JSON.stringify({ lease, dbName })); }
function database(name = "producthunt_dev_fixture") {
  writeFileSync(join(agent.dir, ".env"), "DATABASE_URL=postgres://fixture:secret@localhost/producthunt_development\n");
  writeFileSync(join(agent.dir, "tmp", ".dev-stack-db"), `DB_NAME=${name}\nDATABASE_URL=postgres://fixture:secret@localhost/${name}\n`);
}

test("no resources does not invoke dev-pool", () => {
  expect(planDevPoolCleanup(agent)).toMatchObject({ remove: [], blockers: [] });
  applyDevPoolCleanup(planDevPoolCleanup(agent));
});
test("malformed pool state fails closed", () => {
  writeFileSync(join(root, "pool", "state", "slot-1.json"), "{}");
  expect(planDevPoolCleanup(agent).blockers.join()).toContain("invalid");
});
test("other agent ownership is a hard blocker", () => {
  slot({ worktree: agent.dir, agentName: "other" });
  expect(planDevPoolCleanup(agent).blockers.join()).toContain("another agent");
});
test("shared and injected database names cannot reach a command", () => {
  for (const name of ["producthunt_development", 'producthunt_dev_x"; DROP DATABASE postgres; --']) {
    database(name);
    expect(planDevPoolCleanup(agent).blockers.join()).toContain("private namespace");
  }
});
test("preview lists exact lease and DB without exposing credentials or changing records", () => {
  database(); slot({ worktree: agent.dir, agentName: agent.name }, "producthunt_dev_fixture");
  command("psql", "echo 1"); command("dev-pool", "exit 99");
  const plan = planDevPoolCleanup(agent);
  expect(plan.blockers).toEqual([]);
  expect(plan.remove).toEqual([`dev-pool slot-1 lease (${agent.dir})`, "private database producthunt_dev_fixture (all data)"]);
  expect(JSON.stringify(plan)).not.toContain("secret");
  expect(readFileSync(join(agent.dir, "tmp", ".dev-stack-db"), "utf8")).toContain("secret");
});
test("idle slot using database blocks destructive database drop", () => {
  database(); slot(null, "producthunt_dev_fixture"); command("psql", "echo 1"); command("dev-pool", "exit 99");
  expect(planDevPoolCleanup(agent).blockers.join()).toContain("still used");
});
test("failed database drop is detected despite successful dev-pool exit", () => {
  database(); command("psql", "echo 1"); command("dev-pool", "exit 0");
  const plan = planDevPoolCleanup(agent);
  expect(plan.blockers).toEqual([]);
  expect(() => applyDevPoolCleanup(plan)).toThrow("still exists");
  expect(readFileSync(join(agent.dir, "tmp", ".dev-stack-db"), "utf8")).toContain("DB_NAME=producthunt_dev_fixture");
});
test("does not restore the database marker after absence is verified", () => {
  database();
  const exists = join(root, "db-exists"); writeFileSync(exists, "1");
  command("psql", `if [ -f '${exists}' ]; then echo 1; fi`);
  command("dev-pool", `/bin/rm '${exists}' '${join(agent.dir, "tmp", ".dev-stack-db")}'\nexit 99`);
  const plan = planDevPoolCleanup(agent);
  expect(() => applyDevPoolCleanup(plan)).toThrow(/verified removed: private database producthunt_dev_fixture/);
  expect(existsSync(join(agent.dir, "tmp", ".dev-stack-db"))).toBe(false);
});
test("lease reassignment invalidates preview before invoking cleanup", () => {
  slot({ worktree: agent.dir, agentName: agent.name }); command("dev-pool", "exit 99");
  const plan = planDevPoolCleanup(agent);
  slot({ worktree: agent.dir, agentName: "different" });
  expect(() => applyDevPoolCleanup(plan)).toThrow("ownership changed");
});

test("refuses a database marker pointing to a different server than dev-pool", () => {
  database(); command("psql", "echo 1"); command("dev-pool", "exit 99");
  writeFileSync(join(agent.dir, ".env.local"), "DATABASE_URL=postgres://fixture:secret@other-host/producthunt_development\n");
  expect(planDevPoolCleanup(agent).blockers.join()).toContain("differs from dev-pool");
});

test("successful release and drop verifies both resources before returning", () => {
  database(); slot({ worktree: agent.dir, agentName: agent.name }, "producthunt_dev_fixture");
  const exists = join(root, "db-exists"); writeFileSync(exists, "1");
  command("psql", `if [ -f '${exists}' ]; then echo 1; fi`);
  command("dev-pool", `printf '%s' '{"lease":null,"dbName":"producthunt_development"}' > '${join(root, "pool", "state", "slot-1.json")}'\n/bin/rm '${exists}'`);
  const plan = planDevPoolCleanup(agent);
  expect(plan.blockers).toEqual([]);
  expect(() => applyDevPoolCleanup(plan)).not.toThrow();
});

test("another worktree's database reference prevents cleanup", () => {
  database();
  const other = join(root, "other-checkout"); mkdirSync(join(other, "tmp"), { recursive: true });
  writeFileSync(join(other, "tmp", ".dev-stack-db"), "DB_NAME=producthunt_dev_fixture\n");
  agent.repoRoot = root;
  command("git", `printf 'worktree ${agent.dir}\\0\\0worktree ${other}\\0\\0'`);
  command("psql", "echo 1"); command("dev-pool", "exit 99");
  expect(planDevPoolCleanup(agent).blockers.join()).toContain("referenced by another worktree");
});

test("lease heartbeats do not invalidate a confirmation but a new lease does", () => {
  const lease = { worktree: agent.dir, agentName: agent.name, leaseId: "lease-one", lastSyncedAt: "before" };
  slot(lease); command("dev-pool", "exit 99");
  const first = planDevPoolCleanup(agent);
  slot({ ...lease, lastSyncedAt: "after" });
  expect(planDevPoolCleanup(agent).fingerprint).toBe(first.fingerprint);
  slot({ ...lease, leaseId: "lease-two" });
  expect(planDevPoolCleanup(agent).fingerprint).not.toBe(first.fingerprint);
});
