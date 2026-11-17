import { parseEnv } from "node:util";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, lstatSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import type { AgentState } from "./state";
import { canonicalPath, withWorktreeDeletionLock } from "./worktreeOwnership";

export interface DevPoolCleanupPlan {
  remove: string[];
  blockers: string[];
  worktree?: string;
  dbName?: string;
  fingerprint?: string;
  repoRoot?: string;
}

type Slot = { id: number; lease: null | { worktree: string; agentName?: string; leaseId?: string; owner?: { pid?: number; startTime?: string } }; dbName?: string; lastWorktree?: string };
const privateName = /^producthunt_dev_[a-zA-Z0-9_]+$/;

function run(args: string[], env?: Record<string, string | undefined>) {
  try { return Bun.spawnSync(args, { env: env ?? process.env, timeout: 30_000, killSignal: "SIGKILL" }); }
  catch { return { exitCode: -1, stdout: Buffer.from(""), stderr: Buffer.from("") }; }
}

function slots(): Slot[] {
  const root = process.env.DEV_POOL_ROOT || join(homedir(), ".dev-pool");
  const result: Slot[] = [];
  for (let id = 1; id <= 3; id++) {
    const file = join(root, "state", `slot-${id}.json`);
    let raw: string;
    try { raw = readFileSync(file, "utf8"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw new Error(`cannot read dev-pool slot-${id}`); }
    const state = JSON.parse(raw);
    if (!state || typeof state !== "object" || !Object.hasOwn(state, "lease") ||
        (state.lease !== null && (!state.lease || typeof state.lease.worktree !== "string" || !isAbsolute(state.lease.worktree))) ||
        (state.dbName != null && typeof state.dbName !== "string")) throw new Error(`invalid dev-pool slot-${id} ownership`);
    result.push({ id, lease: state.lease, dbName: state.dbName, lastWorktree: state.lastWorktree });
  }
  return result;
}

function ownershipFingerprint(held: Slot[], record: ReturnType<typeof dbRecord>, dbName?: string): string {
  const owners = held.map(slot => ({ id: slot.id, dbName: slot.dbName, worktree: slot.lease!.worktree,
    agentName: slot.lease!.agentName, leaseId: slot.lease!.leaseId, owner: slot.lease!.owner }));
  return createHash("sha256").update(JSON.stringify({ owners, record: record?.raw, dbName })).digest("hex");
}

function dbRecord(worktree: string) {
  const file = join(worktree, "tmp", ".dev-stack-db");
  let raw: string;
  try {
    if (!lstatSync(file).isFile()) throw new Error("private database record must be a regular file");
    raw = readFileSync(file, "utf8");
  }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw new Error("cannot read private database record"); }
  const names = [...raw.matchAll(/^DB_NAME=(.*)$/gm)];
  const urls = [...raw.matchAll(/^DATABASE_URL=(.*)$/gm)];
  if (names.length !== 1 || urls.length > 1) throw new Error("invalid private database record");
  const name = names[0]![1]!.trim();
  if (!urls.length) return { name, url: null, raw };
  if (!privateName.test(name)) throw new Error("refusing database outside producthunt_dev_* private namespace");
  let url: URL;
  try { url = new URL(urls[0]![1]!.trim()); } catch { throw new Error("invalid private database URL"); }
  if (!["postgres:", "postgresql:"].includes(url.protocol) || decodeURIComponent(url.pathname.slice(1)) !== name)
    throw new Error("private database name and URL disagree");
  return { name, url, raw };
}

function verifyDatabaseServer(worktree: string, repoRoot: string | undefined, expected: URL): void {
  for (const root of [worktree, repoRoot]) {
    if (!root) continue;
    let values: Record<string, string> = {};
    for (const file of [".env", ".env.development", ".env.local", ".env.development.local"]) {
      try { values = { ...values, ...parseEnv(readFileSync(join(root, file), "utf8")) }; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("cannot inspect dev-pool database configuration"); }
    }
    if (!values.DATABASE_URL) continue;
    let actual: URL;
    try { actual = new URL(values.DATABASE_URL); } catch { throw new Error("invalid dev-pool database configuration"); }
    if (actual.protocol !== expected.protocol || actual.hostname !== expected.hostname || actual.port !== expected.port || actual.username !== expected.username || actual.password !== expected.password || actual.search !== expected.search)
      throw new Error("private database record differs from dev-pool database server");
    return;
  }
  throw new Error("cannot verify dev-pool database server");
}

function databaseExists(url: URL, name: string): boolean {
  const query = `SELECT 1 FROM pg_database WHERE datname = '${name}'`;
  const target = new URL(url); target.pathname = "/postgres";
  const result = run(["psql", "-X", "-qAt", "-v", "ON_ERROR_STOP=1", "-c", query], {
    ...process.env, PGDATABASE: target.toString(), PGCONNECT_TIMEOUT: "5", PGGSSENCMODE: "disable",
  });
  if (result.exitCode === 0) return result.stdout.toString().trim() === "1";
  // Match dev-pool's local Docker fallback, never redirect a remote database query.
  if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) throw new Error("cannot verify private database catalog");
  const containers = run(["docker", "ps", "--format", "{{.Names}}"]);
  const matches = containers.stdout.toString().trim().split("\n").filter(name => /^producthunt[-_]postgres(?:[-_]|$)/.test(name));
  if (containers.exitCode !== 0 || matches.length !== 1) throw new Error("cannot verify private database catalog");
  const fallback = run(["docker", "exec", matches[0]!, "psql", "-X", "-qAt", "-v", "ON_ERROR_STOP=1", "-U", decodeURIComponent(url.username) || "producthunt", "-d", "postgres", "-c", query]);
  if (fallback.exitCode !== 0) throw new Error("cannot verify private database catalog");
  return fallback.stdout.toString().trim() === "1";
}

function verifyOtherDatabaseReferences(worktree: string, repoRoot: string | undefined, name: string): void {
  if (!repoRoot) return;
  const list = run(["git", "-C", repoRoot, "worktree", "list", "--porcelain", "-z"]);
  if (list.exitCode !== 0) throw new Error("cannot inspect other worktree database references");
  for (const entry of list.stdout.toString().split("\0")) {
    if (!entry.startsWith("worktree ")) continue;
    const other = canonicalPath(entry.slice(9));
    if (other !== worktree && dbRecord(other)?.name === name)
      throw new Error(`private database ${name} is referenced by another worktree`);
  }
}

export function planDevPoolCleanup(agent: AgentState): DevPoolCleanupPlan {
  const plan: DevPoolCleanupPlan = { remove: [], blockers: [] };
  if (!agent.worktreePath) return plan;
  try {
    const worktree = canonicalPath(agent.worktreePath);
    plan.worktree = worktree;
    plan.repoRoot = agent.repoRoot;
    const records = slots();
    const held = records.filter(s => s.lease && canonicalPath(s.lease.worktree) === worktree);
    for (const slot of held) {
      if (slot.lease!.agentName && ![agent.name, ...(agent.aliases ?? [])].includes(slot.lease!.agentName))
        plan.blockers.push(`dev-pool slot-${slot.id} belongs to another agent`);
      plan.remove.push(`dev-pool slot-${slot.id} lease (${worktree})`);
    }
    const record = dbRecord(worktree);
    if (record?.url) {
      plan.dbName = record.name;
      verifyDatabaseServer(worktree, agent.repoRoot, record.url);
      for (const slot of records) {
        if (slot.dbName === record.name && !held.includes(slot))
          plan.blockers.push(`private database ${record.name} is still used by dev-pool slot-${slot.id}`);
      }
      verifyOtherDatabaseReferences(worktree, agent.repoRoot, record.name);
      if (databaseExists(record.url, record.name)) plan.remove.push(`private database ${record.name} (all data)`);
    }
    for (const slot of held) {
      if (slot.dbName && privateName.test(slot.dbName) && slot.dbName !== plan.dbName)
        plan.blockers.push(`slot-${slot.id} private database has no matching worktree record`);
    }
    if ((held.length || record?.url) && !Bun.which("dev-pool")) plan.blockers.push("dev-pool is unavailable");
    plan.fingerprint = ownershipFingerprint(held, record, plan.dbName);
  } catch (error) {
    plan.blockers.push(error instanceof SyntaxError ? "invalid dev-pool state" : (error as Error).message);
  }
  return plan;
}

export function applyDevPoolCleanup(plan: DevPoolCleanupPlan): void {
  if (plan.blockers.length) throw new Error(plan.blockers.join("; "));
  if (!plan.worktree || (!plan.remove.length && !plan.dbName)) return;
  const lockError = withWorktreeDeletionLock(() => {
    // Preserve the identity check while the pool cannot assign this checkout elsewhere.
    const records = slots();
    const held = records.filter(s => s.lease && canonicalPath(s.lease.worktree) === plan.worktree);
    const record = dbRecord(plan.worktree!);
    const fingerprint = ownershipFingerprint(held, record, record?.url ? record.name : undefined);
    if (fingerprint !== plan.fingerprint) throw new Error("dev-pool ownership changed; preview cleanup again");
    if (record?.url) {
      verifyDatabaseServer(plan.worktree!, plan.repoRoot, record.url);
      verifyOtherDatabaseReferences(plan.worktree!, plan.repoRoot, record.name);
    }
    if (plan.dbName && records.some(s => s.dbName === plan.dbName && !held.includes(s))) throw new Error("private database acquired by another slot");
    try {
    const result = run(["dev-pool", "-C", plan.worktree!, "down", ...(plan.dbName ? ["--drop-db"] : [])]);
    if (result.exitCode !== 0) throw new Error("dev-pool cleanup failed; worktree retained");
    if (slots().some(s => s.lease && canonicalPath(s.lease.worktree) === plan.worktree)) throw new Error("dev-pool lease was not released; worktree retained");
    if (plan.dbName && record?.url && databaseExists(record.url, plan.dbName)) throw new Error(`private database ${plan.dbName} still exists; worktree retained`);
    } catch (error) {
      if (record?.url) writeFileSync(join(plan.worktree!, "tmp", ".dev-stack-db"), record.raw, { mode: 0o600 });
      throw error;
    }
  });
  if (lockError) throw new Error(lockError);
}
