import AppKit

/// The native confirmation for destructive bridge methods: an `NSAlert` sheet on the app window.
/// The page cannot reach it (it is not part of the web view), so it cannot skip, pre-answer or
/// restyle it, and there is no other way to answer it than its buttons. One at a time: a caller
/// reserves the slot before its pre-check, so a second confirmed call rejects instead of queueing.
@MainActor
final class Confirmation {
    private let window: () -> NSWindow?
    private let reveal: () -> Void
    private var open = false

    /// `reveal` brings the window forward before the sheet appears (the app's own `showWindow`,
    /// which never activates the background smoke app).
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

    /// Shows the sheet and returns whether the confirm button was clicked. Needs a reservation.
    func ask(_ text: ConfirmationText) async throws -> Bool {
        reveal()
        guard let window = window() else { throw PolicyError("The app window is not available") }
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
        confirm.keyEquivalent = text.destructive ? "" : "\r"
        cancel.keyEquivalent = text.destructive ? "\r" : "\u{1b}"
        let sheet = alert.window
        // Esc cancels even when Return belongs to Cancel (a button holds only one key equivalent).
        let escape = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak sheet, weak cancel] event in
            guard event.keyCode == 53 else { return event }
            let target = event.windowNumber
            // Local monitors run on the main thread; only the window number crosses into the actor.
            let handled = MainActor.assumeIsolated { () -> Bool in
                guard let sheet, sheet.windowNumber == target, let cancel else { return false }
                cancel.performClick(nil)
                return true
            }
            return handled ? nil : event
        }
        defer { if let escape { NSEvent.removeMonitor(escape) } }
        let confirmIndex = alert.buttons.firstIndex(of: confirm) ?? 0
        let response = await withCheckedContinuation { (continuation: CheckedContinuation<NSApplication.ModalResponse, Never>) in
            alert.beginSheetModal(for: window) { continuation.resume(returning: $0) }
        }
        return response.rawValue == NSApplication.ModalResponse.alertFirstButtonReturn.rawValue + confirmIndex
    }
}
