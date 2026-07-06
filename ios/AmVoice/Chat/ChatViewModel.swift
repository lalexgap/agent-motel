import Foundation
import Observation

enum SendMode: String, CaseIterable, Identifiable {
    case queue, now, interrupt
    var id: String { rawValue }
}

struct ChatItem: Identifiable {
    let id: Int // absolute turn index — doubles as the transcript cursor
    let turn: Turn
}

// Owns the whole voice loop for one agent: transcript polling with the
// `after` cursor, sending (with the voice hint on mic-originated messages),
// turn-completion detection, and speaking the reply.
@MainActor
@Observable
final class ChatViewModel {
    let agent: FleetRow
    private let client: ApiClient

    var items: [ChatItem] = []
    var status = "…"
    var draft = ""
    var mode: SendMode = .queue
    var handsFree = false
    var voiceReplies = false // hint typed sends too (listen-while-typing)
    var isListening = false
    var isSpeaking = false
    var errorMessage: String?
    var sendNote: String? // e.g. "queued — agent is working"

    private var total = 0
    // Set after a voice-hinted send: speak the first assistant turn at or
    // past replyCursor once the agent leaves `working`.
    private var awaitingSpokenReply = false
    private var replyCursor = 0
    private var pollTask: Task<Void, Never>?

    private let recognizer = SpeechRecognizer()
    private let speaker = Speaker()

    init(agent: FleetRow, client: ApiClient) {
        self.agent = agent
        self.client = client

        recognizer.onPartial = { [weak self] text in self?.draft = text }
        recognizer.onFinal = { [weak self] text in
            guard let self else { return }
            draft = ""
            send(text: text, voice: true)
        }
        recognizer.onEnd = { [weak self] in self?.isListening = false }

        speaker.onFinish = { [weak self] in
            guard let self else { return }
            isSpeaking = false
            if handsFree { startListening() }
        }
        speaker.onStop = { [weak self] in self?.isSpeaking = false }
    }

    // MARK: - lifecycle

    func start() {
        pollTask = Task { [weak self] in
            while !Task.isCancelled {
                await self?.poll()
                try? await Task.sleep(for: .seconds(1.5))
            }
        }
    }

    func teardown() {
        pollTask?.cancel()
        recognizer.cancel()
        speaker.stop()
    }

    // MARK: - polling

    private func poll() async {
        do {
            let page = try await client.transcript(agent: agent.name, after: total)
            status = page.status
            if page.total < total {
                // Session was replaced/reset — reload from scratch next poll.
                total = 0
                items = []
                return
            }
            for (offset, turn) in page.turns.enumerated() {
                items.append(ChatItem(id: total + offset, turn: turn))
            }
            total = page.total
            errorMessage = nil
            maybeSpeakReply()
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func maybeSpeakReply() {
        guard awaitingSpokenReply, status != "working", status != "starting" else { return }
        guard let reply = items.last(where: { $0.turn.kind == "assistant" && $0.id >= replyCursor }) else { return }
        awaitingSpokenReply = false
        let text = SpeechText.spoken(from: reply.turn.text ?? "")
        guard !text.isEmpty else { return }
        isSpeaking = true
        speaker.speak(text)
    }

    // MARK: - sending

    func sendDraft() {
        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        draft = ""
        send(text: text, voice: false)
    }

    private func send(text: String, voice: Bool) {
        let hinted = voice || voiceReplies
        let outgoing = hinted ? text + SpeechText.voiceHint : text
        let wasWorking = status == "working"
        Task {
            do {
                try await client.send(agent: agent.name, text: outgoing, mode: mode.rawValue)
                if hinted {
                    awaitingSpokenReply = true
                    replyCursor = total
                }
                sendNote = mode == .queue && wasWorking ? "queued — agent is working" : nil
                errorMessage = nil
            } catch {
                errorMessage = error.localizedDescription
            }
        }
    }

    // MARK: - voice controls

    func micTapped() {
        if isListening {
            recognizer.cancel()
            draft = ""
            return
        }
        stopSpeaking()
        startListening()
    }

    func startListening() {
        guard !isListening else { return }
        Task {
            guard await SpeechRecognizer.requestPermissions() else {
                errorMessage = "microphone / speech permission denied — enable both in Settings"
                return
            }
            do {
                try recognizer.start()
                isListening = true
            } catch {
                errorMessage = error.localizedDescription
            }
        }
    }

    func stopSpeaking() {
        speaker.stop()
        isSpeaking = false
    }
}
