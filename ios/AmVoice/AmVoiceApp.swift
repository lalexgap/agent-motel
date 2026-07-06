import SwiftUI

@main
struct AmVoiceApp: App {
    @State private var settings = SettingsStore()

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(settings)
        }
    }
}

struct RootView: View {
    @Environment(SettingsStore.self) private var settings

    var body: some View {
        NavigationStack {
            if let client = settings.client {
                FleetListView(client: client)
            } else {
                SettingsView()
            }
        }
    }
}
