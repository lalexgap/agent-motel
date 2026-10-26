import AppKit
import WebKit

// Run only against a server you control. The access key is read from stdin, never an argument.
@main
struct Smoke {
    @MainActor static func main() {
        let token = readLine() ?? ""
        guard !token.isEmpty else { fputs("An access key is required on stdin.\n", stderr); exit(1) }
        let app = NSApplication.shared
        let delegate = AppDelegate()
        app.delegate = delegate
        app.setActivationPolicy(.regular)
        Task { @MainActor in
            do {
                try await Task.sleep(nanoseconds: 1_000_000_000)
                let web = delegate.webView!
                func evaluate(_ js: String) async throws -> Any? { try await web.evaluateJavaScript(js) }
                func waitFor(_ js: String) async throws {
                    for _ in 0..<100 {
                        if (try? await evaluate(js)) as? Bool == true { return }
                        try await Task.sleep(nanoseconds: 200_000_000)
                    }
                    throw NSError(domain: "Smoke condition timed out: \(js)", code: 1)
                }
                try await waitFor("!!document.querySelector('#access-key')")
                let result = try await web.callAsyncJavaScript("""
                    const r = await fetch('/auth/login', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({token})});
                    return r.ok;
                    """, arguments: ["token": token], in: nil, contentWorld: .page)
                guard result as? Bool == true else { throw NSError(domain: "Login failed", code: 1) }
                _ = try await evaluate("window.__smokeOldDocument = true")
                delegate.reloadPage()
                try await waitFor("!window.__smokeOldDocument && document.querySelectorAll('.side-agent').length > 0")
                print("PASS native WebKit authentication and fleet rendering")
                _ = try await evaluate("document.querySelector('#sidebar-search').value = 'no-such-agent-smoke'; document.querySelector('#sidebar-search').dispatchEvent(new Event('input'))")
                try await waitFor("document.querySelectorAll('.side-agent').length === 0")
                _ = try await evaluate("document.querySelector('#sidebar-search').value = ''; document.querySelector('#sidebar-search').dispatchEvent(new Event('input'))")
                try await waitFor("document.querySelectorAll('.side-agent').length > 0")
                print("PASS sidebar filtering and clear")
                let streaming = try await web.callAsyncJavaScript("""
                    return await new Promise(resolve => {
                        const s = new EventSource('/api/web-events');
                        const timer = setTimeout(() => {s.close(); resolve(false)}, 10000);
                        s.addEventListener('ready', () => {clearTimeout(timer); s.close(); resolve(true)});
                    });
                    """, arguments: [:], in: nil, contentWorld: .page)
                guard streaming as? Bool == true else { throw NSError(domain: "SSE failed", code: 1) }
                print("PASS authenticated SSE connection")
                _ = try await evaluate("selectAgent('concierge'); undefined")
                _ = try await evaluate("document.querySelector('#terminal-tab').click()")
                try await waitFor("document.querySelector('#terminal-status').textContent.includes('Live terminal') && !!document.querySelector('.xterm-screen')")
                print("PASS authenticated WebSocket terminal in native WebKit (read-only attach)")
                let image = try await web.takeSnapshot(configuration: nil)
                let png = NSBitmapImageRep(data: image.tiffRepresentation!)!.representation(using: .png, properties: [:])!
                let screenshot = FileManager.default.temporaryDirectory.appendingPathComponent("am-macos-smoke.png")
                try png.write(to: screenshot)
                print("Screenshot: \(screenshot.path)")
                _ = try await evaluate("document.querySelector('#chat-tab').click()")
                let confirm = Task { @MainActor in try await evaluate("confirm('Smoke test — cancel this dialog')") }
                try await Task.sleep(nanoseconds: 500_000_000)
                guard let sheet = delegate.window.attachedSheet else { throw NSError(domain: "Native confirmation missing", code: 1) }
                @MainActor func cancelButton(_ view: NSView) -> NSButton? {
                    if let button = view as? NSButton, button.title == "Cancel" { return button }
                    return view.subviews.compactMap(cancelButton).first
                }
                guard let cancel = cancelButton(sheet.contentView!) else { throw NSError(domain: "Cancel button missing", code: 1) }
                cancel.performClick(nil)
                guard try await confirm.value as? Bool == false else { throw NSError(domain: "Confirmation was not cancelled", code: 1) }
                print("PASS native destructive-action confirmation cancellation")
                _ = try await evaluate("document.querySelector('#logout').click()")
                try await waitFor("!document.querySelector('#login').hidden")
                print("PASS logout")
                exit(0)
            } catch {
                fputs("FAIL \(error)\n", stderr)
                exit(1)
            }
        }
        withExtendedLifetime(delegate) { app.run() }
    }
}
