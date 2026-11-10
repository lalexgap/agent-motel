import Foundation

enum BundleResource {
    static let contentTypes = [
        "html": "text/html; charset=utf-8",
        "js": "text/javascript; charset=utf-8",
        "css": "text/css; charset=utf-8",
        "svg": "image/svg+xml",
        "png": "image/png",
        "json": "application/json; charset=utf-8",
        "woff2": "font/woff2",
    ]

    static let headers = [
        "Content-Security-Policy": "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'none'; base-uri 'none'; form-action 'none'",
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "no-store",
    ]

    /// Maps a URL path (still percent-encoded) to a regular file inside `root`, or nil.
    /// Rejects dot segments, backslashes, NULs, unknown extensions and anything that
    /// resolves (including through symlinks) outside `root`.
    static func resolve(root: URL, encodedPath: String) -> (file: URL, contentType: String)? {
        guard let decoded = encodedPath.removingPercentEncoding, decoded.hasPrefix("/"),
              !decoded.contains("\\"), !decoded.contains("\0") else { return nil }
        var relative = String(decoded.dropFirst())
        if relative.isEmpty || relative.hasSuffix("/") { relative += "index.html" }
        let segments = relative.split(separator: "/", omittingEmptySubsequences: false)
        guard !segments.contains(where: { $0.isEmpty || $0 == "." || $0 == ".." }) else { return nil }
        guard let ext = segments.last?.split(separator: ".").last.map({ $0.lowercased() }),
              segments.last?.contains(".") == true, let contentType = contentTypes[ext] else { return nil }
        let base = root.standardizedFileURL.resolvingSymlinksInPath()
        let file = base.appendingPathComponent(relative).standardizedFileURL.resolvingSymlinksInPath()
        guard file.path.hasPrefix(base.path + "/") else { return nil }
        var isDirectory: ObjCBool = false
        guard FileManager.default.fileExists(atPath: file.path, isDirectory: &isDirectory), !isDirectory.boolValue else {
            return nil
        }
        return (file, contentType)
    }
}
