import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { readAgent, writeAgent } from "../state";
import { listTrashed, readTrashedState } from "../trash";
import { reviveAgent } from "./resume";

// `am restore <name>` brings back an agent removed with `am rm`: re-register its
// state from the trash snapshot and resume its conversation. `am restore` with
// no name lists what's recoverable.
export async function restoreCommand(name: string | undefined, opts: { resume?: boolean } = {}): Promise<void> {
  if (!name) {
    const trashed = listTrashed();
    if (trashed.length === 0) {
      console.log("no recently removed agents to restore");
      return;
    }
    console.log("removed agents — restore with `am restore <name>`:");
    for (const t of trashed) {
      console.log(`  ${t.name}  · removed ${t.trashedAt}  · ${t.dir}`);
    }
    return;
  }

  if (readAgent(name)) throw new Error(`agent "${name}" already exists — nothing to restore`);
  const trashed = readTrashedState(name);
  if (!trashed) throw new Error(`no removed agent "${name}" to restore — run \`am restore\` to see what's recoverable`);

  const { trashedAt, ...state } = trashed;

  // If `rm --clean` removed the worktree, recreate it from its branch so the
  // agent has somewhere to run again. Committed work is on the branch;
  // uncommitted changes from before the delete are gone for good.
  if (!existsSync(state.dir) && state.worktreePath && state.worktreeBranch && state.repoRoot && existsSync(state.repoRoot)) {
    mkdirSync(dirname(state.worktreePath), { recursive: true });
    const res = Bun.spawnSync(["git", "-C", state.repoRoot, "worktree", "add", state.worktreePath, state.worktreeBranch]);
    if (res.exitCode === 0) console.log(`recreated worktree ${state.worktreePath} from ${state.worktreeBranch}`);
    else console.error(`warning: could not recreate worktree: ${res.stderr.toString().trim()}`);
  }

  state.status = "exited";
  state.workingSince = undefined;
  writeAgent(state);
  console.log(`restored agent "${name}" (removed ${trashedAt})`);

  if (opts.resume === false) {
    console.log(`  start it:  am resume ${name}`);
    return;
  }
  if (!existsSync(state.dir)) {
    console.error(`  note: ${state.dir} no longer exists — re-registered, but can't relaunch; read its history with \`am transcript ${name}\``);
    return;
  }
  await reviveAgent(state);
  console.log(`  resumed in ${state.dir} — jump with \`am j ${name}\``);
}
