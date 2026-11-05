import { createHash, randomBytes } from "node:crypto";
import { join } from "node:path";
import { baseDir } from "./paths";
import { readAgent, agentProvider } from "./state";
import { tmux } from "./tmux";
import { readJsonOrNull, writeJsonAtomic } from "./fsutil";
import { withFileLock } from "./filelock";
import { acquireLifecycleLock, releaseLifecycleLock } from "./lifecycle";
import { detectClaudePrompt, buildPromptKeys } from "./panePrompts";

interface Snapshot { fingerprint: string; id: string; consumed: boolean }
export interface PromptAnswer { id: string; optionId: string; text?: string }
export function validPromptAnswer(value: unknown): value is PromptAnswer {
  const b = value as PromptAnswer | null;
  return !!b && typeof b.id === "string" && /^[a-f0-9]{32}$/.test(b.id)
    && typeof b.optionId === "string" && b.optionId.length <= 64
    && (b.text === undefined || (typeof b.text === "string" && b.text.length <= 2000 && !/[\x00-\x1f\x7f]/.test(b.text)));
}
function paths(name: string) {
  const key = createHash("sha256").update(name).digest("hex");
  const file = join(baseDir(), "pane-prompts", key);
  return { file, lock: file + ".lock" };
}
function capture(name: string) {
  const agent = readAgent(name);
  if (!agent || agent.name !== name || agent.status === "exited" || agentProvider(agent) !== "claude") return null;
  const target = tmux("display-message", "-p", "-t", `=${agent.tmuxSession}:`, "#{pane_id}:#{pane_pid}");
  const identity = target.stdout.trim();
  if (target.exitCode || !/^%\d+:\d+$/.test(identity)) return null;
  const paneId = identity.split(":")[0]!;
  const result = tmux("capture-pane", "-p", "-t", paneId);
  if (result.exitCode) return null;
  const pane = result.stdout.trimEnd();
  const prompt = detectClaudePrompt(pane);
  const fingerprint = createHash("sha256").update(JSON.stringify([agent.createdAt, agent.tmuxSession, identity, pane])).digest("hex");
  return { prompt, fingerprint, paneId };
}
function snapshot(file: string, fingerprint: string): Snapshot {
  const old = readJsonOrNull<Snapshot>(file);
  if (old?.fingerprint === fingerprint) return old;
  const next = { fingerprint, id: randomBytes(16).toString("hex"), consumed: false };
  writeJsonAtomic(file, next, { mode: 0o600 });
  return next;
}
export function agentPanePrompt(name: string) {
  const { file, lock } = paths(name);
  return withFileLock(lock, () => {
    const live = capture(name);
    if (!live) return null;
    const record = snapshot(file, live.fingerprint);
    return live.prompt && !record.consumed ? { ...live.prompt, id: record.id } : null;
  });
}
export function answerPanePrompt(name: string, answer: PromptAnswer): { ok: boolean; error?: string } {
  if (!validPromptAnswer(answer)) return { ok: false, error: "Invalid prompt answer" };
  if (!acquireLifecycleLock(name)) return { ok: false, error: "Agent is changing; refresh before answering" };
  try {
    const { file, lock } = paths(name);
    return withFileLock(lock, () => {
      const record = readJsonOrNull<Snapshot>(file);
      const live = capture(name);
      if (!record || record.consumed || record.id !== answer.id || !live?.prompt || live.fingerprint !== record.fingerprint)
        return { ok: false, error: "Prompt changed or was already answered; refresh and try again" };
      let steps;
      try { steps = buildPromptKeys(live.prompt, answer); }
      catch (error) { return { ok: false, error: (error as Error).message }; }
      // Consume before sending: a partial write must never be retried automatically.
      writeJsonAtomic(file, { ...record, consumed: true }, { mode: 0o600 });
      for (const [index, step] of steps.entries()) {
        const args = "text" in step ? ["-l", "--", step.text] : [step.key];
        const sent = tmux("send-keys", "-t", live.paneId, ...args);
        if (sent.exitCode) return { ok: false, error: "Terminal input failed; inspect the terminal before continuing" };
        if (index < steps.length - 1) Bun.sleepSync("text" in step ? 100 : 50);
      }
      return { ok: true };
    });
  } finally { releaseLifecycleLock(name); }
}
