import Foundation

/// The value is private to this file, so nothing else in the app can log it, return it to the
/// page or send it anywhere else.
struct SessionCookie: Equatable, CustomStringConvertible, CustomDebugStringConvertible, CustomReflectable {
    fileprivate let value: String

    var description: String { "SessionCookie(redacted)" }
    var debugDescription: String { description }
    var customMirror: Mirror { Mirror(self, children: []) }

    /// For the smoke test's leak scan: whether `text` contains the value, without revealing it.
    func occurs(in text: String) -> Bool { text.contains(value) }
}

/// Carries the access token or the session cookie. The initialiser is private to this file, so
/// every instance is built by `TerminalPolicy` from the saved connection URL and a validated agent.
struct TerminalRequest {
    enum Kind: Equatable {
        case login, preflight, upgrade
    }

    let kind: Kind
    let request: URLRequest

    fileprivate init(kind: Kind, request: URLRequest) {
        self.kind = kind
        self.request = request
    }
}

/// The same rules and strings are in desktop/src/policy.ts.
enum TerminalPolicy {
    static let methods: Set<String> = ["terminal.open", "terminal.input", "terminal.resize", "terminal.close"]
    static let maxTerminals = 4
    static let maxInputBytes = 16 * 1024
    static let cols = 2...500
    static let rows = 2...200
    static let loginTimeout: TimeInterval = 30
    static let preflightTimeout: TimeInterval = 30
    static let upgradeTimeout: TimeInterval = 30
    /// The server's idle timeout is 120 s.
    static let pingInterval: TimeInterval = 30
    static let flushDelay: TimeInterval = 0.016
    static let flushBytes = 64 * 1024
    static let maxPendingOutput = 4 * 1024 * 1024
    /// Input waiting to be written to the socket. The server allows 64 KiB queued on its side.
    static let maxQueuedInput = 1024 * 1024
    /// Login and preflight answers are a few bytes of JSON.
    static let maxResponseBytes = 64 * 1024
    static let cookieName = "__Host-am_session"

    // MARK: Messages

    static let rejectedToken = "The server rejected the access token"
    static let noWebSignIn = "This server has no web sign-in, so terminals are unavailable"
    static let tooManyLogins = "Too many sign-in attempts. Wait a minute and try again."
    static let tooManyConnections = "Too many terminal connections"
    static let unreachable = "Couldn't reach the server"
    static let needsHTTPS = "Terminals need an https connection"
    static let tooManyTerminals = "Too many terminals open"
    static let unknownTerminal = "unknown terminal"
    static let invalidData = "invalid data"
    static let invalidCols = "invalid cols"
    static let invalidRows = "invalid rows"
    static let sessionRejected = "The server rejected the terminal session"
    static let noSession = "The server did not start a terminal session"
    static let unexpected = "This server did not answer like Agent Motel"
    static let pageChanged = "The page changed while the terminal was opening"
    static func httpStatus(_ status: Int) -> String { "The server returned HTTP \(status)" }
    static func originRejected(_ webOrigin: String? = nil) -> String {
        let address = webOrigin.map { " (\($0))" } ?? ""
        return "This server only allows terminals from its own web address\(address). Connect the app to that address to use terminals."
    }

    // MARK: Close codes

    static let closedCode = 1000
    static let closedReason = "Terminal closed"
    static let lostCode = 1006
    static let lostReason = "Connection lost"
    static let removedReason = "The connection was removed or changed"
    static let overflowCode = 1013
    static let overflowReason = "Output exceeded rendering capacity"
    static let inputOverflowCode = 1008
    static let inputOverflowReason = "Terminal input limit exceeded"

    // MARK: Sheet

    static func consentText(name: String, url: String) -> ConfirmationText {
        let host = ActionPolicy.host(fromURL: url)
        return ConfirmationText(
            title: "Open interactive terminals on \(ActionPolicy.displayText(name))?",
            message: "Keys you type in a terminal go straight to the agent's terminal on \(host), including Ctrl-C and shell commands.",
            button: "Allow", destructive: false, suppression: "Don't ask again for this server")
    }

    // MARK: Params

    static func terminalID(_ value: Any?) throws -> String {
        guard let text = value as? String, text.utf8.count == 32,
              text.utf8.allSatisfy({ (0x30...0x39).contains($0) || (0x61...0x66).contains($0) }) else {
            throw PolicyError(unknownTerminal)
        }
        return text
    }

    /// Any bytes are allowed: control keys are the point of a terminal.
    static func input(_ value: Any?) throws -> String {
        guard let text = value as? String, (1...maxInputBytes).contains(text.utf8.count) else { throw PolicyError(invalidData) }
        return text
    }

    static func size(cols rawCols: Any?, rows rawRows: Any?) throws -> (cols: Int, rows: Int) {
        guard let cols = integer(rawCols), self.cols.contains(cols) else { throw PolicyError(invalidCols) }
        guard let rows = integer(rawRows), self.rows.contains(rows) else { throw PolicyError(invalidRows) }
        return (cols, rows)
    }

    /// A JavaScript number with an integral value (WebKit may pass 80 as a double); never a boolean.
    static func integer(_ value: Any?) -> Int? {
        guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID() else { return nil }
        let double = number.doubleValue
        guard double.isFinite, double.rounded() == double, abs(double) < 1e9 else { return nil }
        return Int(double)
    }

    static func newID() -> String {
        var generator = SystemRandomNumberGenerator()
        return (0..<16).map { _ in String(format: "%02x", UInt8.random(in: 0...255, using: &generator)) }.joined()
    }

    // MARK: Requests

    /// Only https or plain http to loopback: the session cookie must never travel in clear text
    /// over a network.
    static func base(_ url: String) throws -> String {
        guard let parts = URLComponents(string: url), let scheme = parts.scheme?.lowercased(),
              var host = parts.host?.lowercased(), parts.user == nil, parts.password == nil,
              parts.path.isEmpty || parts.path == "/", parts.query == nil, parts.fragment == nil else {
            throw PolicyError("The connection URL is invalid")
        }
        if host.hasPrefix("[") && host.hasSuffix("]") { host = String(host.dropFirst().dropLast()) }
        switch scheme {
        case "https": return url
        case "http" where isLoopback(host): return url
        default: throw PolicyError(needsHTTPS)
        }
    }

    static func isLoopback(_ host: String) -> Bool {
        host == "localhost" || host == "::1" || ConnectionPolicy.ipv4(host)?.first == 127
    }

    static func login(base rawBase: String, token: String) throws -> TerminalRequest {
        let base = try self.base(rawBase)
        try ConnectionPolicy.validateToken(token)
        guard let url = URL(string: base + "/auth/login") else { throw PolicyError("The connection URL is invalid") }
        var request = plain(url, base: base, timeout: loginTimeout)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONSerialization.data(withJSONObject: ["token": token], options: [.sortedKeys, .withoutEscapingSlashes])
        return TerminalRequest(kind: .login, request: request)
    }

    static func preflight(base rawBase: String, agent rawAgent: Any?, cookie: SessionCookie) throws -> TerminalRequest {
        let url = try terminalURL(base: rawBase, agent: rawAgent)
        var request = plain(url, base: try base(rawBase), timeout: preflightTimeout)
        request.httpMethod = "GET"
        request.setValue("\(cookieName)=\(cookie.value)", forHTTPHeaderField: "Cookie")
        return TerminalRequest(kind: .preflight, request: request)
    }

    static func upgrade(base rawBase: String, agent rawAgent: Any?, cookie: SessionCookie) throws -> TerminalRequest {
        let url = try terminalURL(base: rawBase, agent: rawAgent)
        guard var parts = URLComponents(url: url, resolvingAgainstBaseURL: false) else { throw PolicyError("The connection URL is invalid") }
        parts.scheme = parts.scheme == "https" ? "wss" : "ws"
        guard let socketURL = parts.url else { throw PolicyError("The connection URL is invalid") }
        var request = plain(socketURL, base: try base(rawBase), timeout: upgradeTimeout)
        request.setValue("\(cookieName)=\(cookie.value)", forHTTPHeaderField: "Cookie")
        request.setValue(nil, forHTTPHeaderField: "Accept")
        return TerminalRequest(kind: .upgrade, request: request)
    }

    static func terminalURL(base rawBase: String, agent rawAgent: Any?) throws -> URL {
        let base = try self.base(rawBase)
        let agent = try MessagePolicy.agent(rawAgent)
        return try ConnectionPolicy.apiURL(base: base, path: "/api/agents/\(MessagePolicy.encodedAgent(agent))/terminal")
    }

    /// `Origin` must be exactly the connection's base: the server compares it with its web origin.
    private static func plain(_ url: URL, base: String, timeout: TimeInterval) -> URLRequest {
        var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalAndRemoteCacheData, timeoutInterval: timeout)
        request.httpShouldHandleCookies = false
        request.setValue(base, forHTTPHeaderField: "Origin")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        return request
    }

    // MARK: Responses

    /// Foundation joins repeated `Set-Cookie` headers with commas. The value must be base64url so
    /// it can never inject anything into a header.
    static func sessionCookie(fromSetCookie header: String?) -> SessionCookie? {
        guard let header else { return nil }
        for piece in header.split(separator: ",") {
            let pair = piece.split(separator: ";", maxSplits: 1, omittingEmptySubsequences: false).first ?? ""
            guard let equals = pair.firstIndex(of: "=") else { continue }
            let name = pair[..<equals].trimmingCharacters(in: .whitespaces)
            let value = pair[pair.index(after: equals)...].trimmingCharacters(in: .whitespaces)
            guard name == cookieName else { continue }
            guard (16...512).contains(value.utf8.count), value.utf8.allSatisfy(isBase64URL) else { return nil }
            return SessionCookie(value: value)
        }
        return nil
    }

    private static func isBase64URL(_ byte: UInt8) -> Bool {
        switch byte {
        case UInt8(ascii: "A")...UInt8(ascii: "Z"), UInt8(ascii: "a")...UInt8(ascii: "z"), UInt8(ascii: "0")...UInt8(ascii: "9"),
             UInt8(ascii: "-"), UInt8(ascii: "_"):
            return true
        default:
            return false
        }
    }

    static func loginError(status: Int) -> String? {
        switch status {
        case 200: return nil
        case 401: return rejectedToken
        case 403: return originRejected()
        case 404: return noWebSignIn
        case 429: return tooManyLogins
        default: return httpStatus(status)
        }
    }

    enum Outcome: Equatable {
        case ok(transport: String)
        /// Log in once more and retry the step once.
        case unauthorized
        case failed(String)
    }

    static func preflightOutcome(status: Int, body: Data) -> Outcome {
        let json = try? JSONSerialization.jsonObject(with: body) as? [String: Any]
        switch status {
        case 200:
            guard json?["available"] as? Bool == true, let transport = json?["transport"] as? String,
                  transport == "local" || transport == "ssh" else { return .failed(unexpected) }
            return .ok(transport: transport)
        case 401: return .unauthorized
        case 403: return .failed(originRejected())
        case 404, 409:
            guard let error = json?["error"] as? String else { return .failed(httpStatus(status)) }
            return .failed(serverText(error))
        case 429: return .failed(tooManyConnections)
        default: return .failed(httpStatus(status))
        }
    }

    /// A failed upgrade has no readable body; status 0 means no HTTP answer at all.
    static func upgradeOutcome(status: Int) -> Outcome {
        switch status {
        case 0: return .failed(unreachable)
        case 401: return .unauthorized
        case 403: return .failed(originRejected())
        case 429: return .failed(tooManyConnections)
        default: return .failed(httpStatus(status))
        }
    }

    static func control(_ text: String) -> [String: Any]? {
        guard text.utf8.count <= maxResponseBytes, let data = text.data(using: .utf8),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let type = json["type"] as? String else { return nil }
        switch type {
        case "ready":
            return ["type": "ready"]
        case "exit":
            guard let code = integer(json["code"]) else { return nil }
            return ["type": "exit", "code": code]
        case "error":
            guard let message = json["message"] as? String else { return nil }
            return ["type": "error", "message": serverText(message)]
        default:
            return nil
        }
    }

    static func serverText(_ raw: String) -> String {
        let kept = raw.unicodeScalars.filter {
            ![.control, .format, .lineSeparator, .paragraphSeparator].contains($0.properties.generalCategory)
        }
        let text = String(String.UnicodeScalarView(kept.prefix(300))).trimmingCharacters(in: .whitespaces)
        return text.isEmpty ? "Terminal unavailable" : text
    }

    static func closeReason(_ data: Data?) -> String {
        guard let data, !data.isEmpty, let text = String(data: data, encoding: .utf8) else { return "" }
        return serverText(text)
    }

    // MARK: Frames

    static func inputFrame(_ data: String) -> String {
        frame(["type": "input", "data": data])
    }

    static func resizeFrame(cols: Int, rows: Int) -> String {
        frame(["type": "resize", "cols": cols, "rows": rows])
    }

    private static func frame(_ object: [String: Any]) -> String {
        let data = (try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys, .withoutEscapingSlashes])) ?? Data()
        return String(data: data, encoding: .utf8) ?? "{}"
    }
}

/// Output waiting to reach the page for one terminal: bytes received but not yet sent as an event
/// (`buffered`), plus bytes sent in events the page has not finished handling (`inFlight`).
struct OutputBuffer {
    private var chunks: [Data] = []
    private var head = 0
    private(set) var buffered = 0
    private(set) var inFlight = 0

    var pending: Int { buffered + inFlight }

    /// False when the bytes would put more than `limit` in waiting; the terminal must then close.
    mutating func append(_ data: Data, limit: Int = TerminalPolicy.maxPendingOutput) -> Bool {
        guard pending + data.count <= limit else { return false }
        if !data.isEmpty {
            chunks.append(data)
            buffered += data.count
        }
        return true
    }

    /// The bytes count as in flight until `delivered`.
    mutating func take(max: Int = TerminalPolicy.flushBytes) -> Data? {
        guard buffered > 0 else { return nil }
        var chunk = Data()
        chunk.reserveCapacity(Swift.min(max, buffered))
        while chunk.count < max, head < chunks.count {
            let next = chunks[head]
            let room = max - chunk.count
            if next.count <= room {
                chunk.append(next)
                head += 1
            } else {
                chunk.append(next.prefix(room))
                chunks[head] = Data(next.dropFirst(room))
            }
        }
        if head == chunks.count {
            chunks.removeAll(keepingCapacity: true)
            head = 0
        } else if head > 64 && head * 2 > chunks.count {
            chunks.removeFirst(head)
            head = 0
        }
        buffered -= chunk.count
        inFlight += chunk.count
        return chunk
    }

    mutating func delivered(_ count: Int) {
        inFlight = Swift.max(0, inFlight - count)
    }

    mutating func clear() {
        chunks = []
        head = 0
        buffered = 0
    }
}
