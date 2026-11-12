// Synthetic fleet for the fixture am server. Every name, path and line of
// transcript here is invented; nothing comes from a real fleet.
import type { AgentRow, QueueItem, TranscriptEntry } from "../src/types";

// Fields real fleet rows carry that the app's AgentRow does not declare yet.
export type FixtureRow = AgentRow & {
  aliases?: string[];
  subagents?: { active: number; types: string; detail: string; running: { id: string; type: string; description?: string; startedAt: string }[] };
};

export const FIXTURE_LOCAL_HOST = "motel";
export const FIXTURE_HOME = "/home/keeper";
export const FIXTURE_REMOTE_HOSTS = [
  { name: "annex", reachable: true },
  { name: "lantern", reachable: false },
];
const HOME = FIXTURE_HOME;
export const REPO = {
  lighthouse: `${HOME}/code/lighthouse`,
  paperCrane: `${HOME}/code/paper-crane`,
  tideTables: `${HOME}/code/tide-tables`,
};
export const worktree = (repo: string, name: string) => `${HOME}/.agent-manager/worktrees/${repo}/${name}`;

interface Seed {
  name: string;
  host?: string;
  status: AgentRow["status"];
  provider: AgentRow["provider"];
  model?: string;
  effort?: string;
  repo?: keyof typeof REPO;
  repoName?: string;
  dir?: string;
  task?: string;
  statusReason?: string;
  statusDetail?: string;
  queued?: number;
  // Minutes ago.
  changed: number;
  updated: number;
  created: number;
  spawnedBy?: string;
  role?: string;
  prMonitor?: AgentRow["prMonitor"];
  // The stored status when it differs from the shown one (am's derived presence).
  rawStatus?: AgentRow["status"];
  busyWith?: { subagents: number; background: number };
  decisions?: { open: number; blocking: number; oldest: number; first: string };
}

const SEEDS: Seed[] = [
  {
    name: "harbor-lights", status: "working", provider: "claude", model: "claude-opus-4-5", effort: "high", repo: "lighthouse", repoName: "lighthouse",
    task: "Add a retry budget to the beacon sync worker\n\nIt retries forever when the tide-tables API is down, which floods the logs and pins a CPU. Cap the retries, back off with jitter, honour Retry-After, and surface the state on /status. Keep the public SyncWorker API unchanged.",
    changed: 2.3, updated: 0.1, created: 48,
    prMonitor: { pullRequests: [{ number: 128, state: "OPEN" }] },
  },
  {
    name: "fog-signal", status: "needs-attention", provider: "codex", model: "gpt-5.2-codex", effort: "medium", repo: "lighthouse", repoName: "lighthouse",
    task: "Migrate the lamp schedule table to the new timezone-aware column", statusReason: "Approval needed: run `bun run db:migrate` against the local database",
    changed: 4, updated: 4, created: 35,
  },
  {
    name: "drift-net", status: "working", provider: "claude", model: "claude-sonnet-4-5", repo: "lighthouse", repoName: "lighthouse",
    task: "Watch CI on the lens-cleaning branch and fix flaky tests as they show up", changed: 0.5, updated: 0.5, created: 90,
  },
  {
    name: "keeper-log", status: "idle", provider: "claude", model: "claude-sonnet-4-5", repo: "lighthouse", repoName: "lighthouse",
    task: "Summarise yesterday's incident notes into the runbook", changed: 12, updated: 12, created: 200,
  },
  {
    name: "old-lens", status: "exited", provider: "claude", repo: "lighthouse", repoName: "lighthouse",
    task: "Spike: replace the SVG beacon renderer", changed: 300, updated: 300, created: 600,
  },
  {
    name: "fold-line", status: "waiting", provider: "codex", model: "gpt-5.2-codex", effort: "high", repo: "paperCrane", repoName: "paper-crane",
    task: "Run the full visual regression suite and triage the diffs", changed: 7, updated: 1, created: 60,
  },
  {
    name: "crease-check", status: "idle", provider: "claude", model: "claude-opus-4-5", repo: "paperCrane", repoName: "paper-crane",
    task: "Review the PDF export PR for accessibility issues", changed: 26, updated: 26, created: 140,
    prMonitor: { pullRequests: [{ number: 97, state: "MERGED" }] },
  },
  {
    name: "origami-docs", status: "starting", provider: "claude", repo: "paperCrane", repoName: "paper-crane",
    task: "Write the getting-started guide for the folding API", changed: 0.2, updated: 0.2, created: 0.2, spawnedBy: "crease-check",
  },
  {
    name: "paper-trail", status: "dead", provider: "codex", repo: "paperCrane", repoName: "paper-crane",
    task: "Audit the changelog for missing entries", changed: 1500, updated: 1500, created: 2000,
  },
  {
    name: "tide-pilot", status: "working", provider: "claude", model: "claude-opus-4-5", effort: "medium", repo: "tideTables", repoName: "tide-tables",
    task: "Return Retry-After on 503s from the tide-tables API", queued: 2, changed: 9, updated: 0.4, created: 70,
  },
  {
    name: "night-watch", status: "idle", provider: "antigravity", model: "gemini-3-pro", repo: "tideTables", repoName: "tide-tables",
    task: "Sketch the tide chart print layout", changed: 30, updated: 30, created: 120,
  },
  {
    name: "ebb-report", status: "idle", provider: "codex", model: "gpt-5.2-codex", repo: "tideTables", repoName: "tide-tables",
    task: "Generate the weekly tide accuracy report", changed: 45, updated: 45, created: 400,
  },
  {
    name: "kelp-forest", host: "annex", status: "working", provider: "codex", model: "gpt-5.2-codex", effort: "low", repo: "tideTables", repoName: "tide-tables",
    task: "Profile the tide prediction batch job on the annex box", changed: 3, updated: 0.3, created: 25,
  },
  {
    name: "sandbar", host: "annex", status: "needs-attention", provider: "claude", model: "claude-sonnet-4-5", repo: "lighthouse", repoName: "lighthouse",
    task: "Bump the beacon firmware SDK", statusReason: "Asked a question: keep SDK 3.x compatibility or drop it?", changed: 15, updated: 15, created: 80,
  },
  {
    name: "concierge", role: "concierge", status: "idle", provider: "claude", model: "claude-sonnet-4-5", dir: HOME,
    changed: 18, updated: 18, created: 4000,
  },
  {
    name: "errand-runner", status: "idle", provider: "claude", model: "claude-haiku-4-5", dir: HOME,
    task: "Tidy the dotfiles and update the shell aliases", changed: 64, updated: 64, created: 900,
  },
  // Its worktree was deleted by hand: resume fails, and its transcript is empty, so handoff fails too.
  {
    name: "ghost-pier", status: "exited", provider: "claude", repo: "lighthouse", repoName: "lighthouse",
    task: "Spike: draw the beacon map with WebGL", changed: 2400, updated: 2400, created: 3000,
  },
  // Holds its lifecycle lock for the whole run, as if halfway through a move to annex.
  {
    name: "slipway", status: "working", provider: "codex", model: "gpt-5.2-codex", effort: "medium", repo: "tideTables", repoName: "tide-tables",
    task: "Re-run the tide archive importer against the new schema", statusDetail: "moving to annex", changed: 6, updated: 0.6, created: 150,
  },
  // Idle at its prompt with two live subagents: shown working, stored idle.
  {
    name: "bosun-call", status: "working", rawStatus: "idle", busyWith: { subagents: 2, background: 0 }, provider: "claude", model: "claude-opus-4-5",
    repo: "lighthouse", repoName: "lighthouse", task: "Ship the lamp schedule export and see its PR through review",
    statusReason: "waiting on 2 subagents (Shepherd PR 12, reviewer)", statusDetail: "waiting on 2 subagents (Shepherd PR 12, reviewer)",
    changed: 8, updated: 2, created: 75,
  },
  // A subagent finished 12 minutes ago and the agent never took another turn.
  {
    name: "still-water", status: "needs-attention", rawStatus: "idle", provider: "claude", model: "claude-sonnet-4-5", repo: "tideTables", repoName: "tide-tables",
    task: "Backfill the missing tide gauge readings for March",
    statusReason: "subagent finished 12m ago, agent never resumed (reviewer)", statusDetail: "subagent finished 12m ago, agent never resumed (reviewer)",
    changed: 20, updated: 12, created: 110,
  },
  {
    name: "chart-table", status: "idle", provider: "codex", model: "gpt-5.2-codex", repo: "paperCrane", repoName: "paper-crane",
    task: "Redesign the fold diagram legend",
    decisions: { open: 2, blocking: 0, oldest: 40, first: "Should the legend sit below the diagram or in a side panel?" },
    changed: 22, updated: 22, created: 160,
  },
  {
    name: "anchor-watch", status: "idle", provider: "claude", model: "claude-opus-4-5", repo: "lighthouse", repoName: "lighthouse",
    task: "Retire the v1 beacon protocol",
    decisions: {
      open: 1, blocking: 1, oldest: 95,
      first: "The v1 beacon protocol still has two field units reporting through it every night from the north jetty; do we keep a compatibility shim for one more release while the harbour crew replaces them, or drop v1 now and accept that those units go dark until their firmware is flashed by hand?",
    },
    changed: 95, updated: 95, created: 300,
  },
];

const ago = (now: number, minutes: number) => new Date(now - minutes * 60_000).toISOString();

export function buildRows(now: number): FixtureRow[] {
  return SEEDS.map((seed) => {
    const row: FixtureRow = {
      name: seed.name,
      status: seed.status,
      statusChangedAt: ago(now, seed.changed),
      provider: seed.provider,
      dir: seed.dir ?? worktree(seed.repoName ?? "", seed.name),
      createdAt: ago(now, seed.created),
      updatedAt: ago(now, seed.updated),
      rawStatus: seed.rawStatus ?? seed.status,
      openDecisions: seed.decisions?.open ?? 0,
      blockingDecisions: seed.decisions?.blocking ?? 0,
    };
    if (seed.host) row.host = seed.host;
    if (seed.model) row.model = seed.model;
    if (seed.effort) row.effort = seed.effort;
    if (seed.repo) {
      row.repoRoot = REPO[seed.repo];
      row.worktreeBranch = `am/${seed.name}`;
    }
    if (seed.task) row.task = seed.task;
    if (seed.statusReason) row.statusReason = seed.statusReason;
    if (seed.statusDetail) row.statusDetail = seed.statusDetail;
    if (seed.queued) row.queued = seed.queued;
    if (seed.spawnedBy) row.spawnedBy = seed.spawnedBy;
    if (seed.role) row.role = seed.role;
    if (seed.prMonitor) row.prMonitor = seed.prMonitor;
    if (seed.busyWith) row.busyWith = seed.busyWith;
    if (seed.decisions) {
      row.oldestDecisionAt = ago(now, seed.decisions.oldest);
      row.firstDecision = seed.decisions.first;
    }
    // am clears workingSince at turn end, so an agent shown working only for its subagents has none.
    if (row.rawStatus === "working" || row.rawStatus === "waiting") row.workingSince = row.statusChangedAt;
    return row;
  });
}

// Messages already waiting when the fixture starts, for agents seeded with
// `queued`. The first is from another agent (msgId with no record behind it).
export function seedQueue(row: AgentRow, id: () => string, now = Date.now()): QueueItem[] {
  return Array.from({ length: row.queued ?? 0 }, (_, index) => ({
    message: index === 0 ? "When you're done, link the PR in the release notes channel." : "Also note which endpoints still return 503 without the header.",
    queuedAt: new Date(now - (row.queued! - index) * 60_000).toISOString(),
    ...(index === 0 ? { msgId: id() } : {}),
  }));
}

const json = (value: unknown) => JSON.stringify(value);
let counter = 0;
const user = (text: string): TranscriptEntry => ({ index: counter++, kind: "user", text });
const assistant = (text: string): TranscriptEntry => ({ index: counter++, kind: "assistant", text });
const tool = (name: string, input: unknown, output: string): TranscriptEntry =>
  ({ index: counter++, kind: "tool", name, input: typeof input === "string" ? input : json(input), output });

function harborLights(): TranscriptEntry[] {
  counter = 0;
  return [
    user("Add a retry budget to the beacon sync worker. It retries forever when the tide-tables API is down, which floods the logs and pins a CPU. Cap the retries, back off with jitter, and surface the state on `/status`. Keep the public `SyncWorker` API unchanged."),
    assistant("I'll start by finding where the sync worker schedules its retries and how failures are logged."),
    tool("Grep", { pattern: "retry|backoff", path: "src/sync" }, "src/sync/worker.ts:42:    // retry immediately; the API usually recovers\nsrc/sync/worker.ts:57:      return this.retry(job);\nsrc/sync/worker.ts:88:  private retry(job: SyncJob) {\nsrc/sync/backoff.ts:3:export function backoff(attempt: number): number {"),
    tool("Read", { file_path: "src/sync/worker.ts" }, "  40\t  async run(job: SyncJob) {\n  41\t    try {\n  42\t      // retry immediately; the API usually recovers\n  43\t      await this.client.pull(job.station);\n  44\t    } catch (error) {\n  45\t      this.log.warn(`sync failed for ${job.station}`, error);\n  46\t      return this.retry(job);\n  47\t    }\n  48\t  }\n  ...\n  88\t  private retry(job: SyncJob) {\n  89\t    queueMicrotask(() => this.run(job));\n  90\t  }"),
    tool("Read", { file_path: "src/sync/backoff.ts" }, "   1\t// Unused since the 2.0 rewrite.\n   2\t\n   3\texport function backoff(attempt: number): number {\n   4\t  return Math.min(30_000, 250 * 2 ** attempt);\n   5\t}"),
    tool("Bash", { command: "bun test tests/sync.test.ts", description: "Run the sync tests before changing anything" }, "bun test v1.3.2\n\ntests/sync.test.ts:\n✓ pulls a station [3.12ms]\n✓ stores readings in order [1.40ms]\n✓ retries a failed pull [0.88ms]\n\n 3 pass\n 0 fail\nRan 3 tests across 1 file. [41.00ms]"),
    assistant([
      "Found it. The worker re-queues a failed job on the **next microtask**, so an outage turns into a hot loop. There is a `backoff()` helper, but nothing calls it.",
      "",
      "| Path | Today | Problem |",
      "| --- | --- | --- |",
      "| `worker.ts` `retry()` | `queueMicrotask` re-run | no delay, no cap |",
      "| `backoff.ts` | exponential, max 30 s | unused, no jitter |",
      "| `/status` | shows last sync time | no failure state |",
      "",
      "Plan:",
      "",
      "1. Give each station a retry budget (5 attempts) and a circuit that opens when it runs out.",
      "2. Use `backoff()` with full jitter between attempts.",
      "3. Report `retrying` / `paused` per station on `/status`.",
    ].join("\n")),
    tool("Edit", { file_path: "src/sync/backoff.ts", old_string: "return Math.min(30_000, 250 * 2 ** attempt);", new_string: "const ceiling = Math.min(30_000, 250 * 2 ** attempt);\n  return Math.round(random() * ceiling);" }, "The file src/sync/backoff.ts has been updated."),
    tool("Edit", { file_path: "src/sync/worker.ts", old_string: "queueMicrotask(() => this.run(job));", new_string: "const attempt = this.budget.spend(job.station);\n    if (attempt === null) return this.pause(job.station);\n    this.timers.set(job.station, setTimeout(() => this.run(job), backoff(attempt)));" }, "The file src/sync/worker.ts has been updated."),
    tool("Bash", { command: "bun test tests/sync.test.ts" }, "bun test v1.3.2\n\ntests/sync.test.ts:\n✓ pulls a station [2.97ms]\n✓ stores readings in order [1.21ms]\n✓ retries a failed pull [12.40ms]\n✓ stops after five attempts [0.77ms]\n✓ waits between attempts [0.65ms]\n\n 5 pass\n 0 fail"),
    user([
      "<task-notification>",
      "<task-id>beacon-audit-7</task-id>",
      "<status>completed</status>",
      "<summary>Agent \"beacon-audit\" completed</summary>",
      "<result>Checked every caller of SyncWorker. Only the CLI and the scheduler construct it; neither depends on the immediate retry. The scheduler already de-duplicates jobs per station, so a paused station will not be re-queued behind your back.</result>",
      "<usage><total_tokens>18422</total_tokens><tool_uses>14</tool_uses><duration_ms>63000</duration_ms></usage>",
      "</task-notification>",
    ].join("\n")),
    assistant("The audit agent confirms nothing relies on the immediate retry, and the scheduler won't re-queue a paused station. Moving on to `/status`."),
    user("[am · from tide-pilot]\nHeads up: tide-tables 503s now carry a `Retry-After` header (seconds). Worth honouring it in your backoff instead of guessing."),
    assistant([
      "Good call — I'll prefer the server's hint when it's present and fall back to jittered backoff otherwise:",
      "",
      "```ts",
      "function nextDelay(attempt: number, error: unknown): number {",
      "  const hinted = retryAfterSeconds(error);",
      "  if (hinted !== null) return Math.min(hinted, 300) * 1000;",
      "  return backoff(attempt);",
      "}",
      "```",
      "",
      "Capping the hint at five minutes keeps a misconfigured server from parking a station for hours.",
    ].join("\n")),
    tool("Edit", { file_path: "src/sync/worker.ts", old_string: "setTimeout(() => this.run(job), backoff(attempt))", new_string: "setTimeout(() => this.run(job), nextDelay(attempt, error))" }, "The file src/sync/worker.ts has been updated."),
    tool("Grep", { pattern: "lastSyncAt", path: "src/http" }, "src/http/status.ts:18:      lastSyncAt: station.lastSyncAt,"),
    tool("Edit", { file_path: "src/http/status.ts", old_string: "lastSyncAt: station.lastSyncAt,", new_string: "lastSyncAt: station.lastSyncAt,\n      sync: worker.state(station.id), // \"ok\" | \"retrying\" | \"paused\"" }, "The file src/http/status.ts has been updated."),
    tool("Bash", { command: "bun test && bun run lint" }, "bun test v1.3.2\n\n 128 pass\n 0 fail\nRan 128 tests across 19 files. [1.84s]\n\n$ eslint src tests\n✔ no problems"),
    user("[am] PR #12 merged at 3f9c2ab on main\nRepository: example/lighthouse\nhttps://github.com/example/lighthouse/pull/12"),
    assistant([
      "### Retry budget for the beacon sync worker",
      "",
      "PR #12 (the logging clean-up this builds on) is merged, so this branch is now a clean diff on `main`.",
      "",
      "**What changed**",
      "",
      "- **Retry budget.** Each station gets 5 attempts. When the budget is spent the station is *paused* instead of retried, and one warning is logged rather than one per attempt.",
      "- **Backoff.** `backoff()` now uses full jitter (0 – 2ⁿ × 250 ms, capped at 30 s), so stations that failed together don't retry together.",
      "- **Retry-After.** A 503 with `Retry-After` wins over the computed delay, capped at 5 minutes.",
      "- **Status.** `/status` reports `sync: ok | retrying | paused` per station.",
      "",
      "**Why paused stations don't stay paused forever**",
      "",
      "The scheduler's next tick (every 10 minutes) refills the budget. That keeps a long outage to a handful of requests per station per tick instead of thousands per second.",
      "",
      "| Scenario | Before | After |",
      "| --- | --- | --- |",
      "| API down 10 min | ~2.4M requests, 1 CPU pinned | ≤ 5 requests per station |",
      "| API returns 503 + Retry-After: 60 | ignored | waits 60 s |",
      "| Single blip | immediate retry | retry after ≤ 250 ms |",
      "",
      "**Verification**",
      "",
      "```console",
      "$ bun test",
      " 128 pass",
      " 0 fail",
      "$ bun run lint",
      "✔ no problems",
      "```",
      "",
      "> The public `SyncWorker` API is unchanged; the new `state()` method is additive.",
      "",
      "Next I'm adding a test for the Retry-After cap and then I'll open the PR.",
    ].join("\n")),
    tool("Write", { file_path: "tests/retryAfter.test.ts" }, "File created successfully at: tests/retryAfter.test.ts"),
    tool("Bash", { command: "bun test tests/retryAfter.test.ts" }, "bun test v1.3.2\n\ntests/retryAfter.test.ts:\n✓ honours Retry-After [0.51ms]\n✓ caps Retry-After at five minutes [0.22ms]\n\n 2 pass\n 0 fail"),
  ];
}

function kelpForest(): TranscriptEntry[] {
  counter = 0;
  return [
    user("Profile the tide prediction batch job here on the annex box and tell me where the time goes."),
    tool("exec_command", { cmd: ["bash", "-lc", "bun run predict --stations all --profile"] }, "profile written to .profile/predict-0412.cpuprofile\nwall 41.2s · harmonics 29.8s · io 7.1s · other 4.3s"),
    assistant("About **72%** of the wall time is in the harmonic sum. Each station recomputes the same 37 constituent phases per timestamp; caching them per day should cut that roughly in half. Trying it now."),
  ];
}

function concierge(): TranscriptEntry[] {
  counter = 0;
  return [
    user("What's blocked right now?"),
    tool("Bash", { command: "am ls --json", description: "List the fleet" }, "18 agents · 5 working · 1 waiting · 2 need attention · 3 stopped"),
    assistant([
      "Two agents are waiting on you:",
      "",
      "- **fog-signal** (lighthouse) wants approval to run `bun run db:migrate` against the local database.",
      "- **sandbar** on annex asks whether to keep SDK 3.x compatibility while bumping the beacon firmware SDK.",
      "",
      "Everything else is moving. tide-pilot has two messages queued behind its current turn.",
    ].join("\n")),
    user("Tell sandbar to drop 3.x."),
    tool("Bash", { command: "am send annex:sandbar \"Drop SDK 3.x compatibility; nothing ships on it any more.\"" }, "queued for annex:sandbar"),
    assistant("Sent. sandbar will pick it up on its next turn; I'll mention it here if it asks anything else."),
  ];
}

function generic(row: AgentRow): TranscriptEntry[] {
  counter = 0;
  const entries: TranscriptEntry[] = [user(row.task || "Take a look around the repository.")];
  if (row.status === "starting") return entries;
  entries.push(assistant(`On it. I'll start by reading the relevant code in \`${row.repoRoot?.split("/").pop() ?? "~"}\`.`));
  entries.push(tool(row.provider === "codex" ? "exec_command" : "Bash", row.provider === "codex" ? { cmd: ["bash", "-lc", "git status --short"] } : { command: "git status --short" }, ""));
  if (row.status === "needs-attention") entries.push(assistant(row.statusReason?.replace(/^[^:]+:\s*/, "") ?? "I need your input before I continue."));
  else if (row.status === "idle") entries.push(assistant("Done. Everything is committed on the branch; let me know if you want a PR."));
  else if (row.status === "dead" || row.status === "exited") entries.push(assistant("Stopping here; the session was closed."));
  else entries.push(assistant("Still going — the suite takes a few minutes."));
  return entries;
}

export function buildTranscript(row: AgentRow): TranscriptEntry[] {
  if (row.name === "ghost-pier" && !row.host) return [];
  if (row.name === "harbor-lights" && !row.host) return harborLights();
  if (row.name === "kelp-forest" && row.host === "annex") return kelpForest();
  if (row.name === "concierge" && !row.host) return concierge();
  return generic(row);
}
