import SwiftUI

struct SettingsView: View {
    @Environment(SettingsStore.self) private var settings
    @Environment(\.dismiss) private var dismiss

    @State private var testResult: String?
    @State private var testing = false

    var body: some View {
        @Bindable var settings = settings
        Form {
            Section("Server") {
                TextField("https://server.tailnet.ts.net:7337", text: $settings.serverURLString)
                    .keyboardType(.URL)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                SecureField("API token (am token)", text: $settings.token)
            }
            Section {
                Button {
                    testConnection()
                } label: {
                    if testing { ProgressView() } else { Text("Test connection") }
                }
                .disabled(settings.client == nil || testing)
                if let testResult {
                    Text(testResult)
                        .font(.callout)
                        .foregroundStyle(testResult.hasPrefix("✓") ? .green : .red)
                }
            } footer: {
                Text("Run `am serve` on the machine with your agents, `am token` for the token, and reach it over your tailnet.")
            }
        }
        .navigationTitle("Settings")
        .toolbar {
            ToolbarItem(placement: .confirmationAction) {
                Button("Save") {
                    settings.save()
                    dismiss()
                }
                .disabled(settings.client == nil)
            }
        }
    }

    private func testConnection() {
        guard let client = settings.client else { return }
        testing = true
        testResult = nil
        Task {
            do {
                try await client.health()
                testResult = "✓ connected"
            } catch {
                testResult = "✕ \(error.localizedDescription)"
            }
            testing = false
        }
    }
}
