import Foundation

struct SSEEvent: Equatable {
    var event: String
    var data: String
    var id: String?
}

/// Incremental parser for the text/event-stream format (WHATWG HTML §9.2.6).
/// Feed it bytes as they arrive; chunks may split lines, CRLF pairs or UTF-8 sequences.
struct SSEParser {
    static let maxLineBytes = 8 << 20

    struct LineTooLong: Error {}

    private var line: [UInt8] = []
    private var afterCR = false
    private var atStart = true
    private var eventType = ""
    private var dataBuffer = ""
    private var hasData = false
    private(set) var lastEventId: String?

    mutating func feed(_ chunk: Data) throws -> [SSEEvent] {
        var events: [SSEEvent] = []
        for byte in chunk {
            if afterCR {
                afterCR = false
                if byte == 0x0A { continue }
            }
            if byte == 0x0A || byte == 0x0D {
                afterCR = byte == 0x0D
                if let event = processLine() { events.append(event) }
                line.removeAll(keepingCapacity: true)
            } else {
                guard line.count < Self.maxLineBytes else { throw LineTooLong() }
                line.append(byte)
            }
        }
        return events
    }

    private mutating func processLine() -> SSEEvent? {
        var bytes = line[...]
        if atStart {
            atStart = false
            if bytes.starts(with: [0xEF, 0xBB, 0xBF]) { bytes = bytes.dropFirst(3) }
        }
        if bytes.isEmpty { return dispatch() }
        if bytes.first == UInt8(ascii: ":") { return nil }
        let text = String(decoding: bytes, as: UTF8.self)
        let field: Substring
        var value: Substring
        if let colon = text.firstIndex(of: ":") {
            field = text[..<colon]
            value = text[text.index(after: colon)...]
            if value.first == " " { value = value.dropFirst() }
        } else {
            field = text[...]
            value = ""
        }
        switch field {
        case "event": eventType = String(value)
        case "data":
            dataBuffer += value
            dataBuffer += "\n"
            hasData = true
        case "id": if !value.contains("\0") { lastEventId = String(value) }
        default: break
        }
        return nil
    }

    private mutating func dispatch() -> SSEEvent? {
        defer {
            eventType = ""
            dataBuffer = ""
            hasData = false
        }
        guard hasData else { return nil }
        var data = dataBuffer
        if data.hasSuffix("\n") { data.removeLast() }
        return SSEEvent(event: eventType.isEmpty ? "message" : eventType, data: data, id: lastEventId)
    }
}
