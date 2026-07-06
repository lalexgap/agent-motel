import AVFoundation
import Speech

// On-device speech-to-text with silence-based end-of-speech: partial results
// stream to onPartial; ~1.2s without a new partial finalizes and fires
// onFinal. A longer leading window (6s) lets the user gather their thoughts
// before saying anything; pure silence cancels instead of sending "".
final class SpeechRecognizer {
    var onPartial: ((String) -> Void)?
    var onFinal: ((String) -> Void)?
    var onEnd: (() -> Void)? // listening stopped, however it stopped

    private(set) var isListening = false

    private let engine = AVAudioEngine()
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var task: SFSpeechRecognitionTask?
    private var silenceTimer: Timer?
    private var transcript = ""

    private static let leadingWindow: TimeInterval = 6.0
    private static let silenceWindow: TimeInterval = 1.2

    static func requestPermissions() async -> Bool {
        let mic = await AVAudioApplication.requestRecordPermission()
        guard mic else { return false }
        return await withCheckedContinuation { continuation in
            SFSpeechRecognizer.requestAuthorization { status in
                continuation.resume(returning: status == .authorized)
            }
        }
    }

    func start() throws {
        guard !isListening else { return }
        guard let recognizer = SFSpeechRecognizer(), recognizer.isAvailable else {
            throw ApiError(message: "speech recognition unavailable")
        }

        try AudioSession.activate()

        let request = SFSpeechAudioBufferRecognitionRequest()
        request.shouldReportPartialResults = true
        if recognizer.supportsOnDeviceRecognition {
            request.requiresOnDeviceRecognition = true
        }
        self.request = request

        let input = engine.inputNode
        let format = input.outputFormat(forBus: 0)
        input.removeTap(onBus: 0)
        input.installTap(onBus: 0, bufferSize: 1024, format: format) { buffer, _ in
            request.append(buffer)
        }
        engine.prepare()
        try engine.start()

        transcript = ""
        isListening = true
        resetSilenceTimer(Self.leadingWindow)

        task = recognizer.recognitionTask(with: request) { [weak self] result, error in
            DispatchQueue.main.async {
                guard let self, self.isListening else { return }
                if let result {
                    self.transcript = result.bestTranscription.formattedString
                    self.onPartial?(self.transcript)
                    self.resetSilenceTimer(Self.silenceWindow)
                }
                if error != nil || result?.isFinal == true {
                    self.finish(send: true)
                }
            }
        }
    }

    func cancel() {
        finish(send: false)
    }

    private func finish(send: Bool) {
        guard isListening else { return }
        isListening = false
        silenceTimer?.invalidate()
        silenceTimer = nil
        engine.stop()
        engine.inputNode.removeTap(onBus: 0)
        request?.endAudio()
        task?.cancel()
        request = nil
        task = nil

        let text = transcript.trimmingCharacters(in: .whitespacesAndNewlines)
        if send, !text.isEmpty {
            onFinal?(text)
        }
        onEnd?()
    }

    private func resetSilenceTimer(_ interval: TimeInterval) {
        silenceTimer?.invalidate()
        silenceTimer = Timer.scheduledTimer(withTimeInterval: interval, repeats: false) { [weak self] _ in
            self?.finish(send: true)
        }
    }
}
