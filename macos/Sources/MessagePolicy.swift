import Foundation

/// One of the app's non-GET requests. The initialiser is private to this file, so every instance
/// comes from `MessagePolicy` or `ActionPolicy`, which validate the values and build the path and
/// body themselves. Nothing else in the app can describe a write.
struct WriteRequest: Equatable {
    enum Method: String {
        case post = "POST"
        case delete = "DELETE"
    }

    let method: Method
    let url: URL
    /// JSON for every POST except an upload, whose body is the image bytes; nil for a DELETE.
    let body: Data?
    let contentType: String?
    /// The whole request, not only the idle time: nothing is retried after it.
    let timeout: TimeInterval

    fileprivate init(method: Method, url: URL, body: Data?, contentType: String?, timeout: TimeInterval) {
        self.method = method
        self.url = url
        self.body = body
        self.contentType = contentType
        self.timeout = timeout
    }

    fileprivate static func json(_ url: URL, _ body: [String: Any], timeout: TimeInterval) throws -> WriteRequest {
        let data = try JSONSerialization.data(withJSONObject: body, options: [.sortedKeys, .withoutEscapingSlashes])
        return WriteRequest(method: .post, url: url, body: data, contentType: "application/json", timeout: timeout)
    }
}

/// Validation and request building for `messages.send` and `messages.cancel`. The page supplies
/// values, never a path: the path is fixed here and joined to the stored base by `ConnectionPolicy.apiURL`.
enum MessagePolicy {
    enum Mode: String {
        case queue
        case now
    }

    /// Leaves room for JSON escaping under the server's 256 KiB body limit.
    static let maxTextBytes = 100_000
    /// A `now` send to a remote host goes over ssh, so message requests get longer than reads, but bounded.
    static let timeout: TimeInterval = 60
    static let emptyText = "Message is empty"
    static let longText = "Message is too long (limit 100,000 bytes)"
    static let badMode = "mode must be queue or now"
    static let controlText = "Message contains a control character (only tabs and line breaks are allowed)"

    static let nameCharacters = Set("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-".unicodeScalars)
    private static let hostCharacters = nameCharacters.union(".".unicodeScalars)

    /// `name` or `host:name`, matching am's agent and host name rules.
    static func agent(_ value: Any?) throws -> String {
        guard let text = value as? String else { throw PolicyError("invalid agent: \(describe(value))") }
        let parts = text.split(separator: ":", omittingEmptySubsequences: false)
        let valid: Bool
        switch parts.count {
        case 1: valid = isName(parts[0])
        case 2: valid = isHost(parts[0]) && isName(parts[1])
        default: valid = false
        }
        guard valid else { throw PolicyError("invalid agent: \(text)") }
        return text
    }

    static func mode(_ value: Any?) throws -> Mode {
        guard let text = value as? String, let mode = Mode(rawValue: text) else { throw PolicyError(badMode) }
        return mode
    }

    /// Returns the text with leading and trailing whitespace removed; the inside is untouched.
    static func text(_ value: Any?) throws -> String {
        guard let raw = value as? String else { throw PolicyError("text must be a string") }
        // am types the text into the agent's pane, where Esc or Ctrl-C would act on the agent.
        guard !hasControl(raw, allowLineBreaks: true) else { throw PolicyError(controlText) }
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { throw PolicyError(emptyText) }
        guard trimmed.utf8.count <= maxTextBytes else { throw PolicyError(longText) }
        return trimmed
    }

    /// The server decides whether this is a real message id; this only keeps it one safe path segment.
    static func messageID(_ value: Any?) throws -> String {
        guard let text = value as? String, (1...128).contains(text.unicodeScalars.count),
              text.unicodeScalars.allSatisfy(nameCharacters.contains) else {
            throw PolicyError("invalid message id: \(describe(value))")
        }
        return text
    }

    /// `encodeURIComponent` of a validated agent: only `:` needs escaping, so `host:name` stays one segment.
    static func encodedAgent(_ agent: String) -> String {
        var allowed = CharacterSet()
        allowed.insert(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_.-")
        return agent.addingPercentEncoding(withAllowedCharacters: allowed) ?? agent
    }

    static func send(base: String, agent rawAgent: Any?, text rawText: Any?, mode rawMode: Any?) throws -> WriteRequest {
        let agent = try agent(rawAgent)
        let text = try text(rawText)
        let mode = try mode(rawMode)
        let url = try ConnectionPolicy.apiURL(base: base, path: "/api/agents/\(encodedAgent(agent))/messages")
        return try .json(url, ["text": text, "mode": mode.rawValue], timeout: timeout)
    }

    static func cancel(base: String, agent rawAgent: Any?, id rawID: Any?) throws -> WriteRequest {
        let agent = try agent(rawAgent)
        let id = try messageID(rawID)
        let url = try ConnectionPolicy.apiURL(base: base, path: "/api/agents/\(encodedAgent(agent))/messages/\(id)")
        return WriteRequest(method: .delete, url: url, body: nil, contentType: nil, timeout: timeout)
    }

    static func isName(_ part: Substring) -> Bool {
        (1...64).contains(part.unicodeScalars.count) && part.unicodeScalars.allSatisfy(nameCharacters.contains)
    }

    static func isHost(_ part: Substring) -> Bool {
        guard let first = part.unicodeScalars.first, first != ".", first != "-", !part.contains("..") else { return false }
        return part.unicodeScalars.count <= 255 && part.unicodeScalars.allSatisfy(hostCharacters.contains)
    }

    /// C0 controls other than tab (and, when allowed, line feed and carriage return), DEL and C1.
    static func hasControl(_ text: String, allowLineBreaks: Bool) -> Bool {
        text.unicodeScalars.contains { scalar in
            switch scalar.value {
            case 0x09: return false
            case 0x0A, 0x0D: return !allowLineBreaks
            case 0..<0x20, 0x7F...0x9F: return true
            default: return false
            }
        }
    }

    /// Matches JavaScript's `String(value)` for the values a bridge message can carry.
    static func describe(_ value: Any?) -> String {
        switch value {
        case nil, is NSNull: return "null"
        case let text as String: return text
        case let number as NSNumber where CFGetTypeID(number) == CFBooleanGetTypeID(): return number.boolValue ? "true" : "false"
        case let other?: return String(describing: other)
        }
    }
}

/// What a confirmed action shows in its native sheet.
struct ConfirmationText: Equatable {
    let title: String
    let message: String
    let button: String
    /// Cancel becomes the default button and the confirm button is styled as destructive.
    let destructive: Bool
}

struct ActionPlan {
    /// A confirmed action first reads `precheck` (the exact-name detail route), then asks.
    struct Confirm: Equatable {
        let precheck: URL
        let title: String
        let lead: String
        let button: String
        let destructive: Bool

        func text(status: String, server: String) -> ConfirmationText {
            ConfirmationText(title: title, message: "\(lead) Status: \(status).\nServer: \(server)", button: button,
                             destructive: destructive)
        }
    }

    let request: WriteRequest
    let confirm: Confirm?
}

/// Validation and request building for every other write. Each method takes values; the path,
/// method, body keys and timeout are fixed here. Validation order: agent, then the remaining
/// params in the order the contract lists them (the connection is checked by the bridge first).
enum ActionPolicy {
    static let methods: Set<String> = [
        "agents.resume", "agents.restart", "agents.interrupt", "agents.stop", "agents.remove", "agents.rename",
        "agents.move", "agents.model", "agents.handoff", "agents.create", "permissions.answer", "prompt.answer",
        "files.upload", "concierge.ensure", "search.query",
    ]

    static let missingAgent = "This agent no longer exists"
    static let anotherConfirmation = "another confirmation is open"
    static func precheckFailed(_ status: Int) -> String { "Couldn't check the agent (HTTP \(status))" }

    static let maxUploadBytes = 10 << 20
    /// Base64 of `maxUploadBytes`, so an oversized upload is refused before it is decoded.
    static let maxUploadBase64 = (maxUploadBytes + 2) / 3 * 4
    static let imageTypes = ["image/png", "image/jpeg", "image/gif", "image/webp"]
    static let statuses: Set<String> = ["starting", "idle", "waiting", "working", "needs-attention"]
    static let providers: Set<String> = ["claude", "codex", "antigravity"]
    private static let ulidCharacters = Set("0123456789ABCDEFGHJKMNPQRSTVWXYZ".unicodeScalars)
    private static let hexCharacters = Set("0123456789abcdef".unicodeScalars)
    /// JavaScript's `trim()` also removes the byte order mark.
    private static let trimmed = CharacterSet.whitespacesAndNewlines.union(CharacterSet(charactersIn: "\u{FEFF}"))

    static func plan(_ method: String, base: String, params: [String: Any]) throws -> ActionPlan {
        func url(_ path: String) throws -> URL { try ConnectionPolicy.apiURL(base: base, path: path) }
        func agentURL(_ agent: String, _ suffix: String = "") throws -> URL {
            try url("/api/agents/\(MessagePolicy.encodedAgent(agent))\(suffix)")
        }
        func post(_ agent: String, _ action: String, _ body: [String: Any] = [:], timeout: TimeInterval) throws -> WriteRequest {
            try .json(try agentURL(agent, "/\(action)"), body, timeout: timeout)
        }
        func confirm(_ agent: String, _ title: String, _ lead: String, _ button: String, destructive: Bool = false) throws -> ActionPlan.Confirm {
            ActionPlan.Confirm(precheck: try agentURL(agent), title: title, lead: lead, button: button, destructive: destructive)
        }

        switch method {
        case "agents.resume":
            let agent = try MessagePolicy.agent(params["agent"])
            return ActionPlan(request: try post(agent, "resume", timeout: 60), confirm: nil)
        case "agents.restart":
            let agent = try MessagePolicy.agent(params["agent"])
            return ActionPlan(request: try post(agent, "restart", timeout: 60), confirm: try confirm(
                agent, "Restart \(agent)?", "This interrupts its current turn and reopens the conversation.", "Restart"))
        case "agents.interrupt":
            let agent = try MessagePolicy.agent(params["agent"])
            return ActionPlan(request: try post(agent, "interrupt", timeout: 60), confirm: try confirm(
                agent, "Interrupt \(agent)?", "This interrupts its current work.", "Interrupt"))
        case "agents.stop":
            let agent = try MessagePolicy.agent(params["agent"])
            return ActionPlan(request: try post(agent, "stop", timeout: 60), confirm: try confirm(
                agent, "Stop \(agent)?", "This interrupts its current work and ends its session. It can be resumed later.", "Stop"))
        case "agents.remove":
            let agent = try MessagePolicy.agent(params["agent"])
            let request = WriteRequest(method: .delete, url: try agentURL(agent), body: nil, contentType: nil, timeout: 60)
            return ActionPlan(request: request, confirm: try confirm(
                agent, "Remove \(agent)?",
                "Its session will stop and the agent will be removed, along with its queued messages. The worktree is kept.",
                "Remove", destructive: true))
        case "agents.rename":
            let agent = try MessagePolicy.agent(params["agent"])
            let name = try Self.name(params["name"])
            return ActionPlan(request: try post(agent, "rename", ["name": name], timeout: 60), confirm: nil)
        case "agents.move":
            let agent = try MessagePolicy.agent(params["agent"])
            let host = try Self.host(params["host"])
            var body: [String: Any] = ["host": host]
            if let dir = try optional(params["dir"], directory) {
                guard dir.hasPrefix("/") else { throw PolicyError("invalid directory") }
                body["dir"] = dir
            }
            return ActionPlan(request: try post(agent, "move", body, timeout: 600), confirm: try confirm(
                agent, "Move \(agent) to \(host)?", "The source will stop; workspace files are not copied.", "Move"))
        case "agents.model":
            let agent = try MessagePolicy.agent(params["agent"])
            // `model` is required but may be null (the provider default); an absent `effort` keeps the current one.
            guard params.keys.contains("model") else { throw PolicyError("invalid model") }
            var body: [String: Any] = ["model": try nullable(params["model"]) { try selection($0, maxBytes: 256, "invalid model") }]
            if params.keys.contains("effort") {
                body["effort"] = try nullable(params["effort"]) { try selection($0, maxBytes: 64, "invalid effort") }
            }
            body["createdAt"] = try createdAt(params["createdAt"])
            body["status"] = try oneOf(params["status"], statuses, "invalid status")
            return ActionPlan(request: try post(agent, "model", body, timeout: 120), confirm: try confirm(
                agent, "Change the model for \(agent)?",
                "This restarts the agent and interrupts its current turn. The conversation and queued messages are kept.",
                "Change model"))
        case "agents.handoff":
            let agent = try MessagePolicy.agent(params["agent"])
            var body: [String: Any] = ["to": try oneOf(params["to"], ["claude", "codex"], "invalid to")]
            if let newName = try optional(params["newName"], Self.name) { body["newName"] = newName }
            if let full = try optional(params["full"], { try boolean($0, "invalid full") }) { body["full"] = full }
            return ActionPlan(request: try post(agent, "handoff", body, timeout: 150), confirm: nil)
        case "agents.create":
            var body: [String: Any] = ["name": try Self.name(params["name"])]
            body["task"] = try trimmedText(params["task"], maxBytes: MessagePolicy.maxTextBytes, singleLine: false, "invalid task")
            body["provider"] = try oneOf(params["provider"], providers, "invalid provider")
            let dir = try optional(params["dir"], directory)
            let host = try optional(params["host"], Self.host)
            if let host, host != "local" {
                body["host"] = host
                if let dir {
                    guard dir.hasPrefix("/") else { throw PolicyError("invalid directory") }
                    body["remoteDir"] = dir
                }
            } else if let dir {
                body["dir"] = dir
            }
            if let model = try optional(params["model"], { try selection($0, maxBytes: 256, "invalid model") }) { body["model"] = model }
            if let effort = try optional(params["effort"], { try selection($0, maxBytes: 64, "invalid effort") }) { body["effort"] = effort }
            if let role = try optional(params["role"], Self.role) { body["role"] = role }
            return ActionPlan(request: try .json(try url("/api/agents"), body, timeout: 150), confirm: nil)
        case "permissions.answer":
            let agent = try MessagePolicy.agent(params["agent"])
            guard let id = params["id"] as? String, id.unicodeScalars.count == 26, id.unicodeScalars.allSatisfy(ulidCharacters.contains) else {
                throw PolicyError("invalid id")
            }
            guard let option = params["optionId"] as? String, MessagePolicy.isName(Substring(option)) else {
                throw PolicyError("invalid optionId")
            }
            return ActionPlan(request: try post(agent, "permissions/\(id)", ["optionId": option], timeout: 45), confirm: nil)
        case "prompt.answer":
            let agent = try MessagePolicy.agent(params["agent"])
            guard let id = params["id"] as? String, id.unicodeScalars.count == 32, id.unicodeScalars.allSatisfy(hexCharacters.contains) else {
                throw PolicyError("invalid id")
            }
            guard let option = params["optionId"] as? String, option.unicodeScalars.count == 1,
                  let digit = option.unicodeScalars.first, ("1"..."9").contains(digit) else { throw PolicyError("invalid optionId") }
            var body: [String: Any] = ["id": id, "optionId": option]
            let text = try optional(params["text"]) { value -> String in
                guard let text = value as? String, !text.isEmpty, isText(text, maxBytes: 2000, singleLine: true) else {
                    throw PolicyError("invalid text")
                }
                return text
            }
            if let text { body["text"] = text }
            return ActionPlan(request: try post(agent, "prompt", body, timeout: 45), confirm: nil)
        case "files.upload":
            let agent = try MessagePolicy.agent(params["agent"])
            guard let type = params["type"] as? String, imageTypes.contains(type) else { throw PolicyError("invalid type") }
            let bytes = try image(params["data"])
            guard matchesMagic(bytes, type: type) else { throw PolicyError("File is not a valid \(type) image") }
            let request = WriteRequest(method: .post, url: try agentURL(agent, "/files"), body: bytes, contentType: type, timeout: 120)
            return ActionPlan(request: request, confirm: nil)
        case "concierge.ensure":
            return ActionPlan(request: try .json(try url("/api/concierge"), [:], timeout: 120), confirm: nil)
        case "search.query":
            let query = try trimmedText(params["query"], maxBytes: 256, singleLine: true, "invalid query")
            guard query.unicodeScalars.count >= 2 else { throw PolicyError("invalid query") }
            return ActionPlan(request: try .json(try url("/api/search"), ["query": query], timeout: 30), confirm: nil)
        default:
            throw PolicyError("unknown method: \(method)")
        }
    }

    // MARK: Value rules

    /// T(n), or L(n) when `singleLine`: at most n UTF-8 bytes and no control characters.
    static func isText(_ text: String, maxBytes: Int, singleLine: Bool) -> Bool {
        text.utf8.count <= maxBytes && !MessagePolicy.hasControl(text, allowLineBreaks: !singleLine)
    }

    /// A new agent name or rename target. `concierge` is reserved by am.
    static func name(_ value: Any?) throws -> String {
        guard let text = value as? String, MessagePolicy.isName(Substring(text)), text != "concierge" else {
            throw PolicyError("invalid name: \(MessagePolicy.describe(value))")
        }
        return text
    }

    static func role(_ value: Any?) throws -> String {
        guard let text = value as? String, MessagePolicy.isName(Substring(text)), text != "concierge" else {
            throw PolicyError("invalid role")
        }
        return text
    }

    static func host(_ value: Any?) throws -> String {
        guard let text = value as? String, text == "local" || MessagePolicy.isHost(Substring(text)) else {
            throw PolicyError("invalid host: \(MessagePolicy.describe(value))")
        }
        return text
    }

    static func directory(_ value: Any?) throws -> String {
        guard let text = value as? String, isText(text, maxBytes: 4096, singleLine: true),
              text.hasPrefix("/") || text.hasPrefix("~") else { throw PolicyError("invalid directory") }
        return text
    }

    /// Free text that is sent trimmed (as message text is); the limit applies to what is sent.
    static func trimmedText(_ value: Any?, maxBytes: Int, singleLine: Bool, _ error: String) throws -> String {
        guard let raw = value as? String, !MessagePolicy.hasControl(raw, allowLineBreaks: !singleLine) else { throw PolicyError(error) }
        let text = raw.trimmingCharacters(in: trimmed)
        guard !text.isEmpty, text.utf8.count <= maxBytes else { throw PolicyError(error) }
        return text
    }

    /// A model or effort: L(n), non-empty after trimming, not an option. Sent trimmed, since am refuses padded values.
    static func selection(_ value: Any?, maxBytes: Int, _ error: String) throws -> String {
        let text = try trimmedText(value, maxBytes: maxBytes, singleLine: true, error)
        guard !text.hasPrefix("-") else { throw PolicyError(error) }
        return text
    }

    static func createdAt(_ value: Any?) throws -> String {
        guard let text = value as? String, !text.isEmpty, isText(text, maxBytes: 128, singleLine: true) else {
            throw PolicyError("invalid createdAt")
        }
        return text
    }

    static func oneOf(_ value: Any?, _ allowed: Set<String>, _ error: String) throws -> String {
        guard let text = value as? String, allowed.contains(text) else { throw PolicyError(error) }
        return text
    }

    /// Only a JavaScript boolean: WebKit hands numbers over as `NSNumber` too, and `1 as? Bool` would pass.
    static func boolean(_ value: Any?, _ error: String) throws -> Bool {
        guard let number = value as? NSNumber, CFGetTypeID(number) == CFBooleanGetTypeID() else { throw PolicyError(error) }
        return number.boolValue
    }

    /// Standard padded base64 of 1 byte to 10 MiB, decoded once.
    static func image(_ value: Any?) throws -> Data {
        guard let text = value as? String else { throw PolicyError("invalid data") }
        let length = text.utf8.count
        guard length > 0, length % 4 == 0, length <= maxUploadBase64, isBase64(text.utf8), let data = Data(base64Encoded: text),
              (1...maxUploadBytes).contains(data.count) else { throw PolicyError("invalid data") }
        return data
    }

    /// `^[A-Za-z0-9+/]*={0,2}$`: Foundation alone accepts some all-padding strings.
    private static func isBase64(_ bytes: String.UTF8View) -> Bool {
        var padding = 0
        for byte in bytes {
            switch byte {
            case UInt8(ascii: "="): padding += 1
            case UInt8(ascii: "A")...UInt8(ascii: "Z"), UInt8(ascii: "a")...UInt8(ascii: "z"), UInt8(ascii: "0")...UInt8(ascii: "9"),
                 UInt8(ascii: "+"), UInt8(ascii: "/"):
                if padding > 0 { return false }
            default: return false
            }
        }
        return padding <= 2
    }

    /// The same signatures am checks before writing the file.
    static func matchesMagic(_ data: Data, type: String) -> Bool {
        func ascii(_ range: Range<Int>, _ expected: String) -> Bool {
            data.count >= range.upperBound && data[data.startIndex + range.lowerBound ..< data.startIndex + range.upperBound]
                .elementsEqual(expected.utf8)
        }
        switch type {
        case "image/png": return data.first == 0x89 && ascii(1..<4, "PNG")
        case "image/jpeg": return data.count >= 3 && data.prefix(3).elementsEqual([0xFF, 0xD8, 0xFF])
        case "image/gif": return ascii(0..<4, "GIF8")
        case "image/webp": return ascii(0..<4, "RIFF") && ascii(8..<12, "WEBP")
        default: return false
        }
    }

    /// The agent's status from the pre-check detail, made safe to show in the sheet.
    static func status(fromDetail body: Data) -> String {
        guard let detail = try? JSONSerialization.jsonObject(with: body) as? [String: Any],
              let raw = detail["status"] as? String else { return "unknown" }
        let clean = String(String.UnicodeScalarView(raw.unicodeScalars.filter { !MessagePolicy.hasControl(String($0), allowLineBreaks: false) }))
            .trimmingCharacters(in: trimmed)
        return clean.isEmpty ? "unknown" : String(clean.prefix(64))
    }

    /// An optional param: absent and `null` both mean "not given".
    private static func optional<T>(_ value: Any?, _ rule: (Any?) throws -> T) throws -> T? {
        switch value {
        case nil, is NSNull: return nil
        default: return try rule(value)
        }
    }

    /// A param whose `null` is a real value; the result is `NSNull` so it serialises as JSON null.
    private static func nullable(_ value: Any?, _ rule: (Any?) throws -> String) throws -> Any {
        if value is NSNull { return NSNull() }
        return try rule(value)
    }
}
