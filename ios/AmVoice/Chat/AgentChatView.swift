import SwiftUI

struct AgentChatView: View {
    @State private var model: ChatViewModel

    init(agent: FleetRow, client: ApiClient) {
        _model = State(initialValue: ChatViewModel(agent: agent, client: client))
    }

    var body: some View {
        VStack(spacing: 0) {
            transcript
            statusBar
            inputBar
        }
        .navigationTitle(model.agent.name)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Toggle(isOn: $model.handsFree) {
                    Image(systemName: "repeat.circle")
                }
                .toggleStyle(.button)
                .help("Hands-free: reopen the mic after each spoken reply")
            }
            ToolbarItem(placement: .topBarTrailing) {
                Toggle(isOn: $model.voiceReplies) {
                    Image(systemName: "headphones.circle")
                }
                .toggleStyle(.button)
                .help("Voice replies: ask for spoken summaries on typed messages too")
            }
        }
        .onAppear { model.start() }
        .onDisappear { model.teardown() }
    }

    private var transcript: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 10) {
                    ForEach(model.items) { item in
                        TurnView(turn: item.turn)
                            .id(item.id)
                    }
                }
                .padding(.horizontal)
                .padding(.top, 8)
            }
            .defaultScrollAnchor(.bottom)
            .onChange(of: model.items.count) {
                if let last = model.items.last {
                    withAnimation { proxy.scrollTo(last.id, anchor: .bottom) }
                }
            }
        }
    }

    private var statusBar: some View {
        VStack(spacing: 4) {
            if let error = model.errorMessage {
                Text(error).font(.caption).foregroundStyle(.red)
            }
            if let note = model.sendNote {
                Text(note).font(.caption).foregroundStyle(.secondary)
            }
            HStack(spacing: 8) {
                Image(systemName: AgentStatus.symbol(model.status))
                    .font(.caption2)
                Text(model.status).font(.caption)
                Spacer()
                if model.isSpeaking {
                    Button {
                        model.stopSpeaking()
                    } label: {
                        Label("Speaking — tap to stop", systemImage: "speaker.wave.2.fill")
                            .font(.caption)
                    }
                    .buttonStyle(.bordered)
                    .controlSize(.mini)
                }
                if model.isListening {
                    Label("Listening…", systemImage: "waveform")
                        .font(.caption)
                        .foregroundStyle(.red)
                }
            }
        }
        .padding(.horizontal)
        .padding(.vertical, 6)
    }

    private var inputBar: some View {
        HStack(spacing: 8) {
            Menu {
                Picker("Mode", selection: $model.mode) {
                    Text("queue — deliver when idle").tag(SendMode.queue)
                    Text("now — steer current turn").tag(SendMode.now)
                    Text("interrupt — abort and redirect").tag(SendMode.interrupt)
                }
            } label: {
                Text(model.mode.rawValue)
                    .font(.caption)
                    .padding(.horizontal, 8)
                    .padding(.vertical, 6)
                    .background(.quaternary, in: Capsule())
            }

            TextField("Message", text: $model.draft, axis: .vertical)
                .textFieldStyle(.roundedBorder)
                .lineLimit(1...4)
                .onSubmit { model.sendDraft() }

            Button {
                model.micTapped()
            } label: {
                Image(systemName: model.isListening ? "mic.fill" : "mic")
                    .font(.title3)
                    .foregroundStyle(model.isListening ? .red : .accentColor)
            }

            Button {
                model.sendDraft()
            } label: {
                Image(systemName: "arrow.up.circle.fill").font(.title2)
            }
            .disabled(model.draft.trimmingCharacters(in: .whitespaces).isEmpty)
        }
        .padding(.horizontal)
        .padding(.vertical, 8)
        .background(.bar)
    }
}

struct TurnView: View {
    let turn: Turn
    @State private var expanded = false

    var body: some View {
        switch turn.kind {
        case "user":
            let (text, wasVoice) = SpeechText.userDisplay(from: turn.text ?? "")
            HStack {
                Spacer(minLength: 40)
                HStack(alignment: .top, spacing: 4) {
                    if wasVoice {
                        Image(systemName: "mic.fill").font(.caption2).opacity(0.7)
                    }
                    Text(text)
                }
                .padding(10)
                .background(Color.accentColor.opacity(0.85), in: RoundedRectangle(cornerRadius: 14))
                .foregroundStyle(.white)
            }
        case "assistant":
            HStack {
                Text(SpeechText.display(from: turn.text ?? ""))
                    .padding(10)
                    .background(.quaternary, in: RoundedRectangle(cornerRadius: 14))
                Spacer(minLength: 40)
            }
        default: // tool — collapsed one-liner, tap for the output
            VStack(alignment: .leading, spacing: 4) {
                Button {
                    withAnimation { expanded.toggle() }
                } label: {
                    HStack(spacing: 6) {
                        Image(systemName: "wrench.fill").font(.caption2)
                        Text(turn.name ?? "tool").font(.caption).bold()
                        Text(turn.input ?? "").font(.caption).lineLimit(1)
                        Spacer()
                    }
                    .foregroundStyle(.secondary)
                }
                .buttonStyle(.plain)
                if expanded, let output = turn.output, !output.isEmpty {
                    Text(output)
                        .font(.caption.monospaced())
                        .foregroundStyle(.secondary)
                        .padding(8)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(.quaternary.opacity(0.5), in: RoundedRectangle(cornerRadius: 8))
                }
            }
        }
    }
}
