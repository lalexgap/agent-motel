import Foundation

struct ApiError: Error, LocalizedError {
    let message: String
    var errorDescription: String? { message }
}

// Thin client for the `am serve` HTTP API: bearer token on every request,
// JSON in/out, server-side {error} messages surfaced as thrown ApiErrors.
struct ApiClient {
    let baseURL: URL
    let token: String

    func health() async throws {
        _ = try await request(path: "api/health")
    }

    func agents() async throws -> FleetResponse {
        try decode(await request(path: "api/agents"))
    }

    func transcript(agent: String, after: Int) async throws -> TranscriptPage {
        try decode(await request(path: "api/agents/\(agent)/transcript", query: ["after": String(after)]))
    }

    func send(agent: String, text: String, mode: String) async throws {
        _ = try await request(path: "api/agents/\(agent)/messages", method: "POST", body: ["text": text, "mode": mode])
    }

    func spawn(name: String, task: String?, codex: Bool) async throws {
        var body: [String: Any] = ["name": name, "codex": codex]
        if let task, !task.isEmpty { body["task"] = task }
        _ = try await request(path: "api/agents", method: "POST", body: body)
    }

    func stop(agent: String) async throws {
        _ = try await request(path: "api/agents/\(agent)/stop", method: "POST")
    }

    func resume(agent: String) async throws {
        _ = try await request(path: "api/agents/\(agent)/resume", method: "POST")
    }

    func remove(agent: String) async throws {
        _ = try await request(path: "api/agents/\(agent)", method: "DELETE")
    }

    // MARK: - plumbing

    private func request(
        path: String,
        method: String = "GET",
        query: [String: String] = [:],
        body: [String: Any]? = nil
    ) async throws -> Data {
        var components = URLComponents(url: baseURL.appending(path: path), resolvingAgainstBaseURL: false)!
        if !query.isEmpty {
            components.queryItems = query.map { URLQueryItem(name: $0.key, value: $0.value) }
        }
        guard let url = components.url else { throw ApiError(message: "bad URL") }

        var req = URLRequest(url: url)
        req.httpMethod = method
        req.timeoutInterval = 15
        req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        if let body {
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            req.httpBody = try JSONSerialization.data(withJSONObject: body)
        }

        let (data, response) = try await URLSession.shared.data(for: req)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(status) else {
            if let err = try? JSONDecoder().decode([String: String].self, from: data), let message = err["error"] {
                throw ApiError(message: message)
            }
            throw ApiError(message: "HTTP \(status)")
        }
        return data
    }

    private func decode<T: Decodable>(_ data: Data) throws -> T {
        try JSONDecoder().decode(T.self, from: data)
    }
}
