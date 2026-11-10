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
            try? await Task.sleep(nanoseconds: 120_000_000_000)
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
        _ = try await call("connections.remove", ["id": badID])
        try expect(!delegate.store.hasToken(badID) && delegate.bridge.streams[badID] == nil, "bad connection cleanup")
        print("PASS wrong token: events.state closed with an Unauthorized error, api.get resolves 401")

        if bridgeOnly {
            print("SKIP sidebar rows [data-agent-key] (SMOKE_BRIDGE_ONLY=1)")
            print("SKIP open harbor-lights and render #transcript .turn (SMOKE_BRIDGE_ONLY=1)")
        } else {
            delegate.loadHome()
            try await waitFor("document.body && document.body.dataset.ready === 'true' && document.body.dataset.view === 'fleet'",
                              "fleet view after reload")
            try await waitFor("document.querySelectorAll('[data-agent-key]').length > 0", "sidebar rows [data-agent-key]")
            let rows = try await js("return document.querySelectorAll('[data-agent-key]').length;") as? Int ?? 0
            print("PASS sidebar shows \(rows) agent rows")
            let clicked = try await js("""
                const row = [...document.querySelectorAll('[data-agent-key]')]
                  .find((r) => r.dataset.agentKey.endsWith('/harbor-lights') || r.dataset.agentKey.endsWith(':harbor-lights'));
                if (!row) return false;
                row.click();
                return true;
                """) as? Bool ?? false
            try expect(clicked, "no row ending in harbor-lights")
            try await waitFor("document.querySelectorAll('#transcript .turn').length > 0", "#transcript .turn")
            let turns = try await js("return document.querySelectorAll('#transcript .turn').length;") as? Int ?? 0
            print("PASS harbor-lights transcript rendered \(turns) turns")
            try await Task.sleep(nanoseconds: 500_000_000)
        }

        let image = try await web.takeSnapshot(configuration: nil)
        guard let tiff = image.tiffRepresentation, let png = NSBitmapImageRep(data: tiff)?.representation(using: .png, properties: [:]) else {
            throw SmokeFailure("snapshot could not be encoded")
        }
        let screenshot = FileManager.default.temporaryDirectory.appendingPathComponent("am-macos-smoke.png")
        try png.write(to: screenshot)
        print("SCREENSHOT \(screenshot.path)")

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
