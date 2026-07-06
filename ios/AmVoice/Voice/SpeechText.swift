import Foundation

// Pure text plumbing for the voice loop: the per-message hint that makes an
// agent lead with a spoken summary, extraction of that summary, and a
// best-effort "make markdown listenable" fallback for agents that ignore it.
enum SpeechText {
    // Appended to every mic-originated message (and typed ones when the
    // "voice replies" toggle is on). Per-message and stateless on purpose:
    // works for Claude and Codex alike, and desktop sessions stay untouched.
    static let voiceHint = "\n\n(The user is talking to you by voice on their phone. Begin your reply with a 1-2 sentence spoken summary wrapped in <voice>...</voice> tags, then continue with your normal full response.)"

    // What the synthesizer should say for an assistant message: the <voice>
    // block when present, otherwise the whole message stripped for listening.
    static func spoken(from message: String) -> String {
        if let summary = voiceBlock(in: message) { return summary }
        return strippedForSpeech(message)
    }

    // What the chat bubble should show: tags removed, content kept.
    static func display(from message: String) -> String {
        message
            .replacingOccurrences(of: "<voice>", with: "")
            .replacingOccurrences(of: "</voice>", with: "")
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }

    // A user turn came back from the transcript with our hint attached —
    // trim it for display and remember it was a voice message.
    static func userDisplay(from message: String) -> (text: String, wasVoice: Bool) {
        guard let range = message.range(of: voiceHint.trimmingCharacters(in: .whitespacesAndNewlines)) else {
            return (message, false)
        }
        var text = message
        text.removeSubrange(range)
        return (text.trimmingCharacters(in: .whitespacesAndNewlines), true)
    }

    static func voiceBlock(in message: String) -> String? {
        guard let open = message.range(of: "<voice>"),
              let close = message.range(of: "</voice>", range: open.upperBound..<message.endIndex)
        else { return nil }
        let block = message[open.upperBound..<close.lowerBound].trimmingCharacters(in: .whitespacesAndNewlines)
        return block.isEmpty ? nil : block
    }

    // Fallback speech: fenced code → a spoken marker, markdown syntax and
    // URLs collapsed so the synthesizer doesn't read soup aloud.
    static func strippedForSpeech(_ message: String) -> String {
        var text = message
        text = replaceAll(text, pattern: "```[\\s\\S]*?```", with: " …code block… ")
        text = replaceAll(text, pattern: "`([^`\\n]*)`", with: "$1")
        text = replaceAll(text, pattern: "(?m)^#{1,6}\\s+", with: "")
        text = replaceAll(text, pattern: "(?m)^\\s*[-*+]\\s+", with: "")
        text = replaceAll(text, pattern: "\\[([^\\]]+)\\]\\([^)]*\\)", with: "$1") // markdown link → label
        text = replaceAll(text, pattern: "https?://\\S+", with: " a link ")
        text = replaceAll(text, pattern: "[*_]{1,3}([^*_]+)[*_]{1,3}", with: "$1")
        text = replaceAll(text, pattern: "\\n{2,}", with: "\n")
        return text.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private static func replaceAll(_ text: String, pattern: String, with template: String) -> String {
        guard let regex = try? NSRegularExpression(pattern: pattern) else { return text }
        return regex.stringByReplacingMatches(
            in: text,
            range: NSRange(text.startIndex..., in: text),
            withTemplate: template
        )
    }
}
