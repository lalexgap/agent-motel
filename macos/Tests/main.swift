import Foundation

func check(_ condition: Bool, _ message: @autoclosure () -> String, line: Int = #line) {
    if !condition {
        print("FAIL line \(line): \(message())")
        exit(1)
    }
}

for value in ["am-app://app/index.html", "am-app://app/", "am-app://app/web/style.css?v=1#x"] {
    check(NavigationPolicy.decide(URL(string: value), userInitiated: false, newWindow: false) == .allow, value)
    check(NavigationPolicy.decide(URL(string: value), userInitiated: true, newWindow: true) == .cancel, "new window \(value)")
}
for value in ["am-app://evil/index.html", "am-app://user:pw@app/", "am-app://app:8080/", "https://am.example.com",
              "file:///etc/passwd", "javascript:alert(1)", "about:blank", "am://new", "data:text/html,hi"] {
    check(NavigationPolicy.decide(URL(string: value), userInitiated: false, newWindow: false) == .cancel, value)
}
for value in ["https://github.com/lalexgap/agent-motel", "http://127.0.0.1:8790/x"] {
    check(NavigationPolicy.decide(URL(string: value), userInitiated: true, newWindow: false) == .openExternally, value)
    check(NavigationPolicy.decide(URL(string: value), userInitiated: true, newWindow: true) == .openExternally, value)
    check(NavigationPolicy.decide(URL(string: value), userInitiated: false, newWindow: false) == .cancel, "script \(value)")
}
for value in ["https://user:secret@example.com", "https://user@example.com", "file:///tmp/x", "javascript:alert(1)",
              "mailto:a@example.com", "am-app://app/index.html", "https:///nohost"] {
    check(NavigationPolicy.decide(URL(string: value), userInitiated: true, newWindow: true) != .openExternally, value)
}
check(NavigationPolicy.decide(nil, userInitiated: true, newWindow: false) == .cancel, "nil url")
print("PASS navigation policy")

let accepted = [
    ("https://am.example.com/", "https://am.example.com"),
    ("https://AM.Example.com:443/agents?x=1#y", "https://am.example.com"),
    ("https://am.example.com:8443", "https://am.example.com:8443"),
    (" http://localhost:8790 ", "http://localhost:8790"),
    ("http://127.0.0.1", "http://127.0.0.1"),
    ("http://127.200.3.4:80/", "http://127.200.3.4"),
    ("http://[::1]:8790", "http://[::1]:8790"),
    ("http://100.64.0.1", "http://100.64.0.1"),
    ("http://100.127.255.254:8790", "http://100.127.255.254:8790"),
    ("http://foo.ts.net", "http://foo.ts.net"),
    ("http://box.tail1234.ts.net:8790/", "http://box.tail1234.ts.net:8790"),
    ("https://192.168.1.5", "https://192.168.1.5"),
]
for (input, expected) in accepted {
    do {
        let actual = try ConnectionPolicy.normalize(input)
        check(actual == expected, "\(input) -> \(actual), expected \(expected)")
    } catch {
        check(false, "\(input) rejected: \(error)")
    }
}
let rejected = [
    "http://100.128.0.1", "http://100.63.255.255", "http://evil.ts.net.example.com", "http://ts.net", "http://.ts.net",
    "http://192.168.1.5", "http://10.0.0.1", "http://am.example.com", "http://0x7f.0.0.1", "http://127.1",
    "http://localhost.example.com", "https://user:pw@am.example.com", "https://user@am.example.com",
    "http://user@localhost:8790", "ftp://am.example.com", "file:///etc/passwd", "javascript:alert(1)", "am.example.com",
    "", "https://", "https://am example.com", "https://am.example.com:0", "https://am.example.com\\@evil.com",
]
for input in rejected {
    check((try? ConnectionPolicy.normalize(input)) == nil, "accepted \(input)")
}
do {
    _ = try ConnectionPolicy.normalize("http://192.168.1.5")
} catch let error as PolicyError {
    check(error.message == ConnectionPolicy.httpRestriction, "http message: \(error.message)")
} catch {
    check(false, "unexpected error type")
}
print("PASS connection URL policy and normalisation")

let base = "http://127.0.0.1:8790"
for path in ["/api/health", "/api/agents", "/api/agents/annex%3Akelp-forest/transcript", "/api/agents?all=1&x=a%20b"] {
    do {
        let url = try ConnectionPolicy.apiURL(base: base, path: path)
        check(url.absoluteString == base + path, "\(path) -> \(url)")
        check(url.host == "127.0.0.1" && url.port == 8790 && url.scheme == "http", "host changed for \(path)")
    } catch {
        check(false, "\(path) rejected: \(error)")
    }
}
for path in ["/etc/passwd", "//evil.example/api/x", "/api/../x", "/api/%2e%2e/x", "/api/%2E%2E/x", "/api/x\\y",
             "/api/x%5c..", "/api/x#frag", "/api/x\u{0}", "/api/x%00", "/api/x\ny", "/api/x y", "api/health",
             "https://evil.example/api/x", "/api@evil.example/x", "/api/x%zz", "/api/x%4", "/API/health", ""] {
    check((try? ConnectionPolicy.apiURL(base: base, path: path)) == nil, "accepted \(path.debugDescription)")
}
check((try? ConnectionPolicy.apiURL(base: "https://am.example.com", path: "/api/@evil.example")).map { $0.host } == "am.example.com",
      "userinfo-looking segment changed host")
print("PASS api path validation")

for token in ["fixture-token", "abc.DEF_123~"] { check((try? ConnectionPolicy.validateToken(token)) != nil, token) }
for token in ["", "has space", "line\nbreak", "tab\t", "é"] { check((try? ConnectionPolicy.validateToken(token)) == nil, token.debugDescription) }
print("PASS token validation")

func parse(_ chunks: [String]) -> [SSEEvent] {
    var parser = SSEParser()
    return chunks.flatMap { try! parser.feed(Data($0.utf8)) }
}
check(parse(["event: ready\ndata: {\"ok\":true}\n\n"]) == [SSEEvent(event: "ready", data: "{\"ok\":true}", id: nil)], "basic")
check(parse(["data: a\ndata: b\n\n"]) == [SSEEvent(event: "message", data: "a\nb", id: nil)], "multi-line data")
check(parse([": keepalive\n\n", ": comment\ndata: x\n\n"]) == [SSEEvent(event: "message", data: "x", id: nil)], "comments")
check(parse(["event: fleet\r\ndata: 1\r\n\r\nevent: fleet\rdata: 2\r\r"]) ==
      [SSEEvent(event: "fleet", data: "1", id: nil), SSEEvent(event: "fleet", data: "2", id: nil)], "CRLF and CR")
check(parse(["event: fl", "eet\r", "\ndata: {\"a\"", ":1}\r", "\n\r", "\n"]) ==
      [SSEEvent(event: "fleet", data: "{\"a\":1}", id: nil)], "split chunks")
check(parse(["event: x\n\ndata: y\n\n"]) == [SSEEvent(event: "message", data: "y", id: nil)], "event without data resets")
check(parse(["data: z\n"]).isEmpty, "no dispatch without blank line")
check(parse(["data\n\n", "data:\n\n"]) == [SSEEvent(event: "message", data: "", id: nil), SSEEvent(event: "message", data: "", id: nil)], "empty data")
check(parse(["data:  two spaces\n\n"]) == [SSEEvent(event: "message", data: " two spaces", id: nil)], "only one space stripped")
check(parse(["\u{FEFF}data: bom\n\n"]) == [SSEEvent(event: "message", data: "bom", id: nil)], "BOM")
check(parse(["id: 7\ndata: a\n\n"]) == [SSEEvent(event: "message", data: "a", id: "7")], "id")
check(parse(["retry: 10\nfoo: bar\ndata: q\n\n"]) == [SSEEvent(event: "message", data: "q", id: nil)], "unknown fields")
var split = SSEParser()
let snowman = Array("data: ☃\n\n".utf8)
var splitEvents: [SSEEvent] = []
for byte in snowman { splitEvents += try! split.feed(Data([byte])) }
check(splitEvents == [SSEEvent(event: "message", data: "☃", id: nil)], "UTF-8 split across chunks")
var huge = SSEParser()
check((try? huge.feed(Data(repeating: 0x61, count: SSEParser.maxLineBytes + 1))) == nil, "oversized line")
print("PASS SSE parser")

let root = FileManager.default.temporaryDirectory.appendingPathComponent("am-resource-test-\(getpid())", isDirectory: true)
let outside = FileManager.default.temporaryDirectory.appendingPathComponent("am-resource-outside-\(getpid()).js")
try! FileManager.default.createDirectory(at: root.appendingPathComponent("web"), withIntermediateDirectories: true)
for name in ["index.html", "app.js", "web/style.css", "notes.txt"] {
    try! Data("x".utf8).write(to: root.appendingPathComponent(name))
}
try! Data("secret".utf8).write(to: outside)
try! FileManager.default.createSymbolicLink(at: root.appendingPathComponent("escape.js"), withDestinationURL: outside)
try! FileManager.default.createSymbolicLink(at: root.appendingPathComponent("linkdir"), withDestinationURL: FileManager.default.temporaryDirectory)
for (path, file, type) in [("/", "index.html", "text/html; charset=utf-8"), ("/index.html", "index.html", "text/html; charset=utf-8"),
                           ("/app.js", "app.js", "text/javascript; charset=utf-8"), ("/web/style.css", "web/style.css", "text/css; charset=utf-8"),
                           ("/web/", nil, nil), ("/%61pp.js", "app.js", "text/javascript; charset=utf-8")] as [(String, String?, String?)] {
    let found = BundleResource.resolve(root: root, encodedPath: path)
    if let file {
        check(found?.file.lastPathComponent == URL(fileURLWithPath: file).lastPathComponent && found?.contentType == type, path)
    } else {
        check(found == nil, "\(path) should be missing")
    }
}
for path in ["/../etc/passwd", "/web/../index.html", "/%2e%2e/x.js", "/./index.html", "//index.html", "/web\\style.css",
             "/escape.js", "/linkdir/\(outside.lastPathComponent)", "/notes.txt", "/missing.js", "/web", "/index.html%00.js", ""] {
    check(BundleResource.resolve(root: root, encodedPath: path) == nil, "served \(path)")
}
check(BundleResource.headers["Content-Security-Policy"]?.contains("connect-src 'none'") == true, "CSP")
try? FileManager.default.removeItem(at: root)
try? FileManager.default.removeItem(at: outside)
print("PASS bundle resource resolution")
