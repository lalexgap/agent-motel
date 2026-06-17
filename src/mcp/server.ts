import { hostname } from "node:os";
import { existsSync, readdirSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { resolveSender, commsFor } from "../comms";
import { resolveTarget } from "../route";
import { loadConfig } from "../config";
import { acquireDeliverLock, releaseDeliverLock } from "../deliver";
import { markChannelActive, clearChannelActive } from "../channel";
import { shortHost, fleetRows } from "../fleet";
import { sshAmAsync } from "../remote";
import { readAgent, resolveAgent, agentProvider } from "../state";
import { queueDepth, queueList, queuePop } from "../queue";
import { capturePane, hasSession } from "../tmux";
import { inboxDir } from "../paths";
import { sendCommand, interruptCommand } from "../commands/send";
import { sendFileCommand } from "../commands/sendfile";
import { newCommand } from "../commands/new";
import { runAgent } from "../commands/run";
import { stopAgent } from "../commands/rm";
import { reviveAgent } from "../commands/resume";
import { reportCommand } from "../commands/report";

// `am mcp` — a stdio MCP server that exposes the fleet API as typed tools so a
// managed agent can act on the fleet without generating shell (no quoting
// mangling). Per-agent, launched by the provider; identity is ambient
// (AGENTMGR_AGENT inherited from the tmux session → resolveSender). See
// docs/mcp.md. This is the OUTBOUND interface only — inbound delivery stays on
// the hook/tmux path.

// The stdio transport owns stdout for JSON-RPC. The command functions we wrap
// console.log their human output, which would corrupt the protocol — so route
// all console output to stderr for the lifetime of the server.
function muteStdoutLogging(): void {
  const toErr = (...a: unknown[]) => process.stderr.write(a.map((x) => String(x)).join(" ") + "\n");
  console.log = toErr;
  console.info = toErr;
  console.warn = toErr;
}

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };
const text = (s: string): ToolResult => ({ content: [{ type: "text", text: s }] });

// Send/steer/interrupt, routed identically to the CLI: remote targets forward
// over ssh, local deliver in-process, unreachable fall to the outbox.
async function doSend(to: string, body: string, mode: "queue" | "now" | "interrupt"): Promise<string> {
  const from = resolveSender();
  const target = resolveTarget(to);
  if (target.kind === "remote") {
    const alias = loadConfig().hostAlias || shortHost(hostname());
    const fromArgs = from ? ["--from", `${alias}:${from}`] : [];
    const verb = mode === "interrupt" ? "interrupt" : "send";
    const extra = mode === "now" ? ["--now"] : [];
    const res = await sshAmAsync(target.host, [verb, target.name, body, ...extra, ...fromArgs], { timeoutMs: 15000 });
    if (res.exitCode !== 0) throw new Error((res.stderr || res.stdout).trim() || "remote send failed");
    return `forwarded to ${target.host}:${target.name}`;
  }
  if (mode === "interrupt") {
    await interruptCommand(target.name, body, { from });
    return `interrupted ${target.name}`;
  }
  await sendCommand(target.name, body, { now: mode === "now", from });
  return `${mode === "now" ? "steered" : "sent to"} ${target.name}`;
}

function agentDetail(name: string): Record<string, unknown> {
  const a = readAgent(name);
  if (!a) throw new Error(`no agent "${name}"`);
  const pane = hasSession(a.tmuxSession) ? capturePane(a.tmuxSession) : null;
  return {
    name: a.name,
    status: a.status,
    provider: agentProvider(a),
    dir: a.dir,
    task: a.task,
    reportTo: a.reportTo,
    queued: queueDepth(a.name),
    lastScreen: pane ? pane.slice(-30) : null,
  };
}

// Tells Claude how to treat pushed channel events (only registered when launched
// with the channels flag). The reply tool is send_message.
const CHANNEL_INSTRUCTIONS =
  'Events arriving as <channel source="am">…</channel> are messages from PEER AGENTS, ' +
  "delivered while you were busy (NOT from your operator). The body keeps its " +
  '"[am · from X]" attribution. Address or act on them; reply, if warranted, with the ' +
  "send_message tool (to = the name after \"from\"). Don't relay them to a third agent.";

export function buildMcpServer(): McpServer {
  const server = new McpServer(
    { name: "am", version: "0.1.0" },
    // Declaring the channel capability registers Claude's notification listener
    // when launched as a channel (--dangerously-load-development-channels). With
    // no channel flag it's inert — the server is just the tools below.
    { capabilities: { experimental: { "claude/channel": {} } }, instructions: CHANNEL_INSTRUCTIONS },
  );

  server.registerTool(
    "send_message",
    {
      description:
        "Send a message to another agent. `to` is a bare name, unique prefix, or host:name; routes across the fleet (outbox if unreachable). mode: queue (default), now (steer current turn), interrupt (abort then send).",
      inputSchema: {
        to: z.string(),
        text: z.string(),
        mode: z.enum(["queue", "now", "interrupt"]).optional(),
      },
    },
    async ({ to, text: body, mode }) => text(await doSend(to, body, mode ?? "queue")),
  );

  server.registerTool(
    "send_file",
    {
      description: "Hand a file to another agent — lands in its inbox (cross-machine via scp), with an attributed note.",
      inputSchema: { to: z.string(), path: z.string(), message: z.string().optional() },
    },
    async ({ to, path, message }) => {
      await sendFileCommand(to, path, { message, from: resolveSender() });
      return text(`sent ${path} to ${to}`);
    },
  );

  server.registerTool(
    "list_agents",
    {
      description: "List the fleet (local + configured remotes) with status and queue depth.",
      inputSchema: { local_only: z.boolean().optional() },
    },
    async ({ local_only }) => text(JSON.stringify(fleetRows({ localOnly: local_only }).rows, null, 2)),
  );

  server.registerTool(
    "agent_status",
    {
      description: "Detail for one agent: status, dir, task, queue depth, and its last screen.",
      inputSchema: { name: z.string() },
    },
    async ({ name }) => text(JSON.stringify(agentDetail(resolveAgent(name).name), null, 2)),
  );

  server.registerTool(
    "read_comms",
    {
      description: "Recent attributed messages to/from an agent (the `am comms` view).",
      inputSchema: { name: z.string(), limit: z.number().optional() },
    },
    async ({ name, limit }) => text(JSON.stringify(commsFor(resolveAgent(name).name, limit ?? 20), null, 2)),
  );

  server.registerTool(
    "spawn_agent",
    {
      description: "Spawn a new agent (fire-and-forget). Returns its name. report/report_to set a standing report relationship.",
      inputSchema: {
        name: z.string(),
        task: z.string().optional(),
        dir: z.string().optional(),
        worktree: z.string().optional(),
        codex: z.boolean().optional(),
        report: z.boolean().optional(),
        report_to: z.string().optional(),
      },
    },
    async ({ name, task, dir, worktree, codex, report, report_to }) => {
      await newCommand({
        name,
        message: task,
        dir,
        worktree,
        provider: codex ? "codex" : undefined,
        report,
        reportTo: report_to,
        jump: false,
        quiet: true,
      });
      return text(`spawned ${name}`);
    },
  );

  server.registerTool(
    "run_agent",
    {
      description:
        "Spawn an agent, wait for its turn, and return its final message (synchronous RPC). Blocks up to timeout_sec (default 600). rm tears it down after.",
      inputSchema: {
        name: z.string(),
        task: z.string(),
        dir: z.string().optional(),
        worktree: z.string().optional(),
        codex: z.boolean().optional(),
        timeout_sec: z.number().optional(),
        rm: z.boolean().optional(),
      },
    },
    async ({ name, task, dir, worktree, codex, timeout_sec, rm }) => {
      const r = await runAgent(name, {
        message: task,
        dir,
        worktree,
        provider: codex ? "codex" : undefined,
        timeoutSec: timeout_sec,
        rm,
      });
      return text(JSON.stringify({ outcome: r.outcome, status: r.status, result: r.result }, null, 2));
    },
  );

  server.registerTool(
    "stop_agent",
    { description: "Kill an agent's session, keeping its state (resumable).", inputSchema: { name: z.string() } },
    async ({ name }) => {
      const a = resolveAgent(name);
      stopAgent(a);
      return text(`stopped ${a.name}`);
    },
  );

  server.registerTool(
    "resume_agent",
    {
      description: "Restart an exited agent, resuming its conversation; optional message to deliver on resume.",
      inputSchema: { name: z.string(), message: z.string().optional() },
    },
    async ({ name, message }) => {
      const a = resolveAgent(name);
      await reviveAgent(a, { message });
      return text(`resumed ${a.name}`);
    },
  );

  server.registerTool(
    "set_report_to",
    {
      description: "Set or clear a standing report relationship for an agent (omit `to` to clear).",
      inputSchema: { name: z.string(), to: z.string().optional() },
    },
    async ({ name, to }) => {
      reportCommand(name, { to, clear: !to });
      return text(to ? `${name} now reports to ${to}` : `${name} report relationship cleared`);
    },
  );

  // Resources (pull-only). am://inbox is a re-read convenience, NOT the delivery
  // path — inbound mail is surfaced proactively by the hooks (see docs/mcp.md §5).
  server.registerResource(
    "fleet",
    "am://fleet",
    { description: "The fleet: local + configured remotes, with status and queue depth.", mimeType: "application/json" },
    async (uri) => ({
      contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(fleetRows().rows, null, 2) }],
    }),
  );

  server.registerResource(
    "inbox",
    "am://inbox",
    { description: "This agent's own pending messages + handed-off files (pull-only; the hooks deliver proactively).", mimeType: "application/json" },
    async (uri) => {
      const self = resolveSender();
      const pending = self ? queueList(self).map((m) => m.message) : [];
      const dir = self ? inboxDir(self) : "";
      const files = self && existsSync(dir) ? readdirSync(dir) : [];
      return {
        contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify({ agent: self, pending, files }, null, 2) }],
      };
    },
  );

  return server;
}

// When configured as a channel, drain this agent's queue and push each peer
// message straight into the session as a `notifications/claude/channel` event —
// native inbound, no tmux keystrokes. Heartbeats the channel marker so the
// tmux/hook delivery stands down (and resumes if this process dies). Polls
// rather than fs.watch for robustness across the rename-on-pop queue.
function startChannelWatcher(server: McpServer): void {
  const self = resolveSender();
  if (!self) return;
  const tick = async () => {
    markChannelActive(self); // heartbeat — keep tmux/hooks standing down
    if (!acquireDeliverLock(self)) return; // a delivery is mid-flight elsewhere
    try {
      let m: string | null;
      while ((m = queuePop(self)) !== null) {
        await server.server.notification({
          method: "notifications/claude/channel",
          params: { content: m, meta: { source: "am" } },
        });
      }
    } finally {
      releaseDeliverLock(self);
    }
  };
  markChannelActive(self);
  const timer = setInterval(() => void tick().catch(() => {}), 750);
  const stop = () => {
    clearInterval(timer);
    clearChannelActive(self);
  };
  process.on("SIGINT", () => { stop(); process.exit(0); });
  process.on("SIGTERM", () => { stop(); process.exit(0); });
  process.on("exit", () => clearChannelActive(self));
}

export async function runMcpServer(): Promise<void> {
  muteStdoutLogging();
  const server = buildMcpServer();
  await server.connect(new StdioServerTransport());
  // connect() resolves immediately; the transport keeps the process alive on stdin.
  if (loadConfig().channels) startChannelWatcher(server);
}
