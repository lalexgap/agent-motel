# am voice — native iOS app for `am`

A sideloadable SwiftUI app for the fleet: see every agent's status, chat with
one by **voice** (on-device speech-to-text in, spoken replies out), and do
light lifecycle work (spawn / stop / resume) from your phone.

Voice-originated messages carry a hint asking the agent to lead with a short
`<voice>…</voice>` spoken summary — the app speaks only that, while the full
reply stays in the session and on screen.

## Requirements

- A Mac with Xcode 15+ (free Apple ID is enough)
- [XcodeGen](https://github.com/yonaskolb/XcodeGen): `brew install xcodegen`
- `am serve` running on the machine with your agents, reachable from the
  phone (Tailscale recommended — see `docs/ios-app-exploration.md` §4)
- iPhone on iOS 17+

## Build & sideload (free Apple ID)

```sh
cd ios
xcodegen                     # generates AmVoice.xcodeproj from project.yml
open AmVoice.xcodeproj
```

In Xcode:

1. Select the **AmVoice** target → *Signing & Capabilities* → set **Team** to
   your personal team (add your Apple ID under Xcode → Settings → Accounts if
   it isn't there). Change the bundle id if it collides.
2. Plug in your iPhone, pick it as the run destination, hit **Run**.
3. First launch only: on the phone, *Settings → General → VPN & Device
   Management* → trust your developer certificate.

**Free-tier caveat:** personal-team builds expire after **7 days** — replug
and hit Run again to re-sign. (A paid developer account or TestFlight removes
the treadmill; deliberately out of scope for now.)

## Pair with your fleet

On the agent machine:

```sh
am serve        # starts the HTTP API (see `am serve --help` for port/bind)
am token        # prints the bearer token
```

In the app's Settings screen, enter the server URL (e.g.
`https://yourserver.tailnet.ts.net:7337` or `http://100.x.y.z:7337` over the
tailnet) and paste the token, then *Test connection* → *Save*.

## Using voice chat

- Open an agent → tap the **mic**. Speak; ~1 second of silence sends it.
- The reply is spoken aloud (the `<voice>` summary if the agent provided one,
  otherwise the message with code stripped). Tap the speaking pill to stop.
- **repeat** toggle (toolbar): hands-free — the mic reopens after each spoken
  reply for a continuous conversation.
- **headphones** toggle (toolbar): ask for spoken summaries on *typed*
  messages too (listen-while-typing).
- The send-mode chip (`queue` / `now` / `interrupt`) maps to
  `am send` / `am send --now` / `am interrupt`.

For noticeably better speech, download an Enhanced/Premium Siri voice on the
phone: *Settings → Accessibility → Spoken Content → Voices* — the app picks
the best installed voice automatically.

## Limitations (current)

- Voice/chat works for agents **local to the serve host**; remote (`host:`)
  agents show in the fleet list but aren't chattable yet.
- No push notifications — pair with [ntfy](https://ntfy.sh) via
  `notifyCommand` for lock-screen alerts (exploration doc §3).
- Foreground only: lock the phone mid-conversation and the loop pauses.
