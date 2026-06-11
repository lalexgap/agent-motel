import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
