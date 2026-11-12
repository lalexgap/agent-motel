#!/bin/bash
# Opt-in integration check of the real app against the synthetic fixture server, which it starts.
# It sends messages and stops, removes and creates agents, so SMOKE_URL may only name another
# fixture-compatible server on loopback (pipe its token on stdin), never a real fleet.
# SMOKE_BRIDGE_ONLY=1 skips the UI steps; SMOKE_SCREENSHOT sets where the PNG is copied.
# The app is launched twice: the second launch (SMOKE_PHASE=relaunch) checks that the terminal
# consent's "Don't ask again" survived the relaunch and is cleared when the connection is removed.
set -euo pipefail
cd "$(dirname "$0")"
if [[ "$(uname -s)" != Darwin ]]; then
  echo "Run the smoke test on macOS." >&2
  exit 1
fi
source web.sh
mkdir -p build
app="$PWD/build/Agent Motel Smoke.app"
rm -rf "$app"
mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources"
install_web "$app/Contents/Resources"
cp Info.plist "$app/Contents/Info.plist"
/usr/libexec/PlistBuddy -c 'Set :CFBundleIdentifier ca.alexgap.agent-motel.smoke' "$app/Contents/Info.plist"
sources=()
for file in Sources/*.swift; do [[ "$file" == Sources/main.swift ]] || sources+=("$file"); done
xcrun swiftc -parse-as-library -target "$(uname -m)-apple-macosx12.3" "${sources[@]}" Tests/Smoke.swift Tests/SmokeTerminal.swift \
  -o "$app/Contents/MacOS/AgentMotel"
codesign --force --options runtime --entitlements Entitlements.plist --sign - "$app"

server_pid=""
cleanup() {
  if [[ -n "$server_pid" ]]; then kill "$server_pid" 2>/dev/null || true; wait "$server_pid" 2>/dev/null || true; fi
}
trap cleanup EXIT
if [[ -z "${SMOKE_URL:-}" ]]; then
  command -v bun >/dev/null || { echo "bun is required to start the fixture server (or set SMOKE_URL)." >&2; exit 1; }
  (cd .. && exec bun desktop/fixtures/server.ts --port 8791) >build/smoke-server.log 2>&1 &
  server_pid=$!
  export SMOKE_URL=http://127.0.0.1:8791
  token=fixture-token
  for _ in $(seq 50); do
    curl -sf -o /dev/null -H "Authorization: Bearer $token" "$SMOKE_URL/api/health" && break
    sleep 0.2
  done
else
  if [[ ! "$SMOKE_URL" =~ ^http://(127\.0\.0\.1|localhost|\[::1\]):[0-9]+$ ]]; then
    echo "SMOKE_URL must be a loopback fixture server (http://127.0.0.1:<port>): the smoke test stops, removes and creates agents." >&2
    exit 1
  fi
  IFS= read -r token || true
fi
screenshot="${SMOKE_SCREENSHOT:-${TMPDIR:-/tmp}/am-macos-smoke.png}"

# Launch through LaunchServices so the app runs in the logged-in user's session (an ssh-spawned
# process cannot use the login keychain). -g keeps it in the background; the token goes through a
# FIFO so it never touches disk or argv.
work="$(mktemp -d "${TMPDIR:-/tmp}/am-smoke.XXXXXX")"
writer_pid=""
trap 'cleanup; [[ -z "$writer_pid" ]] || kill "$writer_pid" 2>/dev/null || true; rm -rf "$work"' EXIT

# launch <log> [extra open(1) arguments…]: one run of the smoke app; fails unless it passed.
launch() {
  local log="$1"
  shift
  rm -f "$work/token"
  mkfifo -m 600 "$work/token"
  : >"$log"
  printf '%s\n' "$token" >"$work/token" &
  writer_pid=$!
  local env_args=(--env "SMOKE_URL=$SMOKE_URL")
  [[ "${SMOKE_BRIDGE_ONLY:-}" == 1 ]] && env_args+=(--env SMOKE_BRIDGE_ONLY=1)
  tail -f "$log" &
  local tail_pid=$!
  open -W -n -g --stdin "$work/token" --stdout "$log" --stderr "$log" "${env_args[@]}" "$@" "$app"
  sleep 0.3
  kill "$tail_pid" 2>/dev/null || true
  wait "$tail_pid" 2>/dev/null || true
  wait "$writer_pid" 2>/dev/null || true
  writer_pid=""
  if grep -q '^FAIL' "$log" || ! grep -q '^PASS all smoke checks' "$log"; then
    echo "Smoke test failed ($log)." >&2
    exit 1
  fi
}

launch "$PWD/build/smoke.log"
captured="$(sed -n 's/^SCREENSHOT //p' build/smoke.log | tail -1)"
if [[ -n "$captured" && -f "$captured" ]]; then
  mv "$captured" "$screenshot"
  echo "Screenshot: $screenshot"
fi
echo "Relaunching for the terminal consent check."
launch "$PWD/build/smoke-relaunch.log" --env SMOKE_PHASE=relaunch
echo "Smoke test passed."
