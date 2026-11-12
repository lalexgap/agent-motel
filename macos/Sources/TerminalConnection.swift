import Foundation

/// `terminal.closed` is emitted exactly once, after which nothing more is emitted for the id.
@MainActor
final class TerminalConnection: NSObject {
    /// `status` is 0 when there was no HTTP refusal.
    struct UpgradeFailure: Error {
        let status: Int
    }

    typealias Emit = (_ name: String, _ payload: [String: Any], _ delivered: (@MainActor @Sendable () -> Void)?) -> Void

    let id: String
    let connectionID: String
    let cookie: SessionCookie
    private let emit: Emit
    private let onFinish: (TerminalConnection, Int) -> Void

    private enum State {
        case connecting, open, closed
    }

    private var state = State.connecting
    /// Set once the page has the id; events wait for it.
    private var started = false
    private var deferredClose: (code: Int, reason: String)?
    private var session: URLSession?
    private var task: URLSessionWebSocketTask?
    private var opening: CheckedContinuation<Void, Error>?
    private var output = OutputBuffer()
    private var flushTimer: Task<Void, Never>?
    private var pinger: Task<Void, Never>?
    private var receiver: Task<Void, Never>?
    private var lastSend: Task<Bool, Never>?
    private var queuedInput = 0

    init(id: String, connectionID: String, cookie: SessionCookie, emit: @escaping Emit,
         onFinish: @escaping (TerminalConnection, Int) -> Void) {
        self.id = id
        self.connectionID = connectionID
        self.cookie = cookie
        self.emit = emit
        self.onFinish = onFinish
    }

    var isClosed: Bool { state == .closed }

    func connect(_ request: TerminalRequest) async throws {
        guard request.kind == .upgrade, state == .connecting, task == nil else { throw UpgradeFailure(status: 0) }
        let configuration = APIClient.sessionConfiguration(requestTimeout: TerminalPolicy.upgradeTimeout)
        // An open terminal may sit idle for hours; the handshake has its own timer below.
        configuration.timeoutIntervalForRequest = .greatestFiniteMagnitude
        configuration.timeoutIntervalForResource = .greatestFiniteMagnitude
        var upgrade = request.request
        upgrade.timeoutInterval = .greatestFiniteMagnitude
        // The session retains this connection as its delegate until `finish` invalidates it.
        let session = URLSession(configuration: configuration, delegate: self, delegateQueue: .main)
        let task = session.webSocketTask(with: upgrade)
        self.session = session
        self.task = task
        let timer = Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(TerminalPolicy.upgradeTimeout * 1_000_000_000))
            guard !Task.isCancelled else { return }
            self?.failOpening(status: 0)
        }
        defer { timer.cancel() }
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            opening = continuation
            task.resume()
        }
    }

    /// Called once the page has received the id.
    func start() {
        guard !started else { return }
        started = true
        if let close = deferredClose {
            deferredClose = nil
            emitClosed(code: close.code, reason: close.reason)
            return
        }
        guard state == .open, let task else { return }
        receiver = Task { @MainActor [weak self] in
            while true {
                let message: URLSessionWebSocketTask.Message
                do {
                    message = try await task.receive()
                } catch {
                    self?.receiveEnded(task)
                    return
                }
                guard let self, self.task === task, self.state == .open else { return }
                self.received(message)
            }
        }
        pinger = Task { @MainActor [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: UInt64(TerminalPolicy.pingInterval * 1_000_000_000))
                guard !Task.isCancelled, let self, self.state == .open, self.task === task else { return }
                task.sendPing { [weak self] error in
                    guard error != nil else { return }
                    Task { @MainActor in
                        guard let self, self.task === task else { return }
                        self.finish(code: TerminalPolicy.lostCode, reason: TerminalPolicy.lostReason)
                    }
                }
            }
        }
    }

    /// In order; never merged or retried.
    func send(_ frame: String) async throws {
        guard state == .open, let task else { throw PolicyError(TerminalPolicy.unknownTerminal) }
        let size = frame.utf8.count
        guard queuedInput + size <= TerminalPolicy.maxQueuedInput else {
            finish(code: TerminalPolicy.inputOverflowCode, reason: TerminalPolicy.inputOverflowReason)
            throw PolicyError(TerminalPolicy.inputOverflowReason)
        }
        queuedInput += size
        let previous = lastSend
        let sending = Task { @MainActor [weak self] () -> Bool in
            guard await previous?.value ?? true, let self, self.state == .open, self.task === task else { return false }
            do {
                try await task.send(.string(frame))
                return true
            } catch {
                return false
            }
        }
        lastSend = sending
        let sent = await sending.value
        queuedInput -= size
        guard sent else {
            finish(code: TerminalPolicy.lostCode, reason: TerminalPolicy.lostReason)
            throw PolicyError(TerminalPolicy.unknownTerminal)
        }
    }

    /// `notify` false is for a page that is gone. While still connecting, the pending `connect`
    /// throws `reason`.
    func finish(code: Int, reason: String, notify: Bool = true) {
        guard state != .closed else { return }
        let wasOpen = state == .open
        state = .closed
        flushTimer?.cancel()
        flushTimer = nil
        pinger?.cancel()
        pinger = nil
        receiver?.cancel()
        receiver = nil
        if code == TerminalPolicy.overflowCode || !notify {
            output.clear()
        } else if started {
            // Output received before the close still reaches the page first, in order.
            flush()
        }
        task?.cancel(with: code == TerminalPolicy.closedCode ? .normalClosure : .goingAway, reason: nil)
        task = nil
        session?.finishTasksAndInvalidate()
        session = nil
        if let opening {
            self.opening = nil
            opening.resume(throwing: PolicyError(reason))
        }
        if notify && wasOpen {
            if started {
                emitClosed(code: code, reason: reason)
            } else {
                deferredClose = (code, reason)
            }
        }
        onFinish(self, code)
    }

    // MARK: Socket events

    private func opened(_ task: URLSessionWebSocketTask) {
        guard task === self.task, state == .connecting else { return }
        state = .open
        let opening = self.opening
        self.opening = nil
        opening?.resume()
    }

    private func failOpening(status: Int) {
        guard state == .connecting else { return }
        let opening = self.opening
        self.opening = nil
        finish(code: TerminalPolicy.lostCode, reason: TerminalPolicy.lostReason, notify: false)
        opening?.resume(throwing: UpgradeFailure(status: status))
    }

    private func serverClosed(_ task: URLSessionWebSocketTask, code: Int, reason: Data?) {
        guard task === self.task else { return }
        if state == .connecting { return failOpening(status: 0) }
        finish(code: code == 0 ? TerminalPolicy.lostCode : code,
               reason: code == 0 ? TerminalPolicy.lostReason : TerminalPolicy.closeReason(reason))
    }

    private func completed(_ task: URLSessionTask) {
        guard task === self.task else { return }
        if state == .connecting {
            return failOpening(status: (task.response as? HTTPURLResponse)?.statusCode ?? 0)
        }
        let socket = task as? URLSessionWebSocketTask
        let code = socket?.closeCode.rawValue ?? 0
        finish(code: code == 0 ? TerminalPolicy.lostCode : code,
               reason: code == 0 ? TerminalPolicy.lostReason : TerminalPolicy.closeReason(socket?.closeReason))
    }

    /// Without a close frame code, the task's completion (which always follows) reports it.
    private func receiveEnded(_ task: URLSessionWebSocketTask) {
        guard task === self.task, state == .open, task.closeCode.rawValue != 0 else { return }
        finish(code: task.closeCode.rawValue, reason: TerminalPolicy.closeReason(task.closeReason))
    }

    private func received(_ message: URLSessionWebSocketTask.Message) {
        switch message {
        case .data(let bytes):
            guard output.append(bytes) else {
                finish(code: TerminalPolicy.overflowCode, reason: TerminalPolicy.overflowReason)
                return
            }
            if output.buffered >= TerminalPolicy.flushBytes {
                flush()
            } else if flushTimer == nil {
                flushTimer = Task { @MainActor [weak self] in
                    try? await Task.sleep(nanoseconds: UInt64(TerminalPolicy.flushDelay * 1_000_000_000))
                    guard !Task.isCancelled, let self else { return }
                    self.flushTimer = nil
                    self.flush()
                }
            }
        case .string(let text):
            // Keeps output and control messages in the order the server sent them.
            flush()
            guard let control = TerminalPolicy.control(text) else { return }
            emit("terminal.control", ["id": id, "message": control], nil)
        @unknown default:
            break
        }
    }

    /// Each event stays counted against the pending-output limit until the page has handled it.
    private func flush() {
        flushTimer?.cancel()
        flushTimer = nil
        while let chunk = output.take() {
            let count = chunk.count
            emit("terminal.output", ["id": id, "data": chunk.base64EncodedString()]) { [weak self] in
                self?.output.delivered(count)
            }
        }
    }

    private func emitClosed(code: Int, reason: String) {
        emit("terminal.closed", ["id": id, "code": code, "reason": reason], nil)
    }
}

// The session's delegate queue is the main queue, so these callbacks already run on the main actor.
extension TerminalConnection: URLSessionWebSocketDelegate {
    nonisolated func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                                newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
    }

    nonisolated func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didOpenWithProtocol protocol: String?) {
        MainActor.assumeIsolated { opened(webSocketTask) }
    }

    nonisolated func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask,
                                didCloseWith closeCode: URLSessionWebSocketTask.CloseCode, reason: Data?) {
        MainActor.assumeIsolated { serverClosed(webSocketTask, code: closeCode.rawValue, reason: reason) }
    }

    nonisolated func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        MainActor.assumeIsolated { completed(task) }
    }
}
