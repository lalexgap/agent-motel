import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { notify } from "./notify";
import { baseDir } from "./paths";
import { mutatePrMonitor, parsePrUrl, type PrCommand, type TrackedPullRequest } from "./prMonitor";
import type { AgentState } from "./state";

const exec = promisify(execFile);
const READY_FIELDS = "number,url,state,headRefOid,baseRefName,baseRefOid,mergeable,mergeStateStatus,reviewDecision,statusCheckRollup,updatedAt";
const SHA = /^[a-f0-9]{40,64}$/;

export interface ReadyPullRequest extends TrackedPullRequest {
  state: "OPEN";
  headSha: string;
  baseRefName: string;
  baseRefOid: string;
  mergeable: "MERGEABLE";
}

export type ReadyNotifier = (title: string, message: string, meta: { agent: string; kind: "pr"; url: string }) => void;

export interface ReadyOptions {
  run?: PrCommand;
  notify?: ReadyNotifier;
  reviewScript?: string;
  now?: () => string;
}

const command: PrCommand = async (cwd, executable, args) => (await exec(executable, args, {
  cwd, timeout: 15_000, maxBuffer: 1024 * 1024,
  env: { ...process.env, GH_PROMPT_DISABLED: "1", GIT_TERMINAL_PROMPT: "0" },
})).stdout;

export function findReviewGateScript(home = homedir()): string {
  for (const path of [join(home, ".codex", "skills", "review-gate", "review.sh"), join(home, ".claude", "skills", "review-gate", "review.sh")]) {
    if (existsSync(path)) return path;
  }
  throw new Error("readiness withheld: installed review-gate review.sh was not found");
}

function parseObject(text: string, label: string): any {
  let value: any;
  try { value = JSON.parse(text); } catch { throw new Error(`readiness withheld: malformed ${label}`); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`readiness withheld: malformed ${label}`);
  return value;
}

function checksAreGreen(value: any): boolean {
  if (!Array.isArray(value) || value.length === 0 || value.length >= 100) return false;
  return value.every(check => {
    if (!check || typeof check !== "object") return false;
    if (check.__typename === "CheckRun") return check.status === "COMPLETED" && check.conclusion === "SUCCESS";
    if (check.__typename === "StatusContext") return check.state === "SUCCESS";
    return false;
  });
}

export function parseReadyPullRequest(repository: string, number: number, value: any): ReadyPullRequest {
  const url = `https://github.com/${repository}/pull/${number}`;
  if (!value || value.number !== number || value.url !== url || value.state !== "OPEN" ||
      !SHA.test(value.headRefOid ?? "") || !SHA.test(value.baseRefOid ?? "") ||
      typeof value.baseRefName !== "string" || !value.baseRefName ||
      value.mergeable !== "MERGEABLE" || value.mergeStateStatus !== "CLEAN" ||
      ![null, undefined, "", "APPROVED", "REVIEW_REQUIRED"].includes(value.reviewDecision) || !checksAreGreen(value.statusCheckRollup) ||
      !Number.isFinite(Date.parse(value.updatedAt))) {
    throw new Error("readiness withheld: GitHub does not show an open, clean, mergeable PR with green CI and no requested changes");
  }
  return {
    repository, number, url, state: "OPEN", headSha: value.headRefOid, baseRefName: value.baseRefName,
    baseRefOid: value.baseRefOid, mergeable: "MERGEABLE", updatedAt: value.updatedAt,
  };
}

export function parseBaseRef(repository: string, baseRefName: string, value: any): string {
  if (!value || value.ref !== `refs/heads/${baseRefName}` || value.object?.type !== "commit" || !SHA.test(value.object.sha ?? "")) {
    throw new Error(`readiness withheld: malformed live base ref for ${repository}`);
  }
  return value.object.sha;
}

function safeBaseRef(ref: unknown, baseRefName: string): ref is string {
  if (typeof ref !== "string" || ref.includes("..") || ref.includes("@{") || /[\\\x00-\x20~^:?*[\]]/.test(ref) || ref.endsWith("/") || ref.endsWith(".") || ref.includes("//")) return false;
  if (ref === `refs/heads/${baseRefName}`) return true;
  const match = /^refs\/remotes\/[^/]+\/(.+)$/.exec(ref);
  return match?.[1] === baseRefName;
}

function validateReviewState(value: any, pr: ReadyPullRequest, localHead: string): string {
  const context = value?.layer?.context;
  const main = value?.layer?.main;
  const security = value?.layer?.security;
  if (value?.XREVIEW_COVERS_HEAD !== "yes" || value?.STACK_MAIN_COVERS_HEAD !== "yes" ||
      value?.STACK_PARENTS_COVERED !== "yes" || !context || !main || !security ||
      !Array.isArray(main.blockers) || !Array.isArray(security.blockers) ||
      main.blockers.length > 0 || security.blockers.length > 0 ||
      (value.SEPARATE_SECURITY_REQUIRED === "yes" && value.STACK_SECURITY_COVERS_HEAD !== "yes") ||
      !["yes", "no"].includes(value.SEPARATE_SECURITY_REQUIRED) ||
      !["yes", "no"].includes(value.STACK_SECURITY_COVERS_HEAD) ||
      context.head_sha !== pr.headSha || context.head_sha !== localHead ||
      !SHA.test(context.base_sha ?? "") ||
      !safeBaseRef(context.base_ref, pr.baseRefName)) {
    throw new Error("readiness withheld: review-gate evidence is incomplete, stale, or has unresolved medium/major findings");
  }
  return context.base_ref;
}

function markReady(agent: AgentState, pr: ReadyPullRequest, at: string): "notified" | "already-notified" {
  let result: "notified" | "already-notified" = "notified";
  mutatePrMonitor(agent, current => {
    const monitor = current.prMonitor ?? { pullRequests: [] };
    const existing = monitor.pullRequests.find(item => item.url === pr.url);
    const existingIsNewer = existing && Date.parse(existing.updatedAt) >= Date.parse(pr.updatedAt);
    if (existingIsNewer && (existing.state !== "OPEN" || (existing.headSha && existing.headSha !== pr.headSha))) {
      throw new Error("readiness withheld: newer local PR state superseded the verified GitHub snapshot");
    }
    const sameHeadConflict = existing?.state === "OPEN" && existing.headSha === pr.headSha && existing.conflictActive === true;
    if (sameHeadConflict && existingIsNewer) {
      throw new Error("readiness withheld: local conflict evidence is as new as the verified GitHub snapshot");
    }
    if (existing?.readyNotifiedHead === pr.headSha) {
      result = "already-notified";
      return;
    }
    const next = { ...existing, ...pr, ...(sameHeadConflict ? { conflictActive: false } : {}), readyNotifiedHead: pr.headSha, readyNotifiedAt: at };
    current.prMonitor = {
      ...monitor,
      pullRequests: [...monitor.pullRequests.filter(item => item.url !== pr.url), next],
    };
  }, true, true);
  return result;
}

export async function declarePullRequestReady(agent: AgentState, url: string, reviewDir = agent.dir, options: ReadyOptions = {}): Promise<string> {
  const { repository, number } = parsePrUrl(url);
  const run = options.run ?? command;
  const reviewScript = options.reviewScript ?? findReviewGateScript();
  if (!existsSync(reviewScript)) throw new Error("readiness withheld: installed review-gate review.sh was not found");
  const readGithub = async () => {
    const pr = parseReadyPullRequest(repository, number, parseObject(
      await run(baseDir(), "gh", ["pr", "view", String(number), "--repo", repository, "--json", READY_FIELDS]), "GitHub PR response"));
    const ref = parseObject(await run(baseDir(), "gh", ["api", `repos/${repository}/git/ref/heads/${encodeURIComponent(pr.baseRefName)}`]), "GitHub base ref response");
    return { pr, baseTip: parseBaseRef(repository, pr.baseRefName, ref) };
  };

  const first = await readGithub();
  const localHead = (await run(reviewDir, "git", ["rev-parse", "HEAD"])).trim();
  if (!SHA.test(localHead) || localHead !== first.pr.headSha) throw new Error("readiness withheld: local HEAD does not match the GitHub PR head");
  const review = parseObject(await run(reviewDir, reviewScript, ["stack", "state"]), "review-gate state");
  const baseRef = validateReviewState(review, first.pr, localHead);
  const localBase = (await run(reviewDir, "git", ["rev-parse", "--verify", `${baseRef}^{commit}`])).trim();
  if (!SHA.test(localBase) || localBase !== first.baseTip) throw new Error("readiness withheld: the local reviewed base does not match GitHub; fetch and reconcile review drift first");

  const second = await readGithub();
  if (second.pr.headSha !== first.pr.headSha || second.pr.baseRefName !== first.pr.baseRefName || second.baseTip !== first.baseTip) {
    throw new Error("readiness withheld: the GitHub PR head or live base changed during verification");
  }
  const result = markReady(agent, second.pr, (options.now ?? (() => new Date().toISOString()))());
  if (result === "already-notified") return `PR #${number} already notified as merge-ready for ${second.pr.headSha}`;

  const title = `PR #${number} is merge-ready`;
  const message = `${repository} · ${agent.name} · ${second.pr.headSha.slice(0, 12)}\nReview and CI passed.`;
  try {
    (options.notify ?? ((readyTitle, readyMessage, meta) => notify(readyTitle, readyMessage, meta)))(title, message, {
      agent: agent.name, kind: "pr", url: second.pr.url,
    });
  } catch { /* The durable marker prevents notification retries from becoming spam. */ }
  return `Notified that PR #${number} is merge-ready for ${second.pr.headSha}`;
}
