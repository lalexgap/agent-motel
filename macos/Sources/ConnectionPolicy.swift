import Foundation

struct PolicyError: Error, LocalizedError, Equatable {
    let message: String
    init(_ message: String) { self.message = message }
    var errorDescription: String? { message }
}

enum ConnectionPolicy {
    static let httpRestriction = "Plain http is only allowed for localhost and Tailscale addresses"

    /// Validates a server URL and reduces it to `scheme://host[:port]`.
    static func normalize(_ raw: String) throws -> String {
        let text = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { throw PolicyError("Enter the server URL") }
        guard text.unicodeScalars.allSatisfy({ $0.value > 0x20 && $0.value != 0x7f }), !text.contains("\\"),
              let parts = URLComponents(string: text), let rawScheme = parts.scheme else {
            throw PolicyError("Not a valid URL")
        }
        let scheme = rawScheme.lowercased()
        guard scheme == "https" || scheme == "http" else { throw PolicyError("The URL must start with https://") }
        guard parts.user == nil, parts.password == nil, !(parts.percentEncodedHost ?? "").contains("@") else {
            throw PolicyError("The URL must not contain a user name or password")
        }
        var host = (parts.host ?? "").lowercased()
        if host.hasPrefix("[") && host.hasSuffix("]") { host = String(host.dropFirst().dropLast()) }
        guard !host.isEmpty, !host.contains("%") else { throw PolicyError("The URL has no host") }
        let ipv6 = host.contains(":")
        let allowed = CharacterSet(charactersIn: ipv6 ? "0123456789abcdef:." : "abcdefghijklmnopqrstuvwxyz0123456789.-")
        guard host.unicodeScalars.allSatisfy(allowed.contains) else { throw PolicyError("The URL has an invalid host") }
        if scheme == "http" && !allowsPlainHTTP(host: host) { throw PolicyError(httpRestriction) }
        var port = ""
        if let value = parts.port {
            guard (1...65535).contains(value) else { throw PolicyError("The URL has an invalid port") }
            if !(scheme == "https" && value == 443) && !(scheme == "http" && value == 80) { port = ":\(value)" }
        }
        let base = "\(scheme)://\(ipv6 ? "[\(host)]" : host)\(port)"
        guard URL(string: base) != nil else { throw PolicyError("Not a valid URL") }
        return base
    }

    static func allowsPlainHTTP(host: String) -> Bool {
        if host == "localhost" || host == "::1" { return true }
        if host.hasSuffix(".ts.net"), host.count > ".ts.net".count, !host.hasPrefix(".") { return true }
        guard let octets = ipv4(host) else { return false }
        return octets[0] == 127 || (octets[0] == 100 && (64...127).contains(octets[1]))
    }

    /// Strict dotted-quad parse; shorthand and hex forms are not treated as addresses.
    static func ipv4(_ host: String) -> [Int]? {
        let pieces = host.split(separator: ".", omittingEmptySubsequences: false)
        guard pieces.count == 4 else { return nil }
        var octets: [Int] = []
        for piece in pieces {
            guard (1...3).contains(piece.count), piece.allSatisfy({ $0.isASCII && $0.isNumber }),
                  piece.count == 1 || piece.first != "0", let value = Int(piece), value <= 255 else { return nil }
            octets.append(value)
        }
        return octets
    }

    private static let pathCharacters = CharacterSet(
        charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~!$&'()*+,;=:@/?%")
    private static let hexDigits = Set("0123456789abcdefABCDEF")

    /// Checks an `api.get` path. The URL is built from the stored base plus this path, so the
    /// path alone can never change scheme, host or port.
    static func validateAPIPath(_ path: String) throws {
        guard path.hasPrefix("/api/") else { throw PolicyError("The path must start with /api/") }
        guard path.count <= 4096 else { throw PolicyError("The path is too long") }
        guard path.unicodeScalars.allSatisfy(pathCharacters.contains) else {
            throw PolicyError("The path contains characters that are not allowed (encode them)")
        }
        let characters = Array(path)
        for (index, character) in characters.enumerated() where character == "%" {
            guard index + 2 < characters.count, hexDigits.contains(characters[index + 1]),
                  hexDigits.contains(characters[index + 2]) else { throw PolicyError("The path has an invalid % escape") }
        }
        let decoded = path.removingPercentEncoding ?? path
        guard !path.contains(".."), !decoded.contains(".."), !decoded.contains("\\") else {
            throw PolicyError("The path must not contain .. or a backslash")
        }
        guard !decoded.unicodeScalars.contains(where: { $0.value < 0x20 || $0.value == 0x7f }) else {
            throw PolicyError("The path must not contain control characters")
        }
    }

    static func apiURL(base: String, path: String) throws -> URL {
        try validateAPIPath(path)
        guard let baseURL = URL(string: base), let url = URL(string: base + path),
              url.scheme == baseURL.scheme, url.host == baseURL.host, url.port == baseURL.port,
              url.user == nil, url.password == nil, url.fragment == nil, url.path.hasPrefix("/api/") else {
            throw PolicyError("The path does not form a valid URL")
        }
        return url
    }

    static func validateToken(_ token: String) throws {
        guard !token.isEmpty else { throw PolicyError("Enter the access token") }
        guard token.count <= 4096 else { throw PolicyError("The access token is too long") }
        guard token.unicodeScalars.allSatisfy({ $0.value > 0x20 && $0.value < 0x7f }) else {
            throw PolicyError("The access token must be printable ASCII without spaces")
        }
    }
}
