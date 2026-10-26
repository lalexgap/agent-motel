import Foundation

enum NavigationPolicy {
    static let home = URL(string: "https://am.alexgap.ca")!

    static func isInternal(_ url: URL) -> Bool {
        url.scheme == "https" && url.host == home.host &&
            (url.port == nil || url.port == 443) && url.user == nil && url.password == nil
    }

    static func canOpenExternally(_ url: URL) -> Bool {
        ["https", "http"].contains(url.scheme ?? "") &&
            url.host != nil && url.user == nil && url.password == nil
    }
}
