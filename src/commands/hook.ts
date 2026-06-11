import { setStatus, readAgent } from "../state";
import { queueDepth } from "../queue";
import { spawnDeliver } from "../deliver";
import { notifyDaemon } from "../daemon";

async function readStdinPayload(): Promise<Record<string, unknown>> {
  if (process.stdin.isTTY) return {};
  try {
    const text = await Bun.stdin.text();
    return text.trim() ? JSON.parse(text) : {};
  } catch {
    return {};
  }
}

function notifyMac(title: string, message: string): void {
  const esc = (s: string) => s.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
  Bun.spawnSync([
    "osascript",
    "-e",
    `display notification "${esc(message)}" with title "${esc(title)}"`,
  ]);
}

export async function hookCommand(event: string): Promise<void> {
  const name = process.env.AGENTMGR_AGENT;
  if (!name || !readAgent(name)) return; // not a managed session

  const payload = await readStdinPayload();

  switch (event) {
    case "session-start":
      setStatus(name, "idle");
      break;
    case "user-prompt-submit":
      setStatus(name, "working");
      break;
    case "stop":
      setStatus(name, "idle");
      // Prefer the daemon as scheduler; fall back to a detached one-shot
      // delivery process when it isn't running.
      if (queueDepth(name) > 0 && !(await notifyDaemon(name, "stop"))) {
        spawnDeliver(name);
      }
      break;
    case "notification": {
      setStatus(name, "needs-attention");
      const message = typeof payload.message === "string" ? payload.message : "needs attention";
      notifyMac(`am: ${name}`, message);
      break;
    }
    case "session-end":
      setStatus(name, "exited");
      break;
    default:
      throw new Error(`unknown hook event: ${event}`);
  }
}
