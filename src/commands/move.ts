import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative } from "node:path";
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
import { sshAm, sshRun } from "../remote";
import { splitFleetKey } from "../fleet";

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

export function dirtyGitFiles(dir: string): string[] {
  const isRepo = Bun.spawnSync(["git", "-C", dir, "rev-parse", "--git-dir"]).exitCode === 0;
  if (!isRepo) return [];
  const status = Bun.spawnSync(["git", "-C", dir, "status", "--porcelain"]);
  if (status.exitCode !== 0) return [];
  return status.stdout.toString().split("\n").filter((l) => l.trim() !== "");
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
  force: boolean;
  start: boolean;
}

function remoteHome(host: string): string {
  const result = sshRun(host, "echo $HOME", { timeoutMs: 8000 });
  const home = result.stdout.trim();
  if (result.exitCode !== 0 || !home.startsWith("/")) {
    throw new Error(`cannot reach ${host} (${result.stderr.trim() || "no $HOME"})`);
  }
  return home;
}

async function pushAgent(name: string, host: string, opts: MoveOptions): Promise<string> {
  const agent = resolveAgent(name);
  if (agent.worktreePath && !opts.dir) {
    throw new Error("worktree agents can't be auto-mapped — pass --dir <plain checkout on the target>");
  }

  const dirty = dirtyGitFiles(agent.dir);
  if (dirty.length > 0 && !opts.force) {
    throw new Error(
      `uncommitted changes in ${agent.dir} won't travel:\n  ${dirty.slice(0, 8).join("\n  ")}` +
        (dirty.length > 8 ? `\n  …and ${dirty.length - 8} more` : "") +
        `\npush/pull them yourself, or re-run with --force`,
    );
  }

  const targetHomeDir = remoteHome(host);
  const targetDir = opts.dir ?? mapHomeDir(agent.dir, homedir(), targetHomeDir);
  if (!targetDir) {
    throw new Error(`${agent.dir} is not under $HOME — pass --dir <target dir on ${host}>`);
  }
  if (sshRun(host, `test -d ${shq(targetDir)}`, { timeoutMs: 8000 }).exitCode !== 0) {
    throw new Error(`target dir missing on ${host}: ${targetDir} — create/clone it first, or pass --dir`);
  }

  stopAgent(agent); // exactly one live copy, ever

  // Ship the conversation file (if the agent ever ran a turn).
  const transcript = sourceTranscript(agent);
  const sessionId = agentSessionId(agent);
  let remoteTranscriptPath: string | undefined;
  if (transcript && sessionId) {
    const target = targetTranscriptPath(
      agentProvider(agent), targetHomeDir, targetDir, sessionId, transcript.codexRelative,
    );
    if (sshRun(host, `mkdir -p ${shq(dirname(target))}`, { timeoutMs: 8000 }).exitCode !== 0) {
      throw new Error(`could not create transcript dir on ${host}`);
    }
    const scp = Bun.spawnSync(["scp", "-q", transcript.path, `${host}:${target}`]);
    if (scp.exitCode !== 0) throw new Error(`transcript copy failed: ${scp.stderr.toString().trim()}`);
    if (agentProvider(agent) === "codex") remoteTranscriptPath = target;
  }

  const payload: MovePayload = {
    state: {
      ...agent,
      dir: targetDir,
      status: "exited",
      workingSince: undefined,
      transcriptPath: remoteTranscriptPath,
      worktreePath: undefined,
      worktreeBranch: undefined,
      repoRoot: undefined,
    },
    queue: queueList(agent.name).map((m) => m.message),
  };
  const imported = sshAm(host, ["__import"], { stdin: JSON.stringify(payload), timeoutMs: 20000 });
  if (imported.exitCode !== 0) {
    throw new Error(`import on ${host} failed: ${(imported.stderr + imported.stdout).trim()}`);
  }

  if (!opts.copy) destroyAgent(agent, { clean: false });
  let message = `moved "${agent.name}" → ${host}:${targetDir}${opts.copy ? " (local copy kept)" : ""}`;

  if (opts.start) {
    const resumed = sshAm(host, ["resume", agent.name], { timeoutMs: 30000 });
    message +=
      resumed.exitCode !== 0
        ? ` — remote resume failed: ${resumed.stderr.trim()}`
        : ` — running`;
  }
  return message;
}

async function pullAgent(name: string, host: string, opts: MoveOptions): Promise<string> {
  if (readAgent(name)) throw new Error(`agent "${name}" already exists locally`);

  const exported = sshAm(host, ["__export", name], { timeoutMs: 20000 });
  if (exported.exitCode !== 0) {
    throw new Error(`export on ${host} failed: ${(exported.stderr + exported.stdout).trim()}`);
  }
  const remote = JSON.parse(exported.stdout) as {
    state: AgentState;
    queue: string[];
    home: string;
    transcript: { path: string; codexRelative: string | null } | null;
  };

  const targetDir = opts.dir ?? mapHomeDir(remote.state.dir, remote.home, homedir());
  if (!targetDir) {
    throw new Error(`${remote.state.dir} is not under the remote $HOME — pass --dir <local dir>`);
  }
  if (!existsSync(targetDir)) {
    throw new Error(`target dir missing locally: ${targetDir} — create/clone it first, or pass --dir`);
  }

  // Stop it remotely before copying the conversation so the file is final.
  sshAm(host, ["stop", name], { timeoutMs: 15000 });

  const sessionId = agentSessionId(remote.state);
  let localTranscriptPath: string | undefined;
  if (remote.transcript && sessionId) {
    const provider = agentProvider(remote.state);
    const target = targetTranscriptPath(provider, homedir(), targetDir, sessionId, remote.transcript.codexRelative);
    Bun.spawnSync(["mkdir", "-p", dirname(target)]);
    const scp = Bun.spawnSync(["scp", "-q", `${host}:${remote.transcript.path}`, target]);
    if (scp.exitCode !== 0) throw new Error(`transcript copy failed: ${scp.stderr.toString().trim()}`);
    if (provider === "codex") localTranscriptPath = target;
  }

  importPayload(
    JSON.stringify({
      state: { ...remote.state, dir: targetDir, transcriptPath: localTranscriptPath },
      queue: remote.queue,
    }),
  );

  if (!opts.copy) sshAm(host, ["rm", name], { timeoutMs: 15000 });
  let message = `moved "${name}" ← ${host} (now in ${targetDir})${opts.copy ? " (remote copy kept)" : ""}`;

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
