import Foundation

/// HTTP client for am servers. It sends GETs, plus the writes a `WriteRequest` can describe, which
/// only `MessagePolicy` and `ActionPolicy` can build; there is no way to give it any other method,
/// path shape or body. Redirects are refused so the bearer token is never replayed to another origin;
/// the 3xx response is returned as-is. Nothing is retried.
@MainActor
final class APIClient: NSObject {
    static let maxBodyBytes = 32 << 20
    static let requestTimeout: TimeInterval = 30

    struct Response {
        let status: Int
        let body: Data
    }

    private final class Pending {
        var data = Data()
        var status = 0
        var failure: String?
        let continuation: CheckedContinuation<Response, Error>
        init(_ continuation: CheckedContinuation<Response, Error>) { self.continuation = continuation }
    }

    private var session: URLSession?
    /// One session per write timeout, since the resource timeout is a session setting.
    private var writeSessions: [TimeInterval: URLSession] = [:]
    // Task identifiers are only unique within one session, so pending requests are keyed by task.
    private var pending: [ObjectIdentifier: Pending] = [:]

    static func sessionConfiguration(requestTimeout: TimeInterval) -> URLSessionConfiguration {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.httpCookieStorage = nil
        configuration.httpShouldSetCookies = false
        configuration.httpCookieAcceptPolicy = .never
        configuration.urlCache = nil
        configuration.urlCredentialStorage = nil
        configuration.requestCachePolicy = .reloadIgnoringLocalAndRemoteCacheData
        configuration.timeoutIntervalForRequest = requestTimeout
        return configuration
    }

    nonisolated static func request(_ url: URL, token: String, accept: String, timeout: TimeInterval) -> URLRequest {
        var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalAndRemoteCacheData, timeoutInterval: timeout)
        request.httpMethod = "GET"
        request.httpShouldHandleCookies = false
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.setValue(accept, forHTTPHeaderField: "Accept")
        return request
    }

    /// The only shapes a write can take: `POST` with the policy's body and content type, or `DELETE` without a body.
    nonisolated static func request(_ write: WriteRequest, token: String) -> URLRequest {
        var request = Self.request(write.url, token: token, accept: "application/json", timeout: write.timeout)
        request.httpMethod = write.method.rawValue
        if let body = write.body {
            request.setValue(write.contentType ?? "application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = body
        }
        return request
    }

    func get(_ url: URL, token: String) async throws -> Response {
        let session = self.session ?? {
            let configuration = Self.sessionConfiguration(requestTimeout: Self.requestTimeout)
            configuration.timeoutIntervalForResource = 120
            // The session retains its delegate; the client lives as long as the app.
            let created = URLSession(configuration: configuration, delegate: self, delegateQueue: .main)
            self.session = created
            return created
        }()
        return try await perform(Self.request(url, token: token, accept: "application/json", timeout: Self.requestTimeout),
                                 in: session)
    }

    /// Sends a write once. A network failure or timeout throws: the server may or may not have
    /// acted on it, so retrying could deliver a message twice or create a second agent.
    func send(_ write: WriteRequest, token: String) async throws -> Response {
        let session = writeSessions[write.timeout] ?? {
            let configuration = Self.sessionConfiguration(requestTimeout: write.timeout)
            configuration.timeoutIntervalForResource = write.timeout
            let created = URLSession(configuration: configuration, delegate: self, delegateQueue: .main)
            writeSessions[write.timeout] = created
            return created
        }()
        return try await perform(Self.request(write, token: token), in: session)
    }

    /// Cancels every request in flight (at quit, so a long move does not outlive the app); each
    /// pending call rejects. Later calls create fresh sessions.
    func cancelAll() {
        session?.invalidateAndCancel()
        session = nil
        for session in writeSessions.values { session.invalidateAndCancel() }
        writeSessions.removeAll()
    }

    private func perform(_ request: URLRequest, in session: URLSession) async throws -> Response {
        try await withCheckedThrowingContinuation { continuation in
            let task = session.dataTask(with: request)
            pending[ObjectIdentifier(task)] = Pending(continuation)
            task.resume()
        }
    }

    private func received(_ response: URLResponse, task: URLSessionTask) -> URLSession.ResponseDisposition {
        guard let entry = pending[ObjectIdentifier(task)] else { return .cancel }
        entry.status = (response as? HTTPURLResponse)?.statusCode ?? 0
        if response.expectedContentLength > Int64(Self.maxBodyBytes) {
            entry.failure = "The response is larger than 32 MiB"
            return .cancel
        }
        return .allow
    }

    private func received(_ data: Data, task: URLSessionTask) {
        guard let entry = pending[ObjectIdentifier(task)] else { return }
        if entry.data.count + data.count > Self.maxBodyBytes {
            entry.failure = "The response is larger than 32 MiB"
            task.cancel()
        } else {
            entry.data.append(data)
        }
    }

    private func completed(_ task: URLSessionTask, error: Error?) {
        guard let entry = pending.removeValue(forKey: ObjectIdentifier(task)) else { return }
        if let failure = entry.failure {
            entry.continuation.resume(throwing: PolicyError(failure))
        } else if let error {
            entry.continuation.resume(throwing: PolicyError(error.localizedDescription))
        } else {
            entry.continuation.resume(returning: Response(status: entry.status, body: entry.data))
        }
    }
}

// The session's delegate queue is the main queue, so these callbacks already run on the main actor.
extension APIClient: URLSessionDataDelegate {
    nonisolated func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                                newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
    }

    nonisolated func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse,
                                completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
        completionHandler(MainActor.assumeIsolated { received(response, task: dataTask) })
    }

    nonisolated func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        MainActor.assumeIsolated { received(data, task: dataTask) }
    }

    nonisolated func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        MainActor.assumeIsolated { completed(task, error: error) }
    }
}
