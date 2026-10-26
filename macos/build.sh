#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")"
if [[ "$(uname -s)" != Darwin ]]; then
  echo "Build on macOS with Xcode Command Line Tools installed." >&2
  exit 1
fi
mkdir -p build
app="$PWD/build/Agent Motel.app"
mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources" build/AppIcon.iconset
xcrun swiftc Sources/NavigationPolicy.swift Tests/main.swift -o build/navigation-tests
build/navigation-tests
xcrun swiftc -parse-as-library -O -target "$(uname -m)-apple-macosx12.0" Sources/*.swift -o "$app/Contents/MacOS/AgentMotel"
xcrun swift icon.swift "$PWD/build/AppIcon.iconset"
iconutil -c icns build/AppIcon.iconset -o "$app/Contents/Resources/AppIcon.icns"
cp Info.plist "$app/Contents/Info.plist"
codesign --force --options runtime --entitlements Entitlements.plist --sign "${SIGNING_IDENTITY:--}" "$app"
codesign --verify --strict "$app"
ditto -c -k --keepParent "$app" "build/Agent-Motel-macOS.zip"
echo "Built: $app"
