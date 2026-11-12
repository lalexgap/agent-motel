import AppKit
import WebKit

/// The page's only route to the network: `window.webkit.messageHandlers.am.postMessage({method, params})`.
/// `api.get` only sends GETs. Every write is a named method that takes values (`messages.*` and the
/// `ActionPolicy` methods), whose method, path and body are built by the policy from validated
/// values. There is no generic POST or DELETE. Destructive methods are confirmed natively first.
/// `terminal.*` speaks terminal messages, never URLs, headers or raw frames (see `TerminalManager`).
@MainActor
final class Bridge: NSObject, WKScriptMessageHandlerWithReply {
    static let handlerName = "am"

    weak var webView: WKWebView?
    let store: ConnectionStore
    let confirmation: Confirmation
    private let api = APIClient()
    /// Replaced only by the smoke app so a synthetic capability is captured without launching a browser.
    var decisionsOpener: (URL) -> Bool = { NSWorkspace.shared.open($0) }
    private(set) var streams: [String: EventStream] = [:]
    private(set) lazy var terminals = TerminalManager(store: store, confirmation: confirmation) { [weak self] name, payload, delivered in
        guard let self else { return }
        self.emit(name, payload, delivered: delivered)
    }

    init(store: ConnectionStore, confirmation: Confirmation) {
        self.store = store
        self.confirmation = confirmation
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage,
                               replyHandler: @escaping @MainActor @Sendable (Any?, String?) -> Void) {
        let origin = message.frameInfo.securityOrigin
        guard message.frameInfo.isMainFrame, origin.protocol == NavigationPolicy.scheme,
              origin.host == NavigationPolicy.host, origin.port == 0 else {
            replyHandler(nil, "Bridge messages are only accepted from the app page")
            return
        }
        guard let body = message.body as? [String: Any], let method = body["method"] as? String else {
            replyHandler(nil, "Invalid message: expected {method, params}")
            return
        }
        let params: [String: Any]
        switch body["params"] {
        case nil, is NSNull: params = [:]
        case let value as [String: Any]: params = value
        default:
            replyHandler(nil, "params must be an object")
            return
        }
        Task {
            do {
                replyHandler(try await handle(method, params), nil)
            } catch {
                replyHandler(nil, (error as? PolicyError)?.message ?? error.localizedDescription)
            }
        }
    }

    func handle(_ method: String, _ params: [String: Any]) async throws -> Any {
        switch method {
        case "app.info":
            let info = Bundle.main.infoDictionary ?? [:]
            return ["version": info["CFBundleShortVersionString"] as? String ?? "0",
                    "build": info["CFBundleVersion"] as? String ?? "0", "platform": "macos"]
        case "connections.list":
            return store.list().map(describe)
        case "connections.test":
            return await test(url: try string(params, "url"), token: try string(params, "token"))
        case "connections.save":
            return try save(params)
        case "connections.remove":
            let id = try connectionID(params, "id")
            streams.removeValue(forKey: id)?.stop()
            terminals.connectionChanged(id, urlChanged: false, removed: true)
            try store.remove(id)
            return [String: Any]()
        case "api.get":
            return try await get(params)
        case "decisions.open":
            return try await openDecisions(params)
        case "messages.send":
            let connection = try savedConnection(params)
            return try await write(MessagePolicy.send(base: connection.url, agent: params["agent"], text: params["text"],
                                                      mode: params["mode"]), connection: connection)
        case "messages.cancel":
            let connection = try savedConnection(params)
            return try await write(MessagePolicy.cancel(base: connection.url, agent: params["agent"], id: params["id"]),
                                   connection: connection)
        case "terminal.open":
            _ = try connectionID(params, "connection")
            return try await terminals.handle(method, params)
        case _ where TerminalPolicy.methods.contains(method):
            return try await terminals.handle(method, params)
        case _ where ActionPolicy.methods.contains(method):
            return try await action(method, params)
        case "events.start":
            let id = try connectionID(params, "connection")
            if let stream = streams[id] {
                emitState(stream)
            } else {
                let stream = makeStream(id)
                streams[id] = stream
                stream.start()
            }
            return [String: Any]()
        case "events.stop":
            let id = try string(params, "connection")
            streams.removeValue(forKey: id)?.stop()
            return [String: Any]()
        case "open.external":
            guard let url = URL(string: try string(params, "url")), NavigationPolicy.canOpenExternally(url) else {
                throw PolicyError("Only http and https links without credentials can be opened")
            }
            NSWorkspace.shared.open(url)
            return [String: Any]()
        default:
            throw PolicyError("unknown method: \(method)")
        }
    }

    func stopAllStreams() {
        for stream in streams.values { stream.stop() }
        streams.removeAll()
    }

    /// At quit: in-flight requests (a move can take ten minutes) are cancelled, not left running.
    func cancelRequests() {
        api.cancelAll()
    }

    /// Delivers a native event to `window.__amNativeEvent(name, payload)`. Data is passed as
    /// call arguments, never interpolated into script source.
    /// `delivered` runs once the page has handled the event (or at once when there is no page).
    func emit(_ name: String, _ payload: [String: Any], delivered: (@MainActor @Sendable () -> Void)? = nil) {
        guard let webView, webView.url.map(NavigationPolicy.isInternal) == true else {
            delivered?()
            return
        }
        webView.callAsyncJavaScript(
            "if (typeof window.__amNativeEvent === 'function') window.__amNativeEvent(name, payload);",
            arguments: ["name": name, "payload": payload], in: nil, in: .page,
            completionHandler: delivered.map { done in { @MainActor @Sendable _ in done() } })
    }

    // MARK: Methods

    private func describe(_ connection: Connection) -> [String: Any] {
        ["id": connection.id, "name": connection.name, "url": connection.url, "hasToken": store.hasToken(connection.id)]
    }

    private func test(url: String, token: String) async -> [String: Any] {
        do {
            let base = try ConnectionPolicy.normalize(url)
            try ConnectionPolicy.validateToken(token)
            let response = try await api.get(try ConnectionPolicy.apiURL(base: base, path: "/api/health"), token: token)
            let json = try? JSONSerialization.jsonObject(with: response.body) as? [String: Any]
            switch response.status {
            case 200..<300 where json?["ok"] as? Bool == true:
                return ["ok": true, "status": response.status]
            case 200..<300:
                return ["ok": false, "status": response.status, "error": "This server did not answer like Agent Motel"]
            case 401, 403:
                return ["ok": false, "status": response.status, "error": "The server rejected the token"]
            case 300..<400:
                return ["ok": false, "status": response.status, "error": "The server redirected; use the address it redirects to"]
            default:
                return ["ok": false, "status": response.status, "error": "The server returned HTTP \(response.status)"]
            }
        } catch {
            return ["ok": false, "status": 0, "error": (error as? PolicyError)?.message ?? error.localizedDescription]
        }
    }

    private func save(_ params: [String: Any]) throws -> [String: Any] {
        let id = try optionalString(params, "id")
        let name = try string(params, "name").trimmingCharacters(in: .whitespacesAndNewlines)
        guard (1...200).contains(name.count) else { throw PolicyError("The name must be 1 to 200 characters") }
        let url = try ConnectionPolicy.normalize(try string(params, "url"))
        let token = try optionalString(params, "token").flatMap { $0.isEmpty ? nil : $0 }
        if let token { try ConnectionPolicy.validateToken(token) }
        let connection: Connection
        if let id {
            guard let existing = store.get(id) else { throw PolicyError("unknown connection: \(id)") }
            // Keeping a token while changing the server would send it to a different origin.
            if existing.url != url && token == nil {
                throw PolicyError("Enter the token again when changing the server URL")
            }
            connection = Connection(id: id, name: name, url: url)
            try store.save(connection, token: token)
            if existing.url != url || token != nil {
                streams[id]?.restart()
                terminals.connectionChanged(id, urlChanged: existing.url != url, removed: false)
            }
        } else {
            guard let token else { throw PolicyError("Enter the access token") }
            connection = Connection(id: UUID().uuidString.lowercased(), name: name, url: url)
            try store.save(connection, token: token)
        }
        return describe(connection)
    }

    private func get(_ params: [String: Any]) async throws -> [String: Any] {
        let id = try connectionID(params, "connection")
        let path = try string(params, "path")
        guard let connection = store.get(id) else { throw PolicyError("unknown connection: \(id)") }
        let url = try ConnectionPolicy.apiURL(base: connection.url, path: path)
        guard let token = store.token(for: id) else { throw PolicyError("This connection has no saved token") }
        let response = try await api.get(url, token: token)
        let body = (try? JSONSerialization.jsonObject(with: response.body, options: [.fragmentsAllowed])) ?? NSNull()
        return ["status": response.status, "body": body]
    }

    private func savedConnection(_ params: [String: Any]) throws -> Connection {
        let id = try connectionID(params, "connection")
        guard let connection = store.get(id) else { throw PolicyError("unknown connection: \(id)") }
        return connection
    }

    private func openDecisions(_ params: [String: Any]) async throws -> [String: Any] {
        let connection = try savedConnection(params)
        let agent = try DecisionsPolicy.agent(params["agent"])
        let decisionID = try DecisionsPolicy.decisionID(params["decisionId"])
        let request = try DecisionsPolicy.request(base: connection.url, agent: agent)
        guard let token = store.token(for: connection.id) else { throw PolicyError("This connection has no saved token") }
        let response: APIClient.Response
        do {
            response = try await api.send(request, token: token)
        } catch {
            // URLSession errors can include response details. This method never surfaces them because its
            // successful response contains a secret capability URL.
            throw PolicyError("Could not reach the server to open the decisions page")
        }
        guard (200..<300).contains(response.status) else {
            if response.status == 404 { throw PolicyError("The decisions page is not set up on this server") }
            throw PolicyError("Could not open the decisions page (HTTP \(response.status))")
        }
        let url = try DecisionsPolicy.pageURL(body: response.body, agent: agent, decisionID: decisionID)
        guard let current = store.get(connection.id), current.url == connection.url else {
            throw PolicyError("unknown connection: \(connection.id)")
        }
        guard decisionsOpener(url) else { throw PolicyError("The default browser could not open the decisions page") }
        return [:]
    }

    /// Sent once; a network failure rejects so the page can say the outcome is unknown.
    private func write(_ request: WriteRequest, connection: Connection) async throws -> [String: Any] {
        guard let token = store.token(for: connection.id) else { throw PolicyError("This connection has no saved token") }
        let response = try await api.send(request, token: token)
        let body = (try? JSONSerialization.jsonObject(with: response.body, options: [.fragmentsAllowed])) ?? NSNull()
        return ["status": response.status, "body": body]
    }

    /// Validates everything first; a confirmed method then checks the exact agent still exists (am's
    /// `stop` also matches aliases and prefixes, so a stale name could hit another agent), shows its
    /// status in the native sheet, and sends nothing unless the user accepts.
    private func action(_ method: String, _ params: [String: Any]) async throws -> Any {
        let connection = try savedConnection(params)
        let plan = try ActionPolicy.plan(method, base: connection.url, params: params)
        guard let confirm = plan.confirm else { return try await write(plan.request, connection: connection) }
        guard let token = store.token(for: connection.id) else { throw PolicyError("This connection has no saved token") }
        try confirmation.reserve()
        let accepted: Bool
        do {
            let detail = try await api.get(confirm.precheck, token: token)
            try ActionPolicy.checkPrecheck(detail.status)
            accepted = try await confirmation.ask(confirm.text(status: ActionPolicy.status(fromDetail: detail.body), server: connection.name, url: connection.url))
        } catch {
            confirmation.release()
            throw error
        }
        // Released once the sheet is answered, so a long move or model change does not hold up other calls.
        confirmation.release()
        guard accepted else { return ["cancelled": true] }
        // The page keeps running behind the sheet; it may have removed or re-pointed the connection.
        guard let current = store.get(connection.id), current.url == connection.url else {
            throw PolicyError("unknown connection: \(connection.id)")
        }
        guard let currentToken = store.token(for: current.id) else { throw PolicyError("This connection has no saved token") }
        // The agent may have gone while the sheet was open; its name could then resolve to another one.
        let recheck = try await api.get(confirm.precheck, token: currentToken)
        try ActionPolicy.checkPrecheck(recheck.status)
        return try await write(plan.request, connection: current)
    }

    private func makeStream(_ id: String) -> EventStream {
        EventStream(
            connectionID: id,
            credentials: { [weak self] in
                guard let self, let connection = self.store.get(id), let token = self.store.token(for: id) else { return nil }
                return EventStream.Credentials(base: connection.url, token: token)
            },
            onState: { [weak self] stream in self?.emitState(stream) },
            onEvent: { [weak self] stream, event in
                let data = event.data.data(using: .utf8).flatMap {
                    try? JSONSerialization.jsonObject(with: $0, options: [.fragmentsAllowed])
                } ?? event.data
                self?.emit("events.message", ["connection": stream.connectionID, "event": event.event, "data": data])
            })
    }

    private func emitState(_ stream: EventStream) {
        var payload: [String: Any] = ["connection": stream.connectionID, "state": stream.state.rawValue]
        if let error = stream.lastError { payload["error"] = error }
        emit("events.state", payload)
    }

    // MARK: Params

    private func string(_ params: [String: Any], _ key: String) throws -> String {
        guard let value = params[key] as? String else { throw PolicyError("params.\(key) must be a string") }
        return value
    }

    private func optionalString(_ params: [String: Any], _ key: String) throws -> String? {
        switch params[key] {
        case nil, is NSNull: return nil
        case let value as String: return value
        default: throw PolicyError("params.\(key) must be a string")
        }
    }

    private func connectionID(_ params: [String: Any], _ key: String) throws -> String {
        let id = try string(params, key)
        guard ConnectionStore.isValidID(id), store.get(id) != nil else { throw PolicyError("unknown connection: \(id)") }
        return id
    }
}
