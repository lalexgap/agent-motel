// Manual integration regression: bun scripts/canary-codex-permissions.ts [--opt-out]
// Requires a running Codex daemon, tmux, and model access. Runs one benign TUI
// turn in a disposable directory; only its own TUI/thread/trust entry is stopped.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  codexDaemonSocket, codexDeadline, pretrustCodexDir, releaseCodexTrust,
  startCodexThread, stopCodexThread, withCodexAppServer,
} from "../src/codexDaemon";
import { buildLaunchCommand } from "../src/providers";

const bypass = !process.argv.includes("--opt-out");
const cwd = mkdtempSync(join(tmpdir(), "am-yolo-canary-"));
const name = `am-yolo-canary-${process.pid}`;
const socket = codexDaemonSocket();
const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
const tmux = (...args: string[]) => {
  const r = Bun.spawnSync(["tmux", ...args], { stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(r.stderr.toString());
  return r.stdout.toString();
};
let id: string | undefined;
let launched = false;
let trusted = false;
try {
  // Trust only this disposable folder, also in opt-out mode so this probe
  // measures thread permissions rather than the independent folder dialog.
  trusted = pretrustCodexDir(cwd, codexDeadline(4000));
  if (!trusted) throw new Error("could not trust disposable workspace");
  id = await startCodexThread({ cwd, name, bypass, model: process.env.AM_CODEX_SMOKE_MODEL ?? "gpt-6.1-sol", effort: "low" });
  // Close the last subscription explicitly so the TUI must reconstruct the
  // fresh rollout rather than racing the daemon's in-memory thread lifetime.
  await withCodexAppServer(socket, 4000, async call => {
    await call("thread/resume", { threadId: id, excludeTurns: true });
    await call("thread/unsubscribe", { threadId: id });
  });
  const plan = buildLaunchCommand("codex", name, { resume: id, codexDaemonDir: cwd, model: process.env.AM_CODEX_SMOKE_MODEL ?? "gpt-6.1-sol", effort: "low" });
  const unset = Object.keys(process.env).filter(k => k.startsWith("AGENTMGR_") || k.startsWith("CODEX_THREAD") || k === "CODEX_SESSION_ID");
  tmux("new-session", "-d", "-s", name, "-x", "120", "-y", "35", "-c", cwd,
    ["env", ...unset.flatMap(k => ["-u", k]), ...plan.command].map(quote).join(" "));
  launched = true;
  const until = async (ready: () => Promise<boolean>, label: string) => {
    const end = Date.now() + 180_000;
    while (Date.now() < end) {
      if (await ready()) return;
      await Bun.sleep(200);
    }
    throw new Error(`timed out: ${label}`);
  };
  await Bun.sleep(1500);
  await until(async () => {
    const pane = tmux("capture-pane", "-p", "-t", name);
    if (pane.includes("Hooks need review")) {
      tmux("send-keys", "-t", name, "3");
      await Bun.sleep(200);
      tmux("send-keys", "-t", name, "Enter");
      await Bun.sleep(1000);
      return false;
    }
    return pane.includes("Ask Codex to do anything");
  }, "TUI handoff");
  const snapshot = async (stage: string) => withCodexAppServer(socket, 4000, async call => {
    const r = await call("thread/resume", { threadId: id, excludeTurns: true });
    const result = { stage, threadId: id, bypass, approvalPolicy: r.approvalPolicy, sandbox: r.sandbox, model: r.model, effort: r.reasoningEffort };
    console.log(JSON.stringify(result));
    return r.approvalPolicy === "never" && r.sandbox?.type === "dangerFullAccess";
  });
  const handoff = await snapshot("after-handoff");
  tmux("send-keys", "-t", name, "-l", "Reply with exactly AM_YOLO_CANARY_OK. Do not use tools or modify files.");
  await Bun.sleep(300);
  tmux("send-keys", "-t", name, "Enter");
  await until(async () => withCodexAppServer(socket, 4000, async call => {
    const r = await call("thread/turns/list", { threadId: id, limit: 1, sortDirection: "desc" });
    const turn = r.data?.[0];
    if (turn?.status === "failed" || turn?.status === "interrupted") throw new Error(`turn ${turn.status}`);
    return turn?.status === "completed";
  }), "benign first turn");
  const firstTurn = await snapshot("after-first-turn");
  if (bypass ? !handoff || !firstTurn : handoff || firstTurn) throw new Error("permission regression");
  console.log("PASS");
} finally {
  if (launched) {
    try {
      tmux("kill-session", "-t", name);
    } catch {
      // The TUI may have exited before the canary reached its first snapshot.
    }
  }
  if (id) await stopCodexThread(id).catch(e => console.error(`cleanup: ${e.message}`));
  if (trusted) releaseCodexTrust(cwd, name, codexDeadline(4000));
  rmSync(cwd, { recursive: true, force: true });
}
