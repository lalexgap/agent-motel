#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")"
app="$PWD/build/Agent Motel Smoke.app"
mkdir -p "$app/Contents/MacOS"
cp Info.plist "$app/Contents/Info.plist"
/usr/libexec/PlistBuddy -c 'Set :CFBundleIdentifier ca.alexgap.agent-motel.smoke' "$app/Contents/Info.plist"
xcrun swiftc -parse-as-library Sources/AppDelegate.swift Sources/NavigationPolicy.swift Tests/Smoke.swift -o "$app/Contents/MacOS/AgentMotel"
codesign --force --options runtime --entitlements Entitlements.plist --sign - "$app"
exec "$app/Contents/MacOS/AgentMotel"
