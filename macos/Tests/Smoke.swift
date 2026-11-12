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
        // Not just .accessory: an NSAlert sheet can make an accessory app's window key and the app
        // frontmost. A prohibited app can never be activated, so the confirmation sheets stay off the
        // owner's way while still being real sheets on this window.
        app.setActivationPolicy(.prohibited)
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

    /// host:port of the fixture server, as the sheet's server line shows it (smoke.sh only allows
    /// `http://<loopback>:<port>`, which the connection store keeps unchanged).
    var serverHost: String { server.components(separatedBy: "://").last ?? server }

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

    /// Restores the fixture's initial state (outside /api/, so only the smoke test can reach it).
    func resetFixture() async throws {
        guard let url = URL(string: server + "/__fixture/reset") else { throw SmokeFailure("bad fixture URL") }
        var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalAndRemoteCacheData, timeoutInterval: 10)
        request.httpMethod = "POST"
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        let (_, response) = try await URLSession.shared.data(for: request)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        try expect(status == 200, "POST /__fixture/reset returned \(status)")
    }

    /// The same request log entry, compared as canonical JSON.
    func canonical(_ value: Any) -> String {
        (try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys, .fragmentsAllowed])).flatMap { String(data: $0, encoding: .utf8) } ?? "?"
    }

    func agentStatus(_ connection: String, _ agent: String) async throws -> String {
        let (code, detail) = try status(try await call("api.get", ["connection": connection, "path": "/api/agents/\(agent)"]), "detail")
        try expect(code == 200, "detail \(agent): \(code)")
        return detail["status"] as? String ?? "unknown"
    }

    func views(_ view: NSView) -> [NSView] { [view] + view.subviews.flatMap(views) }

    /// The NSAlert sheet the bridge attached to the (background) app window.
    func waitForSheet(seconds: Double = 10) async throws -> NSWindow {
        let deadline = Date().addingTimeInterval(seconds)
        while Date() < deadline {
            if let sheet = delegate.window.attachedSheet { return sheet }
            try await Task.sleep(nanoseconds: 50_000_000)
        }
        throw SmokeFailure("no confirmation sheet appeared")
    }

    func button(_ title: String, in sheet: NSWindow) throws -> NSButton {
        guard let content = sheet.contentView,
              let found = views(content).compactMap({ $0 as? NSButton }).first(where: { $0.title == title }) else {
            throw SmokeFailure("sheet has no \(title) button")
        }
        return found
    }

    func waitForNoSheet() async throws {
        let deadline = Date().addingTimeInterval(5)
        while delegate.window.attachedSheet != nil && Date() < deadline { try await Task.sleep(nanoseconds: 50_000_000) }
        try expect(delegate.window.attachedSheet == nil, "the sheet stayed open")
    }

    enum Answer { case accept, cancel, escape }

    /// Calls a confirmed method, checks the native sheet (text, buttons, never activating the app)
    /// and answers it the way a person would: by clicking a button, or pressing Esc on the sheet.
    func confirmed(_ method: String, _ params: [String: Any], title: String, agentStatus expectedStatus: String, button confirmTitle: String,
                   destructive: Bool = false, answer: Answer) async throws -> [String: Any] {
        // Data crosses the task boundary (the bridge's reply is a plain property list, not Sendable).
        let pending = Task { @MainActor () throws -> Data in
            try JSONSerialization.data(withJSONObject: try await self.call(method, params) ?? NSNull(), options: [.fragmentsAllowed])
        }
        let sheet: NSWindow
        do {
            sheet = try await waitForSheet()
        } catch {
            let outcome = await pending.result
            throw SmokeFailure("\(method): no sheet; the call gave \(outcome)")
        }
        try expect(!NSApp.isActive && !sheet.isKeyWindow && !delegate.window.isKeyWindow,
                   "\(method): the sheet activated the app (active \(NSApp.isActive), sheet key \(sheet.isKeyWindow), "
                   + "window key \(delegate.window.isKeyWindow), frontmost \(NSWorkspace.shared.frontmostApplication?.bundleIdentifier ?? "?"))")
        let shown = views(sheet.contentView!).compactMap { ($0 as? NSTextField)?.stringValue }
        try expect(shown.contains(title), "\(method): sheet title, saw \(shown)")
        try expect(shown.contains { $0.contains("Status: \(expectedStatus).") && $0.hasSuffix("\nServer: Smoke 2 (\(serverHost))") },
                   "\(method): sheet body should show Status: \(expectedStatus). and the server, saw \(shown)")
        let confirm = try button(confirmTitle, in: sheet)
        let cancel = try button("Cancel", in: sheet)
        // Recent AppKit moves Return from the button to the sheet's default button cell when presenting.
        func isDefault(_ button: NSButton) -> Bool { button.keyEquivalent == "\r" || sheet.defaultButtonCell === button.cell }
        let keys = "confirm \(confirm.keyEquivalent.debugDescription) default \(isDefault(confirm)), "
            + "cancel \(cancel.keyEquivalent.debugDescription) default \(isDefault(cancel))"
        if destructive {
            try expect(isDefault(cancel) && !isDefault(confirm) && confirm.keyEquivalent.isEmpty, "\(method): Cancel must be the default; \(keys)")
            if #available(macOS 11.0, *) { try expect(confirm.hasDestructiveAction, "\(method): \(confirmTitle) is not destructive") }
        } else {
            try expect(isDefault(confirm) && !isDefault(cancel) && cancel.keyEquivalent == "\u{1b}", "\(method): Return confirms, Esc cancels; \(keys)")
        }
        switch answer {
        case .accept: confirm.performClick(nil)
        case .cancel: cancel.performClick(nil)
        case .escape:
            // Posted to this app's own event queue for the sheet's window: the same path a key press takes.
            guard let event = NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime,
                                               windowNumber: sheet.windowNumber, context: nil, characters: "\u{1b}",
                                               charactersIgnoringModifiers: "\u{1b}", isARepeat: false, keyCode: 53) else {
                throw SmokeFailure("could not make an Esc event")
            }
            NSApp.postEvent(event, atStart: false)
        }
        let result = try object(try JSONSerialization.jsonObject(with: try await pending.value, options: [.fragmentsAllowed]), method)
        try await waitForNoSheet()
        return result
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
        for name in ["api.post", "api.delete", "api.put", "api.request", "api.fetch", "messages.interrupt", "agents.terminal", "agents.start"] {
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
        let badCheck = try await rejection("agents.stop", ["connection": badID, "agent": "keeper-log"])
        try expect(badCheck == "Couldn't check the agent (HTTP 401)" && delegate.window.attachedSheet == nil, "pre-check with wrong token: \(badCheck)")
        _ = try await call("connections.remove", ["id": badID])
        try expect(!delegate.store.hasToken(badID) && delegate.bridge.streams[badID] == nil, "bad connection cleanup")
        print("PASS wrong token: events.state closed with an Unauthorized error; api.get, messages.send and messages.cancel resolve 401; "
              + "a confirmed write's pre-check rejects with HTTP 401 and no sheet")

        // Nothing listens on the discard port, so the send fails at the network level and must reject.
        let downSaved = try object(try await call("connections.save", ["name": "Down", "url": "http://127.0.0.1:9", "token": token]), "save")
        guard let downID = downSaved["id"] as? String else { throw SmokeFailure("save returned \(downSaved)") }
        let down = try await rejection("messages.send", ["connection": downID, "agent": "keeper-log", "text": "Smoke offline", "mode": "now"])
        _ = try await call("connections.remove", ["id": downID])
        try expect(!down.isEmpty && !delegate.store.hasToken(downID), "network failure message: \(down)")
        print("PASS messages.send to an unreachable server rejects (\(down))")

        try await writeSurface(id)

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

    // MARK: Write surface

    /// Every write method against the fixture: rejections send nothing, confirmed methods ask
    /// natively (cancel sends nothing), and the fixture's log ends up exactly as expected.
    func writeSurface(_ id: String) async throws {
        try await resetFixture()
        let start = try await fixtureRequests().count
        var expected: [[String: Any]] = []
        func record(_ method: String, _ path: String, _ body: Any = [String: Any]()) {
            expected.append(["method": method, "path": path, "body": body])
        }
        let oversized = Data(count: (10 << 20) + 1).base64EncodedString()
        let png = Data([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 0x0D, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0,
                         0x1F, 0x15, 0xC4, 0x89])
        let jpeg = Data([0xFF, 0xD8, 0xFF, 0xE0, 0, 0x10, 0x4A, 0x46, 0x49, 0x46])
        let stranger = UUID().uuidString.lowercased()
        let rejections: [(String, [String: Any], String)] = [
            ("agents.kill", ["agent": "keeper-log"], "unknown method: agents.kill"),
            ("agents.stop", ["connection": stranger, "agent": "keeper-log"], "unknown connection: \(stranger)"),
            ("agents.resume", ["agent": "../x"], "invalid agent: ../x"),
            ("agents.stop", ["agent": "a:b:c"], "invalid agent: a:b:c"),
            ("agents.remove", ["agent": "a..b:x"], "invalid agent: a..b:x"),
            ("agents.rename", ["agent": "crease-check", "name": "concierge"], "invalid name: concierge"),
            ("agents.rename", ["agent": "crease-check", "name": "a/b"], "invalid name: a/b"),
            ("agents.move", ["agent": "ebb-report", "host": "a..b"], "invalid host: a..b"),
            ("agents.move", ["agent": "ebb-report", "host": "annex", "dir": "~/tide"], "invalid directory"),
            ("agents.model", ["agent": "fold-line", "createdAt": "c", "status": "idle"], "invalid model"),
            ("agents.model", ["agent": "fold-line", "model": NSNull(), "createdAt": "c", "status": "exited"], "invalid status"),
            ("agents.model", ["agent": "fold-line", "model": "-x", "createdAt": "c", "status": "idle"], "invalid model"),
            ("agents.handoff", ["agent": "harbor-lights", "to": "antigravity"], "invalid to"),
            ("agents.handoff", ["agent": "harbor-lights", "to": "codex", "full": 1], "invalid full"),
            ("agents.handoff", ["agent": "harbor-lights", "to": "codex", "newName": "concierge"], "invalid name: concierge"),
            ("agents.create", ["name": "concierge", "task": "t", "provider": "claude"], "invalid name: concierge"),
            ("agents.create", ["name": "smoke-x", "task": "Esc \u{1b} here", "provider": "claude"], "invalid task"),
            ("agents.create", ["name": "smoke-x", "task": String(repeating: "t", count: 100_001), "provider": "claude"], "invalid task"),
            ("agents.create", ["name": "smoke-x", "task": "t", "provider": "gemini"], "invalid provider"),
            ("agents.create", ["name": "smoke-x", "task": "t", "provider": "codex", "host": "annex", "dir": "~/x"], "invalid directory"),
            ("agents.create", ["name": "smoke-x", "task": "t", "provider": "codex", "role": "concierge"], "invalid role"),
            ("permissions.answer", ["agent": "fog-signal", "id": "../x", "optionId": "accept"], "invalid id"),
            ("permissions.answer", ["agent": "fog-signal", "id": "01JZ6R7FQ3M9V2K8T4N5P0XWAB", "optionId": "a b"], "invalid optionId"),
            ("prompt.answer", ["agent": "origami-docs", "id": "5f0c2e9a7d4b4c1e8a6f3d2b1c0e9f87", "optionId": "0"], "invalid optionId"),
            ("prompt.answer", ["agent": "origami-docs", "id": "5f0c2e9a7d4b4c1e8a6f3d2b1c0e9f87", "optionId": "4", "text": "two\nlines"], "invalid text"),
            ("files.upload", ["agent": "keeper-log", "type": "image/svg+xml", "data": png.base64EncodedString()], "invalid type"),
            ("files.upload", ["agent": "keeper-log", "type": "image/png", "data": "!!!!"], "invalid data"),
            ("files.upload", ["agent": "keeper-log", "type": "image/png", "data": oversized], "invalid data"),
            ("files.upload", ["agent": "keeper-log", "type": "image/png", "data": jpeg.base64EncodedString()], "File is not a valid image/png image"),
            ("search.query", ["query": " a "], "invalid query"),
            ("search.query", ["query": "bell\u{7}"], "invalid query"),
        ]
        for (method, params, message) in rejections {
            var params = params
            if params["connection"] == nil { params["connection"] = id }
            let actual = try await rejection(method, params)
            try expect(actual == message, "\(method): expected \"\(message)\", got \"\(actual.prefix(200))\"")
        }
        // A key whose value is JavaScript `undefined` must count as absent (not null) on the way in.
        let undefinedModel = try await js("""
            try {
              await window.webkit.messageHandlers.am.postMessage({method: 'agents.model', params: {connection, agent: 'fold-line',
                model: undefined, createdAt: 'c', status: 'bad'}});
              return 'resolved';
            } catch (error) { return String(error && error.message || error); }
            """, ["connection": id]) as? String
        try expect(undefinedModel == "invalid model", "model: undefined was not treated as absent: \(undefinedModel ?? "?")")
        let missing = try await rejection("agents.stop", ["connection": id, "agent": "no-such-agent"])
        try expect(missing == "This agent no longer exists" && delegate.window.attachedSheet == nil, "pre-check 404: \(missing)")
        try expect(try await fixtureRequests().count == start, "a rejected write reached the fixture")
        print("PASS write rejections (\(rejections.count) vectors: agents, names, concierge, enums, oversized, control characters, upload "
              + "type/data/magic, undefined = absent); pre-check 404 rejects without a sheet; nothing reached the fixture")

        // Each confirmed method: Cancel (or Esc) sends nothing, then accepting sends exactly one request.
        let restartStatus = try await agentStatus(id, "keeper-log")
        var outcome = try await confirmed("agents.restart", ["connection": id, "agent": "keeper-log"], title: "Restart keeper-log?",
                                          agentStatus: restartStatus, button: "Restart", answer: .cancel)
        try expect(outcome["cancelled"] as? Bool == true && outcome.count == 1, "cancelled restart: \(outcome)")
        try expect(try await fixtureRequests().count == start, "a cancelled restart reached the fixture")
        outcome = try await confirmed("agents.restart", ["connection": id, "agent": "keeper-log"], title: "Restart keeper-log?",
                                      agentStatus: restartStatus, button: "Restart", answer: .accept)
        try expect(outcome["status"] as? Int == 200, "restart: \(outcome)")
        record("POST", "/api/agents/keeper-log/restart")

        let interruptStatus = try await agentStatus(id, "harbor-lights")
        outcome = try await confirmed("agents.interrupt", ["connection": id, "agent": "harbor-lights"], title: "Interrupt harbor-lights?",
                                      agentStatus: interruptStatus, button: "Interrupt", answer: .escape)
        try expect(outcome["cancelled"] as? Bool == true, "Esc on interrupt: \(outcome)")
        outcome = try await confirmed("agents.interrupt", ["connection": id, "agent": "harbor-lights", "text": "smuggled"],
                                      title: "Interrupt harbor-lights?", agentStatus: interruptStatus, button: "Interrupt", answer: .accept)
        try expect(outcome["status"] as? Int == 200, "interrupt: \(outcome)")
        record("POST", "/api/agents/harbor-lights/interrupt")

        // While one sheet is open, a second confirmed call rejects instead of queueing behind it.
        let stopStatus = try await agentStatus(id, "tide-pilot")
        let overlap = Task { @MainActor () throws -> String in
            _ = try await self.waitForSheet()
            let second = try await self.rejection("agents.restart", ["connection": id, "agent": "keeper-log"])
            try self.button("Cancel", in: try await self.waitForSheet()).performClick(nil)
            return second
        }
        outcome = try object(try await call("agents.stop", ["connection": id, "agent": "tide-pilot"]), "agents.stop")
        let second = try await overlap.value
        try expect(second == "another confirmation is open" && outcome["cancelled"] as? Bool == true,
                   "concurrent confirms: second gave \(second), first gave \(outcome)")
        outcome = try await confirmed("agents.stop", ["connection": id, "agent": "tide-pilot"], title: "Stop tide-pilot?",
                                      agentStatus: stopStatus, button: "Stop", answer: .accept)
        try expect(outcome["status"] as? Int == 200, "stop: \(outcome)")
        record("POST", "/api/agents/tide-pilot/stop")

        let removeStatus = try await agentStatus(id, "errand-runner")
        outcome = try await confirmed("agents.remove", ["connection": id, "agent": "errand-runner"], title: "Remove errand-runner?",
                                      agentStatus: removeStatus, button: "Remove", destructive: true, answer: .escape)
        try expect(outcome["cancelled"] as? Bool == true, "Esc on remove: \(outcome)")
        outcome = try await confirmed("agents.remove", ["connection": id, "agent": "errand-runner"], title: "Remove errand-runner?",
                                      agentStatus: removeStatus, button: "Remove", destructive: true, answer: .accept)
        try expect(outcome["status"] as? Int == 200, "remove: \(outcome)")
        record("DELETE", "/api/agents/errand-runner", NSNull())
        let gone = try await rejection("agents.remove", ["connection": id, "agent": "errand-runner"])
        try expect(gone == "This agent no longer exists" && delegate.window.attachedSheet == nil, "second remove: \(gone)")

        let moveStatus = try await agentStatus(id, "ebb-report")
        let moveParams: [String: Any] = ["connection": id, "agent": "ebb-report", "host": "annex", "dir": "/srv/tide-tables"]
        outcome = try await confirmed("agents.move", moveParams, title: "Move ebb-report to annex?", agentStatus: moveStatus, button: "Move",
                                      answer: .cancel)
        try expect(outcome["cancelled"] as? Bool == true, "cancelled move: \(outcome)")
        outcome = try await confirmed("agents.move", moveParams, title: "Move ebb-report to annex?", agentStatus: moveStatus, button: "Move",
                                      answer: .accept)
        try expect(outcome["status"] as? Int == 200, "move: \(outcome)")
        record("POST", "/api/agents/ebb-report/move", ["host": "annex", "dir": "/srv/tide-tables"])

        let (detailCode, fold) = try status(try await call("api.get", ["connection": id, "path": "/api/agents/fold-line"]), "detail")
        guard detailCode == 200, let createdAt = fold["createdAt"] as? String, let foldStatus = fold["status"] as? String else {
            throw SmokeFailure("fold-line detail: \(detailCode) \(fold)")
        }
        let modelParams: [String: Any] = ["connection": id, "agent": "fold-line", "model": NSNull(), "createdAt": createdAt, "status": foldStatus]
        outcome = try await confirmed("agents.model", modelParams, title: "Change the model for fold-line?", agentStatus: foldStatus,
                                      button: "Change model", answer: .cancel)
        try expect(outcome["cancelled"] as? Bool == true, "cancelled model change: \(outcome)")
        try expect(try await fixtureRequests().count == start + expected.count, "a cancelled confirmation reached the fixture")
        outcome = try await confirmed("agents.model", modelParams, title: "Change the model for fold-line?", agentStatus: foldStatus,
                                      button: "Change model", answer: .accept)
        try expect(outcome["status"] as? Int == 200, "model: \(outcome)")
        record("POST", "/api/agents/fold-line/model", ["model": NSNull(), "createdAt": createdAt, "status": foldStatus])
        print("PASS confirmed writes (restart, interrupt, stop, remove, move, model): native sheet with title, status and server, "
              + "Cancel/Esc -> {cancelled: true} with nothing sent, accept -> one request; second concurrent confirm rejected; "
              + "removed agent -> \"This agent no longer exists\" without a sheet; the app never activated")

        func accepted(_ method: String, _ params: [String: Any], _ statuses: ClosedRange<Int> = 200...299) async throws -> [String: Any] {
            var params = params
            params["connection"] = id
            let (code, body) = try status(try await call(method, params), method)
            try expect(statuses.contains(code), "\(method): \(code) \(body)")
            return body
        }
        _ = try await accepted("agents.resume", ["agent": "old-lens"])
        record("POST", "/api/agents/old-lens/resume")
        _ = try await accepted("agents.rename", ["agent": "crease-check", "name": "crease-fold"])
        record("POST", "/api/agents/crease-check/rename", ["name": "crease-fold"])
        _ = try await accepted("agents.handoff", ["agent": "harbor-lights", "to": "codex", "full": true], 201...201)
        record("POST", "/api/agents/harbor-lights/handoff", ["to": "codex", "full": true])
        _ = try await accepted("agents.create", ["name": "smoke-new", "task": "  Chart the tide tables.\n", "provider": "claude",
                                                 "dir": "~/code/lighthouse", "host": "local"], 201...201)
        record("POST", "/api/agents", ["name": "smoke-new", "task": "Chart the tide tables.", "provider": "claude", "dir": "~/code/lighthouse"])
        _ = try await accepted("agents.create", ["name": "smoke-annex", "task": "Check the buoys.", "provider": "codex", "host": "annex",
                                                 "dir": "/srv/lighthouse", "effort": "low"], 201...201)
        record("POST", "/api/agents", ["name": "smoke-annex", "task": "Check the buoys.", "provider": "codex", "host": "annex",
                                       "remoteDir": "/srv/lighthouse", "effort": "low"])
        let (permCode, permissions) = try status(try await call("api.get", ["connection": id, "path": "/api/agents/fog-signal/permissions"]), "permissions")
        guard permCode == 200, let pending = (permissions["requests"] as? [[String: Any]])?.first, let permissionID = pending["id"] as? String,
              let option = (pending["options"] as? [[String: Any]])?.first(where: { $0["kind"] as? String == "allow" })?["id"] as? String else {
            throw SmokeFailure("fog-signal permissions: \(permCode) \(permissions)")
        }
        _ = try await accepted("permissions.answer", ["agent": "fog-signal", "id": permissionID, "optionId": option])
        record("POST", "/api/agents/fog-signal/permissions/\(permissionID)", ["optionId": option])
        let (promptCode, origami) = try status(try await call("api.get", ["connection": id, "path": "/api/agents/origami-docs"]), "detail")
        guard promptCode == 200, let promptID = (origami["panePrompt"] as? [String: Any])?["id"] as? String else {
            throw SmokeFailure("origami-docs has no panePrompt: \(promptCode)")
        }
        _ = try await accepted("prompt.answer", ["agent": "origami-docs", "id": promptID, "optionId": "1"])
        record("POST", "/api/agents/origami-docs/prompt", ["id": promptID, "optionId": "1"])
        let uploaded = try await accepted("files.upload", ["agent": "keeper-log", "type": "image/png", "data": png.base64EncodedString()], 201...201)
        try expect((uploaded["path"] as? String)?.hasSuffix(".png") == true, "upload path: \(uploaded)")
        record("POST", "/api/agents/keeper-log/files", ["contentType": "image/png", "bytes": png.count])
        let concierge = try await accepted("concierge.ensure", [:])
        try expect(concierge["key"] as? String == "concierge", "concierge.ensure: \(concierge)")
        record("POST", "/api/concierge")
        let found = try await accepted("search.query", ["query": "  harbor "])
        try expect(found["matches"] is [Any] && found["partial"] is Bool, "search: \(found)")
        record("POST", "/api/search", ["query": "harbor"])
        print("PASS writes without confirmation (resume, rename, handoff 201, create local and remote 201, permission answer, "
              + "prompt answer, image upload 201, concierge, search)")

        let made = Array(try await fixtureRequests().dropFirst(start))
        let seen = made.map { entry -> String in
            var body = entry["body"] ?? NSNull()
            // An upload is logged as its content type and size; any other fields the fixture adds are not compared.
            if let upload = body as? [String: Any], upload["contentType"] != nil { body = ["contentType": upload["contentType"] ?? "", "bytes": upload["bytes"] ?? -1] }
            return canonical(["method": entry["method"] ?? "", "path": entry["path"] ?? "", "body": body])
        }
        let wanted = expected.map(canonical)
        try expect(seen == wanted, "fixture log differs from what the smoke sent:\n  saw    \(seen)\n  wanted \(wanted)")
        print("PASS fixture saw exactly the \(wanted.count) writes sent, with exactly the expected bodies")
        try await resetFixture()
    }
}
