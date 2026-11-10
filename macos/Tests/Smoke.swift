import AppKit
import WebKit

// Opt-in integration check, run by smoke.sh under its own bundle id so its defaults and Keychain
// items are separate. The token is read from stdin, never an argument. It never activates the app.
@main
struct Smoke {
    @MainActor static func main() {
        let environment = ProcessInfo.processInfo.environment
        guard let server = environment["SMOKE_URL"], !server.isEmpty else {
            print("FAIL SMOKE_URL is not set")
            exit(1)
        }
        let token = readLine() ?? ""
        guard !token.isEmpty else {
            print("FAIL a token is required on stdin")
            exit(1)
        }
        let app = NSApplication.shared
        let delegate = AppDelegate()
        delegate.activatesWindow = false
        app.delegate = delegate
        app.setActivationPolicy(.accessory)
        let runner = SmokeRunner(delegate: delegate, server: server, token: token,
                                 bridgeOnly: environment["SMOKE_BRIDGE_ONLY"] == "1")
        Task { @MainActor in
            try? await Task.sleep(nanoseconds: 180_000_000_000)
            print("FAIL smoke test timed out")
            runner.cleanUp()
            exit(1)
        }
        Task { @MainActor in
            try? await Task.sleep(nanoseconds: 300_000_000)
            exit(await runner.run() ? 0 : 1)
        }
        withExtendedLifetime(delegate) { app.run() }
    }
}

struct SmokeFailure: Error, CustomStringConvertible {
    let description: String
    init(_ description: String) { self.description = description }
}

@MainActor
final class SmokeRunner {
    let delegate: AppDelegate
    let server: String
    let token: String
    let bridgeOnly: Bool
    var connectionID: String?

    init(delegate: AppDelegate, server: String, token: String, bridgeOnly: Bool) {
        self.delegate = delegate
        self.server = server
        self.token = token
        self.bridgeOnly = bridgeOnly
    }

    var web: WKWebView { delegate.webView }

    func run() async -> Bool {
        do {
            try await steps()
            print("PASS all smoke checks")
            return true
        } catch {
            print("FAIL \(error)")
            cleanUp()
            return false
        }
    }

    func cleanUp() {
        delegate.bridge.stopAllStreams()
        for connection in delegate.store.list() { try? delegate.store.remove(connection.id) }
        if let connectionID, delegate.store.hasToken(connectionID) { try? delegate.store.remove(connectionID) }
    }

    // MARK: Helpers

    func js(_ body: String, _ arguments: [String: Any] = [:]) async throws -> Any? {
        try await web.callAsyncJavaScript(body, arguments: arguments, in: nil, contentWorld: .page)
    }

    func waitFor(_ condition: String, _ what: String, _ arguments: [String: Any] = [:], seconds: Double = 20) async throws {
        let deadline = Date().addingTimeInterval(seconds)
        while Date() < deadline {
            if (try? await js("return !!(\(condition));", arguments)) as? Bool == true { return }
            try await Task.sleep(nanoseconds: 200_000_000)
        }
        throw SmokeFailure("timed out waiting for \(what)")
    }

    func call(_ method: String, _ params: [String: Any] = [:]) async throws -> Any? {
        try await js("return await window.webkit.messageHandlers.am.postMessage({method, params});",
                     ["method": method, "params": params])
    }

    /// Returns the rejection message, or throws if the call succeeded.
    func rejection(_ method: String, _ params: [String: Any]) async throws -> String {
        let outcome = try await js("""
            try { await window.webkit.messageHandlers.am.postMessage({method, params}); return null; }
            catch (error) { return String(error && error.message || error); }
            """, ["method": method, "params": params])
        guard let message = outcome as? String else { throw SmokeFailure("\(method) \(params) was not rejected") }
        return message
    }

    func object(_ value: Any?, _ what: String) throws -> [String: Any] {
        guard let object = value as? [String: Any] else { throw SmokeFailure("\(what) returned \(String(describing: value))") }
        return object
    }

    func expect(_ condition: Bool, _ message: String) throws {
        if !condition { throw SmokeFailure(message) }
    }

    /// The fixture's log of mutation requests it received, read directly (it is outside /api/, so
    /// the bridge cannot reach it). Bodies are normalised to objects; a missing body is NSNull.
    func fixtureRequests() async throws -> [[String: Any]] {
        guard let url = URL(string: server + "/__fixture/requests") else { throw SmokeFailure("bad fixture URL") }
        var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalAndRemoteCacheData, timeoutInterval: 10)
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        let (data, response) = try await URLSession.shared.data(for: request)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        try expect(status == 200, "GET /__fixture/requests returned \(status)")
        let json = try JSONSerialization.jsonObject(with: data)
        guard let list = (json as? [[String: Any]]) ?? ((json as? [String: Any])?["requests"] as? [[String: Any]]) else {
            throw SmokeFailure("GET /__fixture/requests returned \(json)")
        }
        return list.map { entry in
            var entry = entry
            if let text = entry["body"] as? String {
                entry["body"] = text.isEmpty ? NSNull() : (text.data(using: .utf8).flatMap { try? JSONSerialization.jsonObject(with: $0) } ?? text)
            }
            if entry["body"] == nil { entry["body"] = NSNull() }
            return entry
        }
    }

    func expectSend(_ entry: [String: Any], agent: String, text: String, mode: String) throws {
        let body = entry["body"] as? [String: Any] ?? [:]
        try expect(entry["method"] as? String == "POST" && entry["path"] as? String == "/api/agents/\(agent)/messages"
                   && Set(body.keys) == ["text", "mode"] && body["text"] as? String == text && body["mode"] as? String == mode,
                   "expected POST to \(agent) with only {text, mode}, fixture saw \(entry)")
    }

    func expectCancel(_ entry: [String: Any], agent: String, id: String?) throws {
        let path = entry["path"] as? String ?? ""
        let prefix = "/api/agents/\(agent)/messages/"
        try expect(entry["method"] as? String == "DELETE" && (id.map { path == prefix + $0 } ?? path.hasPrefix(prefix))
                   && entry["body"] is NSNull, "expected bodiless DELETE for \(agent), fixture saw \(entry)")
    }

    func status(_ value: Any?, _ what: String) throws -> (Int, [String: Any]) {
        let result = try object(value, what)
        guard let status = result["status"] as? Int else { throw SmokeFailure("\(what) returned \(result)") }
        return (status, result["body"] as? [String: Any] ?? [:])
    }

    func openAgent(_ name: String) async throws {
        let clicked = try await js("""
            const row = [...document.querySelectorAll('[data-agent-key]')]
              .find((r) => r.dataset.agentKey.endsWith('/' + name) || r.dataset.agentKey.endsWith(':' + name));
            if (!row) return false;
            row.click();
            return true;
            """, ["name": name]) as? Bool ?? false
        try expect(clicked, "no row ending in \(name)")
    }

    /// Fills the composer the way typing would (value plus an input event) and clicks Send.
    func compose(_ text: String) async throws {
        try await waitFor("document.querySelector('#composer-input') && !document.querySelector('#composer-input').disabled",
                          "an enabled #composer-input")
        let sent = try await js("""
            const input = document.querySelector('#composer-input');
            input.focus();
            input.value = text;
            input.dispatchEvent(new Event('input', { bubbles: true }));
            const button = document.querySelector('#composer-send');
            if (!button || button.disabled) return false;
            button.click();
            return true;
            """, ["text": text]) as? Bool ?? false
        try expect(sent, "#composer-send missing or disabled after typing")
    }

    /// The page remembers the last mode chosen (in this bundle's own storage), so pick it explicitly.
    func selectMode(_ mode: String) async throws {
        let button = "document.querySelector(`[data-send-mode=\"${mode}\"]`)"
        try await waitFor("\(button) && !\(button).disabled", "the \(mode) mode button", ["mode": mode])
        _ = try await js("\(button).click(); return true;", ["mode": mode])
        try await waitFor("\(button).getAttribute('aria-pressed') === 'true'", "\(mode) mode selected", ["mode": mode])
    }

    var screenshotTaken = false

    func screenshot() async throws {
        let image = try await web.takeSnapshot(configuration: nil)
        guard let tiff = image.tiffRepresentation, let png = NSBitmapImageRep(data: tiff)?.representation(using: .png, properties: [:]) else {
            throw SmokeFailure("snapshot could not be encoded")
        }
        let screenshot = FileManager.default.temporaryDirectory.appendingPathComponent("am-macos-smoke.png")
        try png.write(to: screenshot)
        screenshotTaken = true
        print("SCREENSHOT \(screenshot.path)")
    }

    // MARK: Steps

    func steps() async throws {
        let leftovers = delegate.store.list()
        if !leftovers.isEmpty {
            print("NOTE removing \(leftovers.count) connection(s) left by an earlier run")
            for connection in leftovers { try delegate.store.remove(connection.id) }
        }

        try await waitFor("document.body && document.body.dataset.ready === 'true'", "document.body.dataset.ready")
        let href = try await js("return location.href;") as? String ?? ""
        try expect(href.hasPrefix("am-app://app/"), "page loaded from \(href)")
        print("PASS page loaded from the bundle (\(href)) and signalled ready")

        _ = try await js("""
            window.__smokeEvents = [];
            const previous = window.__amNativeEvent;
            window.__amNativeEvent = function (name, payload) {
              window.__smokeEvents.push({ name, payload });
              if (typeof previous === 'function') return previous.apply(this, arguments);
            };
            return true;
            """)

        let info = try object(try await call("app.info"), "app.info")
        try expect(info["platform"] as? String == "macos" && info["version"] is String, "app.info: \(info)")
        let unknown = try await rejection("no.such.method", [:])
        try expect(unknown == "unknown method: no.such.method", "unknown method message: \(unknown)")
        print("PASS app.info and unknown-method rejection")

        let bad = try object(try await call("connections.test", ["url": server, "token": "wrong-\(UUID().uuidString)"]), "test")
        try expect(bad["ok"] as? Bool == false && bad["status"] as? Int == 401, "wrong token gave \(bad)")
        let good = try object(try await call("connections.test", ["url": server, "token": token]), "test")
        try expect(good["ok"] as? Bool == true && good["status"] as? Int == 200, "right token gave \(good)")
        try expect(delegate.store.list().isEmpty, "connections.test stored something")
        print("PASS connections.test: wrong token -> 401, right token -> 200, nothing stored")

        let policy = try await rejection("connections.save", ["name": "LAN", "url": "http://192.168.1.5", "token": "x"])
        try expect(policy.contains("only allowed for localhost and Tailscale"), "http policy message: \(policy)")
        let noToken = try await rejection("connections.save", ["name": "Smoke", "url": server])
        try expect(!noToken.isEmpty, "new connection without token")
        let wrongType = try await rejection("connections.save", ["name": 7, "url": server, "token": token])
        try expect(wrongType.contains("name"), "type validation: \(wrongType)")
        print("PASS connections.save validation (http policy, missing token, param types)")

        let saved = try object(try await call("connections.save", ["name": "Smoke", "url": server, "token": token]), "save")
        guard let id = saved["id"] as? String else { throw SmokeFailure("save returned \(saved)") }
        connectionID = id
        try expect(saved["hasToken"] as? Bool == true && saved["token"] == nil, "save result \(saved)")
        try expect(delegate.store.hasToken(id), "Keychain item missing after save")
        let listed = try await call("connections.list") as? [[String: Any]] ?? []
        try expect(listed.count == 1 && listed[0]["id"] as? String == id && listed[0]["token"] == nil, "list: \(listed)")
        let resaved = try object(try await call("connections.save", ["id": id, "name": "Smoke 2", "url": server]), "resave")
        try expect(resaved["name"] as? String == "Smoke 2" && delegate.store.hasToken(id), "rename kept token")
        print("PASS connections.save through the bridge, token in Keychain, never returned to the page")

        let health = try object(try await call("api.get", ["connection": id, "path": "/api/health"]), "api.get")
        try expect(health["status"] as? Int == 200 && (health["body"] as? [String: Any])?["ok"] as? Bool == true, "health: \(health)")
        print("PASS api.get /api/health -> 200")

        for path in ["/etc/passwd", "//evil.example/api/x", "/api/../x"] {
            _ = try await rejection("api.get", ["connection": id, "path": path])
        }
        print("PASS api.get rejects /etc/passwd, //evil.example/api/x and /api/../x")

        let baseline = try await fixtureRequests().count
        let invalidSends: [([String: Any], String)] = [
            (["agent": "harbor-lights", "text": "hi", "mode": "interrupt"], "mode must be queue or now"),
            (["agent": "harbor-lights", "text": "hi", "mode": "Now"], "mode must be queue or now"),
            (["agent": "../x", "text": "hi", "mode": "queue"], "invalid agent: ../x"),
            (["agent": "a/b", "text": "hi", "mode": "queue"], "invalid agent: a/b"),
            (["agent": "a:b:c", "text": "hi", "mode": "queue"], "invalid agent: a:b:c"),
            (["agent": "harbor-lights", "text": "", "mode": "queue"], "Message is empty"),
            (["agent": "harbor-lights", "text": "  \n ", "mode": "queue"], "Message is empty"),
            (["agent": "harbor-lights", "text": String(repeating: "a", count: 100_001), "mode": "queue"],
             "Message is too long (limit 100,000 bytes)"),
        ]
        for (params, expected) in invalidSends {
            var params = params
            params["connection"] = id
            let message = try await rejection("messages.send", params)
            try expect(message == expected, "messages.send \(params["agent"] ?? "") \(params["mode"] ?? ""): \(message.prefix(200))")
        }
        for badID in ["../x", "a/b", ""] {
            let message = try await rejection("messages.cancel", ["connection": id, "agent": "harbor-lights", "id": badID])
            try expect(message.hasPrefix("invalid message id"), "messages.cancel id \(badID): \(message)")
        }
        let unknownConnection = UUID().uuidString.lowercased()
        let stranger = try await rejection("messages.send", ["connection": unknownConnection, "agent": "keeper-log",
                                                             "text": "hi", "mode": "queue"])
        try expect(stranger == "unknown connection: \(unknownConnection)", "unknown connection: \(stranger)")
        for name in ["api.post", "api.delete", "api.put", "api.request", "api.fetch", "messages.interrupt", "agents.stop"] {
            let message = try await rejection(name, ["connection": id, "path": "/api/agents/harbor-lights/messages",
                                                     "method": "POST", "body": ["text": "hi", "mode": "interrupt"]])
            try expect(message == "unknown method: \(name)", "\(name): \(message)")
        }
        // api.get ignores a smuggled method or body: it stays a GET, so the fixture records no mutation.
        _ = try status(try await call("api.get", ["connection": id, "path": "/api/agents/harbor-lights/messages",
                                                        "method": "POST", "body": ["text": "hi", "mode": "now"]]), "api.get")
        try expect(try await fixtureRequests().count == baseline, "a rejected call or api.get reached the server as a mutation")
        print("PASS messages.send/cancel validation (mode interrupt, ../x, a/b, empty, 100,001 bytes, ids, connection); "
              + "no api.post/api.delete/api.request; api.get stays GET")

        let queuedText = "Smoke queued \(UUID().uuidString.prefix(8))"
        let (queuedStatus, queuedBody) = try status(try await call("messages.send", [
            "connection": id, "agent": "harbor-lights", "text": "  \(queuedText)\n", "mode": "queue"]), "messages.send")
        guard queuedStatus == 200, let queuedID = queuedBody["id"] as? String, !queuedID.isEmpty else {
            throw SmokeFailure("queue send to harbor-lights: \(queuedStatus) \(queuedBody)")
        }
        // Like am, detail.queue lists an API-queued message by text, without its record id.
        func queueTexts(_ agent: String) async throws -> [String] {
            let (code, detail) = try status(try await call("api.get", ["connection": id, "path": "/api/agents/\(agent)"]), "detail")
            try expect(code == 200, "detail \(agent): \(code)")
            let queue = detail["queue"] as? [[String: Any]] ?? []
            try expect(!queue.contains { $0["msgId"] as? String == queuedID }, "detail.queue lists record id \(queuedID) as a msgId")
            return queue.compactMap { ($0["message"] ?? $0["text"]) as? String }
        }
        try expect(try await queueTexts("harbor-lights").contains(queuedText), "queued message \(queuedID) not in detail.queue")
        let (cancelStatus, cancelBody) = try status(try await call("messages.cancel", [
            "connection": id, "agent": "harbor-lights", "id": queuedID]), "messages.cancel")
        try expect(cancelStatus == 200 && cancelBody["state"] as? String == "cancelled", "cancel: \(cancelStatus) \(cancelBody)")
        try expect(!(try await queueTexts("harbor-lights").contains(queuedText)), "cancelled message still in detail.queue")
        let (againStatus, againBody) = try status(try await call("messages.cancel", [
            "connection": id, "agent": "harbor-lights", "id": queuedID]), "messages.cancel")
        try expect(againStatus == 404 || againStatus == 409, "second cancel: \(againStatus) \(againBody)")
        print("PASS queue send to harbor-lights -> 200 id in detail.queue; cancel -> 200 and gone; second cancel -> \(againStatus)")

        let nowText = "Smoke now \(UUID().uuidString.prefix(8))"
        let (nowStatus, nowBody) = try status(try await call("messages.send", [
            "connection": id, "agent": "keeper-log", "text": nowText, "mode": "now"]), "messages.send")
        guard nowStatus == 200, let nowID = nowBody["id"] as? String, !nowID.isEmpty else {
            throw SmokeFailure("now send to keeper-log: \(nowStatus) \(nowBody)")
        }
        let answered = Date().addingTimeInterval(10)
        var replied = false
        while !replied && Date() < answered {
            let (code, transcript) = try status(try await call("api.get", [
                "connection": id, "path": "/api/agents/keeper-log/transcript"]), "transcript")
            let entries = code == 200 ? transcript["entries"] as? [[String: Any]] ?? [] : []
            if let turn = entries.lastIndex(where: { $0["kind"] as? String == "user" && $0["text"] as? String == nowText }) {
                replied = entries[(turn + 1)...].contains { $0["kind"] as? String == "assistant" }
            }
            if !replied { try await Task.sleep(nanoseconds: 300_000_000) }
        }
        try expect(replied, "keeper-log transcript has no user turn with the sent text followed by an assistant turn")
        print("PASS now send to keeper-log -> 200; the transcript shows the user turn and an assistant reply")

        let made = Array(try await fixtureRequests().dropFirst(baseline))
        try expect(made.count == 4, "fixture saw \(made.count) mutations, expected 4: \(made)")
        try expectSend(made[0], agent: "harbor-lights", text: queuedText, mode: "queue")
        try expectCancel(made[1], agent: "harbor-lights", id: queuedID)
        try expectCancel(made[2], agent: "harbor-lights", id: queuedID)
        try expectSend(made[3], agent: "keeper-log", text: nowText, mode: "now")
        print("PASS fixture saw exactly the 4 mutations made, POST bodies trimmed with only {text, mode}, DELETEs without a body")

        let fetches = try await js("""
            const results = [];
            for (const url of ['https://example.com', server + '/api/health']) {
              try { await fetch(url); results.push('allowed ' + url); } catch { results.push('blocked'); }
            }
            return results;
            """, ["server": server]) as? [String] ?? []
        try expect(fetches == ["blocked", "blocked"], "page fetch: \(fetches)")
        print("PASS page fetch() is blocked by CSP (https://example.com and the server itself)")

        _ = try await call("events.start", ["connection": id])
        _ = try await call("events.start", ["connection": id])
        try expect(delegate.bridge.streams.count == 1, "events.start not idempotent")
        try await waitFor("window.__smokeEvents.some(({name, payload: p}) => name === 'events.state' && p.connection === id && p.state === 'open')",
                          "events.state open", ["id": id])
        try await waitFor("window.__smokeEvents.some(({name, payload: p}) => name === 'events.message' && p.connection === id)",
                          "an events.message", ["id": id])
        let first = try await js("""
            const hit = window.__smokeEvents.find(({name}) => name === 'events.message');
            return hit.payload.event;
            """) as? String ?? "?"
        print("PASS events.start (idempotent): events.state open and events.message '\(first)' delivered")

        let badSaved = try object(try await call("connections.save", ["name": "Bad", "url": server, "token": "wrong-token"]), "save")
        guard let badID = badSaved["id"] as? String else { throw SmokeFailure("save returned \(badSaved)") }
        _ = try await call("events.start", ["connection": badID])
        try await waitFor("""
            window.__smokeEvents.some(({name, payload: p}) => name === 'events.state' && p.connection === id
              && p.state === 'closed' && /Unauthorized/.test(p.error || ''))
            """, "events.state closed with Unauthorized", ["id": badID])
        let badStatus = try object(try await call("api.get", ["connection": badID, "path": "/api/health"]), "api.get")
        try expect(badStatus["status"] as? Int == 401, "api.get with wrong token: \(badStatus)")
        let (badSend, _) = try status(try await call("messages.send", [
            "connection": badID, "agent": "keeper-log", "text": "Smoke wrong token", "mode": "queue"]), "messages.send")
        try expect(badSend == 401, "messages.send with wrong token: \(badSend)")
        let (badCancel, _) = try status(try await call("messages.cancel", [
            "connection": badID, "agent": "harbor-lights", "id": "01JABCDEFGHJKMNPQRSTVWXYZ0"]), "messages.cancel")
        try expect(badCancel == 401, "messages.cancel with wrong token: \(badCancel)")
        _ = try await call("connections.remove", ["id": badID])
        try expect(!delegate.store.hasToken(badID) && delegate.bridge.streams[badID] == nil, "bad connection cleanup")
        print("PASS wrong token: events.state closed with an Unauthorized error; api.get, messages.send and messages.cancel resolve 401")

        // Nothing listens on the discard port, so the send fails at the network level and must reject.
        let downSaved = try object(try await call("connections.save", ["name": "Down", "url": "http://127.0.0.1:9", "token": token]), "save")
        guard let downID = downSaved["id"] as? String else { throw SmokeFailure("save returned \(downSaved)") }
        let down = try await rejection("messages.send", ["connection": downID, "agent": "keeper-log", "text": "Smoke offline", "mode": "now"])
        _ = try await call("connections.remove", ["id": downID])
        try expect(!down.isEmpty && !delegate.store.hasToken(downID), "network failure message: \(down)")
        print("PASS messages.send to an unreachable server rejects (\(down))")

        if bridgeOnly {
            print("SKIP sidebar rows [data-agent-key] (SMOKE_BRIDGE_ONLY=1)")
            print("SKIP open harbor-lights and render #transcript .turn (SMOKE_BRIDGE_ONLY=1)")
            print("SKIP composer send to keeper-log and queue/cancel on harbor-lights (SMOKE_BRIDGE_ONLY=1)")
        } else {
            delegate.loadHome()
            try await waitFor("document.body && document.body.dataset.ready === 'true' && document.body.dataset.view === 'fleet'",
                              "fleet view after reload")
            try await waitFor("document.querySelectorAll('[data-agent-key]').length > 0", "sidebar rows [data-agent-key]")
            let rows = try await js("return document.querySelectorAll('[data-agent-key]').length;") as? Int ?? 0
            print("PASS sidebar shows \(rows) agent rows")
            try await openAgent("harbor-lights")
            try await waitFor("document.querySelectorAll('#transcript .turn').length > 0", "#transcript .turn")
            let turns = try await js("return document.querySelectorAll('#transcript .turn').length;") as? Int ?? 0
            print("PASS harbor-lights transcript rendered \(turns) turns")

            let uiStart = try await fixtureRequests().count
            let typedNow = "Smoke typed \(UUID().uuidString.prefix(8))"
            try await openAgent("keeper-log")
            try await selectMode("now")
            try await compose(typedNow)
            let hasText = "[...document.querySelectorAll(selector)].some((node) => node.textContent.includes(text))"
            try await waitFor(hasText, "a .turn.pending bubble for the typed message",
                              ["selector": "#transcript .turn.pending", "text": typedNow], seconds: 5)
            try await waitFor("""
                (() => {
                  const turns = [...document.querySelectorAll('#transcript .turn:not(.pending)')];
                  const at = turns.findIndex((node) => node.classList.contains('user') && node.textContent.includes(text));
                  return at >= 0 && turns.slice(at + 1).some((node) => node.classList.contains('assistant'));
                })()
                """, "the delivered user turn and the assistant reply", ["text": typedNow], seconds: 15)
            print("PASS composer: keeper-log showed a pending bubble, then the delivered user turn and the assistant reply")

            let typedQueued = "Smoke typed queued \(UUID().uuidString.prefix(8))"
            try await openAgent("harbor-lights")
            try await selectMode("queue")
            try await compose(typedQueued)
            let queuedBubble = """
                [...document.querySelectorAll('#transcript .turn.pending[data-message-state="queued"]')]
                  .find((node) => node.textContent.includes(text))
                """
            try await waitFor("(\(queuedBubble))?.querySelector('[data-cancel-message]')",
                              "a queued bubble with a Cancel button", ["text": typedQueued], seconds: 10)
            try await screenshot()
            _ = try await js("(\(queuedBubble)).querySelector('[data-cancel-message]').click(); return true;", ["text": typedQueued])
            try await waitFor("!(\(queuedBubble))", "the cancelled bubble to disappear", ["text": typedQueued], seconds: 10)
            print("PASS composer: queued message to harbor-lights showed a Cancel button and disappeared after cancelling")

            let typed = Array(try await fixtureRequests().dropFirst(uiStart))
            try expect(typed.count == 3, "fixture saw \(typed.count) mutations from the UI, expected 3: \(typed)")
            try expectSend(typed[0], agent: "keeper-log", text: typedNow, mode: "now")
            try expectSend(typed[1], agent: "harbor-lights", text: typedQueued, mode: "queue")
            try expectCancel(typed[2], agent: "harbor-lights", id: nil)
            print("PASS fixture saw exactly the UI's 3 mutations (now send, queue send, cancel)")
        }

        if !screenshotTaken { try await screenshot() }

        _ = try await call("events.stop", ["connection": id])
        try expect(delegate.bridge.streams.isEmpty, "events.stop left a stream")
        _ = try await call("events.start", ["connection": id])
        _ = try await call("connections.remove", ["id": id])
        try expect(delegate.bridge.streams.isEmpty, "connections.remove left a stream")
        let after = try await call("connections.list") as? [Any] ?? [0]
        try expect(after.isEmpty, "connection still listed")
        try expect(!delegate.store.hasToken(id), "Keychain item still present after remove")
        connectionID = nil
        print("PASS connections.remove deleted metadata, Keychain item and event stream")
    }
}
