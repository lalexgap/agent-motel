import AppKit
import WebKit

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKUIDelegate {
    private(set) var window: NSWindow!
    private(set) var webView: WKWebView!
    let store = ConnectionStore()
    private(set) lazy var bridge = Bridge(store: store, confirmation: Confirmation(
        window: { [weak self] in self?.window }, reveal: { [weak self] in self?.showWindow() }))
    /// The smoke test runs as an accessory app and must never take focus from the person at the Mac.
    var activatesWindow = true
    private var errorPanel: NSStackView!
    private var errorLabel: NSTextField!

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.appearance = NSAppearance(named: .darkAqua)
        makeMenus()
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .default()
        let webRoot = Bundle.main.resourceURL?.appendingPathComponent("web", isDirectory: true)
            ?? URL(fileURLWithPath: "/nonexistent")
        configuration.setURLSchemeHandler(AppSchemeHandler(root: webRoot), forURLScheme: NavigationPolicy.scheme)
        configuration.userContentController.addScriptMessageHandler(bridge, contentWorld: .page, name: Bridge.handlerName)
        let debug = ProcessInfo.processInfo.environment["AM_DEBUG"] == "1"
        if debug, #unavailable(macOS 13.3) {
            configuration.preferences.setValue(true, forKey: "developerExtrasEnabled")
        }
        webView = WKWebView(frame: .zero, configuration: configuration)
        if debug, #available(macOS 13.3, *) { webView.isInspectable = true }
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.underPageBackgroundColor = NSColor(calibratedWhite: 0.06, alpha: 1)
        bridge.webView = webView

        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1280, height: 840),
                          styleMask: [.titled, .closable, .miniaturizable, .resizable],
                          backing: .buffered, defer: false)
        window.title = "Agent Motel"
        window.minSize = NSSize(width: 480, height: 420)
        window.isReleasedWhenClosed = false
        window.center()
        window.setFrameUsingName("AgentMotelMainWindow")
        window.setFrameAutosaveName("AgentMotelMainWindow")
        let container = NSView()
        window.contentView = container
        webView.translatesAutoresizingMaskIntoConstraints = false
        container.addSubview(webView)
        NSLayoutConstraint.activate([
            webView.leadingAnchor.constraint(equalTo: container.leadingAnchor),
            webView.trailingAnchor.constraint(equalTo: container.trailingAnchor),
            webView.topAnchor.constraint(equalTo: container.topAnchor),
            webView.bottomAnchor.constraint(equalTo: container.bottomAnchor),
        ])
        errorLabel = NSTextField(wrappingLabelWithString: "")
        errorLabel.alignment = .center
        let retry = NSButton(title: "Reload", target: self, action: #selector(loadHome))
        errorPanel = NSStackView(views: [errorLabel, retry])
        errorPanel.orientation = .vertical
        errorPanel.spacing = 16
        errorPanel.translatesAutoresizingMaskIntoConstraints = false
        errorPanel.isHidden = true
        container.addSubview(errorPanel)
        NSLayoutConstraint.activate([
            errorPanel.centerXAnchor.constraint(equalTo: container.centerXAnchor),
            errorPanel.centerYAnchor.constraint(equalTo: container.centerYAnchor),
            errorPanel.widthAnchor.constraint(lessThanOrEqualTo: container.widthAnchor, constant: -48),
        ])
        showWindow()
        loadHome()
    }

    func applicationWillTerminate(_ notification: Notification) {
        bridge.stopAllStreams()
        bridge.terminals.shutDown()
        bridge.cancelRequests()
    }

    private func makeMenus() {
        let menu = NSMenu()
        NSApp.mainMenu = menu
        func section(_ title: String, _ entries: [(String, Selector, String)?]) {
            let root = NSMenuItem(title: title, action: nil, keyEquivalent: "")
            let submenu = NSMenu(title: title)
            root.submenu = submenu
            menu.addItem(root)
            for entry in entries {
                guard let (label, action, key) = entry else {
                    submenu.addItem(.separator())
                    continue
                }
                submenu.addItem(withTitle: label, action: action, keyEquivalent: key)
            }
        }
        section("Agent Motel", [
            ("About Agent Motel", #selector(NSApplication.orderFrontStandardAboutPanel(_:)), ""),
            nil,
            ("Connections…", #selector(showConnections), ","),
            nil,
            ("Hide Agent Motel", #selector(NSApplication.hide(_:)), "h"),
            ("Quit Agent Motel", #selector(NSApplication.terminate(_:)), "q"),
        ])
        section("Edit", [
            ("Undo", Selector(("undo:")), "z"),
            ("Redo", Selector(("redo:")), "Z"),
            nil,
            ("Cut", #selector(NSText.cut(_:)), "x"),
            ("Copy", #selector(NSText.copy(_:)), "c"),
            ("Paste", #selector(NSText.paste(_:)), "v"),
            ("Select All", #selector(NSText.selectAll(_:)), "a"),
        ])
        section("View", [
            ("Reload", #selector(reloadPage), "r"),
            ("Find", #selector(find), "f"),
            nil,
            ("Show Chat", #selector(showChat), "1"),
            ("Show Terminal", #selector(showTerminal), "2"),
        ])
        section("Window", [
            ("Minimize", #selector(NSWindow.performMiniaturize(_:)), "m"),
            ("Close", #selector(NSWindow.performClose(_:)), "w"),
            nil,
            ("Show Agent Motel", #selector(showWindow), "0"),
        ])
        NSApp.windowsMenu = menu.items.last?.submenu
    }

    @objc func showWindow() {
        if activatesWindow {
            window.makeKeyAndOrderFront(nil)
            NSApp.activate(ignoringOtherApps: true)
        } else {
            window.orderBack(nil)
        }
    }

    @objc func loadHome() {
        errorPanel.isHidden = true
        webView.isHidden = false
        webView.load(URLRequest(url: NavigationPolicy.home))
    }

    /// Tells the page to refresh its data; reloads the page itself only if it never became ready.
    @objc func reloadPage() {
        guard errorPanel.isHidden else { return loadHome() }
        bridge.emit("menu.command", ["command": "reload"])
        Task {
            let ready = try? await webView.evaluateJavaScript("document.body?.dataset.ready === 'true'")
            if ready as? Bool != true { loadHome() }
        }
    }

    @objc func showConnections() {
        showWindow()
        bridge.emit("menu.command", ["command": "connections"])
    }

    @objc func find() {
        bridge.emit("menu.command", ["command": "find"])
    }

    @objc func showChat() {
        bridge.emit("menu.command", ["command": "chat"])
    }

    @objc func showTerminal() {
        bridge.emit("menu.command", ["command": "terminal"])
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        showWindow()
        return true
    }

    // MARK: Navigation

    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
                 decisionHandler: @escaping @MainActor @Sendable (WKNavigationActionPolicy) -> Void) {
        let newWindow = action.targetFrame == nil
        switch NavigationPolicy.decide(action.request.url, userInitiated: action.navigationType == .linkActivated || newWindow,
                                       newWindow: newWindow) {
        case .allow:
            decisionHandler(.allow)
        case .openExternally:
            decisionHandler(.cancel)
            if let url = action.request.url { NSWorkspace.shared.open(url) }
        case .cancel:
            decisionHandler(.cancel)
        }
    }

    func webView(_ webView: WKWebView, decidePolicyFor response: WKNavigationResponse,
                 decisionHandler: @escaping @MainActor @Sendable (WKNavigationResponsePolicy) -> Void) {
        if response.isForMainFrame, let status = (response.response as? HTTPURLResponse)?.statusCode, status != 200 {
            decisionHandler(.cancel)
            showError("The app’s page is missing from this build (HTTP \(status)).")
        } else {
            decisionHandler(.allow)
        }
    }

    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if NavigationPolicy.decide(action.request.url, userInitiated: true, newWindow: true) == .openExternally,
           let url = action.request.url {
            NSWorkspace.shared.open(url)
        }
        return nil
    }

    /// A new page load replaces the page and its terminal ids, so its terminals close.
    func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
        bridge.terminals.pageChanged()
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        showError(error)
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        showError(error)
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        bridge.terminals.pageChanged()
        showError("The page stopped unexpectedly.")
    }

    private func showError(_ error: Error) {
        let failure = error as NSError
        guard !(failure.domain == NSURLErrorDomain && failure.code == NSURLErrorCancelled),
              !(failure.domain == "WebKitErrorDomain" && failure.code == 102) else { return }
        showError("Couldn’t load Agent Motel.\n\(failure.localizedDescription)")
    }

    private func showError(_ message: String) {
        errorLabel.stringValue = message
        webView.isHidden = true
        errorPanel.isHidden = false
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping @MainActor @Sendable (Bool) -> Void) {
        guard frame.isMainFrame, frame.request.url.map(NavigationPolicy.isInternal) == true else {
            completionHandler(false)
            return
        }
        let alert = NSAlert()
        alert.messageText = "Agent Motel"
        alert.informativeText = message
        alert.addButton(withTitle: "Confirm")
        alert.addButton(withTitle: "Cancel").keyEquivalent = "\u{1b}"
        alert.beginSheetModal(for: window) { completionHandler($0 == .alertFirstButtonReturn) }
    }
}
