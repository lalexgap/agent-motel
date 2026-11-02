import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordSubagentEvent } from "../src/commands/hook";
import { startApiServer } from "../src/server";
import { writeAgent, type AgentState } from "../src/state";
import { readSubagents, recordSubagentStart, recordSubagentStop } from "../src/subagents";
import {
  antigravityBrainTranscriptPath,
  classifyBashCommand,
  classifyToolCall,
  collectAgentTokenUsage,
  collectFleetTokenUsage,
  detectWorkflowFromText,
  formatTokenReportLines,
  formatTokens,
  normalizeSubagentRole,
  parseAntigravityTranscriptTokens,
  parseClaudeTranscriptTokens,
  parseCodexTranscriptTokens,
  selectBalancedAnomalies,
} from "../src/tokenUsage";

let home: string;
let prevHome: string | undefined;

beforeEach(() => {
  prevHome = process.env.HOME;
  home = mkdtempSync(join(tmpdir(), "am-token-usage-"));
  process.env.HOME = home;
  process.env.AGENTMGR_HOME = home;
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  delete process.env.AGENTMGR_HOME;
});

describe("tokenUsage classifiers", () => {
  test("classifies bash commands into actionable categories and workflows", () => {
    expect(classifyBashCommand("./bin/stack.sh start")).toEqual({
      category: "Bash (dev-server / stack.sh)",
      workflow: "start-dev",
    });
    expect(classifyBashCommand("verify-ui https://localhost:3000")).toEqual({
      category: "Bash (verify-ui / browser)",
      workflow: "pr-screenshots",
    });
    expect(classifyBashCommand("bundle exec rspec spec/models/user_spec.rb")).toMatchObject({
      category: "Bash (test / lint)",
    });
    expect(classifyBashCommand("gh pr checks 29558")).toMatchObject({
      category: "Bash (gh / CI)",
    });
    expect(classifyBashCommand("git status -sb")).toMatchObject({
      category: "Bash (git)",
    });
    expect(classifyBashCommand("rg -n 'parseClaudeTranscript' src/")).toMatchObject({
      category: "Bash (search / read)",
    });
    expect(classifyBashCommand("am ls")).toMatchObject({
      category: "Bash (am fleet)",
    });
  });

  test("unwraps Codex custom_tool_call exec scripts", () => {
    const devCmd = classifyToolCall(
      "exec",
      'const r = await tools.exec_command({ cmd: "./scripts/stack.sh status" });',
    );
    expect(devCmd.category).toBe("Bash (dev-server / stack.sh)");
    expect(devCmd.workflow).toBe("start-dev");

    const patchCall = classifyToolCall("exec", 'await tools.apply_patch("*** Begin Patch...");');
    expect(patchCall.category).toBe("Edit / Write");

    const mcpCall = classifyToolCall("exec", "await tools.mcp__producthunt__datadog_search_datadog_logs({});");
    expect(mcpCall.category).toBe("MCP (datadog)");

    const waitAgent = classifyToolCall(
      "exec",
      'text(await tools[ALL_TOOLS.find(x=>x.name.endsWith("wait_agent")).name]({targets:["01a188e6"]}))',
    );
    expect(waitAgent.category).toBe("Subagent (Agent)");
  });

  test("detects skills from preambles, paths, and prompts", () => {
    expect(
      detectWorkflowFromText("Base directory for this skill: /home/lagap/.gemini/config/skills/shepherd-pr\n# Shepherd"),
    ).toBe("shepherd-pr");
    expect(detectWorkflowFromText("Follow /home/lagap/.codex/skills/review-gate/SKILL.md")).toBe("review-gate");
    expect(detectWorkflowFromText("Run post-deploy-verify on production")).toBe("post-deploy-verify");
  });

  test("normalizes subagent roles from type and description", () => {
    expect(normalizeSubagentRole("Explore", "Find auth handlers")).toBe("Explore");
    expect(normalizeSubagentRole("general-purpose", "Shepherd PR #142 to merge-ready")).toBe("shepherd");
    expect(normalizeSubagentRole("default", "Independent SECURITY reviewer for PR 99")).toBe("reviewer");
    expect(normalizeSubagentRole("default", "Independent risk CLASSIFIER only")).toBe("reviewer");
    expect(normalizeSubagentRole("default", "Backend engineer responsibility: implement endpoint")).toBe("engineer");
    expect(normalizeSubagentRole("default", "Readonly sidecar post-deploy verify")).toBe("post-deploy");
  });
});

describe("parseClaudeTranscriptTokens", () => {
  test("deduplicates multi-block assistant messages by message.id and attributes tool costs", () => {
    const lines = [
      JSON.stringify({
        type: "user",
        timestamp: "2026-11-02T10:00:00.000Z",
        message: {
          role: "user",
          content: "Base directory for this skill: /home/user/.claude/skills/shepherd-pr\nShepherd PR 101",
        },
      }),
      // Step 1: two JSONL lines sharing msg_1 (text + Bash tool_use)
      JSON.stringify({
        type: "assistant",
        timestamp: "2026-11-02T10:00:02.000Z",
        message: {
          id: "msg_1",
          model: "claude-opus-4-7",
          content: [{ type: "text", text: "Checking stack status." }],
          usage: {
            input_tokens: 500,
            cache_creation_input_tokens: 35_000,
            cache_read_input_tokens: 0,
            output_tokens: 200,
          },
        },
      }),
      JSON.stringify({
        type: "assistant",
        timestamp: "2026-11-02T10:00:03.000Z",
        message: {
          id: "msg_1",
          model: "claude-opus-4-7",
          content: [{ type: "tool_use", id: "tu_1", name: "Bash", input: { command: "stack.sh start" } }],
          usage: {
            input_tokens: 500,
            cache_creation_input_tokens: 35_000,
            cache_read_input_tokens: 0,
            output_tokens: 200,
          },
        },
      }),
      // Step 2: 20 seconds later, stack.sh output added 20k new tokens (bloated tool)
      JSON.stringify({
        type: "assistant",
        timestamp: "2026-11-02T10:00:23.000Z",
        message: {
          id: "msg_2",
          model: "claude-opus-4-7",
          content: [{ type: "tool_use", id: "tu_2", name: "Bash", input: { command: "gh pr checks 101" } }],
          usage: {
            input_tokens: 300,
            cache_creation_input_tokens: 20_000,
            cache_read_input_tokens: 35_500,
            output_tokens: 150,
          },
        },
      }),
      // Step 3: 8 minutes later (>5m idle pause), cache expired and re-wrote 55k tokens (cache-bust)
      JSON.stringify({
        type: "assistant",
        timestamp: "2026-11-02T10:08:30.000Z",
        message: {
          id: "msg_3",
          model: "claude-opus-4-7",
          content: [{ type: "text", text: "CI passed." }],
          usage: {
            input_tokens: 200,
            cache_creation_input_tokens: 56_000,
            cache_read_input_tokens: 0,
            output_tokens: 100,
          },
        },
      }),
      JSON.stringify({
        type: "cost-state",
        totalCostUSD: 1.2345,
      }),
    ];

    const parsed = parseClaudeTranscriptTokens(lines.join("\n"), { agentName: "pr-bot" });
    expect(parsed.model).toBe("claude-opus-4-7");
    expect(parsed.tokens.steps).toBe(3);
    expect(parsed.tokens.inputTokens).toBe(1000);
    expect(parsed.tokens.cacheCreationTokens).toBe(111_000);
    expect(parsed.tokens.cacheReadTokens).toBe(35_500);
    expect(parsed.tokens.outputTokens).toBe(450);
    expect(parsed.tokens.costUSD).toBe(1.2345);
    expect(parsed.step1NewTokens).toBe(35_500);
    expect(parsed.cacheBusts).toBe(1);

    // Tool attribution: step 1 -> Session Cold Start, step 2 -> Bash (dev-server / stack.sh), step 3 -> Bash (gh / CI)
    expect(parsed.tools.get("Session Cold Start / Prompt")?.calls).toBe(1);
    expect(parsed.tools.get("Bash (dev-server / stack.sh)")?.calls).toBe(1);
    expect(parsed.tools.get("Bash (gh / CI)")?.calls).toBe(1);

    // Anomalies: 1 bloated-tool on step 2, 1 cache-bust on step 3
    expect(parsed.anomalies.map((a) => a.kind)).toEqual(["bloated-tool", "cache-bust"]);
    expect(parsed.anomalies[0]!.title).toContain("Bash(stack.sh start) injected 20k new tokens");
    expect(parsed.anomalies[1]!.title).toContain("Cache expired after 8m7s pause");
  });
});

describe("parseCodexTranscriptTokens", () => {
  test("subtracts cached_input_tokens from input_tokens and skips AGENTS.md / developer noise", () => {
    const lines = [
      JSON.stringify({
        timestamp: "2026-11-02T10:00:00.000Z",
        type: "session_meta",
        payload: { id: "sub-1", agent_nickname: "Carson", agent_role: "default" },
      }),
      JSON.stringify({
        timestamp: "2026-11-02T10:00:00.100Z",
        type: "turn_context",
        payload: { model: "gpt-5.4" },
      }),
      // Developer skills list (should be ignored for workflow & firstPrompt)
      JSON.stringify({
        timestamp: "2026-11-02T10:00:00.200Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "developer",
          content: [{ type: "input_text", text: "[planning-with-files] DATA ONLY /skills/planning-with-files/SKILL.md" }],
        },
      }),
      // Injected AGENTS.md user message (should be ignored for workflow & firstPrompt)
      JSON.stringify({
        timestamp: "2026-11-02T10:00:00.300Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "# AGENTS.md instructions for /repo\nUse planning-with-files" }],
        },
      }),
      // Actual subagent task prompt
      JSON.stringify({
        timestamp: "2026-11-02T10:00:00.400Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Independent CORRECTNESS reviewer for PR 29558 using review-gate" }],
        },
      }),
      JSON.stringify({
        timestamp: "2026-11-02T10:00:01.000Z",
        type: "event_msg",
        payload: {
          type: "token_count",
          info: {
            total_token_usage: { total_tokens: 20_500 },
            last_token_usage: {
              input_tokens: 20_000,
              cached_input_tokens: 15_000,
              output_tokens: 500,
              reasoning_output_tokens: 200,
              total_tokens: 20_500,
            },
          },
        },
      }),
      JSON.stringify({
        timestamp: "2026-11-02T10:00:01.100Z",
        type: "response_item",
        payload: {
          type: "custom_tool_call",
          name: "exec",
          input: 'await tools.exec_command({ cmd: "git diff origin/main...HEAD" });',
        },
      }),
      JSON.stringify({
        timestamp: "2026-11-02T10:00:05.000Z",
        type: "event_msg",
        payload: {
          type: "token_count",
          info: {
            total_token_usage: { total_tokens: 45_800 },
            last_token_usage: {
              input_tokens: 25_000,
              cached_input_tokens: 20_000,
              output_tokens: 300,
              reasoning_output_tokens: 100,
              total_tokens: 25_300,
            },
          },
        },
      }),
    ];

    const parsed = parseCodexTranscriptTokens(lines.join("\n"), { agentName: "codex-agent" });
    expect(parsed.model).toBe("gpt-5.4");
    expect(parsed.codexMeta).toEqual({
      nickname: "Carson",
      role: "default",
      firstPrompt: "Independent CORRECTNESS reviewer for PR 29558 using review-gate",
    });
    expect(parsed.detectedWorkflow).toBe("review-gate");
    expect(parsed.tokens.steps).toBe(2);
    // Uncached input = (20k - 15k) + (25k - 20k) = 10k
    expect(parsed.tokens.inputTokens).toBe(10_000);
    expect(parsed.tokens.cacheReadTokens).toBe(35_000);
    expect(parsed.tokens.outputTokens).toBe(800);
    expect(parsed.tokens.thinkingTokens).toBe(300);
    expect(parsed.tools.get("Bash (git)")?.calls).toBe(1);
  });
});

describe("fleet & agent rollup, ledger persistence, and HTTP API", () => {
  test("snapshots subagent tokens on subagent-stop and rolls up main + subagents + cold-start anomaly", async () => {
    const mainTranscript = join(home, "main.jsonl");
    writeFileSync(
      mainTranscript,
      JSON.stringify({
        type: "assistant",
        timestamp: "2026-11-02T10:00:01.000Z",
        message: {
          id: "m1",
          model: "claude-sonnet-4-6",
          content: [{ type: "tool_use", id: "t1", name: "Agent", input: { description: "Shepherd PR 1" } }],
          usage: { input_tokens: 2000, cache_creation_input_tokens: 10_000, cache_read_input_tokens: 5000, output_tokens: 500 },
        },
      }) + "\n",
    );

    const agent: AgentState = {
      name: "alpha",
      provider: "claude",
      status: "working",
      dir: home,
      tmuxSession: "am-alpha",
      transcriptPath: mainTranscript,
      createdAt: "2026-11-02T10:00:00.000Z",
      updatedAt: "2026-11-02T10:05:00.000Z",
    };
    writeAgent(agent);

    // Spawn 3 subagents, each with 35k step-1 cold-start tokens (>=90k combined triggers cold-start anomaly)
    for (const idx of [1, 2, 3]) {
      const subId = `sub-${idx}`;
      const subPath = join(home, `agent-${subId}.jsonl`);
      writeFileSync(
        subPath,
        JSON.stringify({
          type: "assistant",
          timestamp: "2026-11-02T10:01:00.000Z",
          message: {
            id: `s_${idx}`,
            model: "claude-sonnet-4-6",
            content: [{ type: "text", text: "Done reviewing." }],
            usage: {
              input_tokens: 1000,
              cache_creation_input_tokens: 34_000,
              cache_read_input_tokens: 0,
              output_tokens: 400,
            },
          },
        }) + "\n",
      );
      writeFileSync(
        join(home, `agent-${subId}.meta.json`),
        JSON.stringify({ description: `Review pass ${idx}` }),
      );
      recordSubagentEvent("subagent-start", agent, {
        agent_id: subId,
        agent_type: "general-purpose",
      });
      recordSubagentEvent("subagent-stop", agent, {
        agent_id: subId,
        agent_type: "general-purpose",
        last_assistant_message: "LGTM",
        agent_transcript_path: subPath,
      });
    }

    // Verify ledger persisted tokens on subagent-stop
    const ledger = readSubagents("alpha");
    expect(ledger).toHaveLength(3);
    expect(ledger[0]!.tokens).toEqual({
      steps: 1,
      inputTokens: 1000,
      cacheCreationTokens: 34_000,
      cacheReadTokens: 0,
      outputTokens: 400,
    });

    // Even if one subagent's transcript file is later deleted, its ledger token snapshot survives
    rmSync(join(home, "agent-sub-3.jsonl"));

    const report = collectAgentTokenUsage(agent);
    expect(report.main.activeTokens).toBe(12_500);
    expect(report.subagents).toHaveLength(3);
    expect(report.subagentTotals.activeTokens).toBe(3 * 35_400);
    expect(report.combined.activeTokens).toBe(12_500 + 3 * 35_400);
    expect(report.byRole.find((r) => r.role === "reviewer")?.runs).toBe(3);

    const fleet = collectFleetTokenUsage();
    const formatted = formatTokenReportLines(fleet, { color: false }).join("\n");
    expect(formatted).toContain("1. Agents & subagents");
    expect(formatted).toContain("alpha");
    expect(formatted).toContain("3. By tool & command category");

    // Verify HTTP API endpoints (/api/usage and /api/agents/alpha/usage)
    const server = startApiServer({ port: 0, hostname: "127.0.0.1", token: "test-token" });
    try {
      const headers = { Authorization: "Bearer test-token" };
      const fleetRes = await fetch(`${server.url}/api/usage?quota=0`, { headers });
      expect(fleetRes.status).toBe(200);
      const fleetJson = (await fleetRes.json()) as any;
      expect(fleetJson.tokens.agents).toHaveLength(1);
      expect(fleetJson.tokens.agents[0].name).toBe("alpha");

      const agentRes = await fetch(`${server.url}/api/agents/alpha/usage`, { headers });
      expect(agentRes.status).toBe(200);
      const agentJson = (await agentRes.json()) as any;
      expect(agentJson.combined.activeTokens).toBe(report.combined.activeTokens);
    } finally {
      server.stop();
    }
  });

  test("selectBalancedAnomalies preserves representation across anomaly kinds", () => {
    const items = [
      ...Array.from({ length: 6 }, (_, i) => ({
        kind: "polling-loop" as const,
        agent: "a",
        title: `loop ${i}`,
        detail: "",
        tokens: 500_000 - i * 1000,
      })),
      { kind: "cache-bust" as const, agent: "a", title: "bust", detail: "", tokens: 80_000 },
      { kind: "bloated-tool" as const, agent: "a", title: "bloat", detail: "", tokens: 40_000 },
      { kind: "cold-start" as const, agent: "a", title: "cold", detail: "", tokens: 95_000 },
    ];
    const picked = selectBalancedAnomalies(items, 8, 3);
    const kinds = new Set(picked.map((p) => p.kind));
    expect(kinds).toEqual(new Set(["polling-loop", "cache-bust", "bloated-tool", "cold-start"]));
    expect(formatTokens(95_000)).toBe("95k");
  });

  test("parses Antigravity brain transcript and rolls up invoke_subagent children", () => {
    const mainSessionId = "agy-main-1111-2222";
    const subSessionId = "agy-sub-3333-4444";
    const mainBrainFile = antigravityBrainTranscriptPath(mainSessionId);
    const subBrainFile = antigravityBrainTranscriptPath(subSessionId);
    mkdirSync(join(mainBrainFile, ".."), { recursive: true });
    mkdirSync(join(subBrainFile, ".."), { recursive: true });

    writeFileSync(
      mainBrainFile,
      [
        JSON.stringify({
          step_index: 0,
          source: "USER_EXPLICIT",
          type: "USER_INPUT",
          status: "DONE",
          created_at: "2026-11-02T15:00:00Z",
          content: "Please shepherd PR #140 using shepherd-pr",
        }),
        JSON.stringify({
          step_index: 1,
          source: "MODEL",
          type: "PLANNER_RESPONSE",
          status: "DONE",
          created_at: "2026-11-02T15:00:05Z",
          input_tokens: 12_000,
          cache_read_tokens: 0,
          output_tokens: 300,
          tool_calls: [
            {
              name: "run_command",
              args: { CommandLine: '"git status -s"', WaitMsBeforeAsync: "5000" },
            },
            {
              name: "invoke_subagent",
              args: {
                TypeName: '"research"',
                Role: '"Correctness Reviewer Subagent"',
                Prompt: '"Run correctness review via review-gate"',
              },
            },
          ],
        }),
        JSON.stringify({
          step_index: 2,
          source: "MODEL",
          type: "GENERIC",
          status: "DONE",
          created_at: "2026-11-02T15:00:08Z",
          content: `Created At: 2026-11-02T08:00:08-07:00\nCompleted At: 2026-11-02T08:00:09-07:00\nCreated the following subagent:\n{\n  "conversationId": "${subSessionId}",\n  "logAbsoluteUri": "file://${subBrainFile}"\n}\n`,
        }),
        JSON.stringify({
          step_index: 3,
          source: "MODEL",
          type: "PLANNER_RESPONSE",
          status: "DONE",
          created_at: "2026-11-02T15:00:15Z",
          input_tokens: 2_500,
          cache_read_tokens: 12_000,
          output_tokens: 200,
          tool_calls: [],
        }),
      ].join("\n") + "\n",
    );

    writeFileSync(
      subBrainFile,
      [
        JSON.stringify({
          step_index: 0,
          source: "SYSTEM",
          type: "SYSTEM_MESSAGE",
          status: "DONE",
          created_at: "2026-11-02T15:00:09Z",
          content: "Run correctness review via review-gate",
        }),
        JSON.stringify({
          step_index: 1,
          source: "MODEL",
          type: "PLANNER_RESPONSE",
          status: "DONE",
          created_at: "2026-11-02T15:00:12Z",
          input_tokens: 9_000,
          cache_read_tokens: 0,
          output_tokens: 400,
          tool_calls: [
            {
              name: "read_file",
              args: { Path: '"/repo/src/antigravity.ts"' },
            },
          ],
        }),
        JSON.stringify({
          step_index: 2,
          source: "MODEL",
          type: "PLANNER_RESPONSE",
          status: "DONE",
          created_at: "2026-11-02T15:00:14Z",
          input_tokens: 1_500,
          cache_read_tokens: 9_000,
          output_tokens: 250,
          tool_calls: [],
        }),
      ].join("\n") + "\n",
    );

    const parsedMain = parseAntigravityTranscriptTokens(
      [
        JSON.stringify({
          step_index: 1,
          type: "PLANNER_RESPONSE",
          status: "DONE",
          created_at: "2026-11-02T15:00:05Z",
          input_tokens: 5_000,
          cache_read_tokens: 1_000,
          output_tokens: 100,
          tool_calls: [{ name: "call_mcp_tool", args: { ServerName: '"datadog"', ToolName: '"search_datadog_logs"' } }],
        }),
      ].join("\n"),
      { agentName: "agy-unit" },
    );
    expect(parsedMain.tokens.activeTokens).toBe(5_100);

    const agyAgent: AgentState = {
      name: "argon-agent",
      provider: "antigravity",
      model: "gemini-4-argon-high",
      status: "idle",
      dir: home,
      tmuxSession: "am-argon-agent",
      sessionId: mainSessionId,
      createdAt: "2026-11-02T15:00:00.000Z",
      updatedAt: "2026-11-02T15:01:00.000Z",
    };
    writeAgent(agyAgent);

    const report = collectAgentTokenUsage(agyAgent);
    expect(report.provider).toBe("antigravity");
    // Main: (12k + 300) + (2.5k + 200) = 15,000 active, 12,000 cacheRead
    expect(report.main.activeTokens).toBe(15_000);
    expect(report.main.cacheReadTokens).toBe(12_000);
    // Subagent: (9k + 400) + (1.5k + 250) = 11,150 active, 9,000 cacheRead
    expect(report.subagents).toHaveLength(1);
    expect(report.subagents[0]!.id).toBe(subSessionId);
    expect(report.subagents[0]!.label).toBe("Correctness Reviewer Subagent");
    expect(report.subagents[0]!.status).toBe("finished");
    expect(report.subagentTotals.activeTokens).toBe(11_150);
    expect(report.combined.activeTokens).toBe(26_150);
    expect(report.workflows.map((w) => w.workflow)).toContain("shepherd-pr");
    expect(report.workflows.map((w) => w.workflow)).toContain("review-gate");
  });
});
