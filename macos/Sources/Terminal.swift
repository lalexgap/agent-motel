import Foundation

/// Ephemeral, without automatic cookies and refusing redirects, so neither the token nor the
/// session cookie is replayed anywhere else.
@MainActor
final class TerminalHTTP {
    struct Response: Sendable {
        let status: Int
        let body: Data
        let setCookie: String?
    }

    private final class RefuseRedirects: NSObject, URLSessionTaskDelegate, Sendable {
        func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                        newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
            completionHandler(nil)
        }
    }

    private var session: URLSession?

    func send(_ request: TerminalRequest) async throws -> Response {
        guard request.kind != .upgrade else { throw PolicyError(TerminalPolicy.unexpected) }
        let session = self.session ?? {
            let configuration = APIClient.sessionConfiguration(requestTimeout: TerminalPolicy.preflightTimeout)
            configuration.timeoutIntervalForResource = max(TerminalPolicy.loginTimeout, TerminalPolicy.preflightTimeout)
            let created = URLSession(configuration: configuration, delegate: RefuseRedirects(), delegateQueue: nil)
            self.session = created
            return created
        }()
        return try await Self.fetch(session, request.request)
    }

    func cancelAll() {
        session?.invalidateAndCancel()
        session = nil
    }

    private nonisolated static func fetch(_ session: URLSession, _ request: URLRequest) async throws -> Response {
        do {
            let (bytes, response) = try await session.bytes(for: request)
            var body = Data()
            for try await byte in bytes {
                guard body.count < TerminalPolicy.maxResponseBytes else {
                    bytes.task.cancel()
                    break
                }
                body.append(byte)
            }
            let http = response as? HTTPURLResponse
            return Response(status: http?.statusCode ?? 0, body: body, setCookie: http?.value(forHTTPHeaderField: "Set-Cookie"))
        } catch {
            throw PolicyError(TerminalPolicy.unreachable)
        }
    }
}

/// Keyed by connection id AND URL. Only the native sheet grants consent; no bridge method, flag
/// or environment variable can.
@MainActor
final class TerminalConsent {
    static let defaultsKey = "terminalConsent"
    private let defaults: UserDefaults
    private var approved: Set<String> = []

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
    }

    private var stored: [String: String] {
        defaults.dictionary(forKey: Self.defaultsKey) as? [String: String] ?? [:]
    }

    private func key(_ id: String, _ url: String) -> String { id + "\n" + url }

    func isRemembered(id: String, url: String) -> Bool {
        stored[id] == url
    }

    func needsAsking(_ connection: Connection) -> Bool {
        !approved.contains(key(connection.id, connection.url)) && !isRemembered(id: connection.id, url: connection.url)
    }

    func grant(_ connection: Connection, remember: Bool) {
        approved.insert(key(connection.id, connection.url))
        guard remember else { return }
        var all = stored
        all[connection.id] = connection.url
        defaults.set(all, forKey: Self.defaultsKey)
    }

    func forget(_ id: String) {
        approved = approved.filter { !$0.hasPrefix(id + "\n") }
        var all = stored
        guard all.removeValue(forKey: id) != nil else { return }
        defaults.set(all, forKey: Self.defaultsKey)
    }

    func prune(keeping connections: [Connection]) {
        let current = Dictionary(connections.map { ($0.id, $0.url) }, uniquingKeysWith: { first, _ in first })
        let all = stored
        let kept = all.filter { current[$0.key] == $0.value }
        if kept.count != all.count { defaults.set(kept, forKey: Self.defaultsKey) }
    }
}

/// Session cookies live in memory only: never persisted, returned or logged.
@MainActor
final class TerminalManager {
    private let store: ConnectionStore
    private let confirmation: Confirmation
    let consent: TerminalConsent
    private let emit: TerminalConnection.Emit
    private let http = TerminalHTTP()
    private var terminals: [String: TerminalConnection] = [:]
    private var connecting: [ObjectIdentifier: TerminalConnection] = [:]
    private var opening = 0
    private var sessions: [String: (url: String, cookie: SessionCookie)] = [:]
    private var logins: [String: (url: String, task: Task<SessionCookie, Error>)] = [:]
    /// A second open for the same connection waits for the sheet's answer instead of being refused.
    private var consents: [String: Task<(accepted: Bool, suppressed: Bool), Error>] = [:]
    /// Bumped when the page navigates: opens that started before it are abandoned.
    private var generation = 0

    init(store: ConnectionStore, confirmation: Confirmation, emit: @escaping TerminalConnection.Emit) {
        self.store = store
        self.confirmation = confirmation
        self.consent = TerminalConsent()
        self.emit = emit
        consent.prune(keeping: store.list())
    }

    var openTerminals: Int { terminals.count }

    /// For the smoke test's leak scan only; the cookie's value cannot be read outside TerminalPolicy.swift.
    func sessionCookie(for connectionID: String) -> SessionCookie? {
        sessions[connectionID]?.cookie
    }

    func handle(_ method: String, _ params: [String: Any]) async throws -> [String: Any] {
        switch method {
        case "terminal.open":
            return try await open(params)
        case "terminal.input":
            let terminal = try existing(params)
            try await terminal.send(TerminalPolicy.inputFrame(try TerminalPolicy.input(params["data"])))
            return [:]
        case "terminal.resize":
            let terminal = try existing(params)
            let size = try TerminalPolicy.size(cols: params["cols"], rows: params["rows"])
            try await terminal.send(TerminalPolicy.resizeFrame(cols: size.cols, rows: size.rows))
            return [:]
        case "terminal.close":
            if let id = params["id"] as? String, let terminal = terminals[id] {
                terminal.finish(code: TerminalPolicy.closedCode, reason: TerminalPolicy.closedReason)
            }
            return [:]
        default:
            throw PolicyError("unknown method: \(method)")
        }
    }

    private func existing(_ params: [String: Any]) throws -> TerminalConnection {
        let id = try TerminalPolicy.terminalID(params["id"])
        guard let terminal = terminals[id], !terminal.isClosed else { throw PolicyError(TerminalPolicy.unknownTerminal) }
        return terminal
    }

    // MARK: Open

    private func open(_ params: [String: Any]) async throws -> [String: Any] {
        guard let id = params["connection"] as? String, ConnectionStore.isValidID(id), let connection = store.get(id) else {
            throw PolicyError("unknown connection: \(MessagePolicy.describe(params["connection"]))")
        }
        let agent = try MessagePolicy.agent(params["agent"])
        _ = try TerminalPolicy.base(connection.url)
        guard terminals.count + opening < TerminalPolicy.maxTerminals else { throw PolicyError(TerminalPolicy.tooManyTerminals) }
        opening += 1
        defer { opening -= 1 }
        let generation = self.generation

        if consent.needsAsking(connection) {
            let answer = try await ask(connection)
            guard answer.accepted else { return ["cancelled": true] }
            // The page keeps running behind the sheet; it may have re-pointed or removed the connection.
            try check(connection, generation)
            consent.grant(connection, remember: answer.suppressed)
        }

        guard let token = store.token(for: connection.id) else { throw PolicyError("This connection has no saved token") }
        var cookie: SessionCookie
        if let current = sessions[connection.id], current.url == connection.url {
            cookie = current.cookie
        } else {
            cookie = try await login(connection, token: token)
        }
        try check(connection, generation)

        var outcome = try await preflight(connection, agent, cookie)
        if outcome == .unauthorized {
            cookie = try await relogin(connection, token: token, stale: cookie)
            try check(connection, generation)
            outcome = try await preflight(connection, agent, cookie)
        }
        let transport: String
        switch outcome {
        case .ok(let value): transport = value
        case .unauthorized: throw PolicyError(TerminalPolicy.sessionRejected)
        case .failed(let message): throw PolicyError(message)
        }
        try check(connection, generation)

        var terminal = try await upgrade(connection, agent, cookie)
        if terminal == nil {
            cookie = try await relogin(connection, token: token, stale: cookie)
            try check(connection, generation)
            terminal = try await upgrade(connection, agent, cookie)
        }
        guard let terminal else { throw PolicyError(TerminalPolicy.sessionRejected) }
        do {
            try check(connection, generation)
        } catch {
            terminal.finish(code: TerminalPolicy.closedCode, reason: TerminalPolicy.closedReason, notify: false)
            throw error
        }
        guard !terminal.isClosed else { throw PolicyError(TerminalPolicy.unreachable) }
        terminals[terminal.id] = terminal
        // Runs after this call returns: the bridge sends the reply synchronously on the way out (no
        // suspension in between), so the page has the id before any event for it.
        Task { @MainActor in terminal.start() }
        return ["id": terminal.id, "transport": transport]
    }

    /// Under the one-confirmation-at-a-time rule, or joins the sheet already open for this connection.
    private func ask(_ connection: Connection) async throws -> (accepted: Bool, suppressed: Bool) {
        let key = connection.id + "\n" + connection.url
        if let pending = consents[key] { return try await pending.value }
        try confirmation.reserve()
        let confirmation = self.confirmation
        let text = TerminalPolicy.consentText(name: connection.name, url: connection.url)
        let task = Task { @MainActor in
            defer { confirmation.release() }
            return try await confirmation.answer(text)
        }
        consents[key] = task
        defer { consents[key] = nil }
        return try await task.value
    }

    private func check(_ connection: Connection, _ generation: Int) throws {
        guard generation == self.generation else { throw PolicyError(TerminalPolicy.pageChanged) }
        guard let current = store.get(connection.id), current.url == connection.url else {
            throw PolicyError("unknown connection: \(connection.id)")
        }
    }

    /// Concurrent opens share one login.
    private func login(_ connection: Connection, token: String) async throws -> SessionCookie {
        if let pending = logins[connection.id], pending.url == connection.url { return try await pending.task.value }
        let request = try TerminalPolicy.login(base: connection.url, token: token)
        let http = self.http
        let task = Task { @MainActor () throws -> SessionCookie in
            let response = try await http.send(request)
            if let message = TerminalPolicy.loginError(status: response.status) { throw PolicyError(message) }
            guard let cookie = TerminalPolicy.sessionCookie(fromSetCookie: response.setCookie) else {
                throw PolicyError(TerminalPolicy.noSession)
            }
            return cookie
        }
        logins[connection.id] = (connection.url, task)
        let result = await task.result
        // Not stored if the connection changed meanwhile (connectionChanged dropped the entry).
        if logins[connection.id]?.task == task {
            logins[connection.id] = nil
            if case .success(let cookie) = result { sessions[connection.id] = (connection.url, cookie) }
        }
        return try result.get()
    }

    private func relogin(_ connection: Connection, token: String, stale: SessionCookie) async throws -> SessionCookie {
        if sessions[connection.id]?.cookie == stale { sessions[connection.id] = nil }
        if let current = sessions[connection.id], current.url == connection.url { return current.cookie }
        return try await login(connection, token: token)
    }

    private func preflight(_ connection: Connection, _ agent: String, _ cookie: SessionCookie) async throws -> TerminalPolicy.Outcome {
        let response = try await http.send(try TerminalPolicy.preflight(base: connection.url, agent: agent, cookie: cookie))
        return TerminalPolicy.preflightOutcome(status: response.status, body: response.body)
    }

    /// nil on a 401 (log in again); throws for every other refusal.
    private func upgrade(_ connection: Connection, _ agent: String, _ cookie: SessionCookie) async throws -> TerminalConnection? {
        let request = try TerminalPolicy.upgrade(base: connection.url, agent: agent, cookie: cookie)
        var id = TerminalPolicy.newID()
        while terminals[id] != nil { id = TerminalPolicy.newID() }
        let terminal = TerminalConnection(id: id, connectionID: connection.id, cookie: cookie, emit: emit,
                                          onFinish: { [weak self] terminal, code in self?.finished(terminal, code: code) })
        connecting[ObjectIdentifier(terminal)] = terminal
        defer { connecting[ObjectIdentifier(terminal)] = nil }
        do {
            try await terminal.connect(request)
            return terminal
        } catch let failure as TerminalConnection.UpgradeFailure {
            switch TerminalPolicy.upgradeOutcome(status: failure.status) {
            case .unauthorized: return nil
            case .failed(let message): throw PolicyError(message)
            case .ok: throw PolicyError(TerminalPolicy.unexpected)
            }
        }
    }

    private func finished(_ terminal: TerminalConnection, code: Int) {
        if terminals[terminal.id] === terminal { terminals[terminal.id] = nil }
        connecting[ObjectIdentifier(terminal)] = nil
        // The server revoked or expired the session: the next open logs in afresh.
        if code == 4001, sessions[terminal.connectionID]?.cookie == terminal.cookie {
            sessions[terminal.connectionID] = nil
        }
    }

    // MARK: Lifecycle

    /// The page's ids are gone, so every terminal closes without events.
    func pageChanged() {
        generation += 1
        closeAll(reason: TerminalPolicy.pageChanged, notify: false)
    }

    func connectionChanged(_ id: String, urlChanged: Bool, removed: Bool) {
        sessions[id] = nil
        logins[id] = nil
        guard urlChanged || removed else { return }
        consent.forget(id)
        for terminal in Array(terminals.values) + Array(connecting.values) where terminal.connectionID == id {
            terminal.finish(code: TerminalPolicy.lostCode, reason: TerminalPolicy.removedReason)
        }
    }

    func shutDown() {
        closeAll(reason: TerminalPolicy.closedReason, notify: false)
        sessions.removeAll()
        logins.removeAll()
        http.cancelAll()
    }

    private func closeAll(reason: String, notify: Bool) {
        for terminal in Array(terminals.values) + Array(connecting.values) {
            terminal.finish(code: TerminalPolicy.closedCode, reason: reason, notify: notify)
        }
        terminals.removeAll()
        connecting.removeAll()
    }
}
