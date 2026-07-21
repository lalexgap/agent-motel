import { existsSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ensureDirs, snapshotsDir } from "./paths";

// The last screen an agent showed, captured by the Stop/SessionEnd hooks.
// Lets the picker preview a dead agent (exited, killed, or lost to a reboot).

const SNAPSHOT_LINES = 40;

function snapshotFile(name: string): string {
  return join(snapshotsDir(), `${name}.txt`);
}

export function writeSnapshot(name: string, lines: string[]): void {
  ensureDirs();
  writeFileSync(snapshotFile(name), lines.slice(-SNAPSHOT_LINES).join("\n") + "\n");
}

export function readSnapshot(name: string): string[] | null {
  if (!existsSync(snapshotFile(name))) return null;
  return readFileSync(snapshotFile(name), "utf8").replace(/\n$/, "").split("\n");
}

export function removeSnapshot(name: string): void {
  rmSync(snapshotFile(name), { force: true });
}

export function snapshotExists(name: string): boolean {
  return existsSync(snapshotFile(name));
}

export function renameSnapshot(oldName: string, newName: string): void {
  if (snapshotExists(newName)) {
    throw new Error(`snapshot storage already exists for "${newName}" — run \`am gc\` or choose another name`);
  }
  if (snapshotExists(oldName)) renameSync(snapshotFile(oldName), snapshotFile(newName));
}

// Every stored snapshot with the agent name it belongs to — the name↔file
// mapping stays in this module so gc can't drift from the layout.
export function listSnapshots(): { name: string; path: string }[] {
  if (!existsSync(snapshotsDir())) return [];
  const out: { name: string; path: string }[] = [];
  for (const f of readdirSync(snapshotsDir())) {
    if (f.endsWith(".txt")) out.push({ name: f.slice(0, -4), path: join(snapshotsDir(), f) });
  }
  return out;
}
