#!/usr/bin/env bash
#
# canary-resume.sh — settle the one risky question for the worktrees migration:
#   does `claude --resume <id>` find a session GLOBALLY by id, or only under the
#   current cwd's project slug?
#
# It is fully isolated under /tmp and cleans up after itself. It touches NO real
# `am` agents and NO real worktrees. It does make ~2 tiny `claude -p` API calls.
#
# Outcome:
#   - "RESUME SUCCEEDED" → resume is global → a symlink (which changes realpath,
#     hence the slug) would be safe for resume.
#   - "RESUME FAILED (session-not-found)" → resume is cwd-slug-scoped → a symlink
#     breaks `am resume` of existing agents unless their transcripts are also
#     reachable under the new slug. (This is what was observed: 2026-06-18,
#     claude 2.1.181 → FAILED. Bind mount recommended.)
#
set -euo pipefail
command -v claude >/dev/null || { echo "claude not on PATH"; exit 1; }
command -v node   >/dev/null || { echo "node not on PATH"; exit 1; }

ROOT=/tmp/wtcanary-$$
PROJECTS="${HOME}/.claude/projects"
slug() { printf '%s' "$1" | sed 's/[^a-zA-Z0-9]/-/g'; }

cleanup() {
  local sid="${1:-}"
  rm -rf "$ROOT"
  [[ -n "$sid" ]] && rm -rf "$PROJECTS/$(slug "$OLD")" "$PROJECTS/$(slug "$NEWREAL")" \
                            "${HOME}/.claude/session-env/$sid" 2>/dev/null || true
  for f in "${HOME}"/.claude/sessions/*.json; do
    grep -q 'wtcanary' "$f" 2>/dev/null && rm -f "$f"
  done
}

mkdir -p "$ROOT/wt"
OLD="$ROOT/wt"

echo "=== 1. create a session at the REAL path $OLD ==="
cd "$OLD"
OUT=$(claude -p --output-format json "Reply with exactly the single word: ACORN")
SID=$(printf '%s' "$OUT" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.parse(s).session_id)}catch{console.log("PARSE_FAIL")}})')
echo "session_id=$SID  → transcript under slug $(slug "$OLD")"
trap 'cleanup "$SID"; cd /' EXIT

echo "=== 2. simulate migration: move data aside, replace path with a symlink ==="
mkdir -p "$ROOT/fastdata"
mv "$OLD" "$ROOT/fastdata/wt"
ln -s "$ROOT/fastdata/wt" "$OLD"
NEWREAL="$(readlink -f "$OLD")"
echo "realpath($OLD) is now $NEWREAL  (slug $(slug "$NEWREAL"), different from $(slug "$OLD"))"

echo "=== 3. resume BY ID from the symlinked cwd (realpath → new slug) ==="
cd "$OLD"
set +e
OUT=$(claude -p --output-format json --resume "$SID" "Reply with exactly the single word: BERRY" 2>&1); RC=$?
set -e

echo "--- exit code: $RC ---"
if [[ $RC -eq 0 ]] && ! printf '%s' "$OUT" | grep -qiE 'no conversation|not found'; then
  echo ">>> RESUME SUCCEEDED → resume resolves globally by id → SYMLINK SAFE for resume"
else
  printf '%s\n' "$OUT" | head -c 300; echo
  echo ">>> RESUME FAILED (session-not-found) → resume is CWD-SLUG-SCOPED"
  echo ">>> A symlink breaks 'am resume' of existing agents unless transcripts are"
  echo ">>> relinked under the new slug. Prefer a BIND MOUNT (realpath unchanged)."
fi
