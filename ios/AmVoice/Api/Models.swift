import Foundation

// Mirrors the JSON shapes served by `am serve` (src/server.ts). Statuses stay
// plain strings so an unknown value from a newer server never breaks decoding.

struct FleetResponse: Decodable {
    let rows: [FleetRow]
    let unreachable: [String]
}

struct FleetRow: Decodable, Identifiable, Hashable {
    let name: String
    let status: String
    let provider: String
    let queued: Int
    let updatedAt: String
    let dir: String
    let task: String?
    let worktreeBranch: String?
    let statusDetail: String?
    let host: String?

    var id: String { host.map { "\($0):\(name)" } ?? name }
    var isRemote: Bool { host != nil }
}

struct TranscriptPage: Decodable {
    let status: String
    let provider: String
    let total: Int
    let turns: [Turn]
}

struct Turn: Decodable, Hashable {
    let kind: String // user | assistant | tool
    let text: String?
    let name: String?
    let input: String?
    let output: String?
}

enum AgentStatus {
    static func symbol(_ status: String) -> String {
        switch status {
        case "working": return "circle.fill"
        case "waiting": return "circle.lefthalf.filled"
        case "needs-attention": return "exclamationmark.triangle.fill"
        case "starting": return "circle.dotted"
        case "exited", "dead": return "xmark.circle"
        default: return "circle" // idle
        }
    }

    static func color(_ status: String) -> ColorName {
        switch status {
        case "working": return .green
        case "waiting": return .orange
        case "needs-attention": return .red
        case "exited", "dead": return .gray
        default: return .secondary
        }
    }

    enum ColorName { case green, orange, red, gray, secondary }
}

func relativeTime(fromISO iso: String) -> String {
    let withFraction = ISO8601DateFormatter()
    withFraction.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    let plain = ISO8601DateFormatter()
    guard let date = withFraction.date(from: iso) ?? plain.date(from: iso) else { return "" }
    let seconds = max(0, Int(Date().timeIntervalSince(date)))
    if seconds < 60 { return "\(seconds)s ago" }
    if seconds < 3600 { return "\(seconds / 60)m ago" }
    if seconds < 86400 { return "\(seconds / 3600)h ago" }
    return "\(seconds / 86400)d ago"
}
