import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { notify } from "./notify";
import { newMsgId } from "./msgid";
import { listAgents, readAgent, updateAgentIf, type AgentState } from "./state";
import { baseDir } from "./paths";
import { githubRepository } from "./workspace";
import { tryAcquireFileLock } from "./filelock";
import { acquireMailboxLock, releaseMailboxLock, withMailboxWrite } from "./mailbox";
import { queueAppendOnceLocked, queueReceived, queueRecordReceipt } from "./queue";
import { loadConfig } from "./config";
import { acquireLifecycleLock, releaseLifecycleLock } from "./lifecycle";

export interface TrackedPullRequest {
  repository: string;
  number: number;
  url: string;
  state: "OPEN" | "CLOSED" | "MERGED";
  closedAt?: string;
  mergedAt?: string;
  mergeCommit?: string;
  updatedAt: string;
}
interface PrEvent { id: string; message: string }
export interface PrMonitorState {
  pullRequests: TrackedPullRequest[];
  bootstrapped?: boolean;
  checkedAt?: string;
  error?: string;
  pending?: PrEvent[];
}
const exec = promisify(execFile);
const FIELDS = "number,state,url,mergedAt,mergeCommit,updatedAt,closedAt,headRepository";
export type PrCommand = (cwd: string, executable: string, args: string[]) => Promise<string>;
const command: PrCommand = async (cwd, executable, args) => (await exec(executable, args, {
  cwd, timeout: 15_000, maxBuffer: 1024 * 1024,
  env: { ...process.env, GH_PROMPT_DISABLED: "1", GIT_TERMINAL_PROMPT: "0" },
})).stdout;

export function parsePrUrl(url: string): { repository: string; number: number } {
  const match = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/pull\/([1-9][0-9]*)\/?$/.exec(url);
  if (!match || !Number.isSafeInteger(Number(match[2]))) throw new Error("Expected a GitHub pull request URL");
  return { repository: match[1]!, number: Number(match[2]) };
}
export function parsePullRequest(repository: string, value: any): TrackedPullRequest {
  if (!value || !Number.isSafeInteger(value.number) || value.number < 1 ||
      !["OPEN", "CLOSED", "MERGED"].includes(value.state) || !Number.isFinite(Date.parse(value.updatedAt))) {
    throw new Error("Invalid GitHub PR response");
  }
  const url = `https://github.com/${repository}/pull/${value.number}`;
  if (value.url !== url) throw new Error("GitHub returned a different repository");
  const sha = value.mergeCommit?.oid;
  if (value.state === "MERGED" && (!/^[a-f0-9]{40,64}$/.test(sha ?? "") || !Number.isFinite(Date.parse(value.mergedAt)))) {
    throw new Error("Merged PR is missing merge evidence");
  }
  return { repository, number: value.number, url, state: value.state, updatedAt: value.updatedAt,
    ...(Number.isFinite(Date.parse(value.closedAt)) ? { closedAt: value.closedAt } : {}),
    ...(value.state === "MERGED" ? { mergedAt: value.mergedAt, mergeCommit: sha } : {}) };
}

export function prEventMessage(pr: TrackedPullRequest): string {
  const detail = pr.state === "MERGED" ? `merged at ${pr.mergeCommit} on ${pr.mergedAt}`
    : pr.state === "CLOSED" ? "closed without merging" : "reopened";
  return `[am] PR #${pr.number} ${detail}\nRepository: ${pr.repository}\n${pr.url}\n` +
    (pr.state === "MERGED" ? "Merge confirmed by GitHub. Follow your repository's post-merge instructions (including post-deploy verification where applicable). This event does not authorize deployment or cleanup."
      : "PR state changed on GitHub. Reconcile your current plan with this state.");
}

// Persist event IDs before enqueueing so crash recovery reuses them.
function withMonitorOwnership(agent: AgentState, strict: boolean, fn: () => boolean): boolean {
  if (!acquireLifecycleLock(agent.name)) {
    if (strict) throw new Error(`agent "${agent.name}" lifecycle is busy — retry PR registration`);
    return false;
  }
  try {
    try {
      return withMailboxWrite(agent.name, fn);
    } catch (error) {
      if (strict) throw error;
      return false;
    }
  } finally {
    releaseLifecycleLock(agent.name);
  }
}

function mutateMonitor(agent: AgentState, fn: (current: AgentState) => void, strict: boolean, durable = false): boolean {
  return withMonitorOwnership(agent, strict, () => {
    const changed = updateAgentIf(agent.name, current => {
      if (current.createdAt !== agent.createdAt || current.tmuxSession !== agent.tmuxSession) return false;
      fn(current);
      return true;
    }, { preserveUpdatedAt: true, durable });
    if (!changed && strict) throw new Error(`agent "${agent.name}" changed — retry PR registration`);
    return changed;
  });
}

export function recordPrObservations(agent: AgentState, prs: TrackedPullRequest[], now = new Date().toISOString(), strict = true): boolean {
  return mutateMonitor(agent, current => {
    const monitor = current.prMonitor ?? { pullRequests: [] };
    const byUrl = new Map(monitor.pullRequests.map(pr => [pr.url, pr]));
    const pending = [...(monitor.pending ?? [])];
    for (const pr of prs) {
      const previous = byUrl.get(pr.url);
      if (previous && (Date.parse(pr.updatedAt) < Date.parse(previous.updatedAt) || previous.state === "MERGED")) continue;
      const changed = previous ? previous.state !== pr.state : pr.state !== "OPEN" &&
        Date.parse(pr.mergedAt ?? pr.closedAt ?? "") >= Date.parse(current.createdAt);
      if (changed) {
        const id = newMsgId();
        if (!pending.some(event => event.id === id)) pending.push({ id, message: prEventMessage(pr) });
      }
      byUrl.set(pr.url, pr);
    }
    current.prMonitor = { pullRequests: [...byUrl.values()], pending, checkedAt: now, bootstrapped: true };
  }, strict, true);
}

export type PrNotifier = (name: string, message: string) => void;
export const notifyPrEvent: PrNotifier = (name, message) => notify(`PR update · ${name}`, message, { agent: name, kind: "pr" });

export function flushPrEvents(agent: AgentState, onEvent?: PrNotifier, strict = false): boolean {
  return withMonitorOwnership(agent, strict, () => {
    const current = readAgent(agent.name);
    if (!current || current.createdAt !== agent.createdAt || current.tmuxSession !== agent.tmuxSession) {
      if (strict) throw new Error(`agent "${agent.name}" changed — retry PR registration`);
      return false;
    }
    if (!acquireMailboxLock(agent.name)) {
      if (strict) throw new Error(`agent "${agent.name}" mailbox is busy — retry PR registration`);
      return false;
    }
    try {
      for (const event of current.prMonitor?.pending ?? []) {
        if (!queueReceived(current.name, event.id)) {
          queueAppendOnceLocked(current.name, event.message, event.id);
          queueRecordReceipt(current.name, event.id);
          try { onEvent?.(current.name, event.message); } catch { /* Owner inbox remains durable if desktop delivery fails. */ }
        }
        updateAgentIf(current.name, state => {
          if (state.createdAt !== current.createdAt || !state.prMonitor) return false;
          state.prMonitor.pending = state.prMonitor.pending?.filter(item => item.id !== event.id);
          return true;
        }, { preserveUpdatedAt: true });
      }
    } finally { releaseMailboxLock(agent.name); }
    return true;
  });
}

async function discover(agent: AgentState, run: PrCommand): Promise<TrackedPullRequest[]> {
  // Exited workspaces may now belong to another agent.
  if (agent.status === "exited" && ((agent.prMonitor?.pullRequests.length ?? 0) > 0 || agent.prMonitor?.bootstrapped || !agent.worktreeBranch)) return [];
  let remote: string, branch: string;
  try {
    const dir = agent.status === "exited" ? agent.repoRoot ?? agent.dir : agent.dir;
    remote = await run(dir, "git", ["remote", "get-url", "origin"]);
    branch = agent.status === "exited" ? agent.worktreeBranch! : (await run(dir, "git", ["symbolic-ref", "--quiet", "--short", "HEAD"])).trim();
  } catch { return []; }
  const repository = githubRepository(remote);
  if (!repository || !branch || ["main", "master"].includes(branch)) return [];
  const result = JSON.parse(await run(agent.dir, "gh", ["pr", "list", "--repo", repository, `--head=${branch}`, "--state", "all", "--limit", "100", "--json", FIELDS]));
  if (!Array.isArray(result)) throw new Error("Invalid PR list");
  return result
    .filter(pr => pr?.headRepository?.nameWithOwner?.toLowerCase() === repository.toLowerCase())
    .map(pr => parsePullRequest(repository, pr));
}

export async function pollPullRequests(run: PrCommand = command, active: () => boolean = () => true, onEvent?: PrNotifier): Promise<void> {
  const release = tryAcquireFileLock(join(baseDir(), "locks", "pr-monitor.lock"));
  if (!release) return;
  try {
    const requests = new Map<string, Promise<string>>();
    const cached: PrCommand = (cwd, executable, args) => {
      if (executable !== "gh") return run(cwd, executable, args);
      const key = JSON.stringify(args);
      if (!requests.has(key)) requests.set(key, run(cwd, executable, args));
      return requests.get(key)!;
    };
    const agents = listAgents();
    let index = 0;
    await Promise.all(Array.from({ length: Math.min(4, agents.length) }, async () => {
      while (active() && index < agents.length) {
        const agent = agents[index++]!;
        try {
          flushPrEvents(agent, onEvent);
          let failed = false;
          const found = await discover(agent, cached).catch(() => { failed = true; return []; });
          const seen = new Set(found.map(pr => pr.url));
          for (const old of agent.prMonitor?.pullRequests ?? []) {
            if (!active()) return;
            if (seen.has(old.url) || old.state === "MERGED") continue;
            try {
              const raw = JSON.parse(await cached(baseDir(), "gh", ["pr", "view", String(old.number), "--repo", old.repository, "--json", FIELDS]));
              const pr = parsePullRequest(old.repository, raw);
              if (pr.number !== old.number) throw new Error("GitHub returned a different PR");
              found.push(pr);
            } catch { failed = true; }
          }
          if (!active()) return;
          if (found.length || agent.prMonitor || (!failed && agent.status === "exited" && !!agent.worktreeBranch)) {
            if (!recordPrObservations(agent, found, undefined, false)) throw new Error("PR monitor state unavailable");
          }
          flushPrEvents(agent, onEvent);
          if (failed) throw new Error("PR lookup unavailable");
        } catch {
          if (!active()) return;
          mutateMonitor(agent, current => {
            current.prMonitor = { ...(current.prMonitor ?? { pullRequests: [] }), error: "PR lookup or delivery unavailable; retrying next sweep." };
          }, false);
        }
      }
    }));
  } finally { release(); }
}

export async function trackPullRequests(agent: AgentState, urls: string[], run: PrCommand = command, onEvent?: PrNotifier): Promise<void> {
  const prs: TrackedPullRequest[] = [];
  for (const url of urls) {
    const { repository, number } = parsePrUrl(url);
    const pr = parsePullRequest(repository, JSON.parse(await run(baseDir(), "gh", ["pr", "view", String(number), "--repo", repository, "--json", FIELDS])));
    if (pr.number !== number) throw new Error("GitHub returned a different PR");
    prs.push(pr);
  }
  if (prs.length) {
    recordPrObservations(agent, prs, undefined, true);
    flushPrEvents(agent, onEvent, true);
  }
}

export function startPrMonitor(): { stop(): void } {
  const seconds = loadConfig().prPollSeconds;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const schedule = (delay: number) => {
    timer = setTimeout(async () => {
      try { await pollPullRequests(command, () => !stopped, notifyPrEvent); } catch (error) { console.error(`am: PR monitor failed: ${error}`); }
      if (!stopped) schedule(Math.max(30, seconds) * 1000);
    }, delay);
  };
  if (Number.isFinite(seconds) && seconds > 0) schedule(5000);
  return { stop() { stopped = true; if (timer) clearTimeout(timer); } };
}
