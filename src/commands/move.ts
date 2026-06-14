import { existsSync, realpathSync, renameSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import {
  agentProvider,
  agentSessionId,
  readAgent,
  resolveAgent,
  writeAgent,
  type AgentState,
} from "../state";
import { queueAppend, queueList } from "../queue";
import { claudeProjectSlug, locateTranscript } from "../transcript";
import { codexHome } from "../codexHooks";
import { stopAgent, destroyAgent } from "./rm";
import { sendText } from "../tmux";
import { enterDelayMs } from "../deliver";
import { runAsync, sshAmAsync, sshRunAsync } from "../remote";
import { splitFleetKey } from "../fleet";
import { expandHome, worktreesDir } from "../paths";
import { hasSession } from "../tmux";
import { loadConfig } from "../config";
import { createWorktree, isGitRepo } from "./new";

// `am move <name> <host>` (push) / `am move <host>:<name>` (pull): a TRUE
// move of an agent between machines — state, queue, and the provider's
// conversation file travel; the working directory does not (repos are
// assumed to exist on both sides).

export interface MovePayload {
  state: AgentState;
  queue: string[];
}

// Swap one $HOME prefix for another; null when the path isn't under $HOME
// (then --dir is required).
export function mapHomeDir(path: string, fromHome: string, toHome: string): string | null {
  if (path === fromHome) return toHome;
  if (path.startsWith(fromHome + "/")) return toHome + path.slice(fromHome.length);
  return null;
}

export interface MoveSpec {
  direction: "push" | "pull";
  host: string;
  name: string;
}

export function parseMoveSpec(first: string, second: string | undefined): MoveSpec {
  const { host, name } = splitFleetKey(first);
  if (host && name) {
    if (second) throw new Error("pull form is `am move <host>:<name>` — no second argument");
    return { direction: "pull", host, name };
  }
  if (!second) throw new Error("usage: am move <name> <host>  |  am move <host>:<name>");
  return { direction: "push", host: second, name: first };
}

// Where the conversation file must land on the target, given the TARGET dir
// (claude keys transcripts by a slug of the working directory).
export function targetTranscriptPath(
  provider: "claude" | "codex",
  targetHome: string,
  targetDir: string,
  sessionId: string,
  codexRelative: string | null,
): string {
  if (provider === "codex") {
    if (!codexRelative) throw new Error("codex agent has no rollout path to migrate");
    return join(targetHome, ".codex", codexRelative);
  }
  return join(targetHome, ".claude", "projects", claudeProjectSlug(targetDir), `${sessionId}.jsonl`);
}

// The conversation file to ship, or null for agents that never ran a turn.
export function sourceTranscript(agent: AgentState): { path: string; codexRelative: string | null } | null {
  try {
    const path = locateTranscript(agent);
    const codexRelative =
      agentProvider(agent) === "codex" ? relative(codexHome(), path) : null;
    return { path, codexRelative };
  } catch {
    return null;
  }
}

export function importPayload(raw: string): string {
  const payload = JSON.parse(raw) as MovePayload;
  const state = payload.state;
  if (!state?.name || !state.dir || !state.tmuxSession) throw new Error("malformed move payload");
  if (readAgent(state.name)) throw new Error(`agent "${state.name}" already exists here`);
  if (!existsSync(state.dir)) throw new Error(`target dir does not exist: ${state.dir}`);
  writeAgent({ ...state, status: "exited", workingSince: undefined });
  for (const message of payload.queue ?? []) queueAppend(state.name, message);
  return state.name;
}

export interface MoveOptions {
  dir?: string;
  copy: boolean;
  start: boolean;
  // Clone: the source keeps running and nothing is removed — the
  // conversation forks into two independent agents.
  clone?: boolean;
}

// Queued as the migrated agent's first message: its history is full of
// now-stale environment facts (paths, running processes, OS conventions),
// and without a heads-up it will confidently act on them.
export function migrationBrief(opts: {
  from: string;
  to: string;
  oldDir: string;
  newDir: string;
  clone: boolean;
  branchNote?: string;
  task?: string;
}): string {
  return [
    opts.clone
      ? `[am] You are a CLONE of an agent on ${opts.from} — the original keeps running there in ${opts.oldDir}; you are an independent copy on ${opts.to} in ${opts.newDir}. Work here may diverge from the original's.`
      : `[am] You were just MOVED to a different machine: this conversation previously ran on ${opts.from} in ${opts.oldDir}; you are now on ${opts.to} in ${opts.newDir}.`,
    // Re-anchor on the durable task. A long conversation's in-context window
    // can truncate away the founding instruction while keeping recent
    // move-handshake turns — leaving the agent unsure why it exists even
    // though the full transcript is still on disk. This restates the task
    // from am's own metadata, which never truncates.
    ...(opts.task?.trim()
      ? [
          `Your assignment is unchanged by the move — if your in-context memory of it has gone thin, re-anchor on this (the full transcript is on disk if you need more): ${opts.task.trim()}`,
        ]
      : []),
    `Your history is intact but the environment is not the one you remember:`,
    `- absolute paths from earlier (under ${opts.oldDir}) likely don't exist here — your working directory is now ${opts.newDir}`,
    `- the working tree here may differ from the source machine's (uncommitted changes never travel)`,
    `- processes, dev servers, and shell state from before are gone`,
    `- OS, installed tools, and credentials may differ`,
    ...(opts.branchNote ? [`- ${opts.branchNote}`] : []),
    `Briefly re-verify the repo/file state before continuing your work.`,
  ].join("\n");
}

const PREMOVE_WAIT_MS = 45_000;

export function premoveNotice(target: string): string {
  return `[am] Heads-up: you are about to be MOVED to ${target}. This session will be stopped shortly — finish your immediate step and save anything in flight (write notes to disk, commit/stash if sensible). Do not start new work.`;
}

// A working agent gets a steering heads-up and a capped window to settle
// before the move stops it; idle/exited agents skip straight to the move
// (nothing is in flight, and the arrival brief reorients them).
async function settleBeforeMove(agentName: string, target: string): Promise<void> {
  const current = readAgent(agentName);
  if (!current || current.status !== "working") return;
  try {
    sendText(current.tmuxSession, premoveNotice(target), { enterDelayMs: enterDelayMs(current) });
  } catch {
    return; // no live session to warn
  }
  const start = Date.now();
  while (Date.now() - start < PREMOVE_WAIT_MS) {
    await Bun.sleep(2000);
    const agent = readAgent(agentName);
    if (!agent || agent.status !== "working") return;
  }
}

// Same for an agent on the far side of a pull.
async function settleBeforeMoveRemote(host: string, name: string, status: string): Promise<void> {
  if (status !== "working") return;
  await sshAmAsync(host, ["send", name, "--now", premoveNotice(hostname())], { timeoutMs: 15000 });
  const start = Date.now();
  while (Date.now() - start < PREMOVE_WAIT_MS) {
    await Bun.sleep(3000);
    const ls = await sshAmAsync(host, ["ls", "--json", "--local-only"], { timeoutMs: 8000 });
    if (ls.exitCode !== 0) return;
    try {
      const rows = JSON.parse(ls.stdout) as { name: string; status: string }[];
      const row = rows.find((r) => r.name === name);
      if (!row || row.status !== "working") return;
    } catch {
      return;
    }
  }
}

export async function remoteHome(host: string): Promise<string> {
  const result = await sshRunAsync(host, "echo $HOME", { timeoutMs: 8000 });
  const home = result.stdout.trim();
  if (result.exitCode !== 0 || !home.startsWith("/")) {
    throw new Error(`cannot reach ${host} (${result.stderr.trim() || "no $HOME"})`);
  }
  return home;
}

async function pushAgent(name: string, host: string, opts: MoveOptions): Promise<string> {
  const agent = resolveAgent(name);

  const targetHomeDir = await remoteHome(host);
  let canonicalDir: string;
  let branchNote: string | undefined;
  let targetWorktree: { path: string; branch: string; repoRoot: string } | undefined;

  if (agent.worktreePath && agent.repoRoot && !opts.dir) {
    // Worktree agent: recreate its worktree against the same repo on the
    // target. Commits travel via origin when possible; uncommitted changes
    // never do.
    const repoTarget = mapHomeDir(agent.repoRoot, homedir(), targetHomeDir);
    if (!repoTarget) {
      throw new Error(`${agent.repoRoot} is not under $HOME — pass --dir <target dir on ${host}>`);
    }
    if ((await sshRunAsync(host, `test -d ${shq(repoTarget)}`, { timeoutMs: 8000 })).exitCode !== 0) {
      throw new Error(`repo missing on ${host}: ${repoTarget} — clone it first, or pass --dir`);
    }
    const branch = agent.worktreeBranch ?? `am/${agent.name}`;
    const pushed =
      (await runAsync(["git", "-C", agent.worktreePath, "push", "origin", branch], { timeoutMs: 60000 }))
        .exitCode === 0;
    branchNote = pushed
      ? `your branch ${branch} was pushed to origin and is checked out here`
      : `your branch could not be pushed to origin — unpushed commits did NOT travel (branch recreated on the target)`;

    const canonicalRepo =
      (await sshRunAsync(host, `realpath ${shq(repoTarget)}`, { timeoutMs: 8000 })).stdout.trim() || repoTarget;
    const wtPath = `${targetHomeDir}/.agent-manager/worktrees/${basename(canonicalRepo)}/${agent.name}`;
    const addScript = [
      `git -C ${shq(canonicalRepo)} fetch origin ${shq(branch)} >/dev/null 2>&1 || true`,
      `mkdir -p ${shq(dirname(wtPath))}`,
      `if git -C ${shq(canonicalRepo)} show-ref --verify --quiet refs/heads/${branch}; then ` +
        `git -C ${shq(canonicalRepo)} worktree add ${shq(wtPath)} ${shq(branch)}; ` +
        `elif git -C ${shq(canonicalRepo)} show-ref --verify --quiet refs/remotes/origin/${branch}; then ` +
        `git -C ${shq(canonicalRepo)} worktree add --track -b ${shq(branch)} ${shq(wtPath)} origin/${branch}; ` +
        `else git -C ${shq(canonicalRepo)} worktree add -b ${shq(branch)} ${shq(wtPath)}; fi`,
    ].join(" && ");
    const added = await sshRunAsync(host, addScript, { timeoutMs: 30000 });
    if (added.exitCode !== 0) {
      throw new Error(`could not create worktree on ${host}: ${added.stderr.trim()}`);
    }
    canonicalDir =
      (await sshRunAsync(host, `realpath ${shq(wtPath)}`, { timeoutMs: 8000 })).stdout.trim() || wtPath;
    targetWorktree = { path: canonicalDir, branch, repoRoot: canonicalRepo };
  } else {
    const targetDir = opts.dir ?? mapHomeDir(agent.dir, homedir(), targetHomeDir);
    if (!targetDir) {
      throw new Error(`${agent.dir} is not under $HOME — pass --dir <target dir on ${host}>`);
    }
    if ((await sshRunAsync(host, `test -d ${shq(targetDir)}`, { timeoutMs: 8000 })).exitCode !== 0) {
      throw new Error(`target dir missing on ${host}: ${targetDir} — create/clone it first, or pass --dir`);
    }
    // Canonicalize on the TARGET: claude resolves symlinks when keying
    // transcripts by project dir (~/code/x → /mnt/.../x), so the slug and the
    // stored dir must use the real path or resume finds no conversation.
    canonicalDir =
      (await sshRunAsync(host, `realpath ${shq(targetDir)}`, { timeoutMs: 8000 })).stdout.trim() || targetDir;
  }

  if (!opts.clone) {
    await settleBeforeMove(agent.name, host); // let a working agent wrap up first
    stopAgent(agent); // a move never leaves two live copies
  }

  // Ship the conversation file (if the agent ever ran a turn).
  const transcript = sourceTranscript(agent);
  const sessionId = agentSessionId(agent);
  let remoteTranscriptPath: string | undefined;
  if (transcript && sessionId) {
    const target = targetTranscriptPath(
      agentProvider(agent), targetHomeDir, canonicalDir, sessionId, transcript.codexRelative,
    );
    if ((await sshRunAsync(host, `mkdir -p ${shq(dirname(target))}`, { timeoutMs: 8000 })).exitCode !== 0) {
      throw new Error(`could not create transcript dir on ${host}`);
    }
    const scp = await runAsync(["scp", "-q", transcript.path, `${host}:${target}`], { timeoutMs: 120000 });
    if (scp.exitCode !== 0) throw new Error(`transcript copy failed: ${scp.stderr.trim()}`);
    if (agentProvider(agent) === "codex") remoteTranscriptPath = target;
  }

  const payload: MovePayload = {
    state: {
      ...agent,
      dir: canonicalDir,
      status: "exited",
      workingSince: undefined,
      transcriptPath: remoteTranscriptPath,
      worktreePath: targetWorktree?.path,
      worktreeBranch: targetWorktree?.branch,
      repoRoot: targetWorktree?.repoRoot,
    },
    queue: [
      migrationBrief({
        from: hostname(),
        to: host,
        oldDir: agent.dir,
        newDir: canonicalDir,
        clone: !!opts.clone,
        branchNote,
        task: agent.task,
      }),
      ...queueList(agent.name).map((m) => m.message),
    ],
  };
  const imported = await sshAmAsync(host, ["__import"], { stdin: JSON.stringify(payload), timeoutMs: 20000 });
  if (imported.exitCode !== 0) {
    throw new Error(`import on ${host} failed: ${(imported.stderr + imported.stdout).trim()}`);
  }

  if (!opts.copy && !opts.clone) destroyAgent(agent, { clean: false });
  let message = opts.clone
    ? `cloned "${agent.name}" → ${host}:${canonicalDir} (original still here)`
    : `moved "${agent.name}" → ${host}:${canonicalDir}${opts.copy ? " (local copy kept)" : ""}`;

  if (opts.start) {
    const resumed = await sshAmAsync(host, ["resume", agent.name], { timeoutMs: 30000 });
    message +=
      resumed.exitCode !== 0
        ? ` — remote resume failed: ${resumed.stderr.trim()}`
        : ` — running`;
  }
  return message;
}

async function pullAgent(name: string, host: string, opts: MoveOptions): Promise<string> {
  if (readAgent(name)) throw new Error(`agent "${name}" already exists locally`);

  const exported = await sshAmAsync(host, ["__export", name], { timeoutMs: 20000 });
  if (exported.exitCode !== 0) {
    throw new Error(`export on ${host} failed: ${(exported.stderr + exported.stdout).trim()}`);
  }
  const remote = JSON.parse(exported.stdout) as {
    state: AgentState;
    queue: string[];
    home: string;
    transcript: { path: string; codexRelative: string | null } | null;
  };

  let canonicalDir: string;
  let branchNote: string | undefined;
  let targetWorktree: { path: string; branch: string; repoRoot: string } | undefined;

  if (remote.state.worktreePath && remote.state.repoRoot && !opts.dir) {
    // Worktree agent on the far side: recreate its worktree against the
    // local clone of the same repo.
    const localRepo = mapHomeDir(remote.state.repoRoot, remote.home, homedir());
    if (!localRepo) {
      throw new Error(`${remote.state.repoRoot} is not under the remote $HOME — pass --dir <local dir>`);
    }
    if (!existsSync(localRepo)) {
      throw new Error(`repo missing locally: ${localRepo} — clone it first, or pass --dir`);
    }
    const branch = remote.state.worktreeBranch ?? `am/${name}`;
    const pushed =
      (
        await sshRunAsync(host, `git -C ${shq(remote.state.worktreePath)} push origin ${shq(branch)}`, {
          timeoutMs: 60000,
        })
      ).exitCode === 0;
    branchNote = pushed
      ? `your branch ${branch} was pushed to origin and is checked out here`
      : `your branch could not be pushed to origin — unpushed commits did NOT travel (branch recreated here)`;

    const canonicalRepo = realpathSync(localRepo);
    const wtPath = join(worktreesDir(), basename(canonicalRepo), name);
    Bun.spawnSync(["mkdir", "-p", dirname(wtPath)]);
    await runAsync(["git", "-C", canonicalRepo, "fetch", "origin", branch], { timeoutMs: 30000 });
    const haveLocal =
      (await runAsync(["git", "-C", canonicalRepo, "show-ref", "--verify", "--quiet", `refs/heads/${branch}`])).exitCode === 0;
    const haveOrigin =
      (await runAsync(["git", "-C", canonicalRepo, "show-ref", "--verify", "--quiet", `refs/remotes/origin/${branch}`])).exitCode === 0;
    const addArgs = haveLocal
      ? ["worktree", "add", wtPath, branch]
      : haveOrigin
        ? ["worktree", "add", "--track", "-b", branch, wtPath, `origin/${branch}`]
        : ["worktree", "add", "-b", branch, wtPath];
    const added = await runAsync(["git", "-C", canonicalRepo, ...addArgs], { timeoutMs: 30000 });
    if (added.exitCode !== 0) throw new Error(`could not create local worktree: ${added.stderr.trim()}`);
    canonicalDir = realpathSync(wtPath);
    targetWorktree = { path: canonicalDir, branch, repoRoot: canonicalRepo };
  } else {
    const targetDir = opts.dir ?? mapHomeDir(remote.state.dir, remote.home, homedir());
    if (!targetDir) {
      throw new Error(`${remote.state.dir} is not under the remote $HOME — pass --dir <local dir>`);
    }
    if (!existsSync(targetDir)) {
      throw new Error(`target dir missing locally: ${targetDir} — create/clone it first, or pass --dir`);
    }
    // Same symlink hazard as push, local side: claude keys transcripts by the
    // resolved path.
    canonicalDir = realpathSync(targetDir);
  }

  // Stop it remotely before copying the conversation so the file is final
  // (clones leave the original running and accept a snapshot).
  if (!opts.clone) {
    await settleBeforeMoveRemote(host, name, remote.state.status); // let it wrap up
    await sshAmAsync(host, ["stop", name], { timeoutMs: 15000 });
  }

  const sessionId = agentSessionId(remote.state);
  let localTranscriptPath: string | undefined;
  if (remote.transcript && sessionId) {
    const provider = agentProvider(remote.state);
    const target = targetTranscriptPath(provider, homedir(), canonicalDir, sessionId, remote.transcript.codexRelative);
    Bun.spawnSync(["mkdir", "-p", dirname(target)]);
    const scp = await runAsync(["scp", "-q", `${host}:${remote.transcript.path}`, target], { timeoutMs: 120000 });
    if (scp.exitCode !== 0) throw new Error(`transcript copy failed: ${scp.stderr.trim()}`);
    if (provider === "codex") localTranscriptPath = target;
  }

  importPayload(
    JSON.stringify({
      state: {
        ...remote.state,
        dir: canonicalDir,
        transcriptPath: localTranscriptPath,
        worktreePath: targetWorktree?.path,
        worktreeBranch: targetWorktree?.branch,
        repoRoot: targetWorktree?.repoRoot,
      },
      queue: [
        migrationBrief({
          from: host,
          to: hostname(),
          oldDir: remote.state.dir,
          newDir: canonicalDir,
          clone: !!opts.clone,
          branchNote,
          task: remote.state.task,
        }),
        ...remote.queue,
      ],
    }),
  );

  if (!opts.copy && !opts.clone) await sshAmAsync(host, ["rm", name], { timeoutMs: 15000 });
  let message = opts.clone
    ? `cloned "${name}" ← ${host} (original still on ${host})`
    : `moved "${name}" ← ${host} (now in ${canonicalDir})${opts.copy ? " (remote copy kept)" : ""}`;

  if (opts.start) {
    const { reviveAgent } = await import("./resume");
    await reviveAgent(readAgent(name)!);
    message += " — running";
  }
  return message;
}

function shq(arg: string): string {
  return `'${arg.replaceAll("'", `'\\''`)}'`;
}

// Quiet core, usable from the sidebar (returns the outcome instead of
// printing — the picker owns the screen).
export async function moveAgent(
  first: string,
  second: string | undefined,
  opts: MoveOptions,
): Promise<string> {
  const spec = parseMoveSpec(first, second);
  return spec.direction === "push"
    ? pushAgent(spec.name, spec.host, opts)
    : pullAgent(spec.name, spec.host, opts);
}

export async function moveCommand(
  first: string,
  second: string | undefined,
  opts: MoveOptions,
): Promise<void> {
  console.log(await moveAgent(first, second, opts));
}

// Where `m` in the sidebar sends the highlighted agent: remote agents pull
// home; local agents push to the single configured remote. With several
// remotes the choice is ambiguous — point at the CLI.
export function defaultMoveTarget(
  key: string,
  remotes: string[],
): { first: string; second?: string; describe: string } | { error: string } {
  const { host, name } = splitFleetKey(key);
  if (host && name) return { first: `${host}:${name}`, describe: `${name} → local` };
  if (remotes.length === 1) return { first: name, second: remotes[0], describe: `${name} → ${remotes[0]}` };
  if (remotes.length === 0) return { error: "no remotes configured (~/.agent-manager/config.json)" };
  return { error: `multiple remotes — use \`am move ${name} <host>\`` };
}

// `am __export <name>`: everything the other side needs, on stdout.
export function exportCommand(name: string): void {
  const agent = resolveAgent(name);
  console.log(
    JSON.stringify({
      state: agent,
      queue: queueList(agent.name).map((m) => m.message),
      home: homedir(),
      transcript: sourceTranscript(agent),
    }),
  );
}

// `am __import`: reads a MovePayload on stdin.
export async function importCommand(): Promise<void> {
  const name = importPayload(await Bun.stdin.text());
  console.log(`imported "${name}"`);
}

// `am cd <name> <dir>`: same-machine directory change — a degenerate move.
// Claude sessions are bound to their project dir (transcripts are slugged by
// it), so this stops the session, re-files the conversation under the new
// dir's slug, and resumes there.
export function dirChangeBrief(oldDir: string, newDir: string): string {
  return [
    `[am] Your working directory just CHANGED: this conversation previously ran in ${oldDir}; you are now in ${newDir} (same machine).`,
    `- paths under ${oldDir} from earlier in the conversation are NOT your working directory anymore`,
    `- re-orient: check where you are and what's here before continuing`,
  ].join("\n");
}

export async function cdAgent(
  prefix: string,
  dirArg: string,
  opts: { inPlace: boolean; start: boolean },
): Promise<string> {
  const agent = resolveAgent(prefix);
  const target = resolve(expandHome(dirArg));
  if (!existsSync(target)) throw new Error(`directory does not exist: ${target}`);
  const canonicalTarget = realpathSync(target);
  if (canonicalTarget === agent.dir) throw new Error(`"${agent.name}" is already in ${canonicalTarget}`);

  // Same default as spawning: a git repo target gets a fresh worktree —
  // agents are guests, not owners.
  let dir = canonicalTarget;
  let worktree: { path: string; branch: string; repoRoot: string } | undefined;
  if (!opts.inPlace && loadConfig().worktreeByDefault && isGitRepo(canonicalTarget)) {
    const branch = agent.worktreeBranch ?? `am/${agent.name}`;
    const wt = createWorktree(agent.name, branch, canonicalTarget);
    dir = realpathSync(wt.path);
    worktree = { path: dir, branch, repoRoot: wt.repoRoot };
  }

  const wasLive = hasSession(agent.tmuxSession);
  if (wasLive) {
    await settleBeforeMove(agent.name, dir); // heads-up + capped wrap-up window
    stopAgent(agent);
  }

  // Re-file the claude conversation under the new dir's slug (codex rollouts
  // aren't dir-keyed — nothing to move).
  const sessionId = agentSessionId(agent);
  const transcript = sourceTranscript(agent);
  if (agentProvider(agent) === "claude" && transcript && sessionId) {
    const dest = targetTranscriptPath("claude", homedir(), dir, sessionId, null);
    Bun.spawnSync(["mkdir", "-p", dirname(dest)]);
    renameSync(transcript.path, dest);
  }

  const oldDir = agent.dir;
  const oldWorktree = agent.worktreePath;
  agent.dir = dir;
  agent.worktreePath = worktree?.path;
  agent.worktreeBranch = worktree?.branch;
  agent.repoRoot = worktree?.repoRoot;
  agent.status = "exited";
  agent.workingSince = undefined;
  writeAgent(agent);
  queueAppend(agent.name, dirChangeBrief(oldDir, dir));

  let message = `moved "${agent.name}" to ${dir}`;
  if (oldWorktree) message += ` (old worktree left at ${oldWorktree})`;

  if (opts.start) {
    const { reviveAgent } = await import("./resume");
    await reviveAgent(readAgent(agent.name)!);
    message += " — running";
  }
  return message;
}

export async function cdCommand(
  prefix: string,
  dirArg: string,
  opts: { inPlace: boolean; start: boolean },
): Promise<void> {
  console.log(await cdAgent(prefix, dirArg, opts));
}
