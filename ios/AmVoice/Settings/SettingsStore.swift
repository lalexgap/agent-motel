import Foundation
import Observation
import Security

// Server URL lives in UserDefaults; the bearer token lives in the Keychain.
@Observable
final class SettingsStore {
    var serverURLString: String
    var token: String

    init() {
        serverURLString = UserDefaults.standard.string(forKey: "serverURL") ?? ""
        token = Keychain.load() ?? ""
    }

    func save() {
        UserDefaults.standard.set(serverURLString, forKey: "serverURL")
        Keychain.save(token)
    }

    var isConfigured: Bool { client != nil }

    var client: ApiClient? {
        let trimmed = serverURLString.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, !token.isEmpty, let url = URL(string: trimmed), url.scheme != nil else { return nil }
        return ApiClient(baseURL: url, token: token)
    }
}

enum Keychain {
    private static let query: [String: Any] = [
        kSecClass as String: kSecClassGenericPassword,
        kSecAttrService as String: "dev.lagap.amvoice",
        kSecAttrAccount as String: "api-token",
    ]

    static func save(_ value: String) {
        SecItemDelete(query as CFDictionary)
        guard !value.isEmpty else { return }
        var attrs = query
        attrs[kSecValueData as String] = Data(value.utf8)
        SecItemAdd(attrs as CFDictionary, nil)
    }

    static func load() -> String? {
        var attrs = query
        attrs[kSecReturnData as String] = true
        attrs[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: AnyObject?
        guard SecItemCopyMatching(attrs as CFDictionary, &result) == errSecSuccess,
              let data = result as? Data
        else { return nil }
        return String(data: data, encoding: .utf8)
    }
}
