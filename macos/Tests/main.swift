import Foundation

let allowed = ["https://am.alexgap.ca", "https://am.alexgap.ca:443/agents?name=test", "https://am.alexgap.ca/#fleet"]
let denied = ["http://am.alexgap.ca", "https://am.alexgap.ca:8790", "https://am.alexgap.ca.evil.test", "https://evil.test", "https://user:secret@am.alexgap.ca", "file:///etc/passwd", "javascript:alert(1)", "am://new"]
for value in allowed { precondition(NavigationPolicy.isInternal(URL(string: value)!), value) }
for value in denied { precondition(!NavigationPolicy.isInternal(URL(string: value)!), value) }
for value in ["file:///tmp/test", "javascript:alert(1)", "am://new", "https://user:secret@example.com"] {
    precondition(!NavigationPolicy.canOpenExternally(URL(string: value)!), value)
}
precondition(NavigationPolicy.canOpenExternally(URL(string: "https://github.com/lalexgap/agent-motel")!))
print("PASS navigation allowlist and external scheme restrictions")
