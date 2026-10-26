import AppKit
import WebKit

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKUIDelegate {
    private(set) var window: NSWindow!
    private(set) var webView: WKWebView!
    private var errorPanel: NSStackView!
    private var errorLabel: NSTextField!

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.appearance = NSAppearance(named: .darkAqua)
        makeMenus()
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .default()
        webView = WKWebView(frame: .zero, configuration: configuration)
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.underPageBackgroundColor = NSColor(calibratedWhite: 0.06, alpha: 1)

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
        let retry = NSButton(title: "Reconnect", target: self, action: #selector(goHome))
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
        goHome()
    }

    private func makeMenus() {
        let menu = NSMenu()
        NSApp.mainMenu = menu
        func section(_ title: String, _ entries: [(String, Selector, String)]) {
            let root = NSMenuItem(title: title, action: nil, keyEquivalent: "")
            let submenu = NSMenu(title: title)
            root.submenu = submenu
            menu.addItem(root)
            for (label, action, key) in entries {
                submenu.addItem(withTitle: label, action: action, keyEquivalent: key)
            }
        }
        section("Agent Motel", [
            ("About Agent Motel", #selector(NSApplication.orderFrontStandardAboutPanel(_:)), ""),
            ("Hide Agent Motel", #selector(NSApplication.hide(_:)), "h"),
            ("Quit Agent Motel", #selector(NSApplication.terminate(_:)), "q"),
        ])
        section("Edit", [
            ("Undo", Selector(("undo:")), "z"),
            ("Redo", Selector(("redo:")), "Z"),
            ("Cut", #selector(NSText.cut(_:)), "x"),
            ("Copy", #selector(NSText.copy(_:)), "c"),
            ("Paste", #selector(NSText.paste(_:)), "v"),
            ("Select All", #selector(NSText.selectAll(_:)), "a"),
        ])
        section("View", [
            ("Reload", #selector(reloadPage), "r"),
            ("Fleet", #selector(goHome), "1"),
            ("Open in Browser", #selector(openInBrowser), ""),
        ])
        section("Window", [
            ("Minimize", #selector(NSWindow.performMiniaturize(_:)), "m"),
            ("Close", #selector(NSWindow.performClose(_:)), "w"),
            ("Show Agent Motel", #selector(showWindow), "0"),
        ])
        NSApp.windowsMenu = menu.items.last?.submenu
    }

    @objc func showWindow() {
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    @objc func goHome() {
        errorPanel.isHidden = true
        webView.isHidden = false
        webView.load(URLRequest(url: NavigationPolicy.home))
    }

    @objc func reloadPage() {
        if !errorPanel.isHidden { goHome() } else { webView.reload() }
    }

    @objc func openInBrowser() {
        NSWorkspace.shared.open(NavigationPolicy.home)
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        showWindow()
        return true
    }

    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = action.request.url else { decisionHandler(.cancel); return }
        if NavigationPolicy.isInternal(url) {
            if action.targetFrame == nil {
                decisionHandler(.cancel)
                webView.load(action.request)
            } else {
                decisionHandler(.allow)
            }
        } else {
            decisionHandler(.cancel)
            if action.navigationType == .linkActivated && NavigationPolicy.canOpenExternally(url) {
                NSWorkspace.shared.open(url)
            }
        }
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        showError(error)
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        showError(error)
    }

    private func showError(_ error: Error) {
        let failure = error as NSError
        guard !(failure.domain == NSURLErrorDomain && failure.code == NSURLErrorCancelled) else { return }
        errorLabel.stringValue = "Couldn’t connect to Agent Motel.\nCheck your connection and try again."
        webView.isHidden = true
        errorPanel.isHidden = false
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        showError(NSError(domain: "AgentMotel", code: 1))
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
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
