import { readdirSync } from "node:fs";
import { createConnection } from "node:net";
import { join } from "node:path";
import { claudeSessionsDir } from "./paths";
import { readJsonOrNull } from "./fsutil";
import { tmux } from "./tmux";
import type { AgentState } from "./state";

// Claude Code's cross-session inbox: every interactive session lists itself in
// ~/.claude/sessions/<pid>.json and accepts NDJSON user frames on a private
// Unix socket. A frame wakes an idle session into a turn without touching the
// composer, so it replaces typing into the pane for peer messages. Internal
// and unversioned upstream — anything unexpected falls back to send-keys.

interface RegistryEntry {
  pid?: number;
  sessionId?: string;
  kind?: string;
  tmux?: string;
  messagingSocketPath?: string;
}

export interface PeerTarget {
  pid: number;
  sessionId: string;
  socketPath: string;
}

// Claude caps a frame at 1 MiB; leave headroom for the JSON envelope.
const MAX_CONTENT = 900_000;

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function paneId(session: string): string | null {
  const result = tmux("display-message", "-p", "-t", `=${session}:`, "#{pane_id}");
  const id = result.stdout.trim();
  return result.exitCode === 0 && id ? id : null;
}

// Only sessions launched with crossSessionInbound=accept qualify (SessionStart
// records them); any other bypass-mode session would hold the message behind
// an approval dialog. The registry entry must sit in this agent's pane, so a
// recycled pid or a stray session never receives it.
export function peerTarget(agent: AgentState): PeerTarget | null {
  if (!agent.peerInboxSession) return null;
  const pane = paneId(agent.tmuxSession);
  if (!pane) return null;
  let files: string[];
  try {
    files = readdirSync(claudeSessionsDir()).filter((f) => /^\d+\.json$/.test(f));
  } catch {
    return null;
  }
  for (const file of files) {
    const entry = readJsonOrNull<RegistryEntry>(join(claudeSessionsDir(), file));
    if (!entry?.pid || !entry.messagingSocketPath || entry.kind !== "interactive") continue;
    if (entry.sessionId !== agent.peerInboxSession) continue;
    // Pane ids are unique per tmux server and survive `am rename`, which the
    // registry's session-name prefix does not.
    if (!entry.tmux?.endsWith(`.${pane}`) || !alive(entry.pid)) continue;
    return { pid: entry.pid, sessionId: entry.sessionId, socketPath: entry.messagingSocketPath };
  }
  return null;
}

function peerToken(pid: number): string | null {
  try {
    const key = readdirSync(claudeSessionsDir()).find((f) => f.startsWith(`${pid}.`) && f.endsWith(".key"));
    if (!key) return null;
    return readJsonOrNull<{ peerToken?: string }>(join(claudeSessionsDir(), key))?.peerToken ?? null;
  } catch {
    return null;
  }
}

export function peerSendable(message: string): boolean {
  return message.trim().length > 0 && message.length <= MAX_CONTENT;
}

// Resolves once the frame is written; the inbox sends no reply, so arrival is
// confirmed separately by the UserPromptSubmit hook.
export function sendPeerMessage(target: PeerTarget, message: string, msgId: string): Promise<void> {
  const token = peerToken(target.pid);
  const lines = [
    ...(token ? [JSON.stringify({ type: "auth", token })] : []),
    JSON.stringify({
      type: "user",
      message: { role: "user", content: message },
      session_id: target.sessionId,
      msg_id: msgId,
      priority: "next",
    }),
  ];
  return new Promise((resolve, reject) => {
    const socket = createConnection(target.socketPath);
    const timer = setTimeout(() => socket.destroy(new Error("peer inbox timed out")), 3000);
    socket.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    socket.on("connect", () => {
      socket.end(`${lines.join("\n")}\n`, () => {
        clearTimeout(timer);
        resolve();
      });
    });
  });
}
