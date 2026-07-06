import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { trashDir } from "./paths";
import type { AgentState } from "./state";

export type TrashedState = AgentState & { trashedAt: string };

function trashFile(name: string): string {
  return join(trashDir(), `${name}.json`);
}

// Snapshot a state file before `am rm` deletes it, so an accidental delete is
// recoverable with `am restore`. Keyed by name — the latest delete wins. The
// conversation and (without --clean) the worktree are untouched by rm, so the
// state snapshot is all that's needed to bring the agent back.
export function trashState(state: AgentState): void {
  mkdirSync(trashDir(), { recursive: true });
  const trashed: TrashedState = { ...state, trashedAt: new Date().toISOString() };
  writeFileSync(trashFile(state.name), JSON.stringify(trashed, null, 2) + "\n");
}

export function readTrashedState(name: string): TrashedState | null {
  const file = trashFile(name);
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8")) as TrashedState;
  } catch {
    return null;
  }
}

// Drop a trash snapshot for good (`am gc` past its retention).
export function removeTrashed(name: string): void {
  rmSync(trashFile(name), { force: true });
}

// Removed agents available to restore, newest deletion first.
export function listTrashed(): TrashedState[] {
  if (!existsSync(trashDir())) return [];
  const out: TrashedState[] = [];
  for (const f of readdirSync(trashDir())) {
    if (!f.endsWith(".json")) continue;
    try {
      out.push(JSON.parse(readFileSync(join(trashDir(), f), "utf8")) as TrashedState);
    } catch {
      // skip a corrupt snapshot
    }
  }
  return out.sort((a, b) => (b.trashedAt ?? "").localeCompare(a.trashedAt ?? ""));
}
