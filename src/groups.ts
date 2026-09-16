import { Database } from "bun:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { groupsDir } from "./paths";

export interface AgentGroup {
  name: string;
  memberCount: number;
}

let active: Database | undefined;

// A separate transactional store keeps status hooks from overwriting membership
// and serializes assignment against deletion, including across CLI processes.
export function withGroupsTransaction<T>(fn: () => T): T {
  if (active) return fn();
  mkdirSync(groupsDir(), { recursive: true });
  const db = new Database(join(groupsDir(), "groups.sqlite"));
  try {
    db.exec("PRAGMA busy_timeout = 3000; PRAGMA foreign_keys = ON;");
    db.exec("CREATE TABLE IF NOT EXISTS groups (name TEXT PRIMARY KEY); CREATE TABLE IF NOT EXISTS memberships (agent TEXT PRIMARY KEY, group_name TEXT NOT NULL REFERENCES groups(name));");
    return db.transaction(() => {
      active = db;
      try { return fn(); } finally { active = undefined; }
    }).immediate();
  } finally {
    db.close();
  }
}

function read<T>(fallback: T, fn: (db: Database) => T): T {
  if (active) return fn(active);
  const file = join(groupsDir(), "groups.sqlite");
  if (!existsSync(file)) return fallback;
  const db = new Database(file, { readonly: true });
  try {
    db.exec("PRAGMA busy_timeout = 3000;");
    if (!db.query("SELECT name FROM sqlite_master WHERE name = 'memberships'").get()) return fallback;
    return fn(db);
  } finally { db.close(); }
}

export function validateGroupName(name: string): void {
  if (name === "ungrouped" || name.length > 64 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) {
    throw new Error("group name must be lowercase letters/numbers separated by hyphens (max 64); ungrouped is reserved");
  }
}

export function listGroups(): AgentGroup[] {
  return read([], (db) => db.query("SELECT g.name, count(m.agent) AS memberCount FROM groups g LEFT JOIN memberships m ON m.group_name = g.name GROUP BY g.name ORDER BY g.name").all() as AgentGroup[]);
}

export function agentGroup(name: string): string | undefined {
  return read(undefined, (db) => (db.query("SELECT group_name FROM memberships WHERE agent = ?").get(name) as { group_name: string } | null)?.group_name);
}

export function requireGroup(name: string): void {
  validateGroupName(name);
  if (!listGroups().some((group) => group.name === name)) throw new Error(`unknown group "${name}" — create it with am group create ${name}`);
}

export function createGroup(name: string): void {
  validateGroupName(name);
  withGroupsTransaction(() => active!.query("INSERT OR IGNORE INTO groups (name) VALUES (?)").run(name));
}

export function setAgentGroup(name: string, group?: string, create = false): void {
  withGroupsTransaction(() => {
    if (group) {
      if (create) createGroup(group);
      else requireGroup(group);
      active!.query("INSERT INTO memberships (agent, group_name) VALUES (?, ?) ON CONFLICT(agent) DO UPDATE SET group_name = excluded.group_name").run(name, group);
    } else {
      active!.query("DELETE FROM memberships WHERE agent = ?").run(name);
    }
  });
}

export function renameGroupMember(oldName: string, newName: string): void {
  withGroupsTransaction(() => active!.query("UPDATE memberships SET agent = ? WHERE agent = ?").run(newName, oldName));
}

export function deleteGroup(name: string): void {
  withGroupsTransaction(() => {
    requireGroup(name);
    if (listGroups().find((group) => group.name === name)!.memberCount) {
      throw new Error(`group "${name}" is not empty — move or clear its members first`);
    }
    active!.query("DELETE FROM groups WHERE name = ?").run(name);
  });
}
