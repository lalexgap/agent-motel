import AppKit

/// The native confirmation for destructive bridge methods and terminal consent: an `NSAlert` sheet on the app window.
/// The page cannot reach it (it is not part of the web view), so it cannot skip, pre-answer or
/// restyle it, and there is no other way to answer it than its buttons. One at a time: a caller
/// reserves the slot before its pre-check, so a second confirmed call rejects instead of queueing.
///
/// An unread accept is refused natively, whatever the page does: for `armDelay` after the sheet
/// appears every key but Esc is swallowed, and a repeated Return, Enter or Space never counts, so a
/// Return already in flight or a held Enter cannot answer it. Clicks are unaffected. When the app is
/// not active the sheet is attached without activating it and the Dock icon asks for attention
/// instead, so typing in another app cannot land on it.
@MainActor
final class Confirmation {
    static let armDelay: TimeInterval = 0.5

    private let window: () -> NSWindow?
    private let reveal: () -> Void
    private var open = false

    /// `reveal` brings the window forward before the sheet appears when the app is already active
    /// (the app's own `showWindow`, which never activates the background smoke app).
    init(window: @escaping () -> NSWindow?, reveal: @escaping () -> Void) {
        self.window = window
        self.reveal = reveal
    }

    func reserve() throws {
        // A page `confirm()` sheet also counts: a second sheet would only queue behind it.
        guard !open, window()?.attachedSheet == nil else { throw PolicyError(ActionPolicy.anotherConfirmation) }
        open = true
    }

    func release() {
        open = false
    }

    /// Needs a reservation.
    func ask(_ text: ConfirmationText) async throws -> Bool {
        try await answer(text).accepted
    }

    /// Needs a reservation. `suppressed` is the state of the suppression checkbox (shown only when
    /// `text.suppression` is set) when the sheet was answered.
    func answer(_ text: ConfirmationText) async throws -> (accepted: Bool, suppressed: Bool) {
        guard let window = window() else { throw PolicyError("The app window is not available") }
        var attention: Int?
        if NSApp.isActive {
            reveal()
        } else {
            if !window.isVisible && !window.isMiniaturized { window.orderBack(nil) }
            attention = NSApp.requestUserAttention(.informationalRequest)
        }
        defer { if let attention { NSApp.cancelUserAttentionRequest(attention) } }
        guard window.attachedSheet == nil else { throw PolicyError(ActionPolicy.anotherConfirmation) }
        let alert = NSAlert()
        alert.alertStyle = text.destructive ? .critical : .warning
        alert.messageText = text.title
        alert.informativeText = text.message
        let confirm: NSButton
        let cancel: NSButton
        if text.destructive {
            // The first button is the default (Return), so Cancel goes first and Remove is never one keystroke away.
            cancel = alert.addButton(withTitle: "Cancel")
            confirm = alert.addButton(withTitle: text.button)
            if #available(macOS 11.0, *) { confirm.hasDestructiveAction = true }
        } else {
            confirm = alert.addButton(withTitle: text.button)
            cancel = alert.addButton(withTitle: "Cancel")
        }
        if let suppression = text.suppression {
            alert.showsSuppressionButton = true
            alert.suppressionButton?.title = suppression
            alert.suppressionButton?.state = .off
        }
        confirm.keyEquivalent = text.destructive ? "" : "\r"
        cancel.keyEquivalent = text.destructive ? "\r" : "\u{1b}"
        let sheet = alert.window
        let defaultButton = text.destructive ? cancel : confirm
        let shownAt = ProcessInfo.processInfo.systemUptime
        // Every key press for the sheet passes through here before AppKit's own key equivalents.
        // Esc cancels at once, even when Return belongs to Cancel (a button holds only one key
        // equivalent). Return and Enter press the default button only once armed; Space keeps
        // its usual meaning once armed.
        let keys = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak sheet, weak cancel, weak defaultButton] event in
            let target = event.windowNumber
            let code = event.keyCode
            let repeated = event.isARepeat
            let typedAt = event.timestamp
            // Local monitors run on the main thread; only plain values cross into the actor.
            let handled = MainActor.assumeIsolated { () -> Bool in
                guard let sheet, sheet.windowNumber == target, let cancel, let defaultButton else { return false }
                if code == 53 {
                    cancel.performClick(nil)
                    return true
                }
                let armed = typedAt >= shownAt + Self.armDelay && ProcessInfo.processInfo.systemUptime >= shownAt + Self.armDelay
                let activating = code == 36 || code == 76 || code == 49
                if !armed || (activating && repeated) { return true }
                if code == 36 || code == 76 {
                    defaultButton.performClick(nil)
                    return true
                }
                return false
            }
            return handled ? nil : event
        }
        defer { if let keys { NSEvent.removeMonitor(keys) } }
        let confirmIndex = alert.buttons.firstIndex(of: confirm) ?? 0
        let response = await withCheckedContinuation { (continuation: CheckedContinuation<NSApplication.ModalResponse, Never>) in
            alert.beginSheetModal(for: window) { continuation.resume(returning: $0) }
        }
        let accepted = response.rawValue == NSApplication.ModalResponse.alertFirstButtonReturn.rawValue + confirmIndex
        return (accepted, text.suppression != nil && alert.suppressionButton?.state == .on)
    }
}
