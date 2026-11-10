import Foundation
import WebKit

/// Serves `am-app://app/<path>` from the bundled frontend in `Contents/Resources/web`.
@MainActor
final class AppSchemeHandler: NSObject, WKURLSchemeHandler {
    private let root: URL

    init(root: URL) {
        self.root = root
    }

    func webView(_ webView: WKWebView, start urlSchemeTask: any WKURLSchemeTask) {
        guard let url = urlSchemeTask.request.url else {
            urlSchemeTask.didFailWithError(URLError(.badURL))
            return
        }
        let method = urlSchemeTask.request.httpMethod ?? "GET"
        if NavigationPolicy.isInternal(url), method == "GET",
           let path = URLComponents(url: url, resolvingAgainstBaseURL: false)?.percentEncodedPath,
           let found = BundleResource.resolve(root: root, encodedPath: path),
           let body = try? Data(contentsOf: found.file) {
            respond(urlSchemeTask, url: url, status: 200, contentType: found.contentType, body: body)
        } else {
            respond(urlSchemeTask, url: url, status: 404, contentType: "text/plain; charset=utf-8", body: Data("Not found".utf8))
        }
    }

    func webView(_ webView: WKWebView, stop urlSchemeTask: any WKURLSchemeTask) {}

    private func respond(_ task: any WKURLSchemeTask, url: URL, status: Int, contentType: String, body: Data) {
        var headers = BundleResource.headers
        headers["Content-Type"] = contentType
        headers["Content-Length"] = String(body.count)
        guard let response = HTTPURLResponse(url: url, statusCode: status, httpVersion: "HTTP/1.1", headerFields: headers) else {
            task.didFailWithError(URLError(.cannotParseResponse))
            return
        }
        task.didReceive(response)
        task.didReceive(body)
        task.didFinish()
    }
}
