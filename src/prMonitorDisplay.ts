import type { TrackedPullRequest } from "./prMonitor";

export function formatTrackedPullRequest(pr: TrackedPullRequest): string {
  const commit = pr.state === "MERGED" && pr.mergeCommit ? ` ${pr.mergeCommit.slice(0, 7)}` : "";
  return `PR #${pr.number} ${pr.state}${commit}`;
}
