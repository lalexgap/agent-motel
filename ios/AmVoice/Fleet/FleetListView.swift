import SwiftUI

struct FleetListView: View {
    let client: ApiClient

    @State private var rows: [FleetRow] = []
    @State private var unreachable: [String] = []
    @State private var errorMessage: String?
    @State private var loaded = false
    @State private var showSettings = false
    @State private var showSpawn = false

    var body: some View {
        List {
            if let errorMessage {
                Text(errorMessage).font(.callout).foregroundStyle(.red)
            }
            ForEach(rows) { row in
                if row.isRemote {
                    // Voice chat needs the transcript endpoint, which is
                    // local-only for now — remote agents are visible but
                    // not chattable from the phone yet.
                    AgentRowView(row: row)
                        .opacity(0.5)
                } else {
                    NavigationLink(value: row) {
                        AgentRowView(row: row)
                    }
                }
            }
            if !unreachable.isEmpty {
                Text("unreachable: \(unreachable.joined(separator: ", "))")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .overlay {
            if !loaded {
                ProgressView()
            } else if rows.isEmpty && errorMessage == nil {
                ContentUnavailableView("No agents", systemImage: "person.3", description: Text("Spawn one with the + button."))
            }
        }
        .navigationTitle("agents")
        .navigationDestination(for: FleetRow.self) { row in
            AgentChatView(agent: row, client: client)
        }
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button { showSpawn = true } label: { Image(systemName: "plus") }
            }
            ToolbarItem(placement: .topBarTrailing) {
                Button { showSettings = true } label: { Image(systemName: "gearshape") }
            }
        }
        .sheet(isPresented: $showSettings) {
            NavigationStack { SettingsView() }
        }
        .sheet(isPresented: $showSpawn) {
            NavigationStack { SpawnView(client: client) { await refresh() } }
        }
        .refreshable { await refresh() }
        .task {
            while !Task.isCancelled {
                await refresh()
                try? await Task.sleep(for: .seconds(3))
            }
        }
    }

    private func refresh() async {
        do {
            let fleet = try await client.agents()
            rows = fleet.rows
            unreachable = fleet.unreachable
            errorMessage = nil
        } catch {
            errorMessage = error.localizedDescription
        }
        loaded = true
    }
}

struct AgentRowView: View {
    let row: FleetRow

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: AgentStatus.symbol(row.status))
                .foregroundStyle(statusColor)
                .font(.callout)
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    Text(row.name).font(.headline)
                    if let host = row.host {
                        Text(host.split(separator: ".").first.map(String.init) ?? host)
                            .font(.caption2)
                            .padding(.horizontal, 5)
                            .padding(.vertical, 1)
                            .background(.quaternary, in: Capsule())
                    }
                    if row.provider == "codex" {
                        Text("codex")
                            .font(.caption2)
                            .padding(.horizontal, 5)
                            .padding(.vertical, 1)
                            .background(.quaternary, in: Capsule())
                    }
                }
                Text(subtitle)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            Spacer()
            VStack(alignment: .trailing, spacing: 2) {
                Text(statusLabel).font(.caption).foregroundStyle(statusColor)
                Text(relativeTime(fromISO: row.updatedAt)).font(.caption2).foregroundStyle(.secondary)
            }
        }
    }

    private var subtitle: String {
        row.task ?? row.dir
    }

    private var statusLabel: String {
        var label = row.status
        if row.queued > 0 { label += " · \(row.queued)q" }
        return label
    }

    private var statusColor: Color {
        switch AgentStatus.color(row.status) {
        case .green: return .green
        case .orange: return .orange
        case .red: return .red
        case .gray: return .gray
        case .secondary: return .secondary
        }
    }
}

struct SpawnView: View {
    let client: ApiClient
    let onSpawned: () async -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var name = ""
    @State private var task = ""
    @State private var codex = false
    @State private var errorMessage: String?
    @State private var spawning = false

    var body: some View {
        Form {
            TextField("name", text: $name)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
            TextField("task (optional)", text: $task, axis: .vertical)
            Toggle("Codex", isOn: $codex)
            if let errorMessage {
                Text(errorMessage).font(.callout).foregroundStyle(.red)
            }
        }
        .navigationTitle("New agent")
        .toolbar {
            ToolbarItem(placement: .cancellationAction) {
                Button("Cancel") { dismiss() }
            }
            ToolbarItem(placement: .confirmationAction) {
                Button("Spawn") { spawn() }
                    .disabled(name.trimmingCharacters(in: .whitespaces).isEmpty || spawning)
            }
        }
    }

    private func spawn() {
        spawning = true
        errorMessage = nil
        Task {
            do {
                try await client.spawn(name: name.trimmingCharacters(in: .whitespaces), task: task, codex: codex)
                await onSpawned()
                dismiss()
            } catch {
                errorMessage = error.localizedDescription
                spawning = false
            }
        }
    }
}
