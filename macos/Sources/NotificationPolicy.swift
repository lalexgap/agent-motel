import Foundation

/// am's notification kinds, each with its own on/off preference.
enum NotificationKind: String, CaseIterable {
    case attention, decision, idle, share, pr

    var label: String {
        switch self {
        case .attention: return "Needs Attention"
        case .decision: return "Decision Requests"
        case .idle: return "Finished Work"
        case .share: return "Shared Files"
        case .pr: return "Pull Requests"
        }
    }
}

/// A notification handed over by am's daemon on this Mac as
/// `agent-motel://notify?v=1&title=…&message=…[&id&host&agent&kind&url]`.
/// Any local process can open that URL, so every field is validated and the
/// only things a notification can do are show text, open an agent in this app
/// and open a GitHub pull request in the browser.
struct IncomingNotification: Equatable {
    let id: String?
    let host: String?
    let agent: String?
    let kind: NotificationKind?
    let title: String
    let message: String
    let pullRequest: URL?

    /// Delivery ids repeat only for the same journal entry, so a re-sent
    /// notification replaces the banner instead of stacking a second one.
    var requestIdentifier: String? {
        guard let id else { return nil }
        return "\(host ?? "-")/\(id)"
    }

    /// One Notification Center group per agent.
    var threadIdentifier: String {
        guard let agent else { return "am" }
        return "\(host ?? "-")/\(agent)"
    }
}

struct NotificationPreferences: Equatable {
    var enabled: Set<NotificationKind> = Set(NotificationKind.allCases)
    var quietHours = false
    /// Minutes after midnight, local time.
    var quietStart = 22 * 60
    var quietEnd = 8 * 60
}

enum NotificationDelivery: Equatable {
    case drop
    /// Banner and sound.
    case alert
    /// Notification Center only, no banner or sound.
    case quiet
}

enum NotificationPolicy {
    static let scheme = "agent-motel"
    static let titleLimit = 200
    static let messageLimit = 1000

    static func parse(_ url: URL) -> IncomingNotification? {
        guard url.scheme?.lowercased() == scheme, url.host == "notify", url.user == nil, url.password == nil,
              let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems else { return nil }
        var fields: [String: String] = [:]
        for item in items {
            // A repeated field is ambiguous; refuse rather than pick one.
            guard fields[item.name] == nil, let value = item.value else { return nil }
            fields[item.name] = value
        }
        guard fields["v"] == "1", let title = text(fields["title"], limit: titleLimit), !title.isEmpty,
              let message = text(fields["message"], limit: messageLimit) else { return nil }
        var kind: NotificationKind?
        if let raw = fields["kind"] {
            guard let parsed = NotificationKind(rawValue: raw) else { return nil }
            kind = parsed
        }
        let id = fields["id"].flatMap { isID($0) ? $0 : nil }
        let host = fields["host"].flatMap { MessagePolicy.isHost(Substring($0)) ? $0 : nil }
        let agent = fields["agent"].flatMap { MessagePolicy.isName(Substring($0)) ? $0 : nil }
        return IncomingNotification(id: id, host: host, agent: agent, kind: kind, title: title, message: message,
                                    pullRequest: fields["url"].flatMap(pullRequestURL))
    }

    /// Single-line text: control characters become spaces, then trimmed and capped.
    static func text(_ value: String?, limit: Int) -> String? {
        guard let value else { return nil }
        let cleaned = String(String.UnicodeScalarView(value.unicodeScalars.map {
            CharacterSet.controlCharacters.contains($0) ? " " : $0
        })).trimmingCharacters(in: .whitespaces)
        return String(cleaned.prefix(limit))
    }

    static func isID(_ value: String) -> Bool {
        (1...64).contains(value.unicodeScalars.count) && value.unicodeScalars.allSatisfy(MessagePolicy.nameCharacters.contains)
    }

    /// Only `https://github.com/<owner>/<repo>/pull/<n>`, the same rule as am's notifier.
    static func pullRequestURL(_ value: String) -> URL? {
        let parts = value.split(separator: "/", omittingEmptySubsequences: false)
        guard value.hasPrefix("https://github.com/"), parts.count == 7, parts[5] == "pull",
              [parts[3], parts[4]].allSatisfy(isRepoPart),
              let number = Int(parts[6]), number > 0, String(number) == parts[6] else { return nil }
        return URL(string: value)
    }

    private static func isRepoPart(_ part: Substring) -> Bool {
        let allowed = CharacterSet(charactersIn: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_.-")
        return !part.isEmpty && part != "." && part != ".." && part.unicodeScalars.allSatisfy(allowed.contains)
    }

    /// Summaries carry no kind and always show, quietly in quiet hours.
    static func delivery(for kind: NotificationKind?, preferences: NotificationPreferences, minuteOfDay: Int) -> NotificationDelivery {
        if let kind, !preferences.enabled.contains(kind) { return .drop }
        if preferences.quietHours, inQuietHours(minuteOfDay, start: preferences.quietStart, end: preferences.quietEnd) {
            return .quiet
        }
        return .alert
    }

    /// Immediate local guard for remote agents only. The server remains authoritative; summaries
    /// and local names lack a reliable owning-host identity and must never be suppressed here.
    static func suppressFocusedIdle(kind: NotificationKind?, appFocused: Bool, focusedAgent: String?,
                                    incomingHost: String?, incomingAgent: String?) -> Bool {
        guard kind == .idle, appFocused, let host = incomingHost, let agent = incomingAgent,
              let focusedAgent else { return false }
        return "\(host):\(agent)" == focusedAgent
    }

    /// `[start, end)`, wrapping past midnight when start > end; empty when they are equal.
    static func inQuietHours(_ minute: Int, start: Int, end: Int) -> Bool {
        if start == end { return false }
        return start < end ? (minute >= start && minute < end) : (minute >= start || minute < end)
    }

    static func clock(_ minutes: Int) -> String {
        String(format: "%02d:%02d", minutes / 60, minutes % 60)
    }
}
