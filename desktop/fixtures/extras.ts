// Synthetic per-agent extras for the fixture am server: relay permissions, a
// Claude pane prompt, built-in subagents, model catalogs, roles and git
// workspaces. Invented like the rest of the fixture world.
import type { TranscriptEntry } from "../src/types";
import { FIXTURE_HOME, type FixtureRow } from "./data";

// Fixed ids, so tests and the smoke test can address them without listing first.
export const FIXTURE_IDS = {
  fogPermission: "01JZ6R7FQ3M9V2K8T4N5P0XWAB",
  // An earlier fog-signal request that timed out: never listed, answers 409 expired.
  fogExpiredPermission: "01JZ6QXH2B8C4D6E8F0G1J3K5M",
  sandbarPermission: "01JZ6S2N4P6Q8R0S2T4V6W8X0Y",
  origamiPrompt: "5f0c2e9a7d4b4c1e8a6f3d2b1c0e9f87",
  subagents: {
    audit: "a3f1c9e27b5d4e80",
    explore: "b84d02e6c1a9f357",
    tests: "c6e9a1b3d5f70824",
  },
};

export type PermissionKind = "allow" | "deny" | "allow_always";
export interface PermissionRecord {
  id: string;
  row: FixtureRow;
  provider: string;
  tool: string;
  summary: string;
  input: unknown;
  options: { id: string; label: string; kind: PermissionKind }[];
  createdAt: string;
  expiresAt: string | null;
  state: "pending" | "answered" | "expired";
}

const minutesAgo = (now: number, minutes: number) => new Date(now - minutes * 60_000).toISOString();
const find = (rows: FixtureRow[], name: string, host?: string) => rows.find((row) => row.name === name && row.host === host);

export function seedPermissions(rows: FixtureRow[], now: number): PermissionRecord[] {
  const records: PermissionRecord[] = [];
  const fog = find(rows, "fog-signal");
  const codexOptions: PermissionRecord["options"] = [
    { id: "accept", label: "Yes", kind: "allow" },
    { id: "acceptForSession", label: "Yes, and don't ask again this session", kind: "allow_always" },
    { id: "decline", label: "No, and tell Codex what to do differently", kind: "deny" },
  ];
  if (fog) {
    records.push({
      id: FIXTURE_IDS.fogPermission, row: fog, provider: "codex", tool: "exec_command",
      summary: "exec_command: bun run db:migrate", input: { command: ["bash", "-lc", "bun run db:migrate"], cwd: fog.dir, reason: "Apply the timezone-aware lamp schedule column" },
      options: codexOptions, createdAt: minutesAgo(now, 4), expiresAt: null, state: "pending",
    });
    records.push({
      id: FIXTURE_IDS.fogExpiredPermission, row: fog, provider: "codex", tool: "exec_command",
      summary: "exec_command: bun run db:reset", input: { command: ["bash", "-lc", "bun run db:reset"], cwd: fog.dir },
      options: codexOptions, createdAt: minutesAgo(now, 30), expiresAt: minutesAgo(now, 20), state: "expired",
    });
  }
  const sandbar = find(rows, "sandbar", "annex");
  if (sandbar) {
    records.push({
      id: FIXTURE_IDS.sandbarPermission, row: sandbar, provider: "claude", tool: "AskUserQuestion",
      summary: "AskUserQuestion: Keep SDK 3.x compatibility?",
      input: {
        questions: [{
          header: "SDK 3.x",
          question: "The firmware SDK bump drops the **3.x** transport. Keep a compatibility shim for beacons still on 3.x, or drop it?",
          multiSelect: false,
          options: [
            { label: "Keep a shim", description: "Adds about 200 lines; 3.x beacons keep syncing." },
            { label: "Drop 3.x", description: "Simpler; 3.x beacons need a firmware update first." },
          ],
        }],
      },
      options: [
        { id: "answer-0", label: "Keep a shim", kind: "allow" },
        { id: "answer-1", label: "Drop 3.x", kind: "allow" },
        { id: "deny", label: "Skip", kind: "deny" },
      ],
      createdAt: minutesAgo(now, 15), expiresAt: null, state: "pending",
    });
  }
  return records;
}

export interface PanePrompt {
  id: string;
  kind: "question" | "permission";
  title: string;
  options: { id: string; label: string; description?: string; other?: true }[];
  selected: string;
  raw: string;
}

export function seedPrompt(): PanePrompt {
  const title = "Who is the getting-started guide for?";
  const options: PanePrompt["options"] = [
    { id: "1", label: "First-time users", description: "Install, fold a first crane, export it." },
    { id: "2", label: "Plugin authors", description: "Start from the folding API and the plugin hooks." },
    { id: "3", label: "Both, in two tracks" },
    { id: "4", label: "Type something.", other: true },
  ];
  const raw = [
    "╭────────────────────────────────────────────╮",
    `│ ${title}`,
    "│",
    ...options.map((option, index) => `│ ${index === 0 ? "❯" : " "} ${option.id}. ${option.label}${option.description ? `\n│      ${option.description}` : ""}`),
    "╰────────────────────────────────────────────╯",
    "Enter to select · ↑/↓ to navigate · Esc to cancel",
  ].join("\n");
  return { id: FIXTURE_IDS.origamiPrompt, kind: "question", title, options, selected: "1", raw };
}

export interface SubagentRecord {
  id: string;
  type: string;
  description?: string;
  startedAt: string;
  endedAt?: string;
  message?: string;
  transcriptPath?: string;
  tokens?: { steps: number; inputTokens: number; cacheCreationTokens: number; cacheReadTokens: number; outputTokens: number; thinkingTokens?: number };
}
export interface Subagent {
  record: SubagentRecord;
  entries: TranscriptEntry[];
}

export function seedSubagents(row: FixtureRow, now: number): Subagent[] {
  if (row.name !== "harbor-lights" || row.host) return [];
  const sidecar = (id: string) => `${FIXTURE_HOME}/.claude/projects/-home-keeper--agent-manager-worktrees-lighthouse-harbor-lights/subagents/agent-${id}.jsonl`;
  const ids = FIXTURE_IDS.subagents;
  return [
    {
      record: {
        id: ids.audit, type: "general-purpose", description: "Audit SyncWorker callers", startedAt: minutesAgo(now, 30), endedAt: minutesAgo(now, 29),
        message: "Checked every caller of SyncWorker. Only the CLI and the scheduler construct it; neither depends on the immediate retry.",
        transcriptPath: sidecar(ids.audit),
        tokens: { steps: 14, inputTokens: 2_140, cacheCreationTokens: 9_870, cacheReadTokens: 61_200, outputTokens: 6_412, thinkingTokens: 1_020 },
      },
      entries: [
        { index: 0, kind: "user", text: "Find every caller of SyncWorker and say whether any depends on the immediate retry." },
        { index: 1, kind: "tool", name: "Grep", input: JSON.stringify({ pattern: "new SyncWorker", path: "src" }), output: "src/cli/sync.ts:12:  const worker = new SyncWorker(client);\nsrc/scheduler/index.ts:30:    this.worker = new SyncWorker(this.client);" },
        { index: 2, kind: "tool", name: "Read", input: JSON.stringify({ file_path: "src/scheduler/index.ts" }), output: "  30\t    this.worker = new SyncWorker(this.client);\n  31\t    this.seen = new Set<string>(); // one job per station" },
        { index: 3, kind: "assistant", text: "Checked every caller of SyncWorker. Only the CLI and the scheduler construct it; neither depends on the immediate retry. The scheduler already de-duplicates jobs per station." },
      ],
    },
    {
      record: { id: ids.explore, type: "Explore", description: "Map the /status handlers", startedAt: minutesAgo(now, 3) },
      entries: [
        { index: 0, kind: "user", text: "List every handler that contributes fields to /status, with file and line." },
        { index: 1, kind: "tool", name: "Grep", input: JSON.stringify({ pattern: "status\\.", path: "src/http" }), output: "src/http/status.ts:18:      lastSyncAt: station.lastSyncAt,\nsrc/http/status.ts:24:      lamp: lamps.state(station.id)," },
      ],
    },
    {
      record: { id: ids.tests, type: "general-purpose", description: "Write Retry-After tests", startedAt: minutesAgo(now, 1.5) },
      entries: [],
    },
  ];
}

export function runningSummary(subagents: Subagent[]): FixtureRow["subagents"] | undefined {
  const running = subagents.filter((item) => !item.record.endedAt).map(({ record }) => ({
    id: record.id, type: record.type, ...(record.description ? { description: record.description } : {}), startedAt: record.startedAt,
  }));
  if (!running.length) return undefined;
  const types = [...new Set(running.map((item) => item.type))].join(", ");
  return { active: running.length, types, detail: `${running.length} subagent${running.length === 1 ? "" : "s"} · ${running[0]!.type}`, running };
}

export interface CatalogModel { id: string; label?: string; description?: string; efforts: string[]; defaultEffort?: string }
export interface ProviderCatalog {
  provider: "claude" | "codex" | "antigravity";
  models: CatalogModel[];
  efforts: string[];
  modelsExhaustive: boolean;
  effortsExhaustive: boolean;
}

// Claude has no catalog command, so its list is best-effort (not exhaustive);
// codex's comes from the CLI; annex runs an older codex with a shorter list
// and a claude whose --help could not be parsed (fallback efforts).
export function catalogsFor(host: string | null): ProviderCatalog[] {
  const claude: ProviderCatalog = {
    provider: "claude",
    models: [
      { id: "claude-opus-4-5", label: "Opus 4.5", description: "Most capable, for long multi-step work", efforts: [] },
      { id: "claude-sonnet-4-5", label: "Sonnet 4.5", description: "Balanced default", efforts: [] },
      { id: "claude-haiku-4-5", label: "Haiku 4.5", description: "Fast and light", efforts: [] },
      { id: "opus", efforts: [] },
      { id: "sonnet", efforts: [] },
      { id: "haiku", efforts: [] },
    ],
    efforts: ["low", "medium", "high", "xhigh", "max"],
    modelsExhaustive: false,
    effortsExhaustive: true,
  };
  const codex: ProviderCatalog = {
    provider: "codex",
    models: [
      { id: "gpt-5.2-codex", label: "GPT-5.2 Codex", description: "Tuned for agentic coding", efforts: ["low", "medium", "high", "xhigh"], defaultEffort: "medium" },
      { id: "gpt-5.2", label: "GPT-5.2", description: "General reasoning", efforts: ["minimal", "low", "medium", "high"], defaultEffort: "medium" },
      { id: "gpt-5.2-codex-mini", label: "GPT-5.2 Codex Mini", description: "Cheaper, faster", efforts: ["medium", "high"], defaultEffort: "medium" },
    ],
    efforts: ["minimal", "low", "medium", "high", "xhigh"],
    modelsExhaustive: true,
    effortsExhaustive: true,
  };
  const antigravity: ProviderCatalog = {
    provider: "antigravity",
    models: [
      { id: "gemini-3-pro", label: "Gemini 3 Pro", efforts: [] },
      { id: "gemini-3-flash", label: "Gemini 3 Flash", efforts: [] },
    ],
    efforts: ["low", "medium", "high"],
    modelsExhaustive: true,
    effortsExhaustive: false,
  };
  if (host === null) return [claude, codex, antigravity];
  return [
    { ...claude, efforts: ["low", "medium", "high"], effortsExhaustive: false },
    { ...codex, models: codex.models.slice(0, 2) },
  ];
}

export function findCatalog(host: string | null, provider: string): ProviderCatalog | undefined {
  return catalogsFor(host).find((catalog) => catalog.provider === provider);
}

// Mirrors validateSelection/checkSelection in src/catalog.ts: the message of
// the first fatal complaint, or null.
export function selectionError(catalog: ProviderCatalog | undefined, model?: string | null, effort?: string | null): string | null {
  if (!catalog) return null;
  const known = model ? catalog.models.find((item) => item.id === model) : undefined;
  if (model && !known && catalog.models.length && catalog.modelsExhaustive) {
    const names = catalog.models.map((item) => item.id).join(", ");
    const matches = [...new Set(catalog.models.filter((item) => item.id.endsWith(`-${model}`)).map((item) => item.id))];
    const hint = matches.length === 1 ? ` — did you mean "${matches[0]}"?` : "";
    return `unknown ${catalog.provider} model "${model}"${hint} — known models: ${names} (see \`am models\`)`;
  }
  if (effort) {
    const efforts = known?.efforts.length ? known.efforts : catalog.efforts;
    if (efforts.length && !efforts.includes(effort) && catalog.effortsExhaustive) {
      const where = known?.efforts.length ? ` for ${known.id}` : "";
      return `unknown ${catalog.provider} effort "${effort}"${where} — supported: ${efforts.join(", ")} (see \`am models\`)`;
    }
  }
  return null;
}

export const ROLES = [
  {
    name: "caretaker",
    description: "Finds cleanup candidates and asks before retiring agents or workspaces",
    instructions: "You are the fleet caretaker. List stopped agents, merged branches and stale worktrees, and ask before removing anything.",
    builtIn: true,
  },
  {
    name: "concierge",
    description: "Fleet concierge for status, routing, and safe agent management",
    instructions: "You are the fleet concierge. Answer questions about the fleet, route messages, and never stop or remove an agent without asking.",
    builtIn: true,
  },
  {
    name: "docs-writer",
    description: "Writes and edits user-facing guides",
    instructions: "Write for a reader who has never seen the project. Prefer short sections, runnable examples and plain words.",
    models: { codex: "gpt-5.2" },
  },
  {
    name: "reviewer",
    description: "Reviews a branch for real bugs and reports findings",
    instructions: "Review the branch against its base. Report only real bugs, each with a file, a line and a severity. Change nothing.",
    provider: "claude",
    models: { claude: "claude-opus-4-5" },
  },
];

export interface WorkspaceFile { path: string; status: string; working: boolean; additions: number | null; deletions: number | null }
export interface Workspace {
  info: {
    available: boolean;
    branch?: string;
    base?: string;
    files: WorkspaceFile[];
    total: number;
    repository?: string;
    pullRequests: { number: number; title: string; url: string; state: "OPEN" | "CLOSED" | "MERGED" | "UNKNOWN"; isDraft: boolean }[];
  };
  diffs: Map<string, { diff: string; binary: boolean }>;
}

const unified = (path: string, hunk: string, lines: string[], added = false) =>
  [`diff --git a/${path} b/${path}`, ...(added ? ["new file mode 100644", "--- /dev/null"] : [`--- a/${path}`]), `+++ b/${path}`, hunk, ...lines].join("\n") + "\n";

export function seedWorkspace(row: FixtureRow): Workspace {
  if (!row.repoRoot) return { info: { available: false, files: [], total: 0, pullRequests: [] }, diffs: new Map() };
  const repoName = row.repoRoot.split("/").pop()!;
  const repository = `example/${repoName}`;
  const branch = row.worktreeBranch ?? `am/${row.name}`;
  const diffs = new Map<string, { diff: string; binary: boolean }>();
  const files: WorkspaceFile[] = [];
  const add = (file: WorkspaceFile, diff: string, binary = false) => {
    files.push(file);
    diffs.set(file.path, { diff, binary });
  };
  if (row.name === "harbor-lights" && !row.host) {
    add({ path: "src/sync/worker.ts", status: "M", working: false, additions: 3, deletions: 1 }, unified("src/sync/worker.ts", "@@ -86,5 +86,7 @@ export class SyncWorker {", [
      "   private retry(job: SyncJob) {",
      "-    queueMicrotask(() => this.run(job));",
      "+    const attempt = this.budget.spend(job.station);",
      "+    if (attempt === null) return this.pause(job.station);",
      "+    this.timers.set(job.station, setTimeout(() => this.run(job), nextDelay(attempt, error)));",
      "   }",
      " }",
    ]));
    add({ path: "src/sync/backoff.ts", status: "M", working: false, additions: 2, deletions: 1 }, unified("src/sync/backoff.ts", "@@ -1,5 +1,6 @@", [
      "-// Unused since the 2.0 rewrite.",
      "+// Full jitter: stations that failed together don't retry together.",
      " ",
      " export function backoff(attempt: number): number {",
      "-  return Math.min(30_000, 250 * 2 ** attempt);",
      "+  const ceiling = Math.min(30_000, 250 * 2 ** attempt);",
      "+  return Math.round(random() * ceiling);",
      " }",
    ]));
    add({ path: "src/http/status.ts", status: "M", working: true, additions: 1, deletions: 0 }, unified("src/http/status.ts", "@@ -16,4 +16,5 @@ export function status(worker: SyncWorker) {", [
      "     stations: stations.map((station) => ({",
      "       lastSyncAt: station.lastSyncAt,",
      "+      sync: worker.state(station.id), // \"ok\" | \"retrying\" | \"paused\"",
      "     })),",
    ]));
    add({ path: "tests/retryAfter.test.ts", status: "??", working: true, additions: 4, deletions: 0 }, unified("tests/retryAfter.test.ts", "@@ -0,0 +1,4 @@", [
      "+import { expect, test } from \"bun:test\";",
      "+import { nextDelay } from \"../src/sync/worker\";",
      "+test(\"honours Retry-After\", () => expect(nextDelay(0, retryAfter(60))).toBe(60_000));",
      "+test(\"caps Retry-After at five minutes\", () => expect(nextDelay(0, retryAfter(900))).toBe(300_000));",
    ], true));
    add({ path: "docs/status-panel.png", status: "M", working: true, additions: null, deletions: null }, "", true);
    return {
      info: {
        available: true, branch, base: "main", files, total: files.length, repository,
        pullRequests: [{ number: 14, title: "Add a retry budget to the beacon sync worker", url: `https://github.com/${repository}/pull/14`, state: "OPEN", isDraft: true }],
      },
      diffs,
    };
  }
  if (row.status === "starting") return { info: { available: true, branch, base: "main", files: [], total: 0, repository, pullRequests: [] }, diffs };
  add({ path: "NOTES.md", status: "M", working: true, additions: 2, deletions: 0 }, unified("NOTES.md", "@@ -3,3 +3,5 @@", [
    " ## Open questions",
    " ",
    `+- ${row.task?.split("\n")[0] ?? "Take a look around"}`,
    "+- Re-check once CI is green.",
  ]));
  return { info: { available: true, branch, base: "main", files, total: files.length, repository, pullRequests: [] }, diffs };
}
