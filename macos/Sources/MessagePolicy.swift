import Foundation

/// One of the only two non-GET requests the app can make. The initialiser is private to this file,
/// so every instance comes from `MessagePolicy`, which validates the values and builds the path itself.
struct MessageRequest: Equatable {
    enum Method: String {
        case post = "POST"
        case delete = "DELETE"
    }

    let method: Method
    let url: URL
    /// JSON `{"mode", "text"}` for a send; nil for a cancel.
    let body: Data?

    fileprivate init(method: Method, url: URL, body: Data?) {
        self.method = method
        self.url = url
        self.body = body
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
    static let emptyText = "Message is empty"
    static let longText = "Message is too long (limit 100,000 bytes)"
    static let badMode = "mode must be queue or now"

    private static let nameCharacters = Set("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-".unicodeScalars)
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

    static func send(base: String, agent rawAgent: Any?, text rawText: Any?, mode rawMode: Any?) throws -> MessageRequest {
        let agent = try agent(rawAgent)
        let text = try text(rawText)
        let mode = try mode(rawMode)
        let url = try ConnectionPolicy.apiURL(base: base, path: "/api/agents/\(encodedAgent(agent))/messages")
        let body = try JSONSerialization.data(withJSONObject: ["text": text, "mode": mode.rawValue], options: [.sortedKeys, .withoutEscapingSlashes])
        return MessageRequest(method: .post, url: url, body: body)
    }

    static func cancel(base: String, agent rawAgent: Any?, id rawID: Any?) throws -> MessageRequest {
        let agent = try agent(rawAgent)
        let id = try messageID(rawID)
        let url = try ConnectionPolicy.apiURL(base: base, path: "/api/agents/\(encodedAgent(agent))/messages/\(id)")
        return MessageRequest(method: .delete, url: url, body: nil)
    }

    private static func isName(_ part: Substring) -> Bool {
        (1...64).contains(part.unicodeScalars.count) && part.unicodeScalars.allSatisfy(nameCharacters.contains)
    }

    private static func isHost(_ part: Substring) -> Bool {
        guard let first = part.unicodeScalars.first, first != ".", first != "-" else { return false }
        return part.unicodeScalars.count <= 255 && part.unicodeScalars.allSatisfy(hostCharacters.contains)
    }

    private static func describe(_ value: Any?) -> String {
        switch value {
        case nil, is NSNull: return "null"
        case let text as String: return text
        case let other?: return String(describing: other)
        }
    }
}
