import AppKit
import WebKit

// Terminal checks for the smoke test, against the fixture's /auth/login, terminal preflight and
// WebSocket (its fake shell). They drive the real consent sheet by clicking it, never activating the app.
extension SmokeRunner {
    static let terminalConnectionName = "Smoke Terminal"
    static let consentCheckbox = "Don't ask again for this server"

    // MARK: Fixture log

    enum TerminalEntry: Equatable {
        case login, preflight, upgrade, input(String), resize(Int, Int), other
    }

    func classify(_ entry: [String: Any]) -> TerminalEntry {
        let path = entry["path"] as? String ?? ""
        let method = (entry["method"] as? String ?? "").uppercased()
        if path == "/auth/login" { return .login }
        guard path.hasSuffix("/terminal") || entry["terminal"] != nil else { return .other }
        let body = (entry["body"] as? [String: Any]) ?? (entry["message"] as? [String: Any])
        switch body?["type"] as? String {
        case "input": return .input(body?["data"] as? String ?? "")
        case "resize": return .resize(body?["cols"] as? Int ?? -1, body?["rows"] as? Int ?? -1)
        default: break
        }
        let kind = (entry["kind"] as? String ?? "").lowercased()
        if method == "UPGRADE" || method == "WS" && body == nil || entry["upgrade"] as? Bool == true || kind == "upgrade" { return .upgrade }
        if method == "GET" || kind == "preflight" { return .preflight }
        return .other
    }

    func terminalLog(since start: Int) async throws -> [TerminalEntry] {
        Array(try await fixtureRequests().dropFirst(start)).map(classify).filter { $0 != .other }
    }

    func count(_ entries: [TerminalEntry], _ kind: TerminalEntry) -> Int {
        entries.filter { $0 == kind }.count
    }

    func fixturePost(_ path: String) async throws -> Int {
        guard let url = URL(string: server + path) else { throw SmokeFailure("bad fixture URL") }
        var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalAndRemoteCacheData, timeoutInterval: 10)
        request.httpMethod = "POST"
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        let (_, response) = try await URLSession.shared.data(for: request)
        return (response as? HTTPURLResponse)?.statusCode ?? 0
    }

    // MARK: Page-side views of the events

    func terminalEvents(_ id: String) async throws -> [String] {
        try await js("return window.__smokeEvents.filter((e) => e.name.startsWith('terminal.') && e.payload.id === id).map((e) => e.name);",
                     ["id": id]) as? [String] ?? []
    }

    func closedEvents(_ id: String) async throws -> [[String: Any]] {
        try await js("return window.__smokeEvents.filter((e) => e.name === 'terminal.closed' && e.payload.id === id).map((e) => e.payload);",
                     ["id": id]) as? [[String: Any]] ?? []
    }

    func waitForOutput(_ id: String, matching pattern: String, _ what: String, seconds: Double = 10) async throws {
        try await waitFor("""
            new RegExp(pattern).test(window.__smokeEvents.filter((e) => e.name === 'terminal.output' && e.payload.id === id)
              .map((e) => atob(e.payload.data)).join(''))
            """, what, ["id": id, "pattern": pattern], seconds: seconds)
    }

    func waitForClosed(_ id: String, seconds: Double = 10) async throws -> [String: Any] {
        try await waitFor("window.__smokeEvents.some((e) => e.name === 'terminal.closed' && e.payload.id === id)",
                          "terminal.closed for \(id)", ["id": id], seconds: seconds)
        let closed = try await closedEvents(id)
        try expect(closed.count == 1, "terminal.closed for \(id) arrived \(closed.count) times: \(closed)")
        return closed[0]
    }

    func outcome(_ method: String, _ params: [String: Any]) async throws -> (result: [String: Any]?, error: String?) {
        let value = try await js("""
            try { return { result: await window.webkit.messageHandlers.am.postMessage({method, params}) }; }
            catch (error) { return { error: String(error && error.message || error) }; }
            """, ["method": method, "params": params])
        let object = try self.object(value, method)
        record(object)
        return (object["result"] as? [String: Any], object["error"] as? String)
    }

    /// Opens a terminal that must not ask (consent already given in this run or remembered).
    func openTerminal(_ connection: String, _ agent: String = "keeper-log") async throws -> (id: String, transport: String) {
        let call = Task { @MainActor () throws -> Data in
            let (result, error) = try await self.outcome("terminal.open", ["connection": connection, "agent": agent])
            return try JSONSerialization.data(withJSONObject: ["result": result.map { $0 as Any } ?? NSNull(), "error": error.map { $0 as Any } ?? NSNull()])
        }
        // Watches for a sheet while the call is pending: none may appear.
        let watch = Task { @MainActor () -> Bool in
            while !Task.isCancelled {
                if self.delegate.window.attachedSheet != nil { return true }
                try? await Task.sleep(nanoseconds: 20_000_000)
            }
            return false
        }
        let answer = try JSONSerialization.jsonObject(with: try await call.value) as? [String: Any] ?? [:]
        watch.cancel()
        try expect(!(await watch.value), "terminal.open showed the consent sheet again")
        guard let result = answer["result"] as? [String: Any], let id = result["id"] as? String,
              let transport = result["transport"] as? String else {
            throw SmokeFailure("terminal.open \(agent): \(answer)")
        }
        try expect(id.range(of: "^[a-f0-9]{32}$", options: .regularExpression) != nil && ["local", "ssh"].contains(transport),
                   "terminal.open result \(result)")
        return (id, transport)
    }

    enum ConsentAnswer { case allow, allowRemembering, cancel }

    func openWithConsent(_ connection: String, name: String, answer: ConsentAnswer) async throws -> (result: [String: Any]?, error: String?) {
        let call = Task { @MainActor () throws -> Data in
            let (result, error) = try await self.outcome("terminal.open", ["connection": connection, "agent": "keeper-log"])
            return try JSONSerialization.data(withJSONObject: ["result": result.map { $0 as Any } ?? NSNull(), "error": error.map { $0 as Any } ?? NSNull()])
        }
        let sheet: NSWindow
        do {
            sheet = try await waitForSheet()
        } catch {
            throw SmokeFailure("terminal.open: no consent sheet; the call gave \(await call.result)")
        }
        try expect(!NSApp.isActive && !sheet.isKeyWindow && !delegate.window.isKeyWindow,
                   "terminal consent: the sheet activated the app (frontmost \(NSWorkspace.shared.frontmostApplication?.bundleIdentifier ?? "?"))")
        let shown = views(sheet.contentView!).compactMap { ($0 as? NSTextField)?.stringValue }
        try expect(shown.contains("Open interactive terminals on \(name)?"), "consent title, saw \(shown)")
        try expect(shown.contains("Keys you type in a terminal go straight to the agent's terminal on \(serverHost), including Ctrl-C and shell commands."),
                   "consent body, saw \(shown)")
        let allow = try button("Allow", in: sheet)
        let cancel = try button("Cancel", in: sheet)
        let checkbox = try button(Self.consentCheckbox, in: sheet)
        func isDefault(_ button: NSButton) -> Bool { button.keyEquivalent == "\r" || sheet.defaultButtonCell === button.cell }
        try expect(isDefault(allow) && !isDefault(cancel) && cancel.keyEquivalent == "\u{1b}" && checkbox.state == .off,
                   "consent buttons: Allow default, Esc cancels, checkbox off")
        switch answer {
        case .allow: allow.performClick(nil)
        case .allowRemembering:
            checkbox.performClick(nil)
            try expect(checkbox.state == .on, "the checkbox did not turn on")
            allow.performClick(nil)
        case .cancel: cancel.performClick(nil)
        }
        let answered = try JSONSerialization.jsonObject(with: try await call.value) as? [String: Any] ?? [:]
        try await waitForNoSheet()
        try expect(!NSApp.isActive, "the consent sheet activated the app")
        return (answered["result"] as? [String: Any], answered["error"] as? String)
    }

    // MARK: Bridge-level steps

    func terminalBridge() async throws {
        let saved = try object(try await call("connections.save", ["name": Self.terminalConnectionName, "url": server, "token": token]), "save")
        guard let id = saved["id"] as? String else { throw SmokeFailure("save returned \(saved)") }
        terminalConnectionID = id
        let consent = delegate.bridge.terminals.consent

        // Rejections before any sheet or request.
        var start = try await fixtureRequests().count
        let stranger = UUID().uuidString.lowercased()
        let unknownID = String(repeating: "ab", count: 16)
        let vectors: [(String, [String: Any], String)] = [
            ("terminal.open", ["connection": id, "agent": "../x"], "invalid agent: ../x"),
            ("terminal.open", ["connection": id, "agent": "a:b:c"], "invalid agent: a:b:c"),
            ("terminal.open", ["connection": stranger, "agent": "keeper-log"], "unknown connection: \(stranger)"),
            ("terminal.input", ["id": "nope", "data": "x"], "unknown terminal"),
            ("terminal.input", ["id": unknownID, "data": "x"], "unknown terminal"),
            ("terminal.resize", ["id": unknownID, "cols": 80, "rows": 24], "unknown terminal"),
            ("terminal.send", ["id": unknownID, "data": "x"], "unknown method: terminal.send"),
            ("terminal.connect", ["connection": id, "url": server + "/api/agents/keeper-log/terminal"], "unknown method: terminal.connect"),
        ]
        for (method, params, message) in vectors {
            let actual = try await rejection(method, params)
            try expect(actual == message, "\(method): expected \"\(message)\", got \"\(actual)\"")
        }
        try expect(try object(try await call("terminal.close", ["id": unknownID]), "close").isEmpty, "close of an unknown id")
        let api = try await rejection("api.get", ["connection": id, "path": "/auth/login"])
        try expect(api == "The path must start with /api/", "api.get /auth/login: \(api)")
        let tailnet = try object(try await call("connections.save", ["name": "Tailnet", "url": "http://100.64.0.1:9", "token": token]), "save")
        guard let tailnetID = tailnet["id"] as? String else { throw SmokeFailure("save returned \(tailnet)") }
        let plain = try await rejection("terminal.open", ["connection": tailnetID, "agent": "keeper-log"])
        _ = try await call("connections.remove", ["id": tailnetID])
        try expect(plain == "Terminals need an https connection", "plain http: \(plain)")
        let reached = try await fixtureRequests().count
        try expect(delegate.window.attachedSheet == nil && reached == start, "a rejected terminal call asked or reached the fixture")
        print("PASS terminal rejections (\(vectors.count) vectors, unknown close is a no-op, api.get cannot reach /auth/login, "
              + "plain http to a Tailscale address refused) without a sheet or a request")

        // Wrong token: the sheet first, then the login is refused. "Don't ask again" is cleared by a URL change.
        let bad = try object(try await call("connections.save", ["name": "Smoke Bad Terminal", "url": server, "token": "wrong-\(UUID().uuidString)"]), "save")
        guard let badID = bad["id"] as? String else { throw SmokeFailure("save returned \(bad)") }
        start = try await fixtureRequests().count
        let wrong = try await openWithConsent(badID, name: "Smoke Bad Terminal", answer: .allowRemembering)
        try expect(wrong.error == "The server rejected the access token", "wrong token: \(wrong)")
        var log = try await terminalLog(since: start)
        try expect(log == [.login], "wrong token: fixture saw \(log)")
        try expect(consent.isRemembered(id: badID, url: server), "Don't ask again was not stored")
        let moved = server.replacingOccurrences(of: "127.0.0.1", with: "localhost")
        _ = try await call("connections.save", ["id": badID, "name": "Smoke Bad Terminal", "url": moved, "token": token])
        try expect(!consent.isRemembered(id: badID, url: server) && !consent.isRemembered(id: badID, url: moved)
                   && (UserDefaults.standard.dictionary(forKey: TerminalConsent.defaultsKey)?[badID] == nil), "a URL change kept the consent")
        _ = try await call("connections.remove", ["id": badID])
        print("PASS wrong token: consent sheet, then \"The server rejected the access token\" after one login; a URL change cleared \"Don't ask again\"")

        // Cancel sends nothing; Allow (remembering) logs in, preflights and upgrades exactly once.
        start = try await fixtureRequests().count
        let cancelled = try await openWithConsent(id, name: Self.terminalConnectionName, answer: .cancel)
        try expect(cancelled.result.map { $0.count == 1 && $0["cancelled"] as? Bool == true } == true, "cancelled consent: \(cancelled)")
        try expect(try await terminalLog(since: start).isEmpty, "a cancelled consent reached the fixture")
        let allowed = try await openWithConsent(id, name: Self.terminalConnectionName, answer: .allowRemembering)
        guard let first = allowed.result?["id"] as? String, let transport = allowed.result?["transport"] as? String else {
            throw SmokeFailure("terminal.open after Allow: \(allowed)")
        }
        try expect(Set(allowed.result?.keys.map { $0 } ?? []) == ["id", "transport"], "open result keys: \(allowed)")
        log = try await terminalLog(since: start)
        try expect(log == [.login, .preflight, .upgrade], "first open: fixture saw \(log)")
        try expect(consent.isRemembered(id: id, url: server), "Don't ask again not stored for \(id)")
        print("PASS consent sheet: Cancel -> {cancelled: true} with nothing sent; Allow -> {id, transport: \(transport)} after exactly one "
              + "login, preflight and upgrade; the app never activated")

        // Typing, resizing, the shell's answers, and the order of frames.
        try await waitFor("window.__smokeEvents.some((e) => e.name === 'terminal.control' && e.payload.id === id && e.payload.message.type === 'ready')",
                          "terminal.control ready", ["id": first])
        let typing = try await fixtureRequests().count
        _ = try await call("terminal.input", ["id": first, "data": "echo hi"])
        _ = try await call("terminal.input", ["id": first, "data": "\r"])
        try await waitForOutput(first, matching: "\\r?\\nhi\\r?\\n", "the echo of hi")
        _ = try await call("terminal.resize", ["id": first, "cols": 100, "rows": 30])
        _ = try await call("terminal.input", ["id": first, "data": "size\r"])
        try await waitForOutput(first, matching: "\\n30 100\\r?\\n", "size printing 30 100")
        log = try await terminalLog(since: typing)
        try expect(log == [.input("echo hi"), .input("\r"), .resize(100, 30), .input("size\r")], "typing: fixture saw \(log)")
        let invalid: [([String: Any], String)] = [
            (["data": ""], "invalid data"), (["data": String(repeating: "x", count: 16385)], "invalid data"), (["data": 7], "invalid data"),
        ]
        for (params, message) in invalid {
            var params = params
            params["id"] = first
            let actual = try await rejection("terminal.input", params)
            try expect(actual == message, "terminal.input \(params["data"].map { "\($0)".prefix(10) } ?? ""): \(actual)")
        }
        for (cols, rows, message) in [(1, 24, "invalid cols"), (501, 24, "invalid cols"), (80, 201, "invalid rows"), (2.5, 24, "invalid cols"),
                                      ("80", 24, "invalid cols"), (true, 24, "invalid cols")] as [(Any, Any, String)] {
            let actual = try await rejection("terminal.resize", ["id": first, "cols": cols, "rows": rows])
            try expect(actual == message, "terminal.resize \(cols)x\(rows): \(actual)")
        }
        _ = try await call("terminal.input", ["id": first, "data": String(repeating: "é", count: 8192)])
        _ = try await call("terminal.input", ["id": first, "data": "\u{3}"])
        try await waitForOutput(first, matching: "\\^C\\r?\\n", "^C after Ctrl-C")
        log = try await terminalLog(since: typing)
        try expect(log.count == 6 && log[4] == .input(String(repeating: "é", count: 8192)) && log[5] == .input("\u{3}"),
                   "rejected input reached the fixture, or 16 KiB input was changed: \(log.count) entries")
        print("PASS terminal.input echo hi + Enter -> output line \"hi\"; resize 100x30 seen by the fixture and printed by size; "
              + "Ctrl-C and 16 KiB of UTF-8 forwarded unchanged and in order; invalid input/resize rejected without sending")

        // More terminals on the same connection: no sheet, no login. The fifth is refused.
        start = try await fixtureRequests().count
        var open = [first]
        for _ in 0..<3 { open.append(try await openTerminal(id).id) }
        log = try await terminalLog(since: start)
        try expect(log == [.preflight, .upgrade, .preflight, .upgrade, .preflight, .upgrade], "more terminals: fixture saw \(log)")
        try expect(delegate.bridge.terminals.openTerminals == 4, "open terminals: \(delegate.bridge.terminals.openTerminals)")
        let fifth = try await rejection("terminal.open", ["connection": id, "agent": "keeper-log"])
        let afterFifth = try await terminalLog(since: start)
        try expect(fifth == "Too many terminals open" && afterFifth.count == 6, "fifth terminal: \(fifth)")
        print("PASS terminals 2-4 on the same connection opened without a sheet or a login; a fifth -> \"Too many terminals open\"")

        // terminal.close: closed exactly once, then the id is dead.
        let closing = open.removeLast()
        _ = try await call("terminal.close", ["id": closing])
        let closedEvent = try await waitForClosed(closing)
        try expect(closedEvent["code"] as? Int == 1000, "close code: \(closedEvent)")
        _ = try await call("terminal.close", ["id": closing])
        let dead = try await rejection("terminal.input", ["id": closing, "data": "x"])
        try await Task.sleep(nanoseconds: 400_000_000)
        let after = try await terminalEvents(closing)
        try expect(dead == "unknown terminal" && after.last == "terminal.closed" && after.filter({ $0 == "terminal.closed" }).count == 1,
                   "after close: \(dead), events \(after)")
        print("PASS terminal.close -> terminal.closed once (1000); closing again is a no-op; the id is dead afterwards")

        // Fixture-forced 4001: every terminal closes once with 4001, the shell does not reconnect, the next open logs in once.
        start = try await fixtureRequests().count
        try expect(try await fixturePost("/__fixture/terminal/expire") == 200, "expire hook")
        for terminal in open {
            let event = try await waitForClosed(terminal)
            try expect(event["code"] as? Int == 4001, "expired terminal: \(event)")
        }
        try await Task.sleep(nanoseconds: 1_500_000_000)
        log = try await terminalLog(since: start)
        try expect(log.isEmpty && delegate.bridge.terminals.openTerminals == 0, "the shell reconnected after 4001: \(log)")
        for terminal in open { try expect(try await closedEvents(terminal).count == 1, "second terminal.closed for \(terminal)") }
        let reopened = try await openTerminal(id).id
        log = try await terminalLog(since: start)
        try expect(log == [.login, .preflight, .upgrade], "open after 4001: fixture saw \(log)")
        print("PASS fixture-forced 4001 -> terminal.closed 4001 once per terminal, no automatic reconnect; the next open logged in exactly once")

        // exit closes from the server side with a control message and 1000.
        _ = try await call("terminal.input", ["id": reopened, "data": "exit\r"])
        try await waitFor("window.__smokeEvents.some((e) => e.name === 'terminal.control' && e.payload.id === id && e.payload.message.type === 'exit')",
                          "terminal.control exit", ["id": reopened])
        let exited = try await waitForClosed(reopened)
        try expect(exited["code"] as? Int == 1000, "exit close: \(exited)")
        print("PASS exit -> terminal.control {type: exit}, then terminal.closed 1000")

        // A session the server forgot: the preflight's 401 causes exactly one re-login.
        start = try await fixtureRequests().count
        try expect(try await fixturePost("/__fixture/terminal/expire") == 200, "expire hook")
        let renewed = try await openTerminal(id).id
        log = try await terminalLog(since: start)
        try expect(log == [.preflight, .login, .preflight, .upgrade], "forgotten session: fixture saw \(log)")
        print("PASS forgotten session: preflight 401 -> one re-login -> the open succeeded")

        // The cookie never reaches the page.
        guard let cookie = delegate.bridge.terminals.sessionCookie(for: id) else { throw SmokeFailure("no session held for the connection") }
        let everything = try await js("return JSON.stringify(window.__smokeEvents) + document.cookie + JSON.stringify(localStorage) + JSON.stringify(sessionStorage);") as? String ?? ""
        try expect(!everything.isEmpty && !cookie.occurs(in: everything) && !cookie.occurs(in: transcript.joined(separator: "\n")),
                   "the session cookie appeared in an event, a result or page storage")
        let documentCookie = try await js("return document.cookie;") as? String ?? "?"
        try expect(documentCookie.isEmpty, "document.cookie: \(documentCookie)")
        print("PASS the session cookie appears in no bridge result, event or page storage (\(transcript.count) results, "
              + "\(everything.utf8.count) bytes of events scanned)")

        // A quick 8 MiB flood: delivered or closed with 1013, either way exactly one terminal.closed eventually.
        _ = try await call("terminal.close", ["id": renewed])
        _ = try await waitForClosed(renewed)
        if try await fixturePost("/__fixture/terminal/flood") == 200 {
            let flooded = try await openTerminal(id).id
            try await waitFor("""
                window.__smokeEvents.some((e) => e.name === 'terminal.closed' && e.payload.id === id)
                  || window.__smokeEvents.filter((e) => e.name === 'terminal.output' && e.payload.id === id)
                       .reduce((n, e) => n + e.payload.data.length * 3 / 4, 0) >= 8 * 1024 * 1024
                """, "the flood to arrive or the terminal to close", ["id": flooded], seconds: 30)
            let bytes = try await js("""
                return window.__smokeEvents.filter((e) => e.name === 'terminal.output' && e.payload.id === id)
                  .reduce((n, e) => n + atob(e.payload.data).length, 0);
                """, ["id": flooded]) as? Int ?? -1
            let sizes = try await js("""
                return Math.max(0, ...window.__smokeEvents.filter((e) => e.name === 'terminal.output' && e.payload.id === id)
                  .map((e) => atob(e.payload.data).length));
                """, ["id": flooded]) as? Int ?? -1
            try expect(sizes <= 65_536, "an output event carried \(sizes) bytes")
            let early = try await closedEvents(flooded)
            if early.isEmpty { _ = try await call("terminal.close", ["id": flooded]) }
            let event = try await waitForClosed(flooded)
            print("PASS flood: \(bytes) bytes delivered in events of at most \(sizes) bytes, then terminal.closed \(event["code"] ?? "?") once")
        } else {
            print("SKIP flood (the fixture has no /__fixture/terminal/flood)")
        }
        _ = try await js("window.__smokeEvents = window.__smokeEvents.filter((e) => e.name !== 'terminal.output'); return true;")

        delegate.showChat()
        delegate.showTerminal()
        try await waitFor("""
            ['chat', 'terminal'].every((c) => window.__smokeEvents.some((e) => e.name === 'menu.command' && e.payload.command === c))
            """, "menu.command chat and terminal")
        try expect(!NSApp.isActive, "the app was activated")
        print("PASS View > Show Chat / Show Terminal emit menu.command chat / terminal")
    }

    // MARK: UI steps (need the frontend's Terminal tab)

    func terminalUI() async throws {
        guard terminalConnectionID != nil else { throw SmokeFailure("no terminal connection") }
        let start = try await fixtureRequests().count
        // The UI steps reloaded the page.
        try await installRecorder()
        // Records the page's own terminal calls, for diagnostics.
        _ = try await js("""
            window.__smokeCalls = [];
            const handler = window.webkit.messageHandlers.am;
            const post = handler.postMessage.bind(handler);
            handler.postMessage = async (message) => {
              const entry = { method: message.method, at: Date.now() };
              if (String(message.method).startsWith('terminal.')) window.__smokeCalls.push(entry);
              try { const result = await post(message); entry.result = result; return result; }
              catch (error) { entry.error = String(error && error.message || error); throw error; }
            };
            return true;
            """)
        try await openAgent("keeper-log")
        try await waitFor("document.querySelector('#am-view-terminal')", "the Terminal toggle #am-view-terminal")
        _ = try await js("document.querySelector('#am-view-terminal').click(); return true;")
        try await waitFor("document.querySelector('#am-main')?.dataset.agentView === 'terminal'", "#am-main[data-agent-view=terminal]")
        // The main smoke connection has not been allowed yet, so the real consent sheet appears.
        let sheet = try await waitForSheet()
        try expect(!NSApp.isActive, "the consent sheet activated the app")
        let shown = views(sheet.contentView!).compactMap { ($0 as? NSTextField)?.stringValue }
        try expect(shown.contains { $0.hasPrefix("Open interactive terminals on ") }, "UI terminal: unexpected sheet \(shown)")
        try button("Allow", in: sheet).performClick(nil)
        try await waitForNoSheet()
        do {
            try await waitFor("(document.querySelector('#am-terminal-status')?.textContent || '').includes('Live terminal')",
                              "the Live terminal status", seconds: 15)
        } catch {
            let status = try await js("return document.querySelector('#am-terminal-status')?.textContent ?? null;") ?? "none"
            let events = try await js("return JSON.stringify(window.__smokeEvents.filter((e) => e.name.startsWith('terminal.')).slice(-8));") ?? ""
            let log = try await terminalLog(since: start)
            throw SmokeFailure("\(error); status line: \(status); events \(events); fixture \(log)")
        }
        // Typed through the real xterm: a paste into its input element goes through its onData path.
        let typed = try await js("""
            const area = document.querySelector('#am-terminal .xterm-helper-textarea');
            if (!area) return false;
            area.focus();
            const data = new DataTransfer();
            data.setData('text/plain', 'echo hi-from-xterm\\r');
            area.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
            return true;
            """) as? Bool ?? false
        try expect(typed, "no xterm input element in #am-terminal")
        // xterm draws in animation frames, which WebKit pauses for a background window, so its
        // screen may not be painted yet.
        let kept = """
            const closed = new Set(window.__smokeEvents.filter((e) => e.name === 'terminal.closed').map((e) => e.payload.id));
            const live = [...new Set(window.__smokeEvents.filter((e) => e.name === 'terminal.control').map((e) => e.payload.id))]
              .filter((id) => !closed.has(id));
            """
        do {
            try await waitFor("""
                (() => { \(kept)
                  return live.length === 1 && /\\r\\nhi-from-xterm\\r\\n/.test(window.__smokeEvents
                    .filter((e) => e.name === 'terminal.output' && e.payload.id === live[0]).map((e) => atob(e.payload.data)).join(''));
                })()
                """, "the echo of hi-from-xterm on the page's terminal", seconds: 10)
        } catch {
            let calls = try await js("return JSON.stringify(window.__smokeCalls.filter((c) => c.method !== 'terminal.resize'));") ?? ""
            let events = try await js("return JSON.stringify(window.__smokeEvents.filter((e) => e.name.startsWith('terminal.') && e.name !== 'terminal.output').slice(-10));") ?? ""
            throw SmokeFailure("\(error); calls \(calls); events \(events); fixture \(try await terminalLog(since: start))")
        }
        let painted = try await js("""
            return [...document.querySelectorAll('#am-terminal .xterm-rows > div')].some((row) => row.textContent.trim() === 'hi-from-xterm');
            """) as? Bool ?? false
        try await screenshot()
        let log = try await terminalLog(since: start)
        try expect(count(log, .login) == 1 && log.contains(.upgrade) && log.contains { if case .input(let text) = $0 { return text.contains("hi-from-xterm") } else { return false } },
                   "UI terminal: fixture saw \(log)")
        _ = try await js("document.querySelector('#am-view-chat').click(); return true;")
        try await waitFor("document.querySelector('#am-main')?.dataset.agentView === 'chat'", "#am-main[data-agent-view=chat]")
        let deadline = Date().addingTimeInterval(5)
        while delegate.bridge.terminals.openTerminals > 0 && Date() < deadline { try await Task.sleep(nanoseconds: 100_000_000) }
        try expect(delegate.bridge.terminals.openTerminals == 0, "the terminal stayed open after switching to Chat")
        let opens = log.filter { $0 == .upgrade }.count
        print("PASS UI: Terminal tab on keeper-log asked for consent natively, showed Live terminal, typing in xterm sent "
              + "\"echo hi-from-xterm\\r\" and its echo reached the page's terminal (\(painted ? "painted in xterm" : "xterm not painted: window in the background")); "
              + "the page opened \(opens) terminal(s) for it; switching back to Chat closed every terminal")
    }

    // MARK: Relaunch (a second launch of the smoke app)

    /// "Don't ask again" survived the relaunch; removing the connection closes its terminal and clears it.
    func relaunchSteps() async throws {
        try await waitFor("document.body && document.body.dataset.ready === 'true'", "document.body.dataset.ready")
        try await installRecorder()
        let consent = delegate.bridge.terminals.consent
        guard let connection = delegate.store.list().first(where: { $0.name == Self.terminalConnectionName }) else {
            throw SmokeFailure("the first run left no \(Self.terminalConnectionName) connection")
        }
        terminalConnectionID = connection.id
        try expect(consent.isRemembered(id: connection.id, url: connection.url), "Don't ask again did not survive the relaunch")
        let start = try await fixtureRequests().count
        let terminal = try await openTerminal(connection.id).id
        let log = try await terminalLog(since: start)
        try expect(log == [.login, .preflight, .upgrade], "relaunch open: fixture saw \(log)")
        print("PASS after a relaunch, \"Don't ask again\" held: terminal.open without a sheet, one new login")

        _ = try await call("connections.remove", ["id": connection.id])
        let closed = try await waitForClosed(terminal)
        try expect(closed["code"] as? Int == 1006 && delegate.bridge.terminals.openTerminals == 0, "removal close: \(closed)")
        try expect(!consent.isRemembered(id: connection.id, url: connection.url)
                   && UserDefaults.standard.dictionary(forKey: TerminalConsent.defaultsKey)?[connection.id] == nil, "removal kept the consent")
        let again = try object(try await call("connections.save", ["name": Self.terminalConnectionName, "url": server, "token": token]), "save")
        guard let againID = again["id"] as? String else { throw SmokeFailure("save returned \(again)") }
        let asked = try await openWithConsent(againID, name: Self.terminalConnectionName, answer: .cancel)
        try expect(asked.result?["cancelled"] as? Bool == true, "re-added connection: \(asked)")
        _ = try await call("connections.remove", ["id": againID])
        terminalConnectionID = nil
        try expect(delegate.store.list().isEmpty && !NSApp.isActive, "relaunch cleanup")
        print("PASS removing the connection closed its terminal (1006, once) and cleared \"Don't ask again\"; re-adding it asks again")
    }
}
