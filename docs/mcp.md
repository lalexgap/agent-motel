# An MCP server for `am`

Design doc for exposing the Agent Manager API as a Model Context Protocol (MCP)
server, so managed agents can call structured tools (`send_message`,
`spawn_agent`, `list_agents`, …) instead of shelling out to the `am` CLI.
**Draft for Alex to review before implementation. Nothing here is built yet.**

## 1. Goal & non-goals

### The honest framing

Today a managed agent talks to the fleet by shelling out to `am` (`am send`,
`am new`, `am run`, …). It knows how because every session is primed with a
block of CLI usage baked into `agentSystemPrompt` (`src/providers.ts`). That
works, but the seam is a shell command line, and it has two real costs:

1. **Shell-quoting mangling.** A message with backticks, quotes, `$`, or
   newlines gets chewed up by the shell. We already worked around this with
   `am send <name> -` (read body from stdin) and the primer literally tells
   agents to `printf '%s' "$msg" | am send <name> -` to dodge the shell. That's
   a workaround for a structural problem: the model is generating shell, not
   data.
2. **Discovery & correctness lives in prose.** The agent only knows the verbs,
   flags, and addressing rules because we pasted ~15 lines of CLI tutorial into
   every system prompt. Argument shapes aren't typed or validated; the model
   can mis-spell a flag and get a stderr message back instead of a structured
   error.

**MCP fixes the *send* side of that — and only that.** It turns "generate a
correct shell invocation" into "call a typed tool with a JSON argument object":
no shell, no quoting, schema-validated arguments, self-describing tool list the
model gets for free (no primer paste). That is a genuine ergonomic and
reliability win for *agents acting on the fleet*.

### What MCP does NOT fix

**MCP does not make agents read their messages automatically.** That problem —
"a peer sent me something, will I actually see it?" — is *already solved*, and
not by MCP:

- Inbound messages are typed into the agent's tmux pane (queue → `deliverNext`)
  and, as of the recently merged inbox-surfacing work, the **UserPromptSubmit /
  Stop hooks** inject unread peer messages into the agent's context at turn
  boundaries (commits `6796299` "Inbox surfacing", `db42098` "Stop-gate: agents
  don't go idle with unread peer messages"). The hooks are the proactive
  delivery path.
- MCP **resources** are *pull-only*. An MCP server cannot push a message into a
  Claude Code agent's context mid-turn (see §5 — `list_changed` refreshes the
  *list* of resources, it does not stream content, and Claude Code surfaces
  resource content only when the model explicitly fetches it). So an
  `inbox://unread` resource would only be read if the agent thought to read it —
  exactly the unreliability the hooks exist to eliminate.

So: **MCP is a better outbound interface, not a comms-reliability mechanism.**
We should not sell it as "agents will now reliably receive messages." They
already do, via hooks. MCP makes *sending* (and querying) cleaner.

### Goals

- Give managed agents a typed, shell-free way to **act on the fleet**:
  send/steer/interrupt messages, hand off files, spawn agents, query status.
- Eliminate the shell-quoting workarounds and shrink (or delete) the CLI
  tutorial in `agentSystemPrompt`.
- Reuse the existing `am` core (the functions behind the CLI), the existing
  fleet/outbox transport, and the existing attribution/rate-limit machinery —
  **no new delivery path, no new transport.**
- Coexist with the CLI and the HTTP API rather than replacing either.

### Non-goals

- **Not** a replacement for the hook-based inbound delivery. Hooks stay the
  proactive read path.
- **Not** a push channel into agent context. MCP cannot do that here (§5).
- **Not** a new network surface by default. The default deployment is local
  stdio per agent (§3); no new ports, no internet exposure.
- **Not** a human-facing UI. That's the PWA over the HTTP API (`am serve`).

## 2. What maps to tools vs. resources vs. prompts

MCP servers expose three kinds of primitive. The split matters:

- **Tools** = actions the model invokes (verbs). Surface as `mcp__am__<tool>`.
- **Resources** = context the model can *pull* on demand (nouns), referenced in
  Claude Code as `@am:<uri>`.
- **Prompts** = reusable templates, surfaced as `/mcp__am__<name>` slash
  commands (human-triggered, not model-triggered).

### Tools (the core of the value)

Each tool wraps an existing `am` operation. Names and argument schemas below;
all are thin adapters over the functions already in `src/commands/*` (§4).

| Tool | Wraps | Arguments | Notes |
|---|---|---|---|
| `send_message` | `sendCommand` | `to: string`, `text: string`, `mode?: "queue" \| "now" \| "interrupt"` (default `queue`) | The headline tool. `text` is a JSON string — **no shell quoting**. `mode:"now"` steers the current turn, `"interrupt"` aborts then sends. |
| `send_file` | `sendFileCommand` | `to: string`, `path: string`, `message?: string`, `mode?: "queue"\|"now"` | Ships a file to a peer's inbox (cross-machine via the existing scp path). |
| `spawn_agent` | `newCommand` | `name: string`, `task?: string`, `dir?: string`, `worktree?: string`, `codex?: boolean`, `report?: boolean`, `report_to?: string` | Fire-and-forget spawn (`jump:false, quiet:true`). Returns the new name. |
| `run_agent` | `runCommand` | `name: string`, `task: string`, `dir?: string`, `worktree?: string`, `codex?: boolean`, `timeout_sec?: number`, `rm?: boolean` | Spawn-wait-collect: blocks, returns the agent's final message. Maps to `am run`. Long-running → see progress notes below. |
| `list_agents` | `cachedFleetRows` / `lsCommand` | `local_only?: boolean` | Returns the merged local+remote fleet with status & queue depth. Also exposed as a resource (below); tool form is for the model that wants a snapshot inline. |
| `agent_status` | `agentDetail` (`server.ts`) | `name: string` | Detail for one agent: status, dir, task, queue, last pane snapshot. |
| `read_comms` | `commsFor` | `name: string`, `limit?: number` | Recent attributed messages to/from an agent (the `am comms` view). |
| `read_transcript` | `transcriptCommand` core | `name: string`, `full?: boolean` | Render a peer's conversation as markdown — useful before a handoff or to answer "what did X actually do?". Large; prefer the resource form for on-demand pulls. |
| `stop_agent` | `stopAgent` | `name: string` | Kill session, keep state. |
| `resume_agent` | `reviveAgent` | `name: string`, `message?: string` | Restart an exited agent. |
| `set_report_to` | `reportCommand` | `name: string`, `to?: string` (omit to clear) | Set/clear a standing report relationship. |

Argument conventions:

- `to` / `name` accept the same address grammar the CLI resolves: a bare name,
  an unambiguous prefix, or a fleet-qualified `host:name`. We reuse the exact
  resolver (`localMatch` / fleet routing), so behaviour is identical to the CLI
  including the outbox fallback for unreachable targets.
- Every tool returns a structured result: `{ ok, ...detail }` on success, and a
  proper MCP tool error (with the same message the CLI would print) on failure —
  so the model gets "agent X has no live session" as an error, not buried in
  stderr.

Deliberately **not** tools (kept CLI/PWA-only for now): `move` / `clone`
(fleet migration is an operator action with real footguns), `rm --clean`
(destructive worktree removal), `handoff` (composes spawn+transcript; can be
added later if agents need it), the daemon/serve/tunnel lifecycle commands, and
all `__`-prefixed internal verbs.

### Resources (pull-only context)

Resources let an agent *read* fleet state on demand without spending a tool
call's worth of arguments, and they're the natural home for large blobs:

| Resource URI | Content | Backed by |
|---|---|---|
| `am://fleet` | The full fleet list (local + remote), JSON | `cachedFleetRows` |
| `am://agent/{name}` | One agent's detail + queue + last pane | `agentDetail` |
| `am://agent/{name}/transcript` | Rendered conversation markdown | `transcript.ts` |
| `am://agent/{name}/comms` | Recent attributed messages | `commsFor` |
| `am://inbox` | This agent's own unread inbox + handed-off files | queue + `inboxDir` |

`am://inbox` is included for completeness, but see §5: it is **pull-only** and
therefore *not* a substitute for the hook-based proactive delivery. It's useful
for "let me re-read what I was sent," not for "make sure I see new mail."

`am://fleet` and `am://agent/{name}` can advertise `list_changed` /
`resources/updated` notifications so a client that re-reads them stays current —
but, again, that only refreshes a resource a model chooses to read (§5).

### Prompts (human-triggered slash commands)

Prompts surface in Claude Code as `/mcp__am__<name>`. These are for the
*operator* attached to an agent, not for autonomous use. Candidates:

- `/mcp__am__broadcast <text>` — template that expands to "send this to every
  agent reporting to me."
- `/mcp__am__status` — template that pulls `am://fleet` and asks for a summary.

Prompts are low priority — nice-to-have polish, not part of the core value.

## 3. Transport & deployment

### Recommendation: per-agent **stdio**, spawned by the provider

Each managed agent gets its own `am` MCP server, launched by Claude Code / Codex
over stdio as a child process — exactly the model Claude Code uses for local
servers. Concretely the server is a new CLI subcommand:

```
am mcp        # speak MCP over stdio (new entry in src/index.ts → src/mcp/server.ts)
```

Why stdio-per-agent over one shared server:

1. **Free, correct attribution.** The stdio child inherits the tmux session's
   environment, which already carries `AGENTMGR_AGENT=<name>` (set in
   `agentEnv`, `src/commands/new.ts`). So `send_message` resolves its sender the
   same way the CLI does (`resolveSender` reads `AGENTMGR_AGENT`) — **no token,
   no per-call `--from`, no way for agent A to impersonate B.** A shared HTTP
   server would have to authenticate *and* identify the caller on every request;
   here identity is ambient and unspoofable.
2. **No new network surface.** Stdio is a pipe between two local processes owned
   by the same user. Nothing binds a port; nothing is exposed. This is the
   safest possible default and needs zero deployment config.
3. **Reuses the process model we already have.** It's another `am` subcommand,
   launched alongside the agent the same way the hook settings are — see wiring
   below. The server process lives and dies with the agent.

The cost is one extra short-lived `bun` process per agent. That's negligible
next to a `claude`/`codex` session, and it's only spawned when the agent
actually has MCP configured.

### Wiring it into am-spawned agents

This is the concrete `src/settings.ts` extension. Today `settings.ts` writes
`hook-settings.json` and `providers.ts` passes it via `claude --settings`. We
add a parallel **generated MCP config** and pass it via the dedicated flag
(confirmed present: `claude --mcp-config <configs...>` and `--strict-mcp-config`).

**Claude:** add a `buildMcpConfig()` / `writeMcpConfig()` to `settings.ts`:

```jsonc
// ~/.agent-manager/mcp-config.json  (generated, like hook-settings.json)
{
  "mcpServers": {
    "am": {
      "type": "stdio",
      "command": "<process.execPath>",          // the bun binary
      "args": ["<cliEntrypoint()>", "mcp"]       // src/index.ts mcp
    }
  }
}
```

Then in `claudeCommand` (`src/providers.ts`), alongside `--settings`:

```
"--mcp-config", writeMcpConfig(),
```

No env block is needed in the config — the stdio child inherits
`AGENTMGR_AGENT` from the tmux session. Because managed agents already launch
with `--dangerously-skip-permissions` (`permissionArgs`), the `mcp__am__*`
tools are auto-allowed with **no permission prompt** (and if a user flips
`skipPermissions:false`, we'd allow-list `mcp__am__*` in the hook settings'
`permissions.allow`).

**Codex:** Codex can't take a per-launch MCP flag any more than it can take a
hooks flag — its MCP servers live in `~/.codex/config.toml` under
`[mcp_servers.am]`. So we mirror the existing `ensureCodexHooks()` pattern
(`src/codexHooks.ts`): an `ensureCodexMcp()` that idempotently installs an
`[mcp_servers.am]` block (guarded/inert in the user's own sessions the same way
the hooks block is). Same first-launch trust prompt caveat already documented
for Codex hooks applies.

**Opt-out:** a `config.mcp` flag (default… see open questions) and/or
`am new --no-mcp` to skip writing the config for an agent.

### Auth

- **stdio (default): none needed.** Local pipe, same user, ambient identity.
- **If we ever expose MCP over HTTP** (not recommended for v1): reuse the
  existing api-token (`loadOrCreateApiToken`, `server.ts`) as a bearer header,
  exactly as the PWA does. Claude Code supports `headers.Authorization: Bearer
  <token>` in `.mcp.json`. But HTTP loses the ambient-attribution property, so
  we'd then need a per-agent identity scheme — a real cost. Keep it stdio.

### Cross-machine implications

**The MCP server only ever talks to the *local* `am`.** It calls the same
in-process functions the CLI calls, which already do fleet resolution and
store-and-forward:

- `send_message` to a remote agent → `sendCommand` → `localMatch` misses →
  `outboxFallback` (or, if the target host is reachable and configured, the CLI
  path forwards over ssh). The MCP server inherits all of this for free because
  it *is* the same code.
- There is **no remote MCP transport** and we don't want one. An agent on a
  server reaches an agent on the laptop the same way `am send` does today: via
  the fleet forward or the outbox relay. MCP is purely the local agent's
  *interface*; the existing transport moves the bytes.

One subtlety to preserve: the CLI's `maybeForwardToFleet` (in `index.ts`) does
fleet routing *before* dispatch. The MCP `send_message` handler must route
through the **same** resolution (extract the shared resolver, see §4) so a
`host:name` argument behaves identically whether it came from the CLI or MCP.

## 4. Coexistence with the CLI and HTTP API

Right now there are two interfaces over the same operations:

- **CLI** (`src/index.ts` → `src/commands/*`) — for humans and (today) agents.
- **HTTP API** (`src/server.ts`) — for the phone PWA; it *already* imports and
  calls the command functions directly (`sendCommand`, `newCommand`,
  `stopAgent`, `reviveAgent`, `agentDetail`).

MCP becomes a **third thin adapter over the same core — not a wrapper around the
CLI or the HTTP API.** The HTTP API has already shown the pattern: it doesn't
shell out to `am`, it calls the functions. MCP does the same.

```
            ┌─────────── core operations ───────────┐
            │ sendCommand, newCommand, runCommand,   │
            │ stopAgent, reviveAgent, reportCommand, │
            │ commsFor, agentDetail, cachedFleetRows │
            └───┬───────────────┬───────────────┬────┘
                │               │               │
            CLI (index.ts)  HTTP (server.ts)  MCP (mcp/server.ts)
            humans + shell  phone PWA          managed agents
```

To make this clean (and to avoid MCP/HTTP drifting apart), the small amount of
glue that currently lives *inside* `index.ts` should be factored out so all
three adapters share it:

- **Fleet address resolution** (`maybeForwardToFleet` logic) — extract a
  `resolveTarget(ref): { host?, name }` used by CLI, HTTP, and MCP so routing is
  identical everywhere. (The HTTP API today is actually local-only for sends —
  MCP gives us a reason to finally share the resolver.)
- The command functions are already adapter-agnostic (they take plain args and
  `opts`), so most tools are a 5-line schema + a call.

Reuse, not duplication: MCP adds `src/mcp/` (server bootstrap + tool/resource
registry) and **no** new business logic. If a behaviour needs changing
(attribution, rate limiting, outbox), it changes once in the core and all three
interfaces inherit it.

A note on the CLI primer: once `send_message` / `spawn_agent` exist as tools,
the big CLI tutorial in `agentSystemPrompt` can shrink to a couple of lines
("you have `am` MCP tools for talking to the fleet; here's the addressing rule
for `to`"). The etiquette block (what `[am · from X]` means, don't relay, reply
by pasting the address) **stays** — that's about *received* messages, which
still arrive via the hook/tmux path, not MCP. We'd keep the CLI primer as a
fallback for agents launched without MCP.

## 5. Could resource-update notifications push inbox messages to agents?

Short answer: **no — not in a way that replaces the hooks.** This is the section
that keeps us honest.

What the MCP spec offers for "server pushes to client":
- `notifications/resources/list_changed` — "the set of resources changed."
- `notifications/resources/updated` — "this subscribed resource's content
  changed" (requires the client to have `subscribe`d).

What Claude Code actually does with these (from the docs + the research for this
doc):
- Claude Code **does** honour `list_changed` for tools/prompts/resources: it
  refreshes *what is available* from a server without a reconnect. That updates
  the *menu*, not the conversation.
- Resources are **fetched on demand** when the model (or user via `@am:…`)
  references them. There is **no documented mechanism by which an MCP server
  injects resource *content* into an in-progress agent turn unprompted.** The
  docs do not describe Claude Code subscribing to per-resource `updated`
  notifications and surfacing the new content to the model proactively.

So even in the best case, an `am://inbox` resource with `updated` notifications
would, at most, cause a *client that chose to re-read it* to see fresh content.
It cannot interrupt the model and say "you have mail." That is precisely the
gap the **hooks** close:

| Mechanism | Proactive? | Surfaces into model context without the agent asking? |
|---|---|---|
| UserPromptSubmit / Stop hooks (shipped) | **Yes** | **Yes** — injects unread peer messages at turn boundaries; the Stop-gate even keeps the agent from going idle with unread mail. |
| tmux `deliverNext` (queue) | Yes | Yes — types the message straight into the pane. |
| MCP `am://inbox` resource | No | No — pull-only; only seen if the model fetches it. |
| MCP `resources/updated` notification | Refreshes listing only | No content push to the model mid-turn (per Claude Code's documented behaviour). |

**Conclusion:** keep inbound delivery on the hook + tmux path. Offer
`am://inbox` purely as an on-demand "re-read my mail" convenience, and document
it as *not* a delivery guarantee. If we want better *online* push later, the
already-planned `am __mail-stream` long-poll (see
`docs/messaging-redesign.md` §Phase 3) is the right lever — not MCP resources.

(Caveat: Claude Code's MCP behaviour here is from current docs + testing notes;
if a future version surfaces `resources/updated` content proactively, revisit
this — but we should not design v1 assuming it.)

## 6. Phased implementation plan + open questions

Each phase keeps `bunx tsc --noEmit` and `bun test` green and is independently
shippable. The SDK is the official `@modelcontextprotocol/sdk` (TypeScript),
which runs fine under Bun.

**Phase 0 — core refactor (no MCP yet).**
- Extract `resolveTarget(ref)` from `index.ts`'s `maybeForwardToFleet` so CLI,
  HTTP, and a future MCP server share one resolver.
- Confirm the command functions are cleanly callable out-of-band (the HTTP API
  already proves most of them are).
- Tests: resolver parity with current CLI routing.

**Phase 1 — stdio MCP server, send-side tools.**
- `src/mcp/server.ts`: bootstrap the SDK over stdio; `am mcp` subcommand in
  `index.ts`.
- Tools: `send_message`, `send_file`, `list_agents`, `agent_status`,
  `read_comms`. (The highest-value, lowest-risk set — all are read or
  send-through-existing-machinery.)
- Tests: schema validation, sender attribution via `AGENTMGR_AGENT`, error
  mapping (no-session → MCP error), rate-limit drop surfaces as a tool result.

**Phase 2 — wiring into spawned agents.**
- `src/settings.ts`: `buildMcpConfig()` / `writeMcpConfig()`.
- `src/providers.ts`: pass `--mcp-config` for Claude; trim the CLI tutorial in
  `agentSystemPrompt` (keep the etiquette block); keep the full primer as the
  no-MCP fallback.
- `src/codexHooks.ts` sibling `ensureCodexMcp()` for the `[mcp_servers.am]`
  block; `am new --no-mcp` + `config.mcp` opt-out.
- Tests: generated config shape; Claude launch includes `--mcp-config`; codex
  config install is idempotent and inert outside managed sessions.

**Phase 3 — spawn/lifecycle + resources.**
- Tools: `spawn_agent`, `run_agent`, `stop_agent`, `resume_agent`,
  `set_report_to`.
- Resources: `am://fleet`, `am://agent/{name}`, `…/transcript`, `…/comms`,
  `am://inbox` (documented pull-only).
- Decide `run_agent` ergonomics under MCP's request model (it blocks for up to
  `timeout_sec`; consider MCP progress notifications or lean on the experimental
  Tasks primitive — see open questions).

**Phase 4 — polish (optional).**
- Prompts (`/mcp__am__*`).
- `list_changed` / `resources/updated` wiring for `am://fleet` (listing refresh
  only — explicitly not a push channel).

### Open questions for Alex

1. **Default on or opt-in?** Should am-spawned agents get the MCP server by
   default (`config.mcp: true`), or is it opt-in (`am new --mcp`) until it's
   proven? I lean **default-on for Claude, opt-in for Codex** (Codex's persistent
   config-toml install + trust prompt is more intrusive).
2. **Keep the CLI primer too, or fully replace it?** Recommendation: keep a
   trimmed CLI primer as a fallback (agents without MCP, and `am` from the shell
   is still useful for piping). MCP augments, doesn't delete, the CLI.
3. **`run_agent` and long blocking.** `am run` can block for minutes. Under MCP
   that's a long tool call. Options: (a) just block (simplest, relies on client
   timeout config), (b) MCP progress notifications, (c) the experimental Tasks
   primitive for deferred retrieval. Which appetite?
4. **Scope of spawn from MCP.** Are we comfortable letting an agent
   `spawn_agent` / `run_agent` via a typed tool (it can already do this by
   shelling `am new`)? Same capability, cleaner surface — but worth an explicit
   yes. Destructive ops (`rm --clean`, `move`) stay out regardless.
5. **One server name or namespaced?** Single `am` server (tools
   `mcp__am__send_message`, …) — confirmed fine. Any reason to split read vs.
   write servers? I don't think so.
6. **Do we want the HTTP API to *also* expose MCP** (streamable-HTTP) for the
   phone/remote case? My recommendation is no for v1 — it reintroduces auth +
   identity problems that stdio gives us for free, and the PWA already has the
   REST API. Flag it only if there's demand for driving the fleet from an
   external MCP host.

---

## 7. Implementation status (branch `am/mcp-server`)

Built on this branch (tsc + bun test green; smoked over stdio):

**Phase 0 — shared resolver.** `src/route.ts` `resolveTarget(ref)` → `local | remote | none`, extracted from `index.ts`'s `maybeForwardToFleet` (which now delegates to it). CLI, and now MCP, route identically.

**Phase 1–3 — the `am mcp` stdio server** (`src/mcp/server.ts`, wired as `am mcp` in `index.ts`):
- Tools: `send_message`, `send_file`, `list_agents`, `agent_status`, `read_comms`, `spawn_agent`, `run_agent`, `stop_agent`, `resume_agent`, `set_report_to` — thin adapters over the existing core functions. Sender attribution is ambient (`AGENTMGR_AGENT` inherited over stdio). Remote targets forward over ssh; unreachable fall to the outbox — same routing as the CLI. `console.log` is muted to stderr so command-function output can't corrupt the JSON-RPC stream.
- Resources: `am://fleet`, `am://inbox` (pull-only).
- Wiring: `settings.ts` `buildMcpConfig`/`writeMcpConfig`; `providers.ts` passes `--mcp-config` for claude when `config.mcp` (default on; `am new --no-mcp` opts out). With `--dangerously-skip-permissions` the `mcp__am__*` tools need no prompt.

**The channel layer (the convergence).** The same server doubles as a Claude Code **channel** (§5 said MCP resources can't push; the *channel* notification can):
- Declares `experimental: { 'claude/channel': {} }` + instructions; inert unless launched as a channel.
- When `config.channels` is on, `providers.ts` adds `--dangerously-load-development-channels server:am`, and the server runs a queue-watcher (`startChannelWatcher`) that drains the agent's own queue and emits `notifications/claude/channel` per peer message — native inbound push, no tmux keystrokes.
- **Coordination** (`src/channel.ts`): the watcher heartbeats a per-agent marker; `deliverNext` and the inbox hooks (`surfaceInbox`/`stopGate`) stand down for an agent with a fresh marker, so there's no double-delivery. A stale marker (channel crashed) lets tmux/hook delivery resume — graceful fallback.

**Defaults:** `mcp: true` (Claude gets the tools), `channels: false` (opt-in — it needs claude.ai login + Claude Code ≥2.1.80 + org enablement + the research-preview dev flag). Codex is unaffected and keeps the tmux/hook inbound path.

**Deliberately not done (follow-ups):** trimming the CLI tutorial in `agentSystemPrompt` (kept as-is; MCP is additive); `ensureCodexMcp()` for Codex MCP tools; permission relay; the templated `am://agent/{name}` resource; `run_agent` progress notifications.
