import { homedir } from "node:os";
import { readAgent, recordAttached, type AgentState } from "../state";
import { attachOrSwitch, hasSession } from "../tmux";
import { CONCIERGE_NAME } from "../providers";
import { loadConfig } from "../config";
import { fleetRows } from "../fleet";
import { sshAm, sshAmInteractive } from "../remote";
import { newCommand, type NewOptions } from "./new";
import { reviveAgent } from "./resume";
import { sendCommand, type SendOutcome } from "./send";
import type { FeedbackResult } from "../picker";
import { CONCIERGE_ROLE } from "../roles";

// The concierge's whole value is the fleet-management system prompt (selected
// by name in providers.ts), which works on either provider — codex just
// carries it in the initial prompt instead of a system-prompt flag. Provider
// comes from config.conciergeProvider rather than defaultProvider so the front
// desk can differ from the workforce; newCommand fails loudly when the chosen
// provider isn't installed. It manages agents, not code: home dir, no worktree.
export function conciergeNewOptions(question?: string): NewOptions {
  return {
    name: CONCIERGE_NAME,
    concierge: true,
    role: CONCIERGE_ROLE,
    provider: loadConfig().conciergeProvider,
    dir: homedir(),
    inPlace: true,
    message: question ?? "Introduce yourself in a sentence, then give a fleet status report.",
    jump: false,
    quiet: true,
  };
}

// Which host owns the fleet's concierge (undefined = this machine). An
// explicit config.conciergeHost wins — every machine configured with the same
// value shares one concierge. Without it, an existing concierge anywhere in
// the fleet is adopted (local first, then config.remotes order), so pressing
// `c` on a second machine reuses the fleet's front desk instead of opening a
// rival one; only a fleet with no concierge at all creates one, locally.
export function resolveConciergeHost(): string | undefined {
  const config = loadConfig();
  if (config.conciergeHost) return config.conciergeHost === "local" ? undefined : config.conciergeHost;
  if (readAgent(CONCIERGE_NAME)) return undefined;
  const remote = fleetRows({ timeoutMs: 4000 }).rows.find((row) => row.host && row.name === CONCIERGE_NAME);
  return remote?.host;
}

export interface ConciergeLocation {
  // undefined = local; otherwise the ssh host alias the concierge lives on.
  host?: string;
  // Picker/fleet key: "concierge" locally, "host:concierge" remote.
  key: string;
  agent?: AgentState;
  // Where a question went: the first message of a new or revived session,
  // a send to the live one, or handed to the remote host's own am.
  delivery?: "created" | "revived" | "remote" | SendOutcome;
}

// Singleton lifecycle, shared by the CLI and the hub's `c` key: exactly one
// concierge for the fleet, created on first use, revived when its session is
// gone. A question rides the create/revive message queue; a live concierge
// gets it as a normal queued send. On a remote host the whole ensure runs
// through that machine's own `am concierge --no-jump`, so its reservation and
// revive logic apply there.
export async function ensureConcierge(question?: string, opts: { quiet?: boolean } = {}): Promise<ConciergeLocation> {
  const host = resolveConciergeHost();
  if (host) {
    const args = ["concierge", "--no-jump", ...(question ? ["-m", question] : [])];
    const result = sshAm(host, args);
    if (result.exitCode !== 0) {
      throw new Error(
        `concierge on ${host} failed: ${result.stderr.trim() || "no output — does its am know `am concierge`?"}`,
      );
    }
    return { host, key: `${host}:${CONCIERGE_NAME}`, ...(question ? { delivery: "remote" as const } : {}) };
  }

  const existing = readAgent(CONCIERGE_NAME);
  if (!existing) {
    await newCommand(conciergeNewOptions(question));
    return { key: CONCIERGE_NAME, agent: readAgent(CONCIERGE_NAME)!, ...(question ? { delivery: "created" as const } : {}) };
  }
  let delivery: ConciergeLocation["delivery"];
  if (!hasSession(existing.tmuxSession)) {
    await reviveAgent(existing, question ? { message: question } : {});
    if (question) delivery = "revived";
  } else if (question) {
    delivery = await sendCommand(CONCIERGE_NAME, question, { now: false, quiet: opts.quiet });
  }
  return { key: CONCIERGE_NAME, agent: existing, delivery };
}

// Banner for a question asked inline (the palette's ask prompt), saying
// where it landed since the operator isn't watching the concierge's pane.
export function conciergeAskFeedback(location: ConciergeLocation): FeedbackResult {
  switch (location.delivery) {
    case "created":
      return { text: "started the concierge with your question", level: "ok" };
    case "revived":
      return { text: "revived the concierge with your question", level: "ok" };
    case "remote":
      return { text: `queued for the concierge on ${location.host}`, level: "ok" };
    case "steered":
    case "delivered":
      return { text: "sent to the concierge", level: "ok" };
    case "queued":
      return { text: "queued for the concierge — delivered when it goes idle", level: "ok" };
    case "outbox":
      return { text: "concierge not found — question parked in the outbox", level: "warn" };
    case "dropped":
      return { text: "question dropped — over the message rate limit", level: "error" };
    default:
      return { text: "concierge ready", level: "ok" };
  }
}

export async function conciergeCommand(opts: { question?: string; jump?: boolean }): Promise<void> {
  const location = await ensureConcierge(opts.question);
  const jump = opts.jump ?? (!!process.stdout.isTTY && !!process.stdin.isTTY);
  if (!jump) {
    console.log(`concierge ready${location.host ? ` on ${location.host}` : ""}${opts.question ? " — your question is queued" : ""}`);
    console.log(`  jump to it:  am j ${location.key}`);
    return;
  }
  if (location.host) {
    sshAmInteractive(location.host, ["j", CONCIERGE_NAME]);
    return;
  }
  recordAttached(CONCIERGE_NAME);
  attachOrSwitch(location.agent!.tmuxSession);
}
