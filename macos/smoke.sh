#!/bin/bash
# Opt-in integration check of the real app against an am-compatible server. Without SMOKE_URL it
# starts the synthetic fixture server; with SMOKE_URL, pipe that server's token on stdin.
# SMOKE_BRIDGE_ONLY=1 skips the UI steps; SMOKE_SCREENSHOT sets where the PNG is copied.
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
xcrun swiftc -parse-as-library -target "$(uname -m)-apple-macosx12.3" "${sources[@]}" Tests/Smoke.swift \
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
  IFS= read -r token || true
fi
screenshot="${SMOKE_SCREENSHOT:-${TMPDIR:-/tmp}/am-macos-smoke.png}"

# Launch through LaunchServices so the app runs in the logged-in user's session (an ssh-spawned
# process cannot use the login keychain). -g keeps it in the background; the token goes through a
# FIFO so it never touches disk or argv.
work="$(mktemp -d "${TMPDIR:-/tmp}/am-smoke.XXXXXX")"
writer_pid=""
trap 'cleanup; [[ -z "$writer_pid" ]] || kill "$writer_pid" 2>/dev/null || true; rm -rf "$work"' EXIT
mkfifo -m 600 "$work/token"
: >build/smoke.log
printf '%s\n' "$token" >"$work/token" &
writer_pid=$!
env_args=(--env "SMOKE_URL=$SMOKE_URL")
[[ "${SMOKE_BRIDGE_ONLY:-}" == 1 ]] && env_args+=(--env SMOKE_BRIDGE_ONLY=1)
tail -f build/smoke.log &
tail_pid=$!
open -W -n -g --stdin "$work/token" --stdout "$PWD/build/smoke.log" --stderr "$PWD/build/smoke.log" "${env_args[@]}" "$app"
sleep 0.3
kill "$tail_pid" 2>/dev/null || true
wait "$tail_pid" 2>/dev/null || true
captured="$(sed -n 's/^SCREENSHOT //p' build/smoke.log | tail -1)"
if [[ -n "$captured" && -f "$captured" ]]; then
  mv "$captured" "$screenshot"
  echo "Screenshot: $screenshot"
fi
if grep -q '^FAIL' build/smoke.log || ! grep -q '^PASS all smoke checks' build/smoke.log; then
  echo "Smoke test failed." >&2
  exit 1
fi
echo "Smoke test passed."
