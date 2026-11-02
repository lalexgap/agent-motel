import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { codexHome } from "./codexHooks";
import { localHostIdentity } from "./config";
import { displayStatus } from "./commands/ls";
import { roleForAgent } from "./roles";
import { agentProvider, listAgents, resolveAgent, type AgentState, type Provider } from "./state";
import {
  clipMessage,
  describeToolCall,
  readSubagentMeta,
  readSubagents,
  reconcileOpenSubagents,
  subagentLabel,
  subagentTranscriptFile,
  type SubagentRecord,
  type SubagentTokenSummary,
} from "./subagents";
import { locateTranscript } from "./transcript";

export interface TokenBuckets {
  steps: number;
  inputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  outputTokens: number;
  thinkingTokens: number;
  // Uncached input + cache creation + output (the non-cache-read tokens).
  activeTokens: number;
  // All input (uncached + cache write + cache read) + output.
  totalTokens: number;
  // Quota-weighted score: 1x uncached in, 1.25x cache write, 0.1x cache read, 5x out.
  budgetTokens: number;
  costUSD?: number;
}

export interface SubagentTokenSummary {
  steps: number;
  inputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  outputTokens: number;
  thinkingTokens?: number;
}

export interface SubagentTokenRecord {
  id: string;
  type: string;
  role: string;
  label: string;
  workflow?: string;
  startedAt: string;
  endedAt?: string;
  status: "running" | "finished" | "stale";
  model?: string;
  tokens: TokenBuckets;
  cacheBusts: number;
}

export interface RoleTokenBreakdown {
  role: string;
  scope: "main" | "subagent";
  runs: number;
  tokens: TokenBuckets;
}

export interface WorkflowTokenBreakdown {
  workflow: string;
  runs: number;
  tokens: TokenBuckets;
}

export interface ToolTokenBreakdown {
  category: string;
  calls: number;
  tokens: TokenBuckets;
}

export type AnomalyKind = "cache-bust" | "bloated-tool" | "polling-loop" | "cold-start";

export interface BudgetAnomaly {
  kind: AnomalyKind;
  agent: string;
  subagentId?: string;
  subagentLabel?: string;
  title: string;
  detail: string;
  // Active tokens or weighted token impact used to rank anomalies.
  tokens: number;
  timestamp?: string;
}

export interface AgentTokenReport {
  name: string;
  provider: Provider;
  status: string;
  role?: string;
  model?: string;
  updatedAt: string;
  main: TokenBuckets;
  subagentTotals: TokenBuckets;
  combined: TokenBuckets;
  subagents: SubagentTokenRecord[];
  byRole: RoleTokenBreakdown[];
  workflows: WorkflowTokenBreakdown[];
  tools: ToolTokenBreakdown[];
  anomalies: BudgetAnomaly[];
}

export interface FleetTokenReport {
  generatedAt: string;
  host?: string;
  totals: {
    main: TokenBuckets;
    subagents: TokenBuckets;
    combined: TokenBuckets;
  };
  agents: AgentTokenReport[];
  byRole: RoleTokenBreakdown[];
  workflows: WorkflowTokenBreakdown[];
  tools: ToolTokenBreakdown[];
  anomalies: BudgetAnomaly[];
}

const CACHE_BUST_GAP_MS = 5 * 60 * 1000;
const CACHE_BUST_MIN_NEW_TOKENS = 25_000;
const BLOATED_TOOL_MIN_NEW_TOKENS = 15_000;
const POLLING_LOOP_MIN_STEPS = 40;
const POLLING_LOOP_MIN_CACHE_READ = 5_000_000;
const COLD_START_MIN_SPAWNS = 3;
const COLD_START_MIN_TOKENS = 90_000;
const MAX_ANOMALIES = 15;

export function emptyBuckets(): TokenBuckets {
  return {
    steps: 0,
    inputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    outputTokens: 0,
    thinkingTokens: 0,
    activeTokens: 0,
    totalTokens: 0,
    budgetTokens: 0,
  };
}

export function computeBuckets(raw: {
  steps: number;
  inputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  outputTokens: number;
  thinkingTokens?: number;
  costUSD?: number;
}): TokenBuckets {
  const inputTokens = Math.max(0, Math.round(raw.inputTokens || 0));
  const cacheCreationTokens = Math.max(0, Math.round(raw.cacheCreationTokens || 0));
  const cacheReadTokens = Math.max(0, Math.round(raw.cacheReadTokens || 0));
  const outputTokens = Math.max(0, Math.round(raw.outputTokens || 0));
  const thinkingTokens = Math.max(0, Math.round(raw.thinkingTokens || 0));
  const activeTokens = inputTokens + cacheCreationTokens + outputTokens;
  const totalTokens = activeTokens + cacheReadTokens;
  const budgetTokens = Math.round(
    inputTokens + cacheCreationTokens * 1.25 + cacheReadTokens * 0.1 + outputTokens * 5,
  );
  return {
    steps: Math.max(0, Math.round(raw.steps || 0)),
    inputTokens,
    cacheCreationTokens,
    cacheReadTokens,
    outputTokens,
    thinkingTokens,
    activeTokens,
    totalTokens,
    budgetTokens,
    ...(typeof raw.costUSD === "number" && raw.costUSD > 0 ? { costUSD: Number(raw.costUSD.toFixed(4)) } : {}),
  };
}

export function addBuckets(a: TokenBuckets, b: TokenBuckets): TokenBuckets {
  const costUSD =
    a.costUSD !== undefined || b.costUSD !== undefined ? (a.costUSD ?? 0) + (b.costUSD ?? 0) : undefined;
  return computeBuckets({
    steps: a.steps + b.steps,
    inputTokens: a.inputTokens + b.inputTokens,
    cacheCreationTokens: a.cacheCreationTokens + b.cacheCreationTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    thinkingTokens: a.thinkingTokens + b.thinkingTokens,
    costUSD,
  });
}

export function formatTokens(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0";
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`;
  if (n >= 10_000_000) return `${Math.round(n / 1_000_000)}M`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 10_000) return `${Math.round(n / 1_000)}k`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(Math.round(n));
}

// Known skills / workflows from personal and repo skill libraries.
const KNOWN_WORKFLOWS: Array<[pattern: RegExp, name: string]> = [
  [/\bpost-deploy-verify\b|post[- ]deploy\s+verif/i, "post-deploy-verify"],
  [/\bshepherd-pr\b|\bshepherd\s+(?:pr|stack|#?\d+)/i, "shepherd-pr"],
  [/\breview-gate\b|\bstack_review\.py\b|(?:correctness|security|risk)\s+(?:review|classify)\s+pr\b|^\/code-review\b|^\/review\b/i, "review-gate"],
  [/\bpr-screenshots\b|\bverify-ui\b/i, "pr-screenshots"],
  [/\bstart-dev\b|\bstack\.sh\s+(?:start|up|restart|status|stop)\b/i, "start-dev"],
  [/\bbabysit-pr\b|\bbabysit\s+pr\b/i, "babysit-pr"],
  [/\bship-plan\b/i, "ship-plan"],
  [/\bexplain-diff\b/i, "explain-diff"],
  [/\bcomment-cleanup\b/i, "comment-cleanup"],
  [/\bcleanup-worktrees\b/i, "cleanup-worktrees"],
  [/\bcodex-design-review\b/i, "codex-design-review"],
  [/\bbuild-recap\b/i, "build-recap"],
  [/\bsync-skills\b/i, "sync-skills"],
  [/\bdrop-share\b/i, "drop-share"],
  [/\bplanning-with-files\b/i, "planning-with-files"],
];

export function detectWorkflowFromText(text: string | undefined): string | undefined {
  if (!text) return undefined;
  // Explicit skill preamble injected by Claude or Codex skill loader
  const skillDir = /Base directory for this skill:\s*[^\n]*\/skills\/([a-zA-Z0-9_-]+)/i.exec(text);
  if (skillDir?.[1]) return skillDir[1].toLowerCase();
  const skillPath = /\/skills\/([a-zA-Z0-9_-]+)\/SKILL\.md\b/i.exec(text);
  if (skillPath?.[1]) return skillPath[1].toLowerCase();
  const skillTag = /<skill>[\s\S]*?<name>([a-zA-Z0-9_-]+)<\/name>/i.exec(text);
  if (skillTag?.[1]) return skillTag[1].toLowerCase();
  for (const [pattern, name] of KNOWN_WORKFLOWS) {
    if (pattern.test(text)) return name;
  }
  return undefined;
}

export function normalizeSubagentRole(type: string, description?: string): string {
  const lowerType = (type || "").trim().toLowerCase();
  if (lowerType && !["general-purpose", "default", "subagent"].includes(lowerType)) {
    return type.trim();
  }
  const desc = (description || "").trim();
  if (/\bshepherd/i.test(desc)) return "shepherd";
  if (/\breview(?:er)?\b|\brisk\s+classif|^\/code-review\b|^\/review\b/i.test(desc)) return "reviewer";
  if (/post[-_ ]?deploy/i.test(desc)) return "post-deploy";
  if (/\bengineer\b|\bimplement|\b(?:build|add|fix|refactor|wire|extract|update|create)\b/i.test(desc)) return "engineer";
  if (/^(?:explore|find|search|investigate|trace|check|audit|compare)\b/i.test(desc)) return "Explore";
  return type?.trim() || "subagent";
}

export function classifyBashCommand(command: string): { category: string; workflow?: string } {
  const cmd = command.trim();
  const workflow = detectWorkflowFromText(cmd);
  if (/\bstack\.sh\b|\bstart-dev\b|\b(?:bin\/dev|foreman|overmind|webpack-dev-server|next\s+dev|rails\s+(?:s|server))\b/i.test(cmd)) {
    return { category: "Bash (dev-server / stack.sh)", workflow: workflow ?? "start-dev" };
  }
  if (/\bverify-ui\b|\bplaywright\b|\bchromium\b|\bpuppeteer\b/i.test(cmd)) {
    return { category: "Bash (verify-ui / browser)", workflow: workflow ?? "pr-screenshots" };
  }
  if (/\b(?:rspec|jest|vitest|pytest|bun\s+test|yarn\s+test|npm\s+test|rubocop|eslint|tsc)\b/i.test(cmd)) {
    return { category: "Bash (test / lint)", workflow };
  }
  if (/\bgh\s+(?:pr|api|run|issue|workflow|repo)\b|\bcircleci\b/i.test(cmd)) {
    return { category: "Bash (gh / CI)", workflow };
  }
  if (/\bgit\s+(?:status|diff|log|show|commit|push|pull|fetch|rebase|checkout|branch|worktree|stash|merge|add|rev-parse|cherry-pick|reset)\b/i.test(cmd)) {
    return { category: "Bash (git)", workflow };
  }
  if (/(?:^|[;&|]\s*)\bam\s+(?:ls|peek|send|new|run|wait|subagents|transcript|summary|usage|comms|resume|restart|stop|rm|role|models|search)\b/i.test(cmd)) {
    return { category: "Bash (am fleet)", workflow };
  }
  if (/^\s*(?:rg|grep|find|cat|sed|head|tail|ls|wc|jq|awk|stat|file)\b/.test(cmd)) {
    return { category: "Bash (search / read)", workflow };
  }
  return { category: "Bash (other)", workflow };
}

export function classifyMcpTool(name: string): string {
  const lower = name.toLowerCase();
  if (lower.includes("ph-internal") || lower.includes("ph_internal")) return "MCP (ph-internal)";
  if (lower.includes("datadog")) return "MCP (datadog)";
  if (lower.includes("sentry")) return "MCP (sentry)";
  if (lower.includes("circle-ci") || lower.includes("circle_ci")) return "MCP (circle-ci)";
  if (lower.includes("slack")) return "MCP (slack)";
  if (lower.includes("notion")) return "MCP (notion)";
  if (lower.includes("intercom")) return "MCP (intercom)";
  return "MCP (other)";
}

function unquoteAntigravityValue(val: unknown): unknown {
  if (typeof val !== "string") return val;
  const trimmed = val.trim();
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return trimmed.slice(1, -1);
    }
  }
  return val;
}

function unquoteAntigravityArgs(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    out[k] = unquoteAntigravityValue(v);
  }
  return out;
}

export function classifyToolCall(
  name: string,
  input: unknown,
): { category: string; workflow?: string; summary: string } {
  let parsed: Record<string, unknown> | null = null;
  if (input && typeof input === "object" && !Array.isArray(input)) {
    parsed = unquoteAntigravityArgs(input as Record<string, unknown>);
  } else if (typeof input === "string") {
    try {
      const obj = JSON.parse(input);
      if (obj && typeof obj === "object" && !Array.isArray(obj)) {
        parsed = unquoteAntigravityArgs(obj as Record<string, unknown>);
      }
    } catch {
      // plain string
    }
  }
  const rawInput = parsed ? JSON.stringify(parsed) : typeof input === "string" ? input : JSON.stringify(input ?? "");

  const summary = describeToolCall(name, rawInput);

  if (name === "Skill") {
    const skill = typeof parsed?.skill === "string" ? parsed.skill.trim().replace(/^\//, "").toLowerCase() : undefined;
    return { category: "Skill", workflow: skill || detectWorkflowFromText(rawInput), summary };
  }

  if (name === "Bash" || name === "shell" || name === "exec_command" || name === "run_command") {
    const cmd =
      typeof parsed?.command === "string"
        ? parsed.command
        : typeof parsed?.CommandLine === "string"
          ? parsed.CommandLine
          : typeof parsed?.cmd === "string"
            ? parsed.cmd
            : Array.isArray(parsed?.command)
              ? parsed.command.join(" ")
              : rawInput;
    const classified = classifyBashCommand(cmd);
    return {
      ...classified,
      summary: describeToolCall(
        name === "exec_command" || name === "run_command" ? "Bash" : name,
        JSON.stringify({ command: cmd }),
      ),
    };
  }

  if (name === "manage_task") {
    const action = typeof parsed?.Action === "string" ? parsed.Action : "";
    const taskId = typeof parsed?.TaskId === "string" ? ` ${parsed.TaskId}` : "";
    return {
      category: "Bash (other)",
      summary: describeToolCall("manage_task", JSON.stringify({ command: `${action}${taskId}`.trim() })),
    };
  }

  if (
    name === "Read" ||
    name === "Grep" ||
    name === "Glob" ||
    name === "view_image" ||
    name === "read_file" ||
    name === "view_file" ||
    name === "view_file_outline" ||
    name === "view_code_item" ||
    name === "grep_search" ||
    name === "find_by_name" ||
    name === "list_dir"
  ) {
    const pathText =
      typeof parsed?.file_path === "string"
        ? parsed.file_path
        : typeof parsed?.path === "string"
          ? parsed.path
          : typeof parsed?.Path === "string"
            ? parsed.Path
            : typeof parsed?.AbsolutePath === "string"
              ? parsed.AbsolutePath
              : typeof parsed?.DirectoryPath === "string"
                ? parsed.DirectoryPath
                : typeof parsed?.SearchPath === "string"
                  ? parsed.SearchPath
                  : typeof parsed?.Query === "string"
                    ? parsed.Query
                    : typeof parsed?.Pattern === "string"
                      ? parsed.Pattern
                      : rawInput;
    return {
      category: "Read / Grep / Glob",
      workflow: detectWorkflowFromText(pathText),
      summary: describeToolCall(name, JSON.stringify({ file_path: pathText })),
    };
  }

  if (
    name === "Edit" ||
    name === "Write" ||
    name === "MultiEdit" ||
    name === "NotebookEdit" ||
    name === "apply_patch" ||
    name === "edit_file" ||
    name === "write_file" ||
    name === "replace_file_content" ||
    name === "multi_replace_file_content"
  ) {
    const pathText =
      typeof parsed?.file_path === "string"
        ? parsed.file_path
        : typeof parsed?.Path === "string"
          ? parsed.Path
          : typeof parsed?.TargetFile === "string"
            ? parsed.TargetFile
            : undefined;
    return {
      category: "Edit / Write",
      summary: pathText ? describeToolCall(name, JSON.stringify({ file_path: pathText })) : summary,
    };
  }

  if (
    name === "Agent" ||
    name === "Task" ||
    name === "TaskOutput" ||
    name === "TaskStop" ||
    name === "spawn_agent" ||
    name === "wait_agent" ||
    name === "send_input" ||
    name === "close_agent" ||
    name === "resume_agent" ||
    name === "invoke_subagent" ||
    name === "define_subagent" ||
    name === "manage_subagents" ||
    name.startsWith("multi_agent_v1__")
  ) {
    const desc =
      typeof parsed?.description === "string"
        ? parsed.description
        : typeof parsed?.Role === "string"
          ? parsed.Role
          : typeof parsed?.prompt === "string"
            ? parsed.prompt
            : typeof parsed?.Prompt === "string"
              ? parsed.Prompt
              : typeof parsed?.message === "string"
                ? parsed.message
                : "";
    const promptText = typeof parsed?.Prompt === "string" ? parsed.Prompt : typeof parsed?.prompt === "string" ? parsed.prompt : "";
    return {
      category: "Subagent (Agent)",
      workflow: detectWorkflowFromText(`${desc} ${promptText}`),
      summary: desc ? describeToolCall(name, JSON.stringify({ description: desc })) : summary,
    };
  }

  if (name === "ToolSearch") return { category: "ToolSearch", summary };
  if (name === "SendMessage" || name === "send_message") return { category: "SendMessage", summary };
  if (name === "call_mcp_tool") {
    const serverName = typeof parsed?.ServerName === "string" ? parsed.ServerName : "";
    const toolName = typeof parsed?.ToolName === "string" ? parsed.ToolName : "mcp";
    const fullName = serverName ? `mcp__${serverName}__${toolName}` : `mcp__${toolName}`;
    return { category: classifyMcpTool(fullName), summary: describeToolCall(fullName, String(parsed?.Arguments ?? "{}")) };
  }
  if (name.startsWith("mcp__") || name.startsWith("mcp_")) return { category: classifyMcpTool(name), summary };

  // Codex custom_tool_call: `exec` wraps JS calls like `tools.exec_command({cmd:"..."})`
  if (name === "exec" && typeof input === "string") {
    return classifyCodexExecScript(input);
  }

  return { category: "Other tools", workflow: detectWorkflowFromText(rawInput), summary };
}

function classifyCodexExecScript(script: string): { category: string; workflow?: string; summary: string } {
  const cmdMatch = /tools\.exec_command\(\s*\{[\s\S]*?"?cmd"?\s*:\s*("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')/.exec(script);
  if (cmdMatch?.[1]) {
    let cmd = cmdMatch[1].slice(1, -1);
    try {
      if (cmdMatch[1].startsWith('"')) cmd = JSON.parse(cmdMatch[1]);
    } catch {
      // keep raw slice
    }
    const classified = classifyBashCommand(cmd);
    return {
      ...classified,
      summary: describeToolCall("Bash", JSON.stringify({ command: cmd })),
    };
  }
  if (script.includes("tools.apply_patch")) {
    return { category: "Edit / Write", summary: "apply_patch" };
  }
  const mcpMatch = /tools\.(mcp__[a-zA-Z0-9_]+)/.exec(script);
  if (mcpMatch?.[1]) {
    return { category: classifyMcpTool(mcpMatch[1]), summary: describeToolCall(mcpMatch[1], "{}") };
  }
  const multiMatch = /(?:tools\.|endsWith\(['"])((?:multi_agent_v1__)?(?:spawn_agent|wait_agent|send_input|close_agent|resume_agent)|multi_agent_v1__[a-zA-Z0-9_]+)/.exec(script);
  if (multiMatch?.[1]) {
    return {
      category: "Subagent (Agent)",
      workflow: detectWorkflowFromText(script),
      summary: multiMatch[1].replace("multi_agent_v1__", ""),
    };
  }
  return {
    category: "Bash (other)",
    workflow: detectWorkflowFromText(script),
    summary: describeToolCall("exec", script),
  };
}

export interface ParsedTranscriptUsage {
  model?: string;
  codexMeta?: { nickname?: string; role?: string; firstPrompt?: string };
  antigravitySubagents?: SubagentRecord[];
  finishedAt?: string;
  tokens: TokenBuckets;
  step1NewTokens: number;
  cacheBusts: number;
  detectedWorkflow?: string;
  workflows: Map<string, { runs: Set<string>; buckets: TokenBuckets }>;
  tools: Map<string, { calls: number; buckets: TokenBuckets }>;
  anomalies: BudgetAnomaly[];
}

interface StepEvent {
  timestamp?: string;
  model?: string;
  inputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  outputTokens: number;
  thinkingTokens: number;
  tools: Array<{ category: string; workflow?: string; summary: string }>;
  workflow: string;
}

function addWorkflowStep(
  map: Map<string, { runs: Set<string>; buckets: TokenBuckets }>,
  workflow: string,
  runKey: string,
  stepBuckets: TokenBuckets,
): void {
  const current = map.get(workflow) ?? { runs: new Set<string>(), buckets: emptyBuckets() };
  current.runs.add(runKey);
  current.buckets = addBuckets(current.buckets, stepBuckets);
  map.set(workflow, current);
}

function addToolStep(
  map: Map<string, { calls: number; buckets: TokenBuckets }>,
  category: string,
  calls: number,
  stepBuckets: TokenBuckets,
): void {
  const current = map.get(category) ?? { calls: 0, buckets: emptyBuckets() };
  current.calls += calls;
  current.buckets = addBuckets(current.buckets, stepBuckets);
  map.set(category, current);
}

function foldSteps(
  steps: StepEvent[],
  context: {
    agentName: string;
    subagentId?: string;
    subagentLabel?: string;
    initialWorkflow?: string;
    costUSD?: number;
  },
): ParsedTranscriptUsage {
  const workflows = new Map<string, { runs: Set<string>; buckets: TokenBuckets }>();
  const tools = new Map<string, { calls: number; buckets: TokenBuckets }>();
  const anomalies: BudgetAnomaly[] = [];
  const runKey = context.subagentId ? `${context.agentName}/${context.subagentId}` : context.agentName;

  let totals = emptyBuckets();
  let model: string | undefined;
  let step1NewTokens = 0;
  let cacheBusts = 0;
  let detectedWorkflow = context.initialWorkflow;
  let prevTimestampMs: number | null = null;
  let prevContextTokens = 0;
  let prevTools: Array<{ category: string; workflow?: string; summary: string }> = [];

  steps.forEach((step, index) => {
    if (step.model) model = step.model;
    if (step.workflow && step.workflow !== "general" && !detectedWorkflow) {
      detectedWorkflow = step.workflow;
    }
    const stepBuckets = computeBuckets({
      steps: 1,
      inputTokens: step.inputTokens,
      cacheCreationTokens: step.cacheCreationTokens,
      cacheReadTokens: step.cacheReadTokens,
      outputTokens: step.outputTokens,
      thinkingTokens: step.thinkingTokens,
    });
    totals = addBuckets(totals, stepBuckets);

    const newInput = step.inputTokens + step.cacheCreationTokens;
    const contextTokens = newInput + step.cacheReadTokens;
    const contextDelta = index > 0 && prevContextTokens > 0 ? Math.max(0, contextTokens - prevContextTokens) : newInput;
    const reCachedTokens = index > 0 && prevContextTokens > 0 ? Math.max(0, newInput - contextDelta) : 0;
    if (index === 0) step1NewTokens = newInput;

    const wf = step.workflow || detectedWorkflow || "general";
    addWorkflowStep(workflows, wf, runKey, stepBuckets);

    // Input/cache tokens on step N pay for the tool result(s) emitted at the end of step N-1
    // (or the initial/user prompt when step N-1 had no tool calls).
    if (index === 0) {
      addToolStep(tools, "Session Cold Start / Prompt", 1, stepBuckets);
    } else if (prevTools.length === 0) {
      addToolStep(tools, "User Prompt", 1, stepBuckets);
    } else {
      const primary = prevTools[prevTools.length - 1]!;
      addToolStep(tools, primary.category, prevTools.length, stepBuckets);
    }

    const nowMs = step.timestamp ? Date.parse(step.timestamp) : NaN;
    const gapMs =
      prevTimestampMs !== null && Number.isFinite(nowMs) && nowMs > prevTimestampMs
        ? nowMs - prevTimestampMs
        : 0;

    // 1. Cache-bust detection: >5m idle pause followed by large cache re-creation,
    // or a mid-session cache miss/eviction where >=25k existing context tokens were re-processed uncached.
    const isIdleCacheBust = index > 0 && gapMs >= CACHE_BUST_GAP_MS && newInput >= CACHE_BUST_MIN_NEW_TOKENS;
    const isEvictionCacheBust =
      index > 0 &&
      !isIdleCacheBust &&
      reCachedTokens >= CACHE_BUST_MIN_NEW_TOKENS &&
      step.cacheReadTokens < prevContextTokens * 0.5;

    if (isIdleCacheBust || isEvictionCacheBust) {
      cacheBusts++;
      if (isIdleCacheBust) {
        const gapMinutes = Math.floor(gapMs / 60_000);
        const gapSeconds = Math.round((gapMs % 60_000) / 1000);
        const pauseLabel = gapMinutes >= 60 ? `${Math.floor(gapMinutes / 60)}h${gapMinutes % 60}m` : `${gapMinutes}m${gapSeconds}s`;
        anomalies.push({
          kind: "cache-bust",
          agent: context.agentName,
          subagentId: context.subagentId,
          subagentLabel: context.subagentLabel,
          title: `Cache expired after ${pauseLabel} pause — re-wrote ${formatTokens(newInput)} tokens`,
          detail: `Step ${index + 1}${wf !== "general" ? ` (${wf})` : ""}: 5m cache TTL expired while waiting; full context was re-cached.`,
          tokens: newInput,
          timestamp: step.timestamp,
        });
      } else {
        anomalies.push({
          kind: "cache-bust",
          agent: context.agentName,
          subagentId: context.subagentId,
          subagentLabel: context.subagentLabel,
          title: `Prompt cache miss — re-processed ${formatTokens(reCachedTokens)} context tokens`,
          detail: `Step ${index + 1}${wf !== "general" ? ` (${wf})` : ""}: cached prefix missed or rotated; existing context billed as uncached input.`,
          tokens: reCachedTokens,
          timestamp: step.timestamp,
        });
      }
    }

    // 2. Bloated tool output injection: a tool result genuinely grew the context by >=15k tokens
    const injectedTokens = prevContextTokens > 0 ? contextDelta : newInput;
    if (index > 0 && !isIdleCacheBust && prevTools.length > 0 && injectedTokens >= BLOATED_TOOL_MIN_NEW_TOKENS) {
      const culprit = prevTools[prevTools.length - 1]!;
      anomalies.push({
        kind: "bloated-tool",
        agent: context.agentName,
        subagentId: context.subagentId,
        subagentLabel: context.subagentLabel,
        title: `${culprit.summary} injected ${formatTokens(injectedTokens)} new tokens`,
        detail: `Step ${index + 1} (${culprit.category}): large tool output entered the conversation context.`,
        tokens: injectedTokens,
        timestamp: step.timestamp,
      });
    }

    if (Number.isFinite(nowMs)) prevTimestampMs = nowMs;
    if (contextTokens > 0) prevContextTokens = contextTokens;
    prevTools = step.tools;
  });

  if (context.costUSD !== undefined && context.costUSD > 0) {
    totals = { ...totals, costUSD: Number(context.costUSD.toFixed(4)) };
  }

  return {
    model,
    tokens: totals,
    step1NewTokens,
    cacheBusts,
    detectedWorkflow,
    workflows,
    tools,
    anomalies,
  };
}

export function parseClaudeTranscriptTokens(
  jsonl: string,
  context: {
    agentName: string;
    subagentId?: string;
    subagentLabel?: string;
    initialWorkflow?: string;
    ownFile?: boolean;
  },
): ParsedTranscriptUsage {
  let activeWorkflow =
    context.initialWorkflow ??
    detectWorkflowFromText(context.subagentLabel) ??
    "general";
  let costUSD: number | undefined;

  // Group assistant entries by message.id so multi-block responses are counted once.
  const byMessageId = new Map<string, StepEvent>();
  const messageOrder: string[] = [];
  let pendingUserToolsReset = false;
  let anonymousSeq = 0;

  for (const line of jsonl.split("\n")) {
    if (!line.trim()) continue;
    // Fast pre-filter: skip large blob/snapshot lines and tool_result lines without skill markers
    if (
      line.includes('"type":"api-request-blob"') ||
      line.includes('"type":"api-request-shape"') ||
      line.includes('"type":"file-history-snapshot"') ||
      line.includes('"type":"progress"')
    ) {
      continue;
    }
    if (
      !line.includes('"type":"assistant"') &&
      !line.includes('"type": "assistant"') &&
      !line.includes('"cost-state"') &&
      !line.includes("/skills/") &&
      !line.includes("Base directory for this skill")
    ) {
      continue;
    }
    let entry: any;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (!entry || typeof entry !== "object") continue;

    if (entry.type === "cost-state" && typeof entry.totalCostUSD === "number") {
      costUSD = entry.totalCostUSD;
      continue;
    }

    if (!context.ownFile && entry.isSidechain === true) continue;

    if (entry.type === "user") {
      const content = entry.message?.content;
      let hasToolResult = false;
      if (typeof content === "string") {
        const wf = detectWorkflowFromText(content);
        if (wf) activeWorkflow = wf;
      } else if (Array.isArray(content)) {
        for (const block of content) {
          if (block?.type === "text" && typeof block.text === "string") {
            const wf = detectWorkflowFromText(block.text);
            if (wf) activeWorkflow = wf;
          } else if (block?.type === "tool_result") {
            hasToolResult = true;
          }
        }
      }
      if (!hasToolResult) pendingUserToolsReset = true;
      continue;
    }

    if (entry.type !== "assistant") continue;
    const msg = entry.message;
    if (!msg || typeof msg !== "object") continue;

    if (pendingUserToolsReset && messageOrder.length > 0) {
      // A plain user message (not a tool_result) separates the previous assistant turn's tools
      // from the next assistant turn, so the next turn is attributed to User Prompt.
      const prevKey = messageOrder[messageOrder.length - 1]!;
      const prev = byMessageId.get(prevKey);
      if (prev && prev.tools.length === 0) {
        // already empty
      }
      pendingUserToolsReset = false;
    }

    const msgId = typeof msg.id === "string" && msg.id ? msg.id : `anon_${++anonymousSeq}`;
    let step = byMessageId.get(msgId);
    if (!step) {
      step = {
        timestamp: typeof entry.timestamp === "string" ? entry.timestamp : undefined,
        model: typeof msg.model === "string" ? msg.model : undefined,
        inputTokens: 0,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
        outputTokens: 0,
        thinkingTokens: 0,
        tools: [],
        workflow: activeWorkflow,
      };
      byMessageId.set(msgId, step);
      messageOrder.push(msgId);
    }

    if (typeof entry.timestamp === "string") step.timestamp = entry.timestamp;
    if (typeof msg.model === "string") step.model = msg.model;

    if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block?.type === "tool_use") {
          const classified = classifyToolCall(block.name ?? "tool", block.input);
          if (classified.workflow) {
            activeWorkflow = classified.workflow;
            step.workflow = activeWorkflow;
          }
          step.tools.push(classified);
        } else if (block?.type === "text" && typeof block.text === "string") {
          const wf = detectWorkflowFromText(block.text);
          if (wf && activeWorkflow === "general") {
            activeWorkflow = wf;
            step.workflow = activeWorkflow;
          }
        }
      }
    }

    const usage = msg.usage;
    if (usage && typeof usage === "object") {
      step.inputTokens = Number(usage.input_tokens) || 0;
      step.cacheCreationTokens = Number(usage.cache_creation_input_tokens) || 0;
      step.cacheReadTokens = Number(usage.cache_read_input_tokens) || 0;
      step.outputTokens = Number(usage.output_tokens) || 0;
      step.thinkingTokens = Number(usage.output_tokens_details?.thinking_tokens) || 0;
    }
  }

  const steps = messageOrder
    .map((id) => byMessageId.get(id)!)
    .filter(
      (s) =>
        s.inputTokens > 0 ||
        s.cacheCreationTokens > 0 ||
        s.cacheReadTokens > 0 ||
        s.outputTokens > 0,
    );

  return foldSteps(steps, { ...context, costUSD });
}

export function parseCodexTranscriptTokens(
  jsonl: string,
  context: {
    agentName: string;
    subagentId?: string;
    subagentLabel?: string;
    initialWorkflow?: string;
  },
): ParsedTranscriptUsage {
  let activeWorkflow =
    context.initialWorkflow ??
    detectWorkflowFromText(context.subagentLabel) ??
    "general";
  let currentModel: string | undefined;
  let nickname: string | undefined;
  let metaRole: string | undefined;
  let firstPrompt: string | undefined;
  let pendingTools: Array<{ category: string; workflow?: string; summary: string }> = [];
  let prevTotalTokens = -1;
  const steps: StepEvent[] = [];

  for (const line of jsonl.split("\n")) {
    if (!line.trim()) continue;
    // Fast pre-filter: skip large tool output lines which carry no token_count or tool calls
    if (
      line.includes('"function_call_output"') ||
      line.includes('"custom_tool_call_output"') ||
      line.includes('"local_shell_call_output"')
    ) {
      continue;
    }
    let entry: any;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (!entry || typeof entry !== "object") continue;
    const payload = entry.payload;
    if (!payload || typeof payload !== "object") continue;

    if (entry.type === "session_meta") {
      if (typeof payload.agent_nickname === "string" && payload.agent_nickname.trim()) {
        nickname = payload.agent_nickname.trim();
      }
      if (typeof payload.agent_role === "string" && payload.agent_role.trim()) {
        metaRole = payload.agent_role.trim();
      }
      continue;
    }

    if (entry.type === "turn_context" && typeof payload.model === "string") {
      currentModel = payload.model;
      continue;
    }

    if (entry.type === "response_item") {
      if (payload.type === "message" && Array.isArray(payload.content)) {
        if (payload.role !== "user" && payload.role !== "assistant") continue;
        const text = payload.content
          .map((c: any) => (typeof c?.text === "string" ? c.text : ""))
          .filter(Boolean)
          .join("\n");
        const trimmed = text.trim();
        const isHarnessPreamble =
          trimmed.startsWith("# AGENTS.md instructions") ||
          trimmed.startsWith("<INSTRUCTIONS>") ||
          trimmed.startsWith("<user_instructions>") ||
          trimmed.startsWith("<environment_context>") ||
          trimmed.startsWith("<turn_context>") ||
          trimmed.startsWith("<permissions") ||
          trimmed.startsWith("<subagent_notification>") ||
          trimmed.startsWith("[planning-with-files] DATA ONLY");
        if (payload.role === "user" && !firstPrompt && trimmed && !isHarnessPreamble) {
          firstPrompt = trimmed.split("\n")[0]!.slice(0, 120);
        }
        if (!isHarnessPreamble) {
          const wf = detectWorkflowFromText(text);
          if (wf) activeWorkflow = wf;
        }
      } else if (
        payload.type === "function_call" ||
        payload.type === "custom_tool_call" ||
        payload.type === "local_shell_call"
      ) {
        const name = payload.type === "local_shell_call" ? "shell" : (payload.name ?? "tool");
        const rawArgs =
          payload.type === "local_shell_call"
            ? (payload.action?.command ?? payload.action)
            : (payload.arguments ?? payload.input);
        const classified = classifyToolCall(name, rawArgs);
        if (classified.workflow) activeWorkflow = classified.workflow;
        pendingTools.push(classified);
      }
      continue;
    }

    if (entry.type === "event_msg" && payload.type === "token_count" && payload.info) {
      const info = payload.info;
      const total = info.total_token_usage;
      const last = info.last_token_usage;
      if (!total || typeof total.total_tokens !== "number" || total.total_tokens <= prevTotalTokens) {
        continue;
      }
      prevTotalTokens = total.total_tokens;
      if (!last || typeof last !== "object") continue;

      const cacheReadTokens = Math.max(0, Number(last.cached_input_tokens) || 0);
      const cacheCreationTokens = Math.max(0, Number(last.cache_write_input_tokens) || 0);
      const rawInput = Math.max(0, Number(last.input_tokens) || 0);
      // In Codex/OpenAI, input_tokens includes cached_input_tokens.
      const inputTokens = Math.max(0, rawInput - cacheReadTokens - cacheCreationTokens);
      const outputTokens = Math.max(0, Number(last.output_tokens) || 0);
      const thinkingTokens = Math.max(0, Number(last.reasoning_output_tokens) || 0);

      // In Codex, response_item (tool call) is logged immediately BEFORE or AFTER token_count
      // for the same turn; attach any pending tools to the previous step if it had none, or to this step.
      steps.push({
        timestamp: typeof entry.timestamp === "string" ? entry.timestamp : undefined,
        model: currentModel,
        inputTokens,
        cacheCreationTokens,
        cacheReadTokens,
        outputTokens,
        thinkingTokens,
        tools: pendingTools,
        workflow: activeWorkflow,
      });
      pendingTools = [];
    }
  }

  // If trailing tool calls arrived after the last token_count, attach them to the last step.
  if (pendingTools.length > 0 && steps.length > 0) {
    steps[steps.length - 1]!.tools.push(...pendingTools);
  }

  // In Codex rollouts, `token_count` is emitted right BEFORE the assistant's `response_item`
  // tool call for that turn! Shift each step's tool calls back by one step when step[0] has no
  // tools and step[1] has the tool call emitted on turn 1.
  if (steps.length > 1 && steps[0]!.tools.length === 0) {
    for (let i = 0; i < steps.length - 1; i++) {
      if (steps[i]!.tools.length === 0 && steps[i + 1]!.tools.length > 0) {
        steps[i]!.tools = steps[i + 1]!.tools;
        steps[i + 1]!.tools = [];
      }
    }
  }

  const folded = foldSteps(steps, context);
  return {
    ...folded,
    ...(nickname || metaRole || firstPrompt
      ? { codexMeta: { nickname, role: metaRole, firstPrompt } }
      : {}),
  };
}

export function antigravityBrainTranscriptPath(sessionId: string): string {
  const home = process.env.HOME ?? homedir();
  return join(home, ".gemini", "antigravity-cli", "brain", sessionId, ".system_generated", "logs", "transcript.jsonl");
}

export function locateAntigravityBrainTranscript(agent: AgentState): string | null {
  if (agent.sessionId && /^[a-zA-Z0-9_-]{1,128}$/.test(agent.sessionId)) {
    const brainPath = antigravityBrainTranscriptPath(agent.sessionId);
    if (existsSync(brainPath)) return brainPath;
  }
  if (agent.transcriptPath && existsSync(agent.transcriptPath)) {
    return agent.transcriptPath;
  }
  return null;
}

export function parseAntigravityTranscriptTokens(
  jsonl: string,
  context: {
    agentName: string;
    subagentId?: string;
    subagentLabel?: string;
    initialWorkflow?: string;
  },
): ParsedTranscriptUsage {
  let activeWorkflow =
    context.initialWorkflow ??
    detectWorkflowFromText(context.subagentLabel) ??
    "general";
  let currentModel: string | undefined;
  let finishedAt: string | undefined;
  const steps: StepEvent[] = [];
  const antigravitySubagents: SubagentRecord[] = [];
  const seenSubIds = new Set<string>();
  const pendingSubagentSpawns: Array<{
    type: string;
    role: string;
    prompt: string;
    startedAt?: string;
  }> = [];

  for (const line of jsonl.split("\n")) {
    if (!line.trim()) continue;
    let entry: any;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (!entry || typeof entry !== "object") continue;

    if (entry.type === "USER_INPUT" || entry.type === "SYSTEM_MESSAGE") {
      if (typeof entry.content === "string") {
        const wf = detectWorkflowFromText(entry.content);
        if (wf) activeWorkflow = wf;
      }
      finishedAt = undefined;
      continue;
    }

    if (entry.type === "GENERIC" && typeof entry.content === "string") {
      // Subagent creation response emitted by invoke_subagent:
      // "Created At: ...\nCompleted At: ...\nCreated the following subagent:\n{\n  \"conversationId\": \"...\""
      if (
        !entry.content.includes("Command output:") &&
        entry.content.includes("Created the following subagent:")
      ) {
        const match = /Created the following subagent:\s*(\{[\s\S]*?\})/.exec(entry.content);
        if (match?.[1]) {
          try {
            const payload = JSON.parse(match[1]);
            const convId = typeof payload?.conversationId === "string" ? payload.conversationId.trim() : "";
            if (convId && !seenSubIds.has(convId)) {
              seenSubIds.add(convId);
              const spawn = pendingSubagentSpawns.shift();
              let subTranscriptPath = antigravityBrainTranscriptPath(convId);
              if (typeof payload.logAbsoluteUri === "string" && payload.logAbsoluteUri.startsWith("file://")) {
                try {
                  const uriPath = fileURLToPath(payload.logAbsoluteUri);
                  if (existsSync(uriPath)) subTranscriptPath = uriPath;
                } catch {
                  // fall back to antigravityBrainTranscriptPath
                }
              }
              const desc =
                spawn?.role ||
                (spawn?.prompt ? clipMessage(spawn.prompt.split("\n")[0]!, 56) : undefined);
              antigravitySubagents.push({
                id: convId,
                type: spawn?.type || "subagent",
                ...(desc ? { description: desc } : {}),
                startedAt:
                  spawn?.startedAt ||
                  (typeof entry.created_at === "string" ? entry.created_at : new Date().toISOString()),
                transcriptPath: subTranscriptPath,
              });
            }
          } catch {
            // ignore malformed block
          }
        }
      }
      continue;
    }

    if (entry.type !== "PLANNER_RESPONSE") continue;

    if (typeof entry.model === "string" && entry.model.trim()) {
      currentModel = entry.model.trim();
    }

    const inputTokens = Math.max(0, Number(entry.input_tokens) || 0);
    const cacheCreationTokens = Math.max(0, Number(entry.cache_creation_tokens) || 0);
    const cacheReadTokens = Math.max(0, Number(entry.cache_read_tokens) || 0);
    const outputTokens = Math.max(0, Number(entry.output_tokens) || 0);
    const thinkingTokens = Math.max(0, Number(entry.thinking_tokens) || 0);

    let stepWorkflow = activeWorkflow;
    const stepTools: Array<{ category: string; workflow?: string; summary: string }> = [];
    if (Array.isArray(entry.tool_calls)) {
      for (const tc of entry.tool_calls) {
        if (!tc || typeof tc !== "object") continue;
        const name = typeof tc.name === "string" ? tc.name : "tool";
        const rawArgs = tc.args && typeof tc.args === "object" ? unquoteAntigravityArgs(tc.args) : tc.args;
        const classified = classifyToolCall(name, rawArgs);
        if (classified.workflow && (name !== "invoke_subagent" || activeWorkflow === "general")) {
          activeWorkflow = classified.workflow;
          stepWorkflow = activeWorkflow;
        }
        stepTools.push(classified);

        if (name === "invoke_subagent" && rawArgs && typeof rawArgs === "object") {
          const argsObj = rawArgs as Record<string, unknown>;
          pendingSubagentSpawns.push({
            type: typeof argsObj.TypeName === "string" && argsObj.TypeName.trim() ? argsObj.TypeName.trim() : "subagent",
            role: typeof argsObj.Role === "string" ? argsObj.Role.trim() : "",
            prompt: typeof argsObj.Prompt === "string" ? argsObj.Prompt.trim() : "",
            startedAt: typeof entry.created_at === "string" ? entry.created_at : undefined,
          });
        }
      }
    }

    if (typeof entry.content === "string") {
      const wf = detectWorkflowFromText(entry.content);
      if (wf && activeWorkflow === "general") activeWorkflow = wf;
    }

    if (
      inputTokens > 0 ||
      cacheCreationTokens > 0 ||
      cacheReadTokens > 0 ||
      outputTokens > 0
    ) {
      steps.push({
        timestamp: typeof entry.created_at === "string" ? entry.created_at : undefined,
        model: currentModel,
        inputTokens,
        cacheCreationTokens,
        cacheReadTokens,
        outputTokens,
        thinkingTokens,
        tools: stepTools,
        workflow: stepWorkflow,
      });
    }

    if (entry.status === "DONE" && stepTools.length === 0 && typeof entry.created_at === "string") {
      finishedAt = entry.created_at;
    } else if (stepTools.length > 0) {
      finishedAt = undefined;
    }
  }

  const folded = foldSteps(steps, context);
  return {
    ...folded,
    ...(antigravitySubagents.length > 0 ? { antigravitySubagents } : {}),
    ...(finishedAt ? { finishedAt } : {}),
  };
}

// Build a single sessionId -> file path index across ~/.codex/sessions so we
// don't walk the directory tree repeatedly for each agent and subagent.
export function buildCodexRolloutIndex(): Map<string, string> {
  const index = new Map<string, string>();
  const root = join(codexHome(), "sessions");
  if (!existsSync(root)) return index;
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of entries) {
      const path = join(dir, name);
      try {
        if (statSync(path).isDirectory()) {
          stack.push(path);
        } else if (name.endsWith(".jsonl")) {
          const match = /^rollout-.*-([0-9a-f-]{36})\.jsonl$/i.exec(name);
          if (match?.[1]) index.set(match[1], path);
        }
      } catch {
        // ignore transient file errors
      }
    }
  }
  return index;
}

// Quick token snapshot for a subagent transcript (used on subagent-stop hook).
export function snapshotSubagentTokens(
  provider: Provider,
  transcriptPath: string | undefined,
): SubagentTokenSummary | undefined {
  if (!transcriptPath || !existsSync(transcriptPath)) return undefined;
  try {
    const text = readFileSync(transcriptPath, "utf8");
    const parsed =
      provider === "codex"
        ? parseCodexTranscriptTokens(text, { agentName: "subagent" })
        : provider === "antigravity"
          ? parseAntigravityTranscriptTokens(text, { agentName: "subagent" })
          : parseClaudeTranscriptTokens(text, { agentName: "subagent", ownFile: true });
    if (parsed.tokens.steps === 0) return undefined;
    return {
      steps: parsed.tokens.steps,
      inputTokens: parsed.tokens.inputTokens,
      cacheCreationTokens: parsed.tokens.cacheCreationTokens,
      cacheReadTokens: parsed.tokens.cacheReadTokens,
      outputTokens: parsed.tokens.outputTokens,
      ...(parsed.tokens.thinkingTokens > 0 ? { thinkingTokens: parsed.tokens.thinkingTokens } : {}),
    };
  } catch {
    return undefined;
  }
}

export function enrichSubagentsWithTokens(
  agent: AgentState,
  records: SubagentRecord[],
): SubagentRecord[] {
  const provider = agentProvider(agent);
  if (records.length === 0) return records;
  const codexIndex = provider === "codex" ? buildCodexRolloutIndex() : undefined;
  return records.map((record) => {
    if (record.endedAt && record.tokens && (provider !== "codex" || record.description)) {
      return record;
    }
    let subFile: string | null = null;
    if (record.transcriptPath && existsSync(record.transcriptPath)) {
      subFile = record.transcriptPath;
    } else if (provider === "claude") {
      const derived = subagentTranscriptFile(agent, record.id);
      if (derived && existsSync(derived)) subFile = derived;
    } else if (provider === "codex" && codexIndex?.has(record.id)) {
      subFile = codexIndex.get(record.id)!;
    } else if (provider === "antigravity") {
      const brainSub = antigravityBrainTranscriptPath(record.id);
      if (existsSync(brainSub)) subFile = brainSub;
    }
    if (!subFile) return record;
    try {
      const text = readFileSync(subFile, "utf8");
      const parsed =
        provider === "codex"
          ? parseCodexTranscriptTokens(text, { agentName: agent.name, subagentId: record.id })
          : provider === "antigravity"
            ? parseAntigravityTranscriptTokens(text, { agentName: agent.name, subagentId: record.id })
            : parseClaudeTranscriptTokens(text, { agentName: agent.name, subagentId: record.id, ownFile: true });
      const tokens: SubagentTokenSummary | undefined =
        parsed.tokens.steps > 0
          ? {
              steps: parsed.tokens.steps,
              inputTokens: parsed.tokens.inputTokens,
              cacheCreationTokens: parsed.tokens.cacheCreationTokens,
              cacheReadTokens: parsed.tokens.cacheReadTokens,
              outputTokens: parsed.tokens.outputTokens,
              ...(parsed.tokens.thinkingTokens > 0 ? { thinkingTokens: parsed.tokens.thinkingTokens } : {}),
            }
          : record.tokens;
      let description = record.description;
      if (!description && parsed.codexMeta) {
        const { nickname, firstPrompt } = parsed.codexMeta;
        if (firstPrompt) description = clipMessage(nickname ? `${nickname}: ${firstPrompt}` : firstPrompt, 52);
        else if (nickname) description = nickname;
      }
      return {
        ...record,
        ...(description ? { description } : {}),
        ...(tokens ? { tokens } : {}),
      };
    } catch {
      return record;
    }
  });
}

function discoverExtraClaudeSubagents(
  mainTranscript: string | null,
  knownIds: Set<string>,
): SubagentRecord[] {
  if (!mainTranscript) return [];
  const subDir = join(dirname(mainTranscript), basename(mainTranscript, ".jsonl"), "subagents");
  if (!existsSync(subDir)) return [];
  const extra: SubagentRecord[] = [];
  try {
    for (const name of readdirSync(subDir)) {
      const match = /^agent-([a-zA-Z0-9_-]+)\.jsonl$/.exec(name);
      if (!match?.[1] || knownIds.has(match[1])) continue;
      const id = match[1];
      const transcriptPath = join(subDir, name);
      const stat = statSync(transcriptPath);
      let type = "general-purpose";
      let description: string | undefined;
      try {
        const meta = JSON.parse(readFileSync(transcriptPath.replace(/\.jsonl$/, ".meta.json"), "utf8"));
        if (typeof meta?.agentType === "string") type = meta.agentType;
        if (typeof meta?.description === "string") description = meta.description;
      } catch {
        // meta optional
      }
      extra.push({
        id,
        type,
        description,
        startedAt: new Date(stat.birthtimeMs || stat.mtimeMs).toISOString(),
        endedAt: new Date(stat.mtimeMs).toISOString(),
        transcriptPath,
      });
    }
  } catch {
    // ignore
  }
  return extra;
}

// Select top anomalies across all 4 categories so polling loops don't crowd out
// cache-bust spikes, bloated tool outputs, or cold-start fan-out overhead.
export function selectBalancedAnomalies(
  anomalies: BudgetAnomaly[],
  maxTotal = MAX_ANOMALIES,
  perKind = 4,
): BudgetAnomaly[] {
  const sorted = [...anomalies].sort((a, b) => b.tokens - a.tokens);
  const counts = new Map<AnomalyKind, number>();
  const picked: BudgetAnomaly[] = [];
  const overflow: BudgetAnomaly[] = [];
  for (const item of sorted) {
    const c = counts.get(item.kind) ?? 0;
    if (c < perKind) {
      counts.set(item.kind, c + 1);
      picked.push(item);
    } else {
      overflow.push(item);
    }
  }
  return [...picked, ...overflow].slice(0, maxTotal);
}

const agentReportCache = new Map<string, { signature: string; report: AgentTokenReport }>();

function fileStatKey(path: string | null | undefined): string {
  if (!path) return "";
  try {
    const s = statSync(path);
    return `${s.size}:${Math.floor(s.mtimeMs)}`;
  } catch {
    return "";
  }
}

export function collectAgentTokenUsage(
  agent: AgentState,
  codexIndex?: Map<string, string>,
): AgentTokenReport {
  const provider = agentProvider(agent);
  const status = displayStatus(agent);
  const live = status !== "dead" && status !== "exited";
  const agentRole = roleForAgent(agent);
  const initialWorkflow = detectWorkflowFromText(agent.task);

  let mainTranscript: string | null = null;
  if (provider === "antigravity") {
    mainTranscript = locateAntigravityBrainTranscript(agent);
  } else if (provider === "codex" && agent.sessionId && codexIndex?.has(agent.sessionId)) {
    mainTranscript = codexIndex.get(agent.sessionId)!;
  } else {
    try {
      mainTranscript = locateTranscript(agent);
    } catch {
      // no session file yet
    }
  }

  const ledgerRecords = readSubagents(agent.name);
  const lastLedger = ledgerRecords[ledgerRecords.length - 1];
  const cacheSig = [
    agent.createdAt,
    agent.updatedAt,
    status,
    fileStatKey(mainTranscript),
    ledgerRecords.length,
    lastLedger?.id ?? "",
    lastLedger?.endedAt ?? "",
  ].join("|");

  const cached = !live ? agentReportCache.get(agent.name) : undefined;
  if (cached && cached.signature === cacheSig) {
    return cached.report;
  }

  const workflows = new Map<string, { runs: Set<string>; buckets: TokenBuckets }>();
  const tools = new Map<string, { calls: number; buckets: TokenBuckets }>();
  const anomalies: BudgetAnomaly[] = [];
  const byRoleMap = new Map<string, RoleTokenBreakdown>();

  const addRoleUsage = (role: string, scope: "main" | "subagent", buckets: TokenBuckets) => {
    if (buckets.steps === 0 && buckets.totalTokens === 0) return;
    const key = `${scope}:${role}`;
    const current = byRoleMap.get(key) ?? { role, scope, runs: 0, tokens: emptyBuckets() };
    current.runs += 1;
    current.tokens = addBuckets(current.tokens, buckets);
    byRoleMap.set(key, current);
  };

  let main = emptyBuckets();
  let model = agent.model;
  let antigravitySubagents: SubagentRecord[] = [];

  if (mainTranscript && existsSync(mainTranscript)) {
    try {
      const text = readFileSync(mainTranscript, "utf8");
      const parsed =
        provider === "codex"
          ? parseCodexTranscriptTokens(text, { agentName: agent.name, initialWorkflow })
          : provider === "antigravity"
            ? parseAntigravityTranscriptTokens(text, { agentName: agent.name, initialWorkflow })
            : parseClaudeTranscriptTokens(text, { agentName: agent.name, initialWorkflow });
      main = parsed.tokens;
      if (parsed.model) model = parsed.model;
      if (parsed.antigravitySubagents) antigravitySubagents = parsed.antigravitySubagents;
      for (const [wf, data] of parsed.workflows) {
        addWorkflowStep(workflows, wf, agent.name, data.buckets);
      }
      for (const [cat, data] of parsed.tools) {
        addToolStep(tools, cat, data.calls, data.buckets);
      }
      anomalies.push(...parsed.anomalies);

      if (main.steps >= POLLING_LOOP_MIN_STEPS && main.cacheReadTokens >= POLLING_LOOP_MIN_CACHE_READ) {
        const avgContext = Math.round(main.cacheReadTokens / main.steps);
        anomalies.push({
          kind: "polling-loop",
          agent: agent.name,
          title: `Main session ran ${main.steps} steps re-reading ${formatTokens(main.cacheReadTokens)} cached tokens`,
          detail: `Average context carry of ${formatTokens(avgContext)} tokens/step across ${main.steps} turns.`,
          tokens: Math.round(main.cacheReadTokens * 0.1) + main.activeTokens,
          timestamp: agent.updatedAt,
        });
      }
    } catch {
      // unreadable transcript
    }
  }

  addRoleUsage(agentRole ?? "main", "main", main);

  // Subagents
  if (live && provider === "claude") {
    try {
      reconcileOpenSubagents(agent);
    } catch {
      // ignore
    }
  }

  const knownIds = new Set(ledgerRecords.map((r) => r.id));
  const extraRecords =
    provider === "claude"
      ? discoverExtraClaudeSubagents(mainTranscript, knownIds)
      : provider === "antigravity"
        ? antigravitySubagents.filter((r) => !knownIds.has(r.id))
        : [];
  const allSubRecords = [...ledgerRecords, ...extraRecords];

  let subagentTotals = emptyBuckets();
  const subagentReports: SubagentTokenRecord[] = [];
  let coldStartSpawns = 0;
  let coldStartTokensSum = 0;

  for (const record of allSubRecords) {
    const meta = provider === "claude" ? readSubagentMeta(agent, record.id) : null;
    let description =
      record.description ??
      (typeof meta?.description === "string" && meta.description.trim() ? meta.description : undefined);
    let label = subagentLabel({ type: record.type, description });
    let role = normalizeSubagentRole(record.type, description);
    let endedAt = record.endedAt;

    let subFile: string | null = null;
    if (record.transcriptPath && existsSync(record.transcriptPath)) {
      subFile = record.transcriptPath;
    } else if (provider === "claude") {
      const derived = subagentTranscriptFile(agent, record.id);
      if (derived && existsSync(derived)) subFile = derived;
    } else if (provider === "codex" && codexIndex?.has(record.id)) {
      subFile = codexIndex.get(record.id)!;
    } else if (provider === "antigravity") {
      const brainSub = antigravityBrainTranscriptPath(record.id);
      if (existsSync(brainSub)) subFile = brainSub;
    }

    let subBuckets = emptyBuckets();
    let subModel: string | undefined;
    let subWorkflow = detectWorkflowFromText(description);
    let subCacheBusts = 0;

    if (subFile && existsSync(subFile)) {
      try {
        const text = readFileSync(subFile, "utf8");
        const parsed =
          provider === "codex"
            ? parseCodexTranscriptTokens(text, {
                agentName: agent.name,
                subagentId: record.id,
                subagentLabel: label,
                initialWorkflow: subWorkflow,
              })
            : provider === "antigravity"
              ? parseAntigravityTranscriptTokens(text, {
                  agentName: agent.name,
                  subagentId: record.id,
                  subagentLabel: label,
                  initialWorkflow: subWorkflow,
                })
              : parseClaudeTranscriptTokens(text, {
                  agentName: agent.name,
                  subagentId: record.id,
                  subagentLabel: label,
                  initialWorkflow: subWorkflow,
                  ownFile: true,
                });
        if (!endedAt && parsed.finishedAt) {
          endedAt = parsed.finishedAt;
        }
        if (parsed.codexMeta) {
          const { nickname, role: cRole, firstPrompt } = parsed.codexMeta;
          if (!description && firstPrompt) {
            description = clipMessage(nickname ? `${nickname}: ${firstPrompt}` : firstPrompt, 56);
          } else if (!description && nickname) {
            description = nickname;
          }
          const effectiveType = cRole && cRole !== "default" ? cRole : record.type;
          label = subagentLabel({ type: effectiveType, description });
          role = normalizeSubagentRole(effectiveType, firstPrompt ?? description);
        }
        subBuckets = parsed.tokens;
        subModel = parsed.model;
        subCacheBusts = parsed.cacheBusts;
        if (parsed.detectedWorkflow && parsed.detectedWorkflow !== "general") {
          subWorkflow = parsed.detectedWorkflow;
        }
        if (parsed.step1NewTokens > 0) {
          coldStartSpawns++;
          coldStartTokensSum += parsed.step1NewTokens;
        }
        for (const [wf, data] of parsed.workflows) {
          addWorkflowStep(workflows, wf, `${agent.name}/${record.id}`, data.buckets);
        }
        for (const [cat, data] of parsed.tools) {
          addToolStep(tools, cat, data.calls, data.buckets);
        }
        for (const a of parsed.anomalies) {
          anomalies.push({ ...a, subagentLabel: label });
        }

        if (
          subBuckets.steps >= POLLING_LOOP_MIN_STEPS &&
          subBuckets.cacheReadTokens >= POLLING_LOOP_MIN_CACHE_READ
        ) {
          const avgContext = Math.round(subBuckets.cacheReadTokens / subBuckets.steps);
          anomalies.push({
            kind: "polling-loop",
            agent: agent.name,
            subagentId: record.id,
            subagentLabel: label,
            title: `Subagent "${label}" ran ${subBuckets.steps} steps (${formatTokens(subBuckets.cacheReadTokens)} cache reads)`,
            detail: `High-step loop averaging ${formatTokens(avgContext)} cached tokens/step (${formatTokens(subBuckets.activeTokens)} active tokens).`,
            tokens: Math.round(subBuckets.cacheReadTokens * 0.1) + subBuckets.activeTokens,
            timestamp: record.endedAt ?? record.startedAt,
          });
        }
      } catch {
        // fall back to ledger snapshot if present
      }
    }

    if (subBuckets.steps === 0 && record.tokens) {
      subBuckets = computeBuckets(record.tokens);
      const wf = subWorkflow || "general";
      addWorkflowStep(workflows, wf, `${agent.name}/${record.id}`, subBuckets);
    }

    subagentTotals = addBuckets(subagentTotals, subBuckets);
    addRoleUsage(role, "subagent", subBuckets);

    const subStatus: "running" | "finished" | "stale" = endedAt
      ? "finished"
      : live
        ? "running"
        : "stale";

    subagentReports.push({
      id: record.id,
      type: record.type,
      role,
      label,
      ...(subWorkflow && subWorkflow !== "general" ? { workflow: subWorkflow } : {}),
      startedAt: record.startedAt,
      ...(endedAt ? { endedAt } : {}),
      status: subStatus,
      ...(subModel ? { model: subModel } : {}),
      tokens: subBuckets,
      cacheBusts: subCacheBusts,
    });
  }

  if (coldStartSpawns >= COLD_START_MIN_SPAWNS && coldStartTokensSum >= COLD_START_MIN_TOKENS) {
    const avgCold = Math.round(coldStartTokensSum / coldStartSpawns);
    anomalies.push({
      kind: "cold-start",
      agent: agent.name,
      title: `${coldStartSpawns} subagent spawns paid ${formatTokens(coldStartTokensSum)} cold-start tokens`,
      detail: `Each subagent uploaded ~${formatTokens(avgCold)} system/skill/schema tokens on step 1 before its first tool call.`,
      tokens: coldStartTokensSum,
      timestamp: agent.updatedAt,
    });
  }

  subagentReports.sort((a, b) => b.tokens.budgetTokens - a.tokens.budgetTokens);

  const combined = addBuckets(main, subagentTotals);
  const byRole = [...byRoleMap.values()].sort((a, b) => b.tokens.budgetTokens - a.tokens.budgetTokens);
  const workflowList: WorkflowTokenBreakdown[] = [...workflows.entries()]
    .map(([workflow, data]) => ({ workflow, runs: data.runs.size, tokens: data.buckets }))
    .filter((w) => w.tokens.totalTokens > 0)
    .sort((a, b) => b.tokens.budgetTokens - a.tokens.budgetTokens);
  const toolList: ToolTokenBreakdown[] = [...tools.entries()]
    .map(([category, data]) => ({ category, calls: data.calls, tokens: data.buckets }))
    .filter((t) => t.tokens.totalTokens > 0)
    .sort((a, b) => b.tokens.budgetTokens - a.tokens.budgetTokens);
  const sortedAnomalies = selectBalancedAnomalies(anomalies);

  const result: AgentTokenReport = {
    name: agent.name,
    provider,
    status,
    ...(agentRole ? { role: agentRole } : {}),
    ...(model ? { model } : {}),
    updatedAt: agent.updatedAt,
    main,
    subagentTotals,
    combined,
    subagents: subagentReports,
    byRole,
    workflows: workflowList,
    tools: toolList,
    anomalies: sortedAnomalies,
  };
  if (!live) {
    agentReportCache.set(agent.name, { signature: cacheSig, report: result });
  }
  return result;
}

export function collectFleetTokenUsage(
  opts: { provider?: Provider; agentName?: string } = {},
): FleetTokenReport {
  const codexIndex = buildCodexRolloutIndex();
  const agentsToScan: AgentState[] = opts.agentName
    ? [resolveAgent(opts.agentName)]
    : listAgents().filter((a) => !opts.provider || agentProvider(a) === opts.provider);

  const agentReports = agentsToScan
    .map((agent) => collectAgentTokenUsage(agent, codexIndex))
    .filter((r) => opts.agentName || r.combined.totalTokens > 0 || r.subagents.length > 0)
    .sort((a, b) => b.combined.budgetTokens - a.combined.budgetTokens);

  let mainTotal = emptyBuckets();
  let subTotal = emptyBuckets();
  const byRoleMap = new Map<string, RoleTokenBreakdown>();
  const workflowMap = new Map<string, { runs: number; tokens: TokenBuckets }>();
  const toolMap = new Map<string, { calls: number; tokens: TokenBuckets }>();
  const allAnomalies: BudgetAnomaly[] = [];

  for (const report of agentReports) {
    mainTotal = addBuckets(mainTotal, report.main);
    subTotal = addBuckets(subTotal, report.subagentTotals);

    for (const r of report.byRole) {
      const key = `${r.scope}:${r.role}`;
      const cur = byRoleMap.get(key) ?? { role: r.role, scope: r.scope, runs: 0, tokens: emptyBuckets() };
      cur.runs += r.runs;
      cur.tokens = addBuckets(cur.tokens, r.tokens);
      byRoleMap.set(key, cur);
    }

    for (const w of report.workflows) {
      const cur = workflowMap.get(w.workflow) ?? { runs: 0, tokens: emptyBuckets() };
      cur.runs += w.runs;
      cur.tokens = addBuckets(cur.tokens, w.tokens);
      workflowMap.set(w.workflow, cur);
    }

    for (const t of report.tools) {
      const cur = toolMap.get(t.category) ?? { calls: 0, tokens: emptyBuckets() };
      cur.calls += t.calls;
      cur.tokens = addBuckets(cur.tokens, t.tokens);
      toolMap.set(t.category, cur);
    }

    allAnomalies.push(...report.anomalies);
  }

  return {
    generatedAt: new Date().toISOString(),
    host: localHostIdentity(),
    totals: {
      main: mainTotal,
      subagents: subTotal,
      combined: addBuckets(mainTotal, subTotal),
    },
    agents: agentReports,
    byRole: [...byRoleMap.values()].sort((a, b) => b.tokens.budgetTokens - a.tokens.budgetTokens),
    workflows: [...workflowMap.entries()]
      .map(([workflow, d]) => ({ workflow, runs: d.runs, tokens: d.tokens }))
      .sort((a, b) => b.tokens.budgetTokens - a.tokens.budgetTokens),
    tools: [...toolMap.entries()]
      .map(([category, d]) => ({ category, calls: d.calls, tokens: d.tokens }))
      .sort((a, b) => b.tokens.budgetTokens - a.tokens.budgetTokens),
    anomalies: selectBalancedAnomalies(allAnomalies),
  };
}

// --- CLI Formatting ---------------------------------------------------------

const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const YELLOW = "\x1b[33m";
const CYAN = "\x1b[36m";
const RESET = "\x1b[0m";

function shareBar(part: number, total: number, width = 10): string {
  if (total <= 0) return "░".repeat(width);
  const filled = Math.max(0, Math.min(width, Math.round((part / total) * width)));
  return "█".repeat(filled) + "░".repeat(width - filled);
}

export function formatTokenReportLines(
  report: FleetTokenReport,
  opts: { color?: boolean; singleAgent?: boolean } = {},
): string[] {
  const color = opts.color ?? true;
  const paint = (text: string, code: string) => (color ? `${code}${text}${RESET}` : text);
  const lines: string[] = [];

  if (report.agents.length === 0) {
    lines.push(paint("No token usage recorded for matching agents.", DIM));
    return lines;
  }

  const { main, subagents, combined } = report.totals;
  const subShare =
    combined.budgetTokens > 0 ? Math.round((subagents.budgetTokens / combined.budgetTokens) * 100) : 0;

  // Header summary
  lines.push(
    [
      paint("token breakdown", BOLD),
      paint("·", DIM),
      `active ${paint(formatTokens(combined.activeTokens), BOLD)}`,
      paint(`(in+cache-write ${formatTokens(combined.inputTokens + combined.cacheCreationTokens)} · out ${formatTokens(combined.outputTokens)})`, DIM),
      paint("·", DIM),
      `cache-read ${formatTokens(combined.cacheReadTokens)}`,
      paint("·", DIM),
      `subagents ${subShare}% of budget`,
    ].join(" "),
  );

  // 1. By Agent & Subagent
  lines.push("");
  lines.push(paint("1. Agents & subagents (ranked by quota weight)", BOLD));
  const maxAgentBudget = Math.max(1, ...report.agents.map((a) => a.combined.budgetTokens));
  const nameWidth = Math.min(28, Math.max(12, ...report.agents.map((a) => a.name.length)));

  lines.push(
    paint(
      `  ${"AGENT".padEnd(nameWidth)}  ${"SHARE".padEnd(10)}  ${"STEPS".padStart(5)}  ${"ACTIVE (NEW+OUT)".padStart(16)}  ${"CACHE READ".padStart(10)}  ${"OUT".padStart(7)}  SUBAGENTS`,
      DIM,
    ),
  );

  const shownAgents = opts.singleAgent ? report.agents : report.agents.slice(0, 12);
  for (const agent of shownAgents) {
    const bar = paint(shareBar(agent.combined.budgetTokens, maxAgentBudget, 10), CYAN);
    const steps = String(agent.combined.steps).padStart(5);
    const active = formatTokens(agent.combined.activeTokens).padStart(16);
    const cacheRead = formatTokens(agent.combined.cacheReadTokens).padStart(10);
    const out = formatTokens(agent.combined.outputTokens).padStart(7);
    const subNote =
      agent.subagents.length > 0
        ? `${agent.subagents.length} (${formatTokens(agent.subagentTotals.activeTokens)} active)`
        : "—";
    const nameLabel = agent.name.length > nameWidth ? agent.name.slice(0, nameWidth - 1) + "…" : agent.name.padEnd(nameWidth);
    lines.push(`  ${nameLabel}  ${bar}  ${steps}  ${active}  ${cacheRead}  ${out}  ${paint(subNote, DIM)}`);

    const subLimit = opts.singleAgent ? 15 : 3;
    const topSubs = agent.subagents.filter((s) => s.tokens.totalTokens > 0).slice(0, subLimit);
    for (const sub of topSubs) {
      const subLabel = `⤷ [${sub.role}] ${sub.label}`;
      const clipped = subLabel.length > nameWidth + 12 ? subLabel.slice(0, nameWidth + 11) + "…" : subLabel.padEnd(nameWidth + 12);
      const sSteps = String(sub.tokens.steps).padStart(5);
      const sActive = formatTokens(sub.tokens.activeTokens).padStart(16);
      const sCache = formatTokens(sub.tokens.cacheReadTokens).padStart(10);
      const sOut = formatTokens(sub.tokens.outputTokens).padStart(7);
      const bustTag = sub.cacheBusts > 0 ? paint(` · ${sub.cacheBusts} cache-bust${sub.cacheBusts === 1 ? "" : "s"}`, YELLOW) : "";
      lines.push(`  ${paint(clipped, DIM)}  ${sSteps}  ${sActive}  ${sCache}  ${sOut}${bustTag}`);
    }
    if (agent.subagents.length > subLimit) {
      lines.push(paint(`    … +${agent.subagents.length - subLimit} more subagents (run \`am usage ${agent.name}\` for all)`, DIM));
    }
  }

  // Role summary line
  if (report.byRole.length > 0) {
    const roleSummary = report.byRole
      .slice(0, 6)
      .map((r) => `${r.role} (${r.runs}): ${formatTokens(r.tokens.activeTokens)} active`)
      .join(" · ");
    lines.push(paint(`  Roles: ${roleSummary}`, DIM));
  }

  // 2. By Workflow / Skill
  if (report.workflows.length > 0) {
    lines.push("");
    lines.push(paint("2. By workflow / skill", BOLD));
    const wfWidth = Math.min(26, Math.max(14, ...report.workflows.slice(0, 8).map((w) => w.workflow.length)));
    lines.push(
      paint(
        `  ${"WORKFLOW".padEnd(wfWidth)}  ${"RUNS".padStart(4)}  ${"STEPS".padStart(5)}  ${"ACTIVE (NEW+OUT)".padStart(16)}  ${"CACHE READ".padStart(10)}  ${"OUT".padStart(7)}`,
        DIM,
      ),
    );
    for (const wf of report.workflows.slice(0, 8)) {
      const label = wf.workflow.length > wfWidth ? wf.workflow.slice(0, wfWidth - 1) + "…" : wf.workflow.padEnd(wfWidth);
      lines.push(
        `  ${label}  ${String(wf.runs).padStart(4)}  ${String(wf.tokens.steps).padStart(5)}  ${formatTokens(wf.tokens.activeTokens).padStart(16)}  ${formatTokens(wf.tokens.cacheReadTokens).padStart(10)}  ${formatTokens(wf.tokens.outputTokens).padStart(7)}`,
      );
    }
  }

  // 3. By Tool / Command Category
  if (report.tools.length > 0) {
    lines.push("");
    lines.push(paint("3. By tool & command category", BOLD));
    const catWidth = Math.min(30, Math.max(18, ...report.tools.slice(0, 10).map((t) => t.category.length)));
    lines.push(
      paint(
        `  ${"CATEGORY".padEnd(catWidth)}  ${"CALLS".padStart(5)}  ${"STEPS".padStart(5)}  ${"ACTIVE (NEW+OUT)".padStart(16)}  ${"CACHE READ".padStart(10)}  ${"OUT".padStart(7)}`,
        DIM,
      ),
    );
    for (const tool of report.tools.slice(0, 10)) {
      const label = tool.category.length > catWidth ? tool.category.slice(0, catWidth - 1) + "…" : tool.category.padEnd(catWidth);
      lines.push(
        `  ${label}  ${String(tool.calls).padStart(5)}  ${String(tool.tokens.steps).padStart(5)}  ${formatTokens(tool.tokens.activeTokens).padStart(16)}  ${formatTokens(tool.tokens.cacheReadTokens).padStart(10)}  ${formatTokens(tool.tokens.outputTokens).padStart(7)}`,
      );
    }
  }

  // 4. Top Budget Offenders / Anomalies
  if (report.anomalies.length > 0) {
    lines.push("");
    lines.push(paint("4. Top budget offenders & anomalies", BOLD));
    for (const anomaly of report.anomalies.slice(0, 8)) {
      const tag = paint(`[${anomaly.kind}]`, YELLOW);
      const who = anomaly.subagentLabel ? `${anomaly.agent} › ${anomaly.subagentLabel}` : anomaly.agent;
      lines.push(`  ${tag} ${paint(who, BOLD)} — ${anomaly.title}`);
      lines.push(`    ${paint(anomaly.detail, DIM)}`);
    }
  }

  return lines;
}
