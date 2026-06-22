#!/usr/bin/env bash
#
# move-worktrees.sh — relocate ~/.agent-manager/worktrees onto /mnt/fastdata to
# free space on the root filesystem, keeping the path ~/.agent-manager/worktrees
# valid (via a bind mount or a symlink) so git-worktree linkage, `am transcript`,
# and `am resume` all keep working.
#
# READ docs/worktree-migration-plan.md FIRST. This is a deliberate manual tool —
# it stops and resumes live agents. It is idempotent and additive: nothing on
# root is deleted until you explicitly pass --purge-backup.
#
# Usage:
#   scripts/move-worktrees.sh [options]
#     --mode bind|symlink   how to re-expose the data at the old path
#                           (default: bind — zero realpath/slug/resume impact)
#     --dest <dir>          destination root (default: /mnt/fastdata/agent-manager/worktrees)
#     --dry-run             print what would happen; change nothing
#     --no-resume           don't auto-resume agents that were live
#     --purge-backup        after a verified migration, delete the on-root backup
#                           (this is the step that actually frees the ~15 G)
#     --yes                 don't prompt for confirmation before destructive steps
#
# Recommended sequence:
#   1) scripts/move-worktrees.sh --dry-run
#   2) scripts/move-worktrees.sh                 # bind mount, agents stopped+resumed
#   3) verify the fleet is healthy (am ls, am transcript <name>, jump into a few)
#   4) scripts/move-worktrees.sh --purge-backup  # reclaim the root space
#
set -euo pipefail

# ---- config / args ---------------------------------------------------------
MODE=bind
DEST=/mnt/fastdata/agent-manager/worktrees
DRY_RUN=0
NO_RESUME=0
PURGE_BACKUP=0
ASSUME_YES=0

SRC="${HOME}/.agent-manager/worktrees"
AGENTS_DIR="${HOME}/.agent-manager/agents"
PROJECTS_DIR="${HOME}/.claude/projects"
TS="$(date +%Y%m%d-%H%M%S)"
BACKUP="${SRC}.old-${TS}"

die()  { echo "ERROR: $*" >&2; exit 1; }
info() { echo "[move-worktrees] $*"; }
run()  { if [[ "$DRY_RUN" == 1 ]]; then echo "  DRY: $*"; else eval "$@"; fi; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --mode)          MODE="${2:?}"; shift 2;;
    --dest)          DEST="${2:?}"; shift 2;;
    --dry-run)       DRY_RUN=1; shift;;
    --no-resume)     NO_RESUME=1; shift;;
    --purge-backup)  PURGE_BACKUP=1; shift;;
    --yes)           ASSUME_YES=1; shift;;
    -h|--help)       sed -n '2,40p' "$0"; exit 0;;
    *)               die "unknown arg: $1";;
  esac
done
[[ "$MODE" == bind || "$MODE" == symlink ]] || die "--mode must be 'bind' or 'symlink'"

command -v am   >/dev/null || die "'am' not on PATH"
command -v rsync>/dev/null || die "'rsync' not installed"
[[ "$(id -u)" != 0 ]] || die "run as your normal user (the script uses sudo only for the mount)"

# Don't run from inside a worktree agent: the script stops worktree agents, so it
# would kill itself mid-run. Run it from a plain login shell (or tmux outside am).
if [[ -n "${AGENTMGR_AGENT:-}" && "$DRY_RUN" != 1 ]]; then
  die "running inside managed agent '$AGENTMGR_AGENT' — this script stops worktree agents and would kill itself. Run from a normal shell."
fi

confirm() {
  [[ "$ASSUME_YES" == 1 || "$DRY_RUN" == 1 ]] && return 0
  read -r -p "$1 [y/N] " a; [[ "$a" == y || "$a" == Y ]]
}

slug() { printf '%s' "$1" | sed 's/[^a-zA-Z0-9]/-/g'; }

# Worktrees can hold foreign-owned dev scratch — e.g. a dev-server container's
# tmp/postgresql_data (uid 999, mode 0700) that only root can read. If any such
# path exists, du/rsync must run under sudo or they silently drop files. Detect
# once; DU/RSYNC then transparently elevate. -aHAX --numeric-ids preserves the
# foreign ownership/ACLs/xattrs faithfully so the copy is byte-for-byte.
NEED_SUDO_IO=0
SUDO=""
detect_sudo_io() {
  if find "$SRC" -xdev \( ! -readable -o ! -executable \) -print -quit 2>/dev/null | grep -q .; then
    NEED_SUDO_IO=1; SUDO="sudo"
    info "foreign-owned/unreadable paths present under $SRC → using 'sudo' for du/rsync"
  fi
}
DU()    { $SUDO du "$@"; }
RSYNC() { $SUDO rsync "$@"; }

# realpath of a logical worktree path AFTER migration, for symlink mode:
# the dir's prefix SRC becomes DEST.
post_realpath() { local p="$1"; printf '%s' "${p/#$SRC/$DEST}"; }

# ---- idempotency: already migrated? ----------------------------------------
already_migrated() {
  if [[ "$MODE" == bind ]]; then
    mountpoint -q "$SRC" 2>/dev/null
  else
    [[ -L "$SRC" ]]
  fi
}

# ---- 1. preflight ----------------------------------------------------------
info "mode=$MODE  src=$SRC  dest=$DEST  dry_run=$DRY_RUN"

if [[ "$PURGE_BACKUP" == 1 ]]; then
  # Reclaim step: delete the most-recent on-root backup, nothing else.
  shopt -s nullglob
  backups=( "${SRC}".old-* )
  shopt -u nullglob
  [[ ${#backups[@]} -gt 0 ]] || die "no ${SRC}.old-* backup found — nothing to purge"
  already_migrated || die "refusing to purge: $SRC is not a $MODE yet (migration not in place)"
  # The backup can hold foreign-owned dirs (uid 999 postgres data) that only root
  # can stat/delete; elevate for the size readout and the rm.
  if find "${backups[0]}" -xdev \( ! -readable -o ! -executable \) -print -quit 2>/dev/null | grep -q .; then SUDO=sudo; fi
  for b in "${backups[@]}"; do
    info "backup found: $b  ($($SUDO du -sh "$b" 2>/dev/null | cut -f1))"
    if confirm "DELETE this on-root backup to free space?"; then run "$SUDO rm -rf '$b'"; fi
  done
  info "purge complete."
  exit 0
fi

[[ -d "$DEST" || ! -e "$DEST" ]] || die "dest exists but is not a dir: $DEST"
mkdir -p "$(dirname "$DEST")" 2>/dev/null || true
[[ -w "$(dirname "$DEST")" ]] || die "dest parent not writable: $(dirname "$DEST")"

if already_migrated; then
  info "ALREADY MIGRATED ($SRC is a $MODE). Skipping copy/swap; will re-verify only."
else
  [[ -d "$SRC" && ! -L "$SRC" ]] || die "src is not a plain dir (already a link/mount?): $SRC"
fi

# Detect foreign-owned content so du/rsync elevate as needed.
detect_sudo_io

# Refuse if a live container mounts a path *under* the worktrees — moving a busy
# data dir (e.g. a running postgres) would corrupt it. Best-effort: skips quietly
# if docker isn't reachable. (A dev server bind-mounting the MAIN checkout, not a
# worktree, is fine and won't trip this.)
if command -v docker >/dev/null 2>&1; then
  BUSY=$( { $SUDO docker ps -q 2>/dev/null | xargs -r $SUDO docker inspect \
            --format '{{range .Mounts}}{{.Source}}{{"\n"}}{{end}}' 2>/dev/null; } \
          | grep -F "$SRC/" || true )
  if [[ -n "$BUSY" ]]; then
    echo "REFUSING: a live container mounts a path under $SRC (moving it would corrupt the data):" >&2
    printf '  %s\n' $BUSY >&2
    echo "Stop that container/dev-server first, then retry." >&2
    exit 1
  fi
fi

# space check (sudo-aware so foreign-owned dirs are counted, not skipped)
SRC_KB=$(DU -sk "$SRC" 2>/dev/null | tail -1 | cut -f1)
DEST_AVAIL_KB=$(df -Pk "$(dirname "$DEST")" | awk 'NR==2{print $4}')
info "source size: $((SRC_KB/1024)) MB   dest avail: $((DEST_AVAIL_KB/1024)) MB"
[[ "$DEST_AVAIL_KB" -ge "$SRC_KB" ]] || die "not enough space on dest fs"

# ---- 2. inventory: agents under the worktrees root -------------------------
# Emits TSV: name<TAB>provider<TAB>status<TAB>dir<TAB>transcriptPath<TAB>live(0/1)
inventory() {
  for f in "$AGENTS_DIR"/*.json; do
    [[ -e "$f" ]] || continue
    node -e '
      const a=require(process.argv[1]);
      const SRC=process.argv[2];
      if(!a.dir || !a.dir.startsWith(SRC+"/")) process.exit(0);
      const live = (()=>{ try{ require("child_process").execSync("tmux has-session -t "+JSON.stringify(a.tmuxSession),{stdio:"ignore"}); return 1;}catch{return 0;} })();
      console.log([a.name,a.provider||"claude",a.status||"",a.dir,a.transcriptPath||"",live].join("\t"));
    ' "$f" "$SRC" 2>/dev/null
  done
}

INV="$(inventory)"
N_AGENTS=$(printf '%s\n' "$INV" | grep -c . || true)
info "worktree-resident agents: $N_AGENTS"

# Safety gate: every CLAUDE agent must have an existing captured transcriptPath.
# Codex agents are keyed by session-id under ~/.codex (cwd-independent) — exempt.
MISSING=""
while IFS=$'\t' read -r name provider status dir tpath live; do
  [[ -z "$name" ]] && continue
  [[ "$provider" == codex ]] && continue
  if [[ -z "$tpath" || ! -f "$tpath" ]]; then
    MISSING+="  - $name (status=$status, transcriptPath='${tpath:-<none>}')"$'\n'
  fi
done <<< "$INV"
if [[ -n "$MISSING" ]]; then
  echo "REFUSING: these Claude worktree agents lack a usable captured transcriptPath," >&2
  echo "so their transcript may not be locatable after the move:" >&2
  printf '%s' "$MISSING" >&2
  echo "Give each at least one more turn (so a hook captures transcript_path), or rm them, then retry." >&2
  exit 1
fi
info "transcriptPath coverage OK for all Claude worktree agents."

# Which agents are live → must be stopped now, resumed at the end.
LIVE_AGENTS=()
while IFS=$'\t' read -r name provider status dir tpath live; do
  [[ "$live" == 1 ]] && LIVE_AGENTS+=("$name")
done <<< "$INV"
info "live worktree agents (${#LIVE_AGENTS[@]}): ${LIVE_AGENTS[*]:-<none>}"

# ---- 3. pre-copy while live (additive; original untouched; no downtime) ----
# Bulk copy with the agents still running, to minimize the later quiesced
# window. The authoritative, consistent copy is the delta re-sync in step 4b,
# after writers are stopped.
if ! already_migrated; then
  info "rsync pre-copy (live) → $DEST"
  run "$SUDO rsync -aHAX --numeric-ids --delete '$SRC/' '$DEST/'"
fi

# ---- 4. stop live agents ---------------------------------------------------
if ! already_migrated && [[ ${#LIVE_AGENTS[@]} -gt 0 ]]; then
  confirm "Stop ${#LIVE_AGENTS[@]} live worktree agent(s) now?" || die "aborted before stopping agents"
  for a in "${LIVE_AGENTS[@]}"; do info "am stop $a"; run "am stop '$a'"; done
  # wait for tmux sessions to actually die
  if [[ "$DRY_RUN" != 1 ]]; then
    for a in "${LIVE_AGENTS[@]}"; do
      for _ in $(seq 1 20); do
        sess=$(node -e 'console.log(require("'"$AGENTS_DIR"'/"+process.argv[1]+".json").tmuxSession)' "$a" 2>/dev/null) || sess=""
        [[ -n "$sess" ]] && tmux has-session -t "$sess" 2>/dev/null || break
        sleep 0.5
      done
    done
  fi
fi

# ---- 4b. delta re-sync now that writers are quiesced -----------------------
# This is the authoritative copy: with the agents stopped, nothing is writing
# into the worktrees, so this catches anything that changed during the live
# pre-copy. The verify pass must then report zero differences before we swap.
if ! already_migrated; then
  info "rsync delta (agents stopped) → $DEST"
  run "$SUDO rsync -aHAX --numeric-ids --delete '$SRC/' '$DEST/'"
  info "verify: re-sync must report no remaining differences"
  if [[ "$DRY_RUN" != 1 ]]; then
    CHANGES=$(RSYNC -aHAX --numeric-ids --delete -i --dry-run "$SRC/" "$DEST/" | grep -vE '^$' | wc -l)
    [[ "$CHANGES" == 0 ]] || die "verify found $CHANGES differing entries after stop — aborting before swap (is something still writing under $SRC?)"
  fi
  info "copy verified — source and dest are identical."
fi

# ---- 5. swap the path ------------------------------------------------------
if ! already_migrated; then
  confirm "Swap $SRC → $MODE pointing at $DEST? (original kept at $BACKUP)" || die "aborted before swap"
  run "mv '$SRC' '$BACKUP'"
  if [[ "$MODE" == bind ]]; then
    run "mkdir -p '$SRC'"
    run "sudo mount --bind '$DEST' '$SRC'"
    FSTAB_LINE="$DEST $SRC none bind 0 0"
    if [[ "$DRY_RUN" == 1 ]]; then
      echo "  DRY: append to /etc/fstab: $FSTAB_LINE"
    elif ! grep -qsF "$SRC none bind" /etc/fstab; then
      echo "$FSTAB_LINE" | sudo tee -a /etc/fstab >/dev/null
      info "added /etc/fstab bind entry"
    fi
  else
    run "ln -s '$DEST' '$SRC'"
  fi
fi

# symlink mode: relink each affected agent's Claude project dir so the new
# realpath slug resolves to the existing transcripts (resume is cwd-slug-scoped).
if [[ "$MODE" == symlink ]]; then
  info "relinking ~/.claude/projects slugs (symlink mode)"
  declare -A DONE=()
  while IFS=$'\t' read -r name provider status dir tpath live; do
    [[ -z "$name" || "$provider" == codex ]] && continue
    OLD_SLUG="$(slug "$dir")"
    NEW_SLUG="$(slug "$(post_realpath "$dir")")"
    [[ "$OLD_SLUG" == "$NEW_SLUG" ]] && continue
    [[ -n "${DONE[$NEW_SLUG]:-}" ]] && continue
    DONE[$NEW_SLUG]=1
    if [[ -e "$PROJECTS_DIR/$OLD_SLUG" && ! -e "$PROJECTS_DIR/$NEW_SLUG" ]]; then
      run "ln -s '$PROJECTS_DIR/$OLD_SLUG' '$PROJECTS_DIR/$NEW_SLUG'"
    fi
  done <<< "$INV"
fi

# ---- 6. verify -------------------------------------------------------------
info "verifying…"
if [[ "$DRY_RUN" != 1 ]]; then
  SAMPLE=$(printf '%s\n' "$INV" | head -1 | cut -f4)
  if [[ -n "$SAMPLE" ]]; then
    git -C "$SAMPLE" status --short >/dev/null 2>&1 && info "git OK in sample worktree: $SAMPLE" \
      || die "git check failed in $SAMPLE — investigate before resuming"
    RP=$(readlink -f "$SAMPLE")
    if [[ "$MODE" == bind ]]; then
      [[ "$RP" == "$SAMPLE" ]] || die "bind verify failed: realpath($SAMPLE)=$RP (expected unchanged)"
      info "bind verify OK: realpath unchanged → Claude slug unchanged"
    else
      [[ "$RP" == "$(post_realpath "$SAMPLE")" ]] || die "symlink verify failed: realpath=$RP"
      info "symlink verify OK: realpath now under $DEST"
    fi
  fi
fi

# ---- 7. resume the agents that were live -----------------------------------
if [[ "$NO_RESUME" != 1 && ${#LIVE_AGENTS[@]} -gt 0 ]]; then
  for a in "${LIVE_AGENTS[@]}"; do info "am resume $a"; run "am resume '$a'"; done
else
  [[ ${#LIVE_AGENTS[@]} -gt 0 ]] && info "skipping resume (--no-resume); resume manually: ${LIVE_AGENTS[*]}"
fi

# ---- 8. reclaim --------------------------------------------------------------
cat <<EOF

[move-worktrees] DONE (mode=$MODE).
  Data now served from: $DEST
  On-root backup kept:  $BACKUP   ($(DU -sh "$BACKUP" 2>/dev/null | cut -f1 || echo '?'))

  Root space is NOT freed yet — the backup is intentionally retained for rollback.
  After you confirm the fleet is healthy (am ls; am transcript <name>; jump in):

      scripts/move-worktrees.sh --mode $MODE --purge-backup

  Rollback (before purge): see docs/worktree-migration-plan.md §7.
EOF
