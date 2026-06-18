# Moving `~/.agent-manager/worktrees` onto `/mnt/fastdata`

**Goal:** free ~15 GB off the root filesystem by relocating the worktree data to
`/mnt/fastdata`, **without disrupting the live agents** and **without losing
`am transcript` / `am resume`** for any agent.

> Status: PLAN + SCRIPTS ONLY. Nothing here has been executed against the live
> fleet. The migration is a deliberate manual run via `scripts/move-worktrees.sh`.

---

## 1. The situation (measured)

| Thing | Value |
|---|---|
| `/` (root, ext4 `ubuntu--vg-ubuntu--lv`) | 98 G, **91 % used, ~8.9 G free** |
| `/mnt/fastdata` (ext4 `/dev/sda`) | 1.9 T, ~198 G free |
| `~/.agent-manager/worktrees` | **15 G**, a real dir on the root fs (`realpath` == itself, not a symlink) |
| Worktree agents | ~28 (most under `worktrees/producthunt/…` and `worktrees/agent-manager/…`) |

Moving the worktrees off root reclaims ~15 G — enough to get root back under
80 %.

## 2. How the pieces are wired (why this is delicate)

Two independent path-keyed systems reference the worktrees:

**a) git worktree linkage** (`src/commands/new.ts` → `createWorktree`)
- Each worktree's `.git` file points *into* the main repo:
  `gitdir: ~/code/<repo>/.git/worktrees/<name>` (on root, **not moved**).
- The main repo's admin dir points *back* to the worktree by its **logical
  path**: `~/code/<repo>/.git/worktrees/<name>/gitdir` contains
  `~/.agent-manager/worktrees/<repo>/<name>/.git`.
- ⇒ As long as the **path** `~/.agent-manager/worktrees/…` keeps resolving to the
  data (symlink *or* bind mount), git linkage stays intact. ✅ for both options.

**b) Claude transcripts** (`src/transcript.ts`)
- Claude stores each session at
  `~/.claude/projects/<cwd-slug>/<sessionId>.jsonl`, where `<cwd-slug>` is the
  **`realpath` of the cwd** with non-alphanumerics replaced by `-`
  (`claudeProjectSlug`). Symlinks are resolved *before* slugging.
- `~/.claude` is **not** being moved.
- `am transcript` (`locateTranscript`) prefers the **captured `transcriptPath`**
  from the hook payload (`src/commands/hook.ts:198`), falling back to a slug
  rebuilt from `realpathSync(agent.dir)` (`claudeProjectSlugResolved`).

**The trap:** a *symlink* at `~/.agent-manager/worktrees → /mnt/fastdata/…`
changes the `realpath` of every agent's cwd, which changes its Claude project
slug. A *bind mount* does **not** — the mountpoint path is preserved in
`realpath`.

## 3. Resume: the one real exposure — SETTLED EMPIRICALLY

The open question was: does `am resume` (which runs `claude --resume <sessionId>`
in the agent's dir, see `src/commands/resume.ts` → `buildResumeCommand`) find an
existing session **globally by id**, or only under the **current cwd's slug**?

I ran a throwaway canary (reproducible via `scripts/canary-resume.sh`, fully
isolated under `/tmp`, cleaned up afterward; it touched **zero** real agents):

1. Created a session at a real path `P` → transcript landed under `slug(P)`.
2. Simulated the migration: moved the data aside and replaced `P` with a
   **symlink** to the new location, so `realpath(P)` now maps to a *different*
   slug.
3. Ran `claude --resume <sessionId>` from `P` (the symlink).

**Result:**
```
No conversation found with session ID: bb252faa-…     (exit 1)
```

> **VERDICT: `claude --resume <id>` is cwd-slug-scoped, not global.** It looks
> only under `~/.claude/projects/<realpath-of-cwd-slug>/`. A symlink that changes
> the realpath **breaks `am resume` of every existing agent** — until its
> transcript is also reachable under the new slug.

**Mitigation, also verified in the canary:** placing the transcript under the new
slug dir restores resume (exit 0). So symlink mode is *survivable* but requires
relinking the Claude project dirs (one `ln -s <old-slug> <new-slug>` per affected
agent).

A **bind mount** sidesteps all of this: realpath is unchanged ⇒ slug unchanged ⇒
resume, `am transcript`, and the captured `transcriptPath` all keep working with
no Claude-side surgery.

## 4. Recommendation — ranked

### ✅ Option A (RECOMMENDED): bind mount
```
/mnt/fastdata/agent-manager/worktrees  ~/.agent-manager/worktrees  none  bind  0 0
```
- **Pros:** `realpath` identical → zero slug/transcript/resume impact; git
  linkage preserved; survives reboot via `/etc/fstab`; nothing under `~/.claude`
  is touched.
- **Cons:** needs `sudo` once (the mount + the fstab line).
- **Net:** the only option with *zero* exposure to the resume trap. Strongly
  preferred.

### ⚠️ Option B (fallback, no root): symlink + project-dir relink
```
~/.agent-manager/worktrees -> /mnt/fastdata/agent-manager/worktrees
# plus, per affected agent:
~/.claude/projects/<new-realpath-slug> -> ~/.claude/projects/<old-logical-slug>
```
- **Pros:** no `sudo`.
- **Cons:** changes `realpath`; **breaks resume** unless every affected agent's
  Claude project dir is relinked to the new slug (the script does this). Future
  agents created post-migration are fine (consistent slug); only the carry-over
  fleet needs the relink. Slightly more moving parts and a standing reliance on
  the slug-symlinks.

The migration script supports both via `--mode bind|symlink` and defaults to
`bind`.

## 5. Pre-flight safety (the script enforces these — it refuses otherwise)

- **Every Claude worktree agent must have a captured `transcriptPath` that still
  exists.** Confirmed today: all Claude agents under `worktrees/` have one. (The
  two without are Codex agents — keyed by session-id under `~/.codex/sessions`,
  independent of cwd, so unaffected.) If a future run finds a Claude agent
  missing it, the script **aborts** and lists the offenders.
- `/mnt/fastdata` must have free space ≥ `du` of the source (it does: ~198 G vs
  15 G).
- Source must not already be a symlink/bind mountpoint (idempotency: if it is,
  the script treats the move as already done and only re-verifies).

## 6. Runbook (what the script does, in order)

1. **Preflight** — space, transcriptPath coverage, idempotency guard.
2. **Inventory** — list agents whose dir is under the worktrees root; record
   which are **live** (tmux session exists) so they can be resumed later.
3. **Copy** — `rsync -a` source → `/mnt/fastdata/agent-manager/worktrees`, then a
   second verifying `rsync` pass that must report no differences.
4. **Stop** live worktree agents (`am stop`), wait for their tmux sessions to die.
5. **Swap** the path:
   - bind: `mv` original aside → `mkdir` empty mountpoint → `sudo mount --bind` →
     add `/etc/fstab` line.
   - symlink: `mv` original aside → `ln -s` → create the per-agent
     `~/.claude/projects` slug symlinks.
6. **Verify** — sample `git -C <worktree> status`, realpath assertion
   (bind: unchanged; symlink: now under fastdata), and that each previously-live
   agent's transcript is resolvable from the new cwd slug.
7. **Resume** previously-live agents (`am resume`), unless `--no-resume`.
8. **Reclaim** — only after you confirm everything is healthy, delete the
   `…worktrees.old-<ts>` backup to actually free the 15 G on root
   (`--purge-backup`, or rerun with it). Until then root is *not* yet freed
   (the copy is additive on purpose, so rollback is trivial).

## 7. Rollback

Nothing is destroyed until step 8. To roll back before that:
- **bind:** `sudo umount ~/.agent-manager/worktrees`, remove the fstab line,
  `rmdir` the empty mountpoint, `mv …worktrees.old-<ts>` back to
  `~/.agent-manager/worktrees`.
- **symlink:** `rm` the symlink, remove the added `~/.claude/projects/<new-slug>`
  symlinks, `mv …worktrees.old-<ts>` back.
Then `am resume` the agents that were live.

## 8. Files in this change

- `scripts/move-worktrees.sh` — idempotent, guarded migration driver
  (`--mode bind|symlink`, `--dry-run`, `--no-resume`, `--purge-backup`,
  `--yes`). **Does not auto-run anything destructive without confirmation.**
- `scripts/canary-resume.sh` — the standalone resume canary, so the
  cwd-slug-scoping verdict can be re-confirmed on any machine before committing
  to symlink mode.
