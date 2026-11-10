import Foundation
import Security

struct Connection: Equatable {
    let id: String
    var name: String
    var url: String
}

/// Connection metadata lives in UserDefaults; tokens live in the login keychain as generic
/// passwords (service = bundle identifier, account = connection id). Tokens are never logged
/// and only leave this type as an Authorization header.
@MainActor
final class ConnectionStore {
    private static let defaultsKey = "connections"
    private let defaults: UserDefaults
    private let service: String

    init(defaults: UserDefaults = .standard, service: String = Bundle.main.bundleIdentifier ?? "ca.alexgap.agent-motel") {
        self.defaults = defaults
        self.service = service
    }

    static func isValidID(_ id: String) -> Bool {
        (1...64).contains(id.count) && id.unicodeScalars.allSatisfy {
            CharacterSet.alphanumerics.contains($0) && $0.isASCII || $0 == "-"
        }
    }

    func list() -> [Connection] {
        let stored = defaults.array(forKey: Self.defaultsKey) as? [[String: String]] ?? []
        return stored.compactMap { entry in
            guard let id = entry["id"], Self.isValidID(id), let name = entry["name"], let url = entry["url"],
                  (try? ConnectionPolicy.normalize(url)) == url else { return nil }
            return Connection(id: id, name: name, url: url)
        }
    }

    func get(_ id: String) -> Connection? {
        list().first { $0.id == id }
    }

    /// Writes metadata and, when given, the token. The token is stored first so a keychain
    /// failure leaves no connection without one.
    func save(_ connection: Connection, token: String?) throws {
        if let token { try setToken(token, for: connection.id, label: connection.name) }
        var all = list()
        if let index = all.firstIndex(where: { $0.id == connection.id }) {
            all[index] = connection
        } else {
            all.append(connection)
        }
        write(all)
    }

    /// Deletes the token first so a Keychain failure leaves the connection listed for a retry.
    func remove(_ id: String) throws {
        try deleteToken(for: id)
        write(list().filter { $0.id != id })
    }

    private func write(_ connections: [Connection]) {
        defaults.set(connections.map { ["id": $0.id, "name": $0.name, "url": $0.url] }, forKey: Self.defaultsKey)
    }

    // MARK: Keychain

    private func baseQuery(_ id: String) -> [String: Any] {
        [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: id]
    }

    /// Attribute-only lookup: reading attributes does not need the item's ACL, so it never prompts.
    func hasToken(_ id: String) -> Bool {
        var query = baseQuery(id)
        query[kSecReturnAttributes as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        return SecItemCopyMatching(query as CFDictionary, nil) == errSecSuccess
    }

    func token(for id: String) -> String? {
        var query = baseQuery(id)
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess, let data = result as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    private func setToken(_ token: String, for id: String, label: String) throws {
        let data = Data(token.utf8)
        var add = baseQuery(id)
        add[kSecValueData as String] = data
        add[kSecAttrLabel as String] = "Agent Motel: \(label)"
        var status = SecItemAdd(add as CFDictionary, nil)
        if status == errSecDuplicateItem {
            status = SecItemUpdate(baseQuery(id) as CFDictionary,
                                   [kSecValueData as String: data, kSecAttrLabel as String: "Agent Motel: \(label)"] as CFDictionary)
        }
        guard status == errSecSuccess else { throw PolicyError("Couldn’t save the token in the Keychain (\(Self.describe(status)))") }
    }

    private func deleteToken(for id: String) throws {
        let status = SecItemDelete(baseQuery(id) as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else {
            throw PolicyError("Couldn’t remove the token from the Keychain (\(Self.describe(status)))")
        }
    }

    private static func describe(_ status: OSStatus) -> String {
        (SecCopyErrorMessageString(status, nil) as String?) ?? "error \(status)"
    }
}
