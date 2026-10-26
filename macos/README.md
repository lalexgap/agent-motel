# Agent Motel for macOS

A small AppKit app hosting `https://am.alexgap.ca` in WKWebView. It uses the live web UI, including agent search, concierge, chat streaming, and interactive terminals. Requires macOS 12.3 or later (for WebKit dialog support) and an internet connection.

Run `bash macos/build.sh` on a Mac with Xcode Command Line Tools. This runs navigation policy tests and produces `macos/build/Agent Motel.app` and a zip for the build machine’s architecture. Copy the app into `~/Applications` and open it.

Sign in with the same access key as the website (`am token` on the server). WebKit keeps the app’s cookies separately from Safari; the server’s existing session expiry and logout rules still apply. The app never stores the access key itself. UI updates appear automatically from the server.

Keyboard shortcuts: **⌘R** reloads, **⌘1** opens the fleet, **⌘0** shows the window, and **⌘W** closes it. Closing the window or quitting leaves server agents running. Standard copy/paste shortcuts work in chat and terminals. The View menu can open the site in your browser.

The app is sandboxed with outbound network access only. Navigation stays on the exact production HTTPS origin; clicked HTTP(S) links open in the default browser. There is no shell bridge, local file access entitlement, custom URL handler, or TLS exception. Agent closure confirmations use native dialogs. Failed page loads show a reconnect button.

For an opt-in integration check on a Mac with a logged-in desktop session, pipe the server access key into `bash macos/smoke.sh`. It uses a separate sandbox container, logs in to production, checks filtering, SSE, a read-only concierge terminal attachment, native confirmation cancellation, and logout. It writes a screenshot inside its temporary container directory and prints the path. It requires a live concierge; it does not send agent messages or terminal input.

Builds use local ad-hoc signing by default. For distribution to other Macs, set `SIGNING_IDENTITY` to your Developer ID Application certificate and notarize the zip with Apple’s `notarytool`, then staple the app and repackage it. This repository does not include signing credentials or claim notarized distribution. No automatic binary updater is included.
