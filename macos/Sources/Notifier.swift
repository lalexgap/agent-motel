import AppKit
import UserNotifications

/// Posts am's notifications as this app's own (see `NotificationPolicy`), so
/// they group per agent, open the agent on click and are managed in System
/// Settings under Agent Motel. Owns the Notifications menu and its preferences.
@MainActor
final class Notifier: NSObject, NSMenuDelegate {
    static let openAgentAction = "open-agent"
    static let openPullRequestAction = "open-pr"
    static let agentCategory = "agent"
    static let pullRequestCategory = "pr"

    /// Called when a notification about an agent is clicked; `host` is empty when unknown.
    var openAgent: (_ host: String, _ agent: String, _ kind: String) -> Void = { _, _, _ in }
    private let defaults: UserDefaults
    private var center: UNUserNotificationCenter { .current() }
    private var authorization: UNAuthorizationStatus = .notDetermined
    private var statusItem: NSMenuItem?

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
    }

    func start() {
        center.delegate = self
        let openAgent = UNNotificationAction(identifier: Self.openAgentAction, title: "Open Agent", options: [.foreground])
        let openPR = UNNotificationAction(identifier: Self.openPullRequestAction, title: "Open Pull Request", options: [])
        center.setNotificationCategories([
            UNNotificationCategory(identifier: Self.agentCategory, actions: [openAgent], intentIdentifiers: []),
            UNNotificationCategory(identifier: Self.pullRequestCategory, actions: [openPR, openAgent], intentIdentifiers: []),
        ])
        center.requestAuthorization(options: [.alert, .sound]) { [weak self] _, _ in
            Task { @MainActor in self?.refreshAuthorization() }
        }
    }

    func refreshAuthorization() {
        center.getNotificationSettings { [weak self] settings in
            let status = settings.authorizationStatus
            Task { @MainActor in self?.authorization = status }
        }
    }

    /// Handles an `agent-motel:` URL; anything else is ignored.
    func handle(_ url: URL) {
        guard let incoming = NotificationPolicy.parse(url) else { return }
        let calendar = Calendar.current
        let now = calendar.dateComponents([.hour, .minute], from: Date())
        let delivery = NotificationPolicy.delivery(for: incoming.kind, preferences: preferences,
                                                   minuteOfDay: (now.hour ?? 0) * 60 + (now.minute ?? 0))
        guard delivery != .drop else { return }
        let content = UNMutableNotificationContent()
        content.title = incoming.title
        content.body = incoming.message
        content.threadIdentifier = incoming.threadIdentifier
        if incoming.pullRequest != nil {
            content.categoryIdentifier = Self.pullRequestCategory
        } else if incoming.agent != nil {
            content.categoryIdentifier = Self.agentCategory
        }
        var info: [String: String] = [:]
        if let host = incoming.host { info["host"] = host }
        if let agent = incoming.agent { info["agent"] = agent }
        if let pr = incoming.pullRequest { info["pr"] = pr.absoluteString }
        if let kind = incoming.kind { info["kind"] = kind.rawValue }
        content.userInfo = info
        if delivery == .quiet {
            content.interruptionLevel = .passive
        } else {
            content.sound = .default
        }
        let request = UNNotificationRequest(identifier: incoming.requestIdentifier ?? UUID().uuidString, content: content, trigger: nil)
        center.add(request) { error in
            if let error { NSLog("Agent Motel: could not post a notification: %@", error.localizedDescription) }
        }
    }

    private func respond(action: String, info: [AnyHashable: Any]) {
        let agent = info["agent"] as? String
        let host = info["host"] as? String ?? ""
        let kind = (info["kind"] as? String).flatMap(NotificationKind.init(rawValue:))?.rawValue ?? ""
        // Re-checked: userInfo comes back from the system, not from code this app ran.
        if action == Self.openPullRequestAction {
            if let raw = info["pr"] as? String, let url = NotificationPolicy.pullRequestURL(raw) { NSWorkspace.shared.open(url) }
            return
        }
        guard action == Self.openAgentAction || action == UNNotificationDefaultActionIdentifier else { return }
        if let agent, MessagePolicy.isName(Substring(agent)) {
            openAgent(host, agent, kind)
        } else {
            openAgent("", "", "")
        }
    }

    // MARK: Preferences

    private static func enabledKey(_ kind: NotificationKind) -> String { "notifications.\(kind.rawValue)" }
    private static let quietKey = "notifications.quietHours"
    private static let quietStartKey = "notifications.quietStart"
    private static let quietEndKey = "notifications.quietEnd"

    var preferences: NotificationPreferences {
        var prefs = NotificationPreferences()
        prefs.enabled = Set(NotificationKind.allCases.filter { defaults.object(forKey: Self.enabledKey($0)) as? Bool ?? true })
        prefs.quietHours = defaults.bool(forKey: Self.quietKey)
        // Minutes after midnight; `defaults write ca.alexgap.agent-motel notifications.quietStart -int 1320` changes them.
        if let start = defaults.object(forKey: Self.quietStartKey) as? Int, (0..<1440).contains(start) { prefs.quietStart = start }
        if let end = defaults.object(forKey: Self.quietEndKey) as? Int, (0..<1440).contains(end) { prefs.quietEnd = end }
        return prefs
    }

    // MARK: Menu

    func makeMenu() -> NSMenu {
        let menu = NSMenu(title: "Notifications")
        menu.delegate = self
        menu.autoenablesItems = false
        return menu
    }

    func menuNeedsUpdate(_ menu: NSMenu) {
        refreshAuthorization()
        menu.removeAllItems()
        let prefs = preferences
        if authorization == .denied {
            let off = NSMenuItem(title: "Off in System Settings: notifications are lost while the app runs", action: nil, keyEquivalent: "")
            off.isEnabled = false
            menu.addItem(off)
            menu.addItem(.separator())
        }
        for kind in NotificationKind.allCases {
            let item = NSMenuItem(title: kind.label, action: #selector(toggleKind(_:)), keyEquivalent: "")
            item.target = self
            item.representedObject = kind.rawValue
            item.state = prefs.enabled.contains(kind) ? .on : .off
            menu.addItem(item)
        }
        menu.addItem(.separator())
        let quiet = NSMenuItem(
            title: "Quiet Hours (\(NotificationPolicy.clock(prefs.quietStart))–\(NotificationPolicy.clock(prefs.quietEnd)))",
            action: #selector(toggleQuietHours), keyEquivalent: "")
        quiet.target = self
        quiet.state = prefs.quietHours ? .on : .off
        quiet.toolTip = "Notifications still arrive in Notification Center, without a banner or sound."
        menu.addItem(quiet)
        menu.addItem(.separator())
        let settings = NSMenuItem(title: "Notification Settings…", action: #selector(openSystemSettings), keyEquivalent: "")
        settings.target = self
        menu.addItem(settings)
    }

    @objc private func toggleKind(_ sender: NSMenuItem) {
        guard let raw = sender.representedObject as? String, let kind = NotificationKind(rawValue: raw) else { return }
        defaults.set(!preferences.enabled.contains(kind), forKey: Self.enabledKey(kind))
    }

    @objc private func toggleQuietHours() {
        defaults.set(!preferences.quietHours, forKey: Self.quietKey)
    }

    @objc private func openSystemSettings() {
        let id = Bundle.main.bundleIdentifier ?? "ca.alexgap.agent-motel"
        if let url = URL(string: "x-apple.systempreferences:com.apple.preference.notifications?id=\(id)") {
            NSWorkspace.shared.open(url)
        }
    }
}

extension Notifier: UNUserNotificationCenterDelegate {
    /// Shows banners while the app is frontmost too: an agent needing attention matters even then.
    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification,
                                            withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        let passive = notification.request.content.interruptionLevel == .passive
        completionHandler(passive ? [.list] : [.banner, .list, .sound])
    }

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse,
                                            withCompletionHandler completionHandler: @escaping () -> Void) {
        let action = response.actionIdentifier
        let info = response.notification.request.content.userInfo
        let host = info["host"] as? String
        let agent = info["agent"] as? String
        let pr = info["pr"] as? String
        let kind = info["kind"] as? String
        Task { @MainActor [weak self] in
            var copy: [String: String] = [:]
            if let host { copy["host"] = host }
            if let agent { copy["agent"] = agent }
            if let pr { copy["pr"] = pr }
            if let kind { copy["kind"] = kind }
            self?.respond(action: action, info: copy)
            completionHandler()
        }
    }
}
