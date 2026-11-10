import Foundation

/// One long-lived `GET /api/events` stream for a connection, reconnecting with backoff.
@MainActor
final class EventStream: NSObject {
    enum State: String {
        case connecting, open, closed
    }

    static let minDelay: TimeInterval = 1
    static let maxDelay: TimeInterval = 30
    /// The daemon sends a keepalive comment every 15s, so 45s of silence means the link is dead.
    static let idleTimeout: TimeInterval = 45

    struct Credentials {
        let base: String
        let token: String
    }

    let connectionID: String
    private(set) var state: State = .closed
    private(set) var lastError: String?
    private let credentials: () -> Credentials?
    private let onState: (EventStream) -> Void
    private let onEvent: (EventStream, SSEEvent) -> Void
    private var session: URLSession?
    private var task: URLSessionDataTask?
    private var parser = SSEParser()
    private var delay = minDelay
    private var pendingError: String?
    private var retryAtMax = false
    private var retry: Task<Void, Never>?
    private var running = false

    /// `credentials` is read on every attempt so a fixed token or URL is picked up.
    init(connectionID: String, credentials: @escaping () -> Credentials?,
         onState: @escaping (EventStream) -> Void, onEvent: @escaping (EventStream, SSEEvent) -> Void) {
        self.connectionID = connectionID
        self.credentials = credentials
        self.onState = onState
        self.onEvent = onEvent
    }

    func start() {
        guard !running else { return }
        running = true
        delay = Self.minDelay
        connect()
    }

    /// Drops the current attempt and reconnects immediately, e.g. after the token changed.
    func restart() {
        guard running else { return }
        retry?.cancel()
        retry = nil
        let old = task
        task = nil
        old?.cancel()
        delay = Self.minDelay
        connect()
    }

    func stop() {
        running = false
        retry?.cancel()
        retry = nil
        task = nil
        session?.invalidateAndCancel()
        session = nil
        state = .closed
        lastError = nil
    }

    private func connect() {
        guard running else { return }
        pendingError = nil
        retryAtMax = false
        guard let credentials = credentials() else {
            fail("This connection has no saved token", atMax: true)
            return
        }
        guard let url = try? ConnectionPolicy.apiURL(base: credentials.base, path: "/api/events") else {
            fail("The connection URL is invalid", atMax: true)
            return
        }
        let session = self.session ?? {
            // The session retains this stream as its delegate until stop() invalidates it.
            let created = URLSession(configuration: APIClient.sessionConfiguration(requestTimeout: Self.idleTimeout),
                                     delegate: self, delegateQueue: .main)
            self.session = created
            return created
        }()
        parser = SSEParser()
        let task = session.dataTask(with: APIClient.request(url, token: credentials.token, accept: "text/event-stream",
                                                            timeout: Self.idleTimeout))
        self.task = task
        set(.connecting, error: nil)
        task.resume()
    }

    private func set(_ state: State, error: String?) {
        self.state = state
        lastError = error
        onState(self)
    }

    private func fail(_ message: String, atMax: Bool) {
        set(.closed, error: message)
        let wait = atMax ? Self.maxDelay : delay
        delay = min(delay * 2, Self.maxDelay)
        retry = Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(wait * 1_000_000_000))
            guard !Task.isCancelled, let self, self.running else { return }
            self.retry = nil
            self.connect()
        }
    }

    private func received(_ response: URLResponse, task: URLSessionTask) -> URLSession.ResponseDisposition {
        guard task === self.task else { return .cancel }
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        if status == 200, response.mimeType?.lowercased() == "text/event-stream" {
            delay = Self.minDelay
            set(.open, error: nil)
            return .allow
        }
        switch status {
        case 401:
            pendingError = "Unauthorized: check the access token"
            retryAtMax = true
        case 200: pendingError = "The server did not return an event stream"
        default: pendingError = "The event stream returned HTTP \(status)"
        }
        return .cancel
    }

    private func received(_ data: Data, task: URLSessionTask) {
        guard task === self.task else { return }
        do {
            for event in try parser.feed(data) { onEvent(self, event) }
        } catch {
            pendingError = "The event stream sent an oversized event"
            task.cancel()
        }
    }

    private func completed(_ task: URLSessionTask, error: Error?) {
        guard task === self.task, running else { return }
        self.task = nil
        let message = pendingError ?? error?.localizedDescription ?? "The event stream ended"
        fail(message, atMax: retryAtMax)
    }
}

// The session's delegate queue is the main queue, so these callbacks already run on the main actor.
extension EventStream: URLSessionDataDelegate {
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
