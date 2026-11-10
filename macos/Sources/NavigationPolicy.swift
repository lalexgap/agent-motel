import Foundation

enum NavigationPolicy {
    static let scheme = "am-app"
    static let host = "app"
    static let origin = "am-app://app"
    static let home = URL(string: "am-app://app/index.html")!

    enum Decision: Equatable {
        case allow
        case openExternally
        case cancel
    }

    static func isInternal(_ url: URL) -> Bool {
        url.scheme == scheme && url.host == host && url.port == nil && url.user == nil && url.password == nil
    }

    static func canOpenExternally(_ url: URL) -> Bool {
        ["https", "http"].contains(url.scheme?.lowercased() ?? "") &&
            !(url.host ?? "").isEmpty && url.user == nil && url.password == nil
    }

    /// `userInitiated` is a link activation or a `window.open`/target=_blank request;
    /// `newWindow` is true when the navigation has no target frame.
    static func decide(_ url: URL?, userInitiated: Bool, newWindow: Bool) -> Decision {
        guard let url else { return .cancel }
        if isInternal(url) { return newWindow ? .cancel : .allow }
        if userInitiated && canOpenExternally(url) { return .openExternally }
        return .cancel
    }
}
