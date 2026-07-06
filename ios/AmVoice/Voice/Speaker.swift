import AVFoundation

// AVSpeechSynthesizer wrapper. Deliberately not @Observable (delegate needs
// NSObject); ChatViewModel mirrors the speaking state via the callbacks.
final class Speaker: NSObject, AVSpeechSynthesizerDelegate {
    var onFinish: (() -> Void)?
    var onStop: (() -> Void)?

    private let synthesizer = AVSpeechSynthesizer()

    override init() {
        super.init()
        synthesizer.delegate = self
    }

    func speak(_ text: String) {
        stop()
        try? AudioSession.activate()
        let utterance = AVSpeechUtterance(string: text)
        utterance.voice = Speaker.bestVoice()
        synthesizer.speak(utterance)
    }

    func stop() {
        if synthesizer.isSpeaking {
            synthesizer.stopSpeaking(at: .immediate)
        }
    }

    // Prefer a downloaded Premium/Enhanced voice (Settings → Accessibility →
    // Spoken Content → Voices) over the compact default.
    static func bestVoice() -> AVSpeechSynthesisVoice? {
        let language = AVSpeechSynthesisVoice.currentLanguageCode()
        let candidates = AVSpeechSynthesisVoice.speechVoices().filter { $0.language == language }
        return candidates.first { $0.quality == .premium }
            ?? candidates.first { $0.quality == .enhanced }
            ?? AVSpeechSynthesisVoice(language: language)
    }

    // MARK: - AVSpeechSynthesizerDelegate

    func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) {
        DispatchQueue.main.async { self.onFinish?() }
    }

    func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didCancel utterance: AVSpeechUtterance) {
        DispatchQueue.main.async { self.onStop?() }
    }
}

// One shared audio session shape for the whole voice loop: play-and-record so
// recognition and synthesis don't fight over the category, ducking other audio.
enum AudioSession {
    static func activate() throws {
        let session = AVAudioSession.sharedInstance()
        try session.setCategory(
            .playAndRecord,
            mode: .default,
            options: [.duckOthers, .defaultToSpeaker, .allowBluetooth]
        )
        try session.setActive(true, options: .notifyOthersOnDeactivation)
    }
}
