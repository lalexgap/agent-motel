import Foundation

func check(_ condition: Bool, _ message: @autoclosure () -> String, line: Int = #line) {
    if !condition {
        print("FAIL line \(line): \(message())")
        exit(1)
    }
}

for value in ["am-app://app/index.html", "am-app://app/", "am-app://app/web/style.css?v=1#x"] {
    check(NavigationPolicy.decide(URL(string: value), userInitiated: false, newWindow: false) == .allow, value)
    check(NavigationPolicy.decide(URL(string: value), userInitiated: true, newWindow: true) == .cancel, "new window \(value)")
}
for value in ["am-app://evil/index.html", "am-app://user:pw@app/", "am-app://app:8080/", "https://am.example.com",
              "file:///etc/passwd", "javascript:alert(1)", "about:blank", "am://new", "data:text/html,hi"] {
    check(NavigationPolicy.decide(URL(string: value), userInitiated: false, newWindow: false) == .cancel, value)
}
for value in ["https://github.com/lalexgap/agent-motel", "http://127.0.0.1:8790/x"] {
    check(NavigationPolicy.decide(URL(string: value), userInitiated: true, newWindow: false) == .openExternally, value)
    check(NavigationPolicy.decide(URL(string: value), userInitiated: true, newWindow: true) == .openExternally, value)
    check(NavigationPolicy.decide(URL(string: value), userInitiated: false, newWindow: false) == .cancel, "script \(value)")
}
for value in ["https://user:secret@example.com", "https://user@example.com", "file:///tmp/x", "javascript:alert(1)",
              "mailto:a@example.com", "am-app://app/index.html", "https:///nohost"] {
    check(NavigationPolicy.decide(URL(string: value), userInitiated: true, newWindow: true) != .openExternally, value)
}
check(NavigationPolicy.decide(nil, userInitiated: true, newWindow: false) == .cancel, "nil url")
print("PASS navigation policy")

let accepted = [
    ("https://am.example.com/", "https://am.example.com"),
    ("https://AM.Example.com:443/agents?x=1#y", "https://am.example.com"),
    ("https://am.example.com:8443", "https://am.example.com:8443"),
    (" http://localhost:8790 ", "http://localhost:8790"),
    ("http://127.0.0.1", "http://127.0.0.1"),
    ("http://127.200.3.4:80/", "http://127.200.3.4"),
    ("http://[::1]:8790", "http://[::1]:8790"),
    ("http://100.64.0.1", "http://100.64.0.1"),
    ("http://100.127.255.254:8790", "http://100.127.255.254:8790"),
    ("http://foo.ts.net", "http://foo.ts.net"),
    ("http://box.tail1234.ts.net:8790/", "http://box.tail1234.ts.net:8790"),
    ("https://192.168.1.5", "https://192.168.1.5"),
]
for (input, expected) in accepted {
    do {
        let actual = try ConnectionPolicy.normalize(input)
        check(actual == expected, "\(input) -> \(actual), expected \(expected)")
    } catch {
        check(false, "\(input) rejected: \(error)")
    }
}
let rejected = [
    "http://100.128.0.1", "http://100.63.255.255", "http://evil.ts.net.example.com", "http://ts.net", "http://.ts.net",
    "http://192.168.1.5", "http://10.0.0.1", "http://am.example.com", "http://0x7f.0.0.1", "http://127.1",
    "http://localhost.example.com", "https://user:pw@am.example.com", "https://user@am.example.com",
    "http://user@localhost:8790", "ftp://am.example.com", "file:///etc/passwd", "javascript:alert(1)", "am.example.com",
    "", "https://", "https://am example.com", "https://am.example.com:0", "https://am.example.com\\@evil.com",
]
for input in rejected {
    check((try? ConnectionPolicy.normalize(input)) == nil, "accepted \(input)")
}
do {
    _ = try ConnectionPolicy.normalize("http://192.168.1.5")
} catch let error as PolicyError {
    check(error.message == ConnectionPolicy.httpRestriction, "http message: \(error.message)")
} catch {
    check(false, "unexpected error type")
}
print("PASS connection URL policy and normalisation")

let base = "http://127.0.0.1:8790"
for path in ["/api/health", "/api/agents", "/api/agents/annex%3Akelp-forest/transcript", "/api/agents?all=1&x=a%20b"] {
    do {
        let url = try ConnectionPolicy.apiURL(base: base, path: path)
        check(url.absoluteString == base + path, "\(path) -> \(url)")
        check(url.host == "127.0.0.1" && url.port == 8790 && url.scheme == "http", "host changed for \(path)")
    } catch {
        check(false, "\(path) rejected: \(error)")
    }
}
for path in ["/etc/passwd", "//evil.example/api/x", "/api/../x", "/api/%2e%2e/x", "/api/%2E%2E/x", "/api/x\\y",
             "/api/x%5c..", "/api/x#frag", "/api/x\u{0}", "/api/x%00", "/api/x\ny", "/api/x y", "api/health",
             "https://evil.example/api/x", "/api@evil.example/x", "/api/x%zz", "/api/x%4", "/API/health", ""] {
    check((try? ConnectionPolicy.apiURL(base: base, path: path)) == nil, "accepted \(path.debugDescription)")
}
check((try? ConnectionPolicy.apiURL(base: "https://am.example.com", path: "/api/@evil.example")).map { $0.host } == "am.example.com",
      "userinfo-looking segment changed host")
print("PASS api path validation")

for token in ["fixture-token", "abc.DEF_123~"] { check((try? ConnectionPolicy.validateToken(token)) != nil, token) }
for token in ["", "has space", "line\nbreak", "tab\t", "é"] { check((try? ConnectionPolicy.validateToken(token)) == nil, token.debugDescription) }
print("PASS token validation")

func rejection(_ body: () throws -> Any) -> String? {
    do {
        _ = try body()
        return nil
    } catch {
        return (error as? PolicyError)?.message ?? "\(error)"
    }
}
for agent in ["harbor-lights", "annex:kelp-forest", "a_b-1", "host.example:agent", String(repeating: "n", count: 64)] {
    check((try? MessagePolicy.agent(agent)) == agent, "agent rejected: \(agent)")
}
for agent in ["", "a/b", "a:b:c", "../x", "a b", ":x", "x:", "host:../x", "a%2Fb", "-host:x", ".host:x", "a..b:x", "annex..:x",
              String(repeating: "n", count: 65), "é", "a\u{0}", "a?b", "a#b", "a\nb"] {
    check(rejection { try MessagePolicy.agent(agent) } == "invalid agent: \(agent)", "agent accepted: \(agent.debugDescription)")
}
for value in [nil, 7, NSNull(), ["harbor-lights"]] as [Any?] {
    check(rejection { try MessagePolicy.agent(value) }?.hasPrefix("invalid agent: ") == true, "agent type \(String(describing: value))")
}
check(MessagePolicy.encodedAgent("annex:kelp-forest") == "annex%3Akelp-forest", "host:name is one segment")
check(MessagePolicy.encodedAgent("host.example:a_b-1") == "host.example%3Aa_b-1", "dots, dashes, underscores kept")

check((try? MessagePolicy.mode("queue")) == .queue && (try? MessagePolicy.mode("now")) == .now, "modes")
for value in ["interrupt", "Now", "", "queue ", nil, 1, true, NSNull()] as [Any?] {
    check(rejection { try MessagePolicy.mode(value) } == "mode must be queue or now", "mode accepted: \(String(describing: value))")
}

check(rejection { try MessagePolicy.text("") } == "Message is empty", "empty text")
check(rejection { try MessagePolicy.text("   \n ") } == "Message is empty", "blank text")
for value in [nil, 7, NSNull(), ["x"]] as [Any?] {
    check(rejection { try MessagePolicy.text(value) } != nil, "text type \(String(describing: value))")
}
check((try? MessagePolicy.text("  hi\n  there \n")) == "hi\n  there", "trims only the ends")
let longest = String(repeating: "a", count: MessagePolicy.maxTextBytes)
check((try? MessagePolicy.text(longest))?.utf8.count == 100_000, "100,000 bytes accepted")
check((try? MessagePolicy.text("  " + longest + "\n")) == longest, "length counted after trimming")
check(rejection { try MessagePolicy.text(longest + "a") } == "Message is too long (limit 100,000 bytes)", "100,001 bytes")
check((try? MessagePolicy.text(String(repeating: "é", count: 50_000))) != nil, "50,000 two-byte characters fit")
check(rejection { try MessagePolicy.text(String(repeating: "é", count: 50_001)) } != nil, "100,002 bytes in 50,001 characters")
check(rejection { try MessagePolicy.text(String(repeating: "☃", count: 33_334)) } != nil, "33,334 snowmen are 100,002 bytes")
// Same vectors as tests/desktopPolicy.test.ts.
let controlCharacters = ["\u{00}", "\u{01}", "\u{03}", "\u{04}", "\u{08}", "\u{0B}", "\u{0C}", "\u{0E}", "\u{1A}", "\u{1B}", "\u{1F}", "\u{7F}", "\u{80}", "\u{85}", "\u{9B}", "\u{9F}"]
for control in controlCharacters {
    for text in [control, "a\(control)b", "  hi\(control)", "\(control)[A"] {
        check(rejection { try MessagePolicy.text(text) } == MessagePolicy.controlText, "control U+\(String(control.unicodeScalars.first!.value, radix: 16)) in \(text.debugDescription)")
    }
}
for (text, expected) in [("a\tb", "a\tb"), ("a\r\nb", "a\r\nb"), ("line\n\tindented", "line\n\tindented"), ("\u{A0}x\u{A0}y", "x\u{A0}y"), ("\u{2028}x", "x")] {
    check((try? MessagePolicy.text(text)) == expected, "allowed \(text.debugDescription)")
}

check((try? MessagePolicy.messageID("01JABCDEFGHJKMNPQRSTVWXYZ0")) == "01JABCDEFGHJKMNPQRSTVWXYZ0", "ulid id")
check((try? MessagePolicy.messageID(String(repeating: "a", count: 128))) != nil, "128-char id")
for value in ["", "a/b", "..", "a b", String(repeating: "a", count: 129), "a%2Fb", "a.b", "é", nil, 5] as [Any?] {
    check(rejection { try MessagePolicy.messageID(value) }?.hasPrefix("invalid message id") == true, "id accepted: \(String(describing: value))")
}

do {
    let send = try MessagePolicy.send(base: base, agent: "annex:kelp-forest", text: "  Ship it. \"/\" é\n", mode: "now")
    check(send.method == .post, "send method")
    check(send.url.absoluteString == "http://127.0.0.1:8790/api/agents/annex%3Akelp-forest/messages", "send url \(send.url)")
    check(send.url.host == "127.0.0.1" && send.url.port == 8790 && send.url.scheme == "http", "send host")
    let json = try JSONSerialization.jsonObject(with: send.body ?? Data()) as? [String: Any] ?? [:]
    check(Set(json.keys) == ["text", "mode"] && json["text"] as? String == "Ship it. \"/\" é" && json["mode"] as? String == "now",
          "send body \(json)")
    let cancel = try MessagePolicy.cancel(base: "https://am.example.com", agent: "harbor-lights", id: "01JABCDEFGHJKMNPQRSTVWXYZ0")
    check(cancel.method == .delete && cancel.body == nil, "cancel method and body")
    check(cancel.url.absoluteString == "https://am.example.com/api/agents/harbor-lights/messages/01JABCDEFGHJKMNPQRSTVWXYZ0",
          "cancel url \(cancel.url)")

    let post = APIClient.request(send, token: "fixture-token")
    check(post.httpMethod == "POST" && post.url == send.url && post.httpBody == send.body, "POST request")
    check(post.value(forHTTPHeaderField: "Content-Type") == "application/json", "POST content type")
    check(post.value(forHTTPHeaderField: "Authorization") == "Bearer fixture-token", "POST bearer")
    check(post.timeoutInterval == 60 && !post.httpShouldHandleCookies && send.timeout == 60, "POST timeout and cookies")
    let delete = APIClient.request(cancel, token: "fixture-token")
    check(delete.httpMethod == "DELETE" && delete.httpBody == nil && delete.value(forHTTPHeaderField: "Content-Type") == nil,
          "DELETE has no body")
    check(delete.value(forHTTPHeaderField: "Authorization") == "Bearer fixture-token" && delete.timeoutInterval == 60, "DELETE headers")
} catch {
    check(false, "message request: \(error)")
}
for (agent, id) in [("a/b", "x"), ("harbor-lights", "../x"), ("harbor-lights", "a?b")] {
    check((try? MessagePolicy.cancel(base: base, agent: agent, id: id)) == nil, "cancel accepted \(agent) \(id)")
}
check((try? MessagePolicy.send(base: base, agent: "harbor-lights", text: "hi", mode: "interrupt")) == nil, "interrupt send")
print("PASS message policy (agent, mode, text bytes, id, paths, request shape)")

// Write surface: same vectors as tests/desktopPolicy.test.ts.
func plan(_ method: String, _ params: [String: Any]) throws -> ActionPlan {
    try ActionPolicy.plan(method, base: base, params: params)
}
func planError(_ method: String, _ params: [String: Any]) -> String? {
    rejection { try plan(method, params) }
}
func body(_ request: WriteRequest) -> [String: Any] {
    request.body.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] } ?? [:]
}
func expectRequest(_ method: String, _ params: [String: Any], _ verb: WriteRequest.Method, _ path: String, _ keys: Set<String>,
                   timeout: TimeInterval, confirmed: Bool, line: Int = #line) -> [String: Any] {
    do {
        let result = try plan(method, params)
        let request = result.request
        check(request.method == verb && request.url.absoluteString == base + path, "\(method) \(request.method) \(request.url)", line: line)
        check(request.timeout == timeout, "\(method) timeout \(request.timeout)", line: line)
        check((result.confirm != nil) == confirmed, "\(method) confirm", line: line)
        if confirmed {
            check(result.confirm?.precheck.absoluteString == base + "/api/agents/" + MessagePolicy.encodedAgent(params["agent"] as? String ?? ""),
                  "\(method) precheck \(String(describing: result.confirm?.precheck))", line: line)
        }
        if verb == .delete {
            check(request.body == nil && request.contentType == nil, "\(method) DELETE has a body", line: line)
            return [:]
        }
        let json = body(request)
        check(request.contentType == "application/json" && Set(json.keys) == keys, "\(method) body keys \(json.keys.sorted())", line: line)
        return json
    } catch {
        check(false, "\(method) rejected: \(error)", line: line)
        return [:]
    }
}

check(planError("agents.fly", ["agent": "keeper-log"]) == "unknown method: agents.fly", "unknown action")
for method in ActionPolicy.methods where !["agents.create", "concierge.ensure", "search.query"].contains(method) {
    for agent in ["a/b", "../x", "a..b:x", "a:b:c", ""] {
        check(planError(method, ["agent": agent]) == "invalid agent: \(agent)", "\(method) agent \(agent)")
    }
    check(planError(method, [:]) == "invalid agent: null", "\(method) without agent")
}

_ = expectRequest("agents.resume", ["agent": "old-lens"], .post, "/api/agents/old-lens/resume", [], timeout: 60, confirmed: false)
_ = expectRequest("agents.restart", ["agent": "keeper-log"], .post, "/api/agents/keeper-log/restart", [], timeout: 60, confirmed: true)
// Interrupt never carries text, even when the page passes some.
_ = expectRequest("agents.interrupt", ["agent": "annex:kelp-forest", "text": "x"], .post, "/api/agents/annex%3Akelp-forest/interrupt", [],
                  timeout: 60, confirmed: true)
_ = expectRequest("agents.stop", ["agent": "tide-pilot", "ifIdle": true], .post, "/api/agents/tide-pilot/stop", [], timeout: 60, confirmed: true)
_ = expectRequest("agents.remove", ["agent": "errand-runner"], .delete, "/api/agents/errand-runner", [], timeout: 60, confirmed: true)

let renamed = expectRequest("agents.rename", ["agent": "crease-check", "name": "crease-fold"], .post, "/api/agents/crease-check/rename",
                            ["name"], timeout: 60, confirmed: false)
check(renamed["name"] as? String == "crease-fold", "rename body")
for name in ["a", "smoke-new_1", "Concierge", String(repeating: "n", count: 64)] {
    check((try? ActionPolicy.name(name)) == name, "name \(name)")
}
for (value, shown) in [("concierge", "concierge"), ("", ""), ("a b", "a b"), ("a:b", "a:b"), ("a.b", "a.b"), ("é", "é"),
                       (String(repeating: "n", count: 65), String(repeating: "n", count: 65))] {
    check(planError("agents.rename", ["agent": "crease-check", "name": value]) == "invalid name: \(shown)", "name \(value)")
}
for (value, shown) in [(nil, "null"), (NSNull(), "null"), (7, "7"), (true, "true")] as [(Any?, String)] {
    var params: [String: Any] = ["agent": "crease-check"]
    params["name"] = value
    check(planError("agents.rename", params) == "invalid name: \(shown)", "name type \(shown)")
}

let moved = expectRequest("agents.move", ["agent": "ebb-report", "host": "annex", "dir": "/srv/tide-tables"], .post,
                          "/api/agents/ebb-report/move", ["host", "dir"], timeout: 600, confirmed: true)
check(moved["host"] as? String == "annex" && moved["dir"] as? String == "/srv/tide-tables", "move body \(moved)")
_ = expectRequest("agents.move", ["agent": "annex:kelp-forest", "host": "local", "dir": NSNull()], .post,
                  "/api/agents/annex%3Akelp-forest/move", ["host"], timeout: 600, confirmed: true)
for host in ["local", "annex", "box.tail1234.ts.net", "a_b", String(repeating: "h", count: 255)] {
    check((try? ActionPolicy.host(host)) == host, "host \(host)")
}
for host in ["", ".annex", "-annex", "a..b", "a/b", "a:b", "a b", "é", String(repeating: "h", count: 256)] {
    check(planError("agents.move", ["agent": "ebb-report", "host": host]) == "invalid host: \(host)", "host \(host)")
}
check(planError("agents.move", ["agent": "ebb-report"]) == "invalid host: null", "move without host")
for dir in ["~/code", "relative/x", "", "/a\nb", "/a\u{0}b", "/" + String(repeating: "d", count: 4096)] {
    check(planError("agents.move", ["agent": "ebb-report", "host": "annex", "dir": dir]) == "invalid directory", "move dir \(dir.debugDescription)")
}

let modelBody = expectRequest("agents.model", ["agent": "fold-line", "model": "  gpt-5.2-codex ", "effort": "high",
                                               "createdAt": "2026-11-01T10:00:00.000Z", "status": "waiting"], .post,
                              "/api/agents/fold-line/model", ["model", "effort", "createdAt", "status"], timeout: 120, confirmed: true)
check(modelBody["model"] as? String == "gpt-5.2-codex" && modelBody["effort"] as? String == "high", "model sent trimmed \(modelBody)")
let defaults = expectRequest("agents.model", ["agent": "fold-line", "model": NSNull(), "createdAt": "c", "status": "idle"], .post,
                             "/api/agents/fold-line/model", ["model", "createdAt", "status"], timeout: 120, confirmed: true)
check(defaults["model"] is NSNull, "null model is sent as null")
let nullEffort = expectRequest("agents.model", ["agent": "fold-line", "model": "m", "effort": NSNull(), "createdAt": "c", "status": "idle"],
                               .post, "/api/agents/fold-line/model", ["model", "effort", "createdAt", "status"], timeout: 120, confirmed: true)
check(nullEffort["effort"] is NSNull, "null effort is sent as null")
let modelOK: [String: Any] = ["agent": "fold-line", "model": "m", "effort": "e", "createdAt": "c", "status": "idle"]
func modelError(_ change: [String: Any?]) -> String? {
    var params = modelOK
    for (key, value) in change { params[key] = value }
    return planError("agents.model", params)
}
check(modelError(["model": nil]) == "invalid model", "model is required")
for value in ["", "   ", "-x", " -x", "a\nb", "a\u{1b}", String(repeating: "m", count: 257), 5] as [Any] {
    check(modelError(["model": value]) == "invalid model", "model \(value)")
}
check((try? plan("agents.model", modelOK.merging(["model": String(repeating: "m", count: 256)]) { $1 })) != nil, "256-byte model")
for value in ["", "-high", String(repeating: "e", count: 65), true] as [Any] {
    check(modelError(["effort": value]) == "invalid effort", "effort \(value)")
}
for value in ["", "a\nb", String(repeating: "c", count: 129), 5] as [Any] {
    check(modelError(["createdAt": value]) == "invalid createdAt", "createdAt \(value)")
}
check(modelError(["createdAt": nil]) == "invalid createdAt", "createdAt required")
check((try? plan("agents.model", modelOK.merging(["createdAt": String(repeating: "c", count: 128)]) { $1 })) != nil, "128-byte createdAt")
for status in ActionPolicy.statuses { check(modelError(["status": status]) == nil, "status \(status)") }
for value in ["exited", "Idle", "", 1] as [Any] { check(modelError(["status": value]) == "invalid status", "status \(value)") }
check(modelError(["status": nil]) == "invalid status", "status required")
check(modelError(["model": "-x", "status": "bad"]) == "invalid model", "model is checked before status")

let handoff = expectRequest("agents.handoff", ["agent": "harbor-lights", "to": "codex", "newName": "harbor-codex", "full": true], .post,
                            "/api/agents/harbor-lights/handoff", ["to", "newName", "full"], timeout: 150, confirmed: false)
check(handoff["to"] as? String == "codex" && handoff["full"] as? Bool == true, "handoff body \(handoff)")
check(String(data: (try! plan("agents.handoff", ["agent": "a", "to": "claude", "full": false])).request.body!, encoding: .utf8)
      == #"{"full":false,"to":"claude"}"#, "full is a JSON boolean")
_ = expectRequest("agents.handoff", ["agent": "harbor-lights", "to": "claude", "newName": NSNull(), "full": NSNull()], .post,
                  "/api/agents/harbor-lights/handoff", ["to"], timeout: 150, confirmed: false)
for value in ["antigravity", "Codex", "", 1] as [Any] {
    check(planError("agents.handoff", ["agent": "a", "to": value]) == "invalid to", "to \(value)")
}
check(planError("agents.handoff", ["agent": "a", "to": "codex", "newName": "concierge"]) == "invalid name: concierge", "newName concierge")
for value in [NSNumber(value: 1), NSNumber(value: 0), "true", "yes"] as [Any] {
    check(planError("agents.handoff", ["agent": "a", "to": "codex", "full": value]) == "invalid full", "full \(value)")
}

let created = expectRequest("agents.create", ["name": "smoke-new", "task": "  Write the tide report.\n", "provider": "claude",
                                              "dir": "~/code/lighthouse", "host": "local", "model": " claude-opus-4-5 ", "effort": "high",
                                              "role": "engineer"], .post, "/api/agents",
                            ["name", "task", "provider", "dir", "model", "effort", "role"], timeout: 150, confirmed: false)
check(created["task"] as? String == "Write the tide report." && created["dir"] as? String == "~/code/lighthouse"
      && created["model"] as? String == "claude-opus-4-5", "create body \(created)")
let remote = expectRequest("agents.create", ["name": "smoke-annex", "task": "t", "provider": "codex", "dir": "/srv/lighthouse", "host": "annex"],
                           .post, "/api/agents", ["name", "task", "provider", "remoteDir", "host"], timeout: 150, confirmed: false)
check(remote["remoteDir"] as? String == "/srv/lighthouse" && remote["host"] as? String == "annex", "remote create body \(remote)")
_ = expectRequest("agents.create", ["name": "n", "task": "t", "provider": "antigravity", "dir": NSNull(), "host": NSNull(), "model": NSNull(),
                                    "inPlace": true, "codex": true], .post, "/api/agents", ["name", "task", "provider"], timeout: 150, confirmed: false)
let createOK: [String: Any] = ["name": "smoke-new", "task": "t", "provider": "codex"]
func createError(_ change: [String: Any?]) -> String? {
    var params = createOK
    for (key, value) in change { params[key] = value }
    return planError("agents.create", params)
}
check(createError(["name": "concierge"]) == "invalid name: concierge", "create concierge")
check(createError(["name": nil]) == "invalid name: null", "create needs a name")
for value in ["", " \n\t ", "a\u{1b}b", "a\u{0}", String(repeating: "t", count: 100_001), 5] as [Any] {
    check(createError(["task": value]) == "invalid task", "task \(String(describing: value).prefix(20))")
}
check(createError(["task": "a\tb\r\nc"]) == nil, "task allows tabs and line breaks")
check(createError(["task": " " + String(repeating: "t", count: 100_000) + " "]) == nil, "task limit counts the trimmed text")
for value in ["gemini", "Claude", "", 1] as [Any] { check(createError(["provider": value]) == "invalid provider", "provider \(value)") }
check(createError(["provider": nil]) == "invalid provider", "provider required")
for value in ["code", "", "/a\nb", 3] as [Any] { check(createError(["dir": value]) == "invalid directory", "create dir \(value)") }
check(createError(["dir": "~/code", "host": "annex"]) == "invalid directory", "remote dir must be absolute")
check(createError(["dir": "~/code", "host": "local"]) == nil, "local dir may start with ~")
check(createError(["host": "a..b"]) == "invalid host: a..b", "create host")
check(createError(["model": ""]) == "invalid model" && createError(["effort": "-x"]) == "invalid effort", "create model/effort")
for value in ["concierge", "a b", "", String(repeating: "r", count: 65)] {
    check(createError(["role": value]) == "invalid role", "role \(value)")
}
check(createError(["name": "bad name", "task": ""]) == "invalid name: bad name", "name is checked before task")
check(createError(["dir": "x", "host": "a..b"]) == "invalid directory", "dir is checked before host")

let permission = expectRequest("permissions.answer", ["agent": "fog-signal", "id": "01JABCDEFGHJKMNPQRSTVWXYZ0", "optionId": "accept"], .post,
                               "/api/agents/fog-signal/permissions/01JABCDEFGHJKMNPQRSTVWXYZ0", ["optionId"], timeout: 45, confirmed: false)
check(permission["optionId"] as? String == "accept", "permission body")
for id in ["01jabcdefghjkmnpqrstvwxyz0", "01JABCDEFGHJKMNPQRSTVWXYZ", "01JABCDEFGHJKMNPQRSTVWXYZ00", "01JABCDEFGHIKMNPQRSTVWXYZ0",
           "01JABCDEFGHJKLNPQRSTVWXYZ0", "01JABCDEFGHJKMNOQRSTVWXYZ0", "01JABCDEFGHJKMNPQRSTUWXYZ0", "../x"] {
    check(planError("permissions.answer", ["agent": "fog-signal", "id": id, "optionId": "accept"]) == "invalid id", "permission id \(id)")
}
for option in ["answer-0", "acceptForSession", String(repeating: "o", count: 64)] {
    check(planError("permissions.answer", ["agent": "a", "id": "01JABCDEFGHJKMNPQRSTVWXYZ0", "optionId": option]) == nil, "option \(option)")
}
for option in ["", "a b", "a.b", "a/b", String(repeating: "o", count: 65)] {
    check(planError("permissions.answer", ["agent": "a", "id": "01JABCDEFGHJKMNPQRSTVWXYZ0", "optionId": option]) == "invalid optionId",
          "option \(option)")
}

let promptID = "0123456789abcdef0123456789abcdef"
let prompt = expectRequest("prompt.answer", ["agent": "origami-docs", "id": promptID, "optionId": "4", "text": " Use\tthe atlas "], .post,
                           "/api/agents/origami-docs/prompt", ["id", "optionId", "text"], timeout: 45, confirmed: false)
check(prompt["text"] as? String == " Use\tthe atlas " && prompt["optionId"] as? String == "4", "prompt text is sent as given \(prompt)")
_ = expectRequest("prompt.answer", ["agent": "origami-docs", "id": promptID, "optionId": "1"], .post, "/api/agents/origami-docs/prompt",
                  ["id", "optionId"], timeout: 45, confirmed: false)
for id in ["0123456789ABCDEF0123456789abcdef", "0123456789abcdef0123456789abcde", "0123456789abcdef0123456789abcdeg"] {
    check(planError("prompt.answer", ["agent": "a", "id": id, "optionId": "1"]) == "invalid id", "prompt id \(id)")
}
for option in ["0", "10", "a", "", " 1"] {
    check(planError("prompt.answer", ["agent": "a", "id": promptID, "optionId": option]) == "invalid optionId", "prompt option \(option)")
}
check(planError("prompt.answer", ["agent": "a", "id": promptID, "optionId": NSNumber(value: 1)]) == "invalid optionId", "numeric option")
for text in ["", "a\nb", "a\rb", "a\u{1b}b", String(repeating: "t", count: 2001), String(repeating: "é", count: 1001)] {
    check(planError("prompt.answer", ["agent": "a", "id": promptID, "optionId": "1", "text": text]) == "invalid text", "prompt text \(text.prefix(10))")
}
check(planError("prompt.answer", ["agent": "a", "id": promptID, "optionId": "1", "text": String(repeating: "t", count: 2000)]) == nil, "2000 bytes")

let png = Data([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 0x0D])
let jpeg = Data([0xFF, 0xD8, 0xFF, 0xE0, 0, 0x10])
let gif = Data("GIF89a\u{1}\u{0}".utf8)
let webp = Data("RIFF\u{4}\u{0}\u{0}\u{0}WEBPVP8 ".utf8)
for (type, data) in [("image/png", png), ("image/jpeg", jpeg), ("image/gif", gif), ("image/webp", webp)] {
    do {
        let upload = try plan("files.upload", ["agent": "keeper-log", "type": type, "data": data.base64EncodedString()]).request
        check(upload.method == .post && upload.url.absoluteString == base + "/api/agents/keeper-log/files" && upload.body == data
              && upload.contentType == type && upload.timeout == 120, "upload \(type)")
        let sent = APIClient.request(upload, token: "fixture-token")
        check(sent.httpBody == data && sent.value(forHTTPHeaderField: "Content-Type") == type && sent.timeoutInterval == 120, "upload request \(type)")
    } catch {
        check(false, "upload \(type) rejected: \(error)")
    }
    for other in ActionPolicy.imageTypes where other != type {
        check(planError("files.upload", ["agent": "keeper-log", "type": other, "data": data.base64EncodedString()]) == "File is not a valid \(other) image",
              "\(type) bytes as \(other)")
    }
}
check(planError("files.upload", ["agent": "a", "type": "image/png", "data": Data("PNG".utf8).base64EncodedString()])
      == "File is not a valid image/png image", "short image")
for type in ["image/svg+xml", "IMAGE/PNG", "image/png; x=1", "", 1] as [Any] {
    check(planError("files.upload", ["agent": "a", "type": type, "data": png.base64EncodedString()]) == "invalid type", "type \(type)")
}
for data in ["", "abc", "!!!!", "iVBO\nRw==", "iVBORw", "iVBORw=", "====", "AA=A", " iVBORw0KGgo=", "iVBORw0KGgo=\n", 7] as [Any] {
    check(planError("files.upload", ["agent": "a", "type": "image/png", "data": data]) == "invalid data", "data \(data)")
}
var largest = Data(count: ActionPolicy.maxUploadBytes)
largest.replaceSubrange(0..<png.count, with: png)
check((try? plan("files.upload", ["agent": "a", "type": "image/png", "data": largest.base64EncodedString()]))?.request.body?.count
      == 10 << 20, "10 MiB upload")
largest.append(0)
check(planError("files.upload", ["agent": "a", "type": "image/png", "data": largest.base64EncodedString()]) == "invalid data", "10 MiB + 1")
check(planError("files.upload", ["agent": "a", "type": "image/png", "data": String(repeating: "A", count: ActionPolicy.maxUploadBase64 + 4)])
      == "invalid data", "oversized base64 refused before decoding")

_ = expectRequest("concierge.ensure", [:], .post, "/api/concierge", [], timeout: 120, confirmed: false)
let search = expectRequest("search.query", ["query": "  tide report "], .post, "/api/search", ["query"], timeout: 30, confirmed: false)
check(search["query"] as? String == "tide report", "query sent trimmed")
for query in ["ab", "é☃", " ab "] { check(planError("search.query", ["query": query]) == nil, "query \(query)") }
for query in ["", "a", "  a  ", "a\nb", "a\u{0}b", String(repeating: "q", count: 257), String(repeating: "é", count: 129)] {
    check(planError("search.query", ["query": query]) == "invalid query", "query \(query.prefix(10).debugDescription)")
}
check(planError("search.query", [:]) == "invalid query", "query required")

let confirmations: [(String, [String: Any], String, String, String, Bool)] = [
    ("agents.restart", ["agent": "keeper-log"], "Restart keeper-log?", "This interrupts its current turn and reopens the conversation.", "Restart", false),
    ("agents.interrupt", ["agent": "annex:kelp-forest"], "Interrupt annex:kelp-forest?", "This interrupts its current work.", "Interrupt", false),
    ("agents.stop", ["agent": "tide-pilot"], "Stop tide-pilot?",
     "This interrupts its current work and ends its session. It can be resumed later.", "Stop", false),
    ("agents.remove", ["agent": "errand-runner"], "Remove errand-runner?",
     "Its session will stop and the agent will be removed, along with its queued messages. The worktree is kept.", "Remove", true),
    ("agents.move", ["agent": "ebb-report", "host": "annex"], "Move ebb-report to annex?",
     "The source will stop; workspace files are not copied.", "Move", false),
    ("agents.model", modelOK, "Change the model for fold-line?",
     "This restarts the agent and interrupts its current turn. The conversation and queued messages are kept.", "Change model", false),
]
for (method, params, title, lead, button, destructive) in confirmations {
    let text = (try? plan(method, params))?.confirm?.text(status: "idle", server: "Fixture")
    check(text == ConfirmationText(title: title, message: "\(lead) Status: idle.\nServer: Fixture", button: button, destructive: destructive),
          "\(method) confirmation \(String(describing: text))")
}
check(ActionPolicy.status(fromDetail: Data(#"{"status":"working","name":"x"}"#.utf8)) == "working", "detail status")
check(ActionPolicy.status(fromDetail: Data(#"{"status":"wo\u001brking\n"}"#.utf8)) == "working", "status controls stripped")
for detail in [#"{}"#, #"{"status":7}"#, "not json", #"{"status":"  "}"#] {
    check(ActionPolicy.status(fromDetail: Data(detail.utf8)) == "unknown", "detail \(detail)")
}
check(ActionPolicy.status(fromDetail: Data("{\"status\":\"\(String(repeating: "s", count: 100))\"}".utf8)).count == 64, "status capped")
check(ActionPolicy.status(fromDetail: Data(#"{"status":"‮idle‬‎"}"#.utf8)) == "idle", "status bidi controls stripped")
// The page sets the connection name, so the sheet's server line is cleaned like the status.
let servers: [(String, String)] = [
    ("Fixture motel", "Fixture motel"),
    ("Fixture\n\nStop everything?", "FixtureStop everything?"),
    ("Fix\rture\u{1b}[31m", "Fixture[31m"),
    ("\u{202e}letom erutxiF", "letom erutxiF"),
    ("a\u{202a}b\u{202b}c\u{202c}d\u{202d}e\u{2066}f\u{2067}g\u{2068}h\u{2069}i\u{200e}j\u{200f}k", "abcdefghijk"),
    ("\u{200f} \u{2069}", "unknown"),
    (String(repeating: "m", count: 80), String(repeating: "m", count: 64)),
]
let stopConfirm = try! plan("agents.stop", ["agent": "tide-pilot"]).confirm!
for (name, shown) in servers {
    check(ActionPolicy.displayText(name) == shown, "server \(name.debugDescription)")
    check(stopConfirm.text(status: "idle", server: name).message.hasSuffix(" Status: idle.\nServer: \(shown)"), "server line \(name.debugDescription)")
}
// The exact-name lookup's verdict, before the sheet and again before sending.
check(rejection { try ActionPolicy.checkPrecheck(200); return 0 } == nil, "lookup 200")
check(rejection { try ActionPolicy.checkPrecheck(404); return 0 } == "This agent no longer exists", "lookup 404")
for status in [204, 302, 500] {
    check(rejection { try ActionPolicy.checkPrecheck(status); return 0 } == "Couldn't check the agent (HTTP \(status))", "lookup \(status)")
}
// Values that are not a string, number or boolean are shown as one placeholder, as in policy.ts.
check(planError("agents.rename", ["agent": "crease-check", "name": ["name": "a"]]) == "invalid name: [object]", "object name")
check(planError("agents.rename", ["agent": "crease-check", "name": ["a", "b"]]) == "invalid name: [object]", "array name")
check(planError("agents.move", ["agent": "ebb-report", "host": ["host": "annex"]]) == "invalid host: [object]", "object host")
check(planError("agents.stop", ["agent": ["harbor-lights"]]) == "invalid agent: [object]", "array agent")
check(planError("agents.rename", ["agent": "crease-check", "name": NSNumber(value: 1.5)]) == "invalid name: 1.5", "number name")

let removal = APIClient.request(try! plan("agents.remove", ["agent": "errand-runner"]).request, token: "fixture-token")
check(removal.httpMethod == "DELETE" && removal.httpBody == nil && removal.value(forHTTPHeaderField: "Content-Type") == nil
      && removal.timeoutInterval == 60, "remove request")
let move = APIClient.request(try! plan("agents.move", ["agent": "ebb-report", "host": "annex"]).request, token: "fixture-token")
check(move.httpMethod == "POST" && move.timeoutInterval == 600 && move.value(forHTTPHeaderField: "Content-Type") == "application/json"
      && move.value(forHTTPHeaderField: "Authorization") == "Bearer fixture-token", "move request")
print("PASS action policy (15 methods: rules, rejection strings, paths, bodies, timeouts, confirmation text, upload decoding)")

func parse(_ chunks: [String]) -> [SSEEvent] {
    var parser = SSEParser()
    return chunks.flatMap { try! parser.feed(Data($0.utf8)) }
}
check(parse(["event: ready\ndata: {\"ok\":true}\n\n"]) == [SSEEvent(event: "ready", data: "{\"ok\":true}", id: nil)], "basic")
check(parse(["data: a\ndata: b\n\n"]) == [SSEEvent(event: "message", data: "a\nb", id: nil)], "multi-line data")
check(parse([": keepalive\n\n", ": comment\ndata: x\n\n"]) == [SSEEvent(event: "message", data: "x", id: nil)], "comments")
check(parse(["event: fleet\r\ndata: 1\r\n\r\nevent: fleet\rdata: 2\r\r"]) ==
      [SSEEvent(event: "fleet", data: "1", id: nil), SSEEvent(event: "fleet", data: "2", id: nil)], "CRLF and CR")
check(parse(["event: fl", "eet\r", "\ndata: {\"a\"", ":1}\r", "\n\r", "\n"]) ==
      [SSEEvent(event: "fleet", data: "{\"a\":1}", id: nil)], "split chunks")
check(parse(["event: x\n\ndata: y\n\n"]) == [SSEEvent(event: "message", data: "y", id: nil)], "event without data resets")
check(parse(["data: z\n"]).isEmpty, "no dispatch without blank line")
check(parse(["data\n\n", "data:\n\n"]) == [SSEEvent(event: "message", data: "", id: nil), SSEEvent(event: "message", data: "", id: nil)], "empty data")
check(parse(["data:  two spaces\n\n"]) == [SSEEvent(event: "message", data: " two spaces", id: nil)], "only one space stripped")
check(parse(["\u{FEFF}data: bom\n\n"]) == [SSEEvent(event: "message", data: "bom", id: nil)], "BOM")
check(parse(["id: 7\ndata: a\n\n"]) == [SSEEvent(event: "message", data: "a", id: "7")], "id")
check(parse(["retry: 10\nfoo: bar\ndata: q\n\n"]) == [SSEEvent(event: "message", data: "q", id: nil)], "unknown fields")
var split = SSEParser()
let snowman = Array("data: ☃\n\n".utf8)
var splitEvents: [SSEEvent] = []
for byte in snowman { splitEvents += try! split.feed(Data([byte])) }
check(splitEvents == [SSEEvent(event: "message", data: "☃", id: nil)], "UTF-8 split across chunks")
var huge = SSEParser()
check((try? huge.feed(Data(repeating: 0x61, count: SSEParser.maxLineBytes + 1))) == nil, "oversized line")
let mebiLine = Data(("data: " + String(repeating: "a", count: 1 << 20) + "\n").utf8)
var bounded = SSEParser()
for _ in 0..<7 { check((try? bounded.feed(mebiLine))?.isEmpty == true, "data under the cap") }
check((try? bounded.feed(Data("\n".utf8)))?.first?.data.utf8.count == 7 * (1 << 20) + 6, "7 MiB event dispatched")
var growing = SSEParser()
var cutOff = false
for _ in 0..<9 where !cutOff { cutOff = (try? growing.feed(mebiLine)) == nil }
check(cutOff, "event data that never ends is capped")
print("PASS SSE parser")

let root = FileManager.default.temporaryDirectory.appendingPathComponent("am-resource-test-\(getpid())", isDirectory: true)
let outside = FileManager.default.temporaryDirectory.appendingPathComponent("am-resource-outside-\(getpid()).js")
try! FileManager.default.createDirectory(at: root.appendingPathComponent("web"), withIntermediateDirectories: true)
for name in ["index.html", "app.js", "web/style.css", "notes.txt"] {
    try! Data("x".utf8).write(to: root.appendingPathComponent(name))
}
try! Data("secret".utf8).write(to: outside)
try! FileManager.default.createSymbolicLink(at: root.appendingPathComponent("escape.js"), withDestinationURL: outside)
try! FileManager.default.createSymbolicLink(at: root.appendingPathComponent("linkdir"), withDestinationURL: FileManager.default.temporaryDirectory)
for (path, file, type) in [("/", "index.html", "text/html; charset=utf-8"), ("/index.html", "index.html", "text/html; charset=utf-8"),
                           ("/app.js", "app.js", "text/javascript; charset=utf-8"), ("/web/style.css", "web/style.css", "text/css; charset=utf-8"),
                           ("/web/", nil, nil), ("/%61pp.js", "app.js", "text/javascript; charset=utf-8")] as [(String, String?, String?)] {
    let found = BundleResource.resolve(root: root, encodedPath: path)
    if let file {
        check(found?.file.lastPathComponent == URL(fileURLWithPath: file).lastPathComponent && found?.contentType == type, path)
    } else {
        check(found == nil, "\(path) should be missing")
    }
}
for path in ["/../etc/passwd", "/web/../index.html", "/%2e%2e/x.js", "/./index.html", "//index.html", "/web\\style.css",
             "/escape.js", "/linkdir/\(outside.lastPathComponent)", "/notes.txt", "/missing.js", "/web", "/index.html%00.js", ""] {
    check(BundleResource.resolve(root: root, encodedPath: path) == nil, "served \(path)")
}
check(BundleResource.headers["Content-Security-Policy"]?.contains("connect-src 'none'") == true, "CSP")
try? FileManager.default.removeItem(at: root)
try? FileManager.default.removeItem(at: outside)
print("PASS bundle resource resolution")
