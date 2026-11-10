#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")"
if [[ "$(uname -s)" != Darwin ]]; then
  echo "Build on macOS with Xcode Command Line Tools installed." >&2
  exit 1
fi
source web.sh
mkdir -p build
xcrun swiftc Sources/NavigationPolicy.swift Sources/ConnectionPolicy.swift Sources/MessagePolicy.swift \
  Sources/APIClient.swift Sources/SSEParser.swift Sources/BundleResource.swift Tests/main.swift -o build/unit-tests
build/unit-tests
app="$PWD/build/Agent Motel.app"
rm -rf "$app"
mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources" build/AppIcon.iconset
install_web "$app/Contents/Resources"
xcrun swiftc -parse-as-library -O -target "$(uname -m)-apple-macosx12.3" Sources/*.swift -o "$app/Contents/MacOS/AgentMotel"
xcrun swift icon.swift "$PWD/build/AppIcon.iconset"
iconutil -c icns build/AppIcon.iconset -o "$app/Contents/Resources/AppIcon.icns"
cp Info.plist "$app/Contents/Info.plist"
# Prefer the stable local identity from setup-signing.sh over an ad-hoc signature.
identity="${SIGNING_IDENTITY:-}"
keychain=()
local_keychain="$HOME/Library/Keychains/agent-motel-signing.keychain-db"
if [[ -z "$identity" && -f "$local_keychain" ]]; then
  security unlock-keychain -p agent-motel-local-signing "$local_keychain"
  identity="Agent Motel Local Signing"
  keychain=(--keychain "$local_keychain")
fi
codesign --force --options runtime --entitlements Entitlements.plist \
  ${keychain[@]+"${keychain[@]}"} --sign "${identity:--}" "$app"
codesign --verify --strict "$app"
rm -f build/Agent-Motel-macOS.zip
ditto -c -k --keepParent "$app" "build/Agent-Motel-macOS.zip"
echo "Built: $app"
