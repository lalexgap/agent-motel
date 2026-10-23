import { existsSync } from "node:fs";
import { codexDaemonSocket } from "./codexDaemon";
import { loadConfig } from "./config";
import {
  claimAnswer,
  createPermission,
  listPermissions,
  resolvePending,
  type PermissionOption,
  type PermissionRecord,
} from "./permissions";
import { agentProvider, agentSessionId, listAgents } from "./state";
import { hasSession } from "./tmux";

// Codex approvals, answered through the app-server rather than the pane. The
// app-server sends a thread's approval requests to every connection
// subscribed to it, takes the first answer, and tells the rest
// (serverRequest/resolved) — so the daemon holds one connection, rejoins each
// daemon-attached agent's thread, records the requests it sees, and replies
// with Codex's own decision values when a client answers. The TUI keeps its
// prompt the whole time; whichever side answers first wins.

const COMMAND_APPROVAL = "item/commandExecution/requestApproval";
const FILE_CHANGE_APPROVAL = "item/fileChange/requestApproval";

type Decision = string | Record<string, unknown>;

function decisionOption(decision: Decision, index: number): PermissionOption | null {
  if (decision === "accept") return { id: "accept", label: "Yes, proceed", kind: "allow" };
  if (decision === "acceptForSession") return { id: "acceptForSession", label: "Yes, and don't ask again this session", kind: "allow_always" };
  if (decision === "decline") return { id: "decline", label: "No, continue without it", kind: "deny" };
  if (decision === "cancel") return { id: "cancel", label: "No, and tell Codex what to do differently", kind: "deny" };
  if (decision && typeof decision === "object") {
    const amendment = (decision as { acceptWithExecpolicyAmendment?: { execpolicy_amendment?: unknown } }).acceptWithExecpolicyAmendment;
    if (amendment) {
      const prefix = Array.isArray(amendment.execpolicy_amendment) ? amendment.execpolicy_amendment.join(" ") : "";
      return {
        id: "acceptWithExecpolicyAmendment",
        label: `Yes, and don't ask again for commands that start with \`${prefix}\``,
        kind: "allow_always",
      };
    }
    const network = (decision as { applyNetworkPolicyAmendment?: { network_policy_amendment?: { host?: string; action?: string } } })
      .applyNetworkPolicyAmendment?.network_policy_amendment;
    if (network) {
      const deny = network.action === "deny";
      return {
        id: `networkPolicy-${index}`,
        label: `${deny ? "No, and always block" : "Yes, and always allow"} network access to ${network.host ?? "this host"}`,
        kind: deny ? "deny" : "allow_always",
      };
    }
  }
  return null; // a decision am can't describe is left to the pane
}

// The request's own decisions when Codex lists them (availableDecisions),
// else only the one-off ones: a standing approval Codex didn't offer is never
// made up. Each option sends exactly the value Codex offered, so a persisted
// rule is Codex's own doing.
export function codexApprovalOptions(
  _method: string,
  params: Record<string, unknown>,
): { options: PermissionOption[]; decisions: Record<string, unknown> } {
  const available: Decision[] = Array.isArray(params.availableDecisions)
    ? (params.availableDecisions as Decision[])
    : ["accept", "decline", "cancel"];
  const options: PermissionOption[] = [];
  const decisions: Record<string, unknown> = {};
  available.forEach((decision, i) => {
    const option = decisionOption(decision, i);
    if (!option || option.id in decisions) return;
    options.push(option);
    decisions[option.id] = decision;
  });
  return { options, decisions };
}

function oneLine(text: string, max = 200): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? flat.slice(0, max - 1) + "…" : flat;
}

// `/bin/bash -lc 'touch x'` → `touch x`: Codex's parsed actions say what runs.
export function codexApprovalSummary(method: string, params: Record<string, unknown>, changedPaths: string[] = []): string {
  if (method === FILE_CHANGE_APPROVAL) {
    const what = changedPaths.length ? changedPaths.join(", ") : typeof params.reason === "string" ? params.reason : "file changes";
    return oneLine(`apply_patch: ${what}`);
  }
  const actions = Array.isArray(params.commandActions)
    ? (params.commandActions as { command?: unknown }[]).map((a) => a?.command).filter((c): c is string => typeof c === "string")
    : [];
  const command = actions.length ? actions.join(" && ") : typeof params.command === "string" ? params.command : "";
  const reason = typeof params.reason === "string" && params.reason ? ` (${params.reason})` : "";
  return oneLine(`Bash: ${command}${reason}`);
}

export interface CodexApprovalTarget {
  agent: string;
  threadId: string;
}

export function codexApprovalTargets(): CodexApprovalTarget[] {
  return listAgents()
    .filter((a) => agentProvider(a) === "codex" && a.codexDaemonAttached && a.status !== "exited")
    .filter((a) => !!agentSessionId(a) && hasSession(a.tmuxSession))
    .map((a) => ({ agent: a.name, threadId: agentSessionId(a)! }));
}

export interface CodexApprovalWatcherOptions {
  publish: (event: string, agent?: string) => void;
  log?: (message: string) => void;
  socket?: () => string;
  // Off while agents launch permissionless: their threads never ask.
  enabled?: () => boolean;
  targets?: () => CodexApprovalTarget[];
  syncMs?: number;
  pollMs?: number;
  // A thread whose policy never asks is rechecked this often.
  recheckMs?: number;
}

export interface CodexApprovalWatcher {
  stop(): void;
  // Run one subscription pass now (tests; also the timer's body).
  sync(): Promise<void>;
  // Hand answered requests back to Codex now (tests; also the poll's body).
  deliver(): void;
}

// Numbers each app-server connection, so an answer only ever goes back on the
// connection whose request it answers.
let connections = 0;

interface Connection {
  epoch: number;
  ws: WebSocket;
  call: (method: string, params: unknown) => Promise<any>;
  subscribed: Map<string, string>; // threadId → agent
  skipped: Map<string, number>; // threadId → when its policy said "never"
}

export function startCodexApprovalWatcher(opts: CodexApprovalWatcherOptions): CodexApprovalWatcher {
  const socket = opts.socket ?? codexDaemonSocket;
  const enabled = opts.enabled ?? (() => !loadConfig().skipPermissions);
  const targets = opts.targets ?? codexApprovalTargets;
  const log = opts.log ?? (() => undefined);
  const recheckMs = opts.recheckMs ?? 60_000;
  let conn: Connection | null = null;
  let connecting: Promise<Connection | null> | null = null;
  let syncing = false;
  let stopped = false;
  // fileChange approvals name no files; the item that precedes them does.
  const fileChanges = new Map<string, string[]>();

  const mine = (r: PermissionRecord) => r.provider === "codex" && r.pid === process.pid && !!r.codex;

  // Ends answers not yet handed back too: once Codex dropped the request (or
  // the connection it came on), nothing can deliver them.
  const staleWhere = (resolution: string, match: (r: PermissionRecord) => boolean) => {
    for (const record of listPermissions()) {
      if ((record.state !== "pending" && record.state !== "answered") || !mine(record) || !match(record)) continue;
      if (resolvePending(record.id, "stale", resolution, ["pending", "answered"])) opts.publish("permission-resolved", record.agent);
    }
  };

  const onRequest = (c: Connection, msg: { id: string | number; method: string; params?: Record<string, unknown> }) => {
    if (msg.method !== COMMAND_APPROVAL && msg.method !== FILE_CHANGE_APPROVAL) return; // the TUI answers the rest
    const params = msg.params ?? {};
    const threadId = typeof params.threadId === "string" ? params.threadId : "";
    const agent = c.subscribed.get(threadId);
    if (!agent) return;
    const paths = typeof params.itemId === "string" ? (fileChanges.get(params.itemId) ?? []) : [];
    const { options, decisions } = codexApprovalOptions(msg.method, params);
    if (options.length === 0) return;
    const startedAt = typeof params.startedAtMs === "number" ? new Date(params.startedAtMs).toISOString() : undefined;
    try {
      createPermission({
        agent,
        provider: "codex",
        tool: msg.method === FILE_CHANGE_APPROVAL ? "apply_patch" : "Bash",
        summary: codexApprovalSummary(msg.method, params, paths),
        input: paths.length ? { ...params, changes: paths } : params,
        options,
        decisions,
        ...(startedAt ? { createdAt: startedAt } : {}),
        expiresAt: null,
        pid: process.pid,
        codex: {
          threadId,
          requestId: msg.id,
          method: msg.method,
          ...(typeof params.turnId === "string" ? { turnId: params.turnId } : {}),
          connection: c.epoch,
        },
      });
      opts.publish("permission-request", agent);
    } catch (error) {
      log(`codex approval for ${agent} not recorded: ${error}`);
    }
  };

  const onNotification = (c: Connection, msg: { method: string; params?: Record<string, any> }) => {
    const p = msg.params ?? {};
    if (msg.method === "item/started" && p.item?.type === "fileChange" && typeof p.item.id === "string") {
      const changes = Array.isArray(p.item.changes) ? p.item.changes : [];
      fileChanges.set(p.item.id, changes.map((c: { path?: unknown }) => c?.path).filter((x: unknown): x is string => typeof x === "string"));
    } else if (msg.method === "item/completed" && typeof p.item?.id === "string") {
      fileChanges.delete(p.item.id);
    } else if (msg.method === "serverRequest/resolved") {
      staleWhere(
        "answered in the pane",
        (r) => r.codex!.connection === c.epoch && r.codex!.threadId === p.threadId && r.codex!.requestId === p.requestId,
      );
    } else if (msg.method === "turn/completed") {
      staleWhere("the turn ended", (r) => r.codex!.threadId === p.threadId);
    }
  };

  const connect = (): Promise<Connection | null> => {
    connecting ??= (async () => {
      const ws = new WebSocket(`ws+unix://${socket()}`);
      const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
      let nextId = 1;
      const c: Connection = {
        epoch: ++connections,
        ws,
        subscribed: new Map(),
        skipped: new Map(),
        call: (method, params) =>
          new Promise((resolve, reject) => {
            const id = nextId++;
            pending.set(id, { resolve, reject });
            try {
              ws.send(JSON.stringify({ id, method, params }));
            } catch (error) {
              pending.delete(id);
              reject(error as Error);
            }
          }),
      };
      ws.onmessage = (event) => {
        let msg: any;
        try {
          msg = JSON.parse(String(event.data));
        } catch {
          return;
        }
        if (msg && typeof msg.method === "string") {
          if (msg.id !== undefined && msg.id !== null) onRequest(c, msg);
          else onNotification(c, msg);
          return;
        }
        const p = typeof msg?.id === "number" ? pending.get(msg.id) : undefined;
        if (!p) return;
        pending.delete(msg.id);
        if (msg.error) p.reject(new Error(msg.error.message ?? "app-server error"));
        else p.resolve(msg.result);
      };
      ws.onclose = () => {
        for (const p of pending.values()) p.reject(new Error("app-server connection closed"));
        pending.clear();
        if (conn === c) conn = null;
        staleWhere("lost the codex app-server connection", (r) => r.codex!.connection === c.epoch);
      };
      try {
        await new Promise<void>((resolve, reject) => {
          ws.onopen = () => resolve();
          ws.onerror = () => reject(new Error("app-server connection failed"));
          setTimeout(() => reject(new Error("app-server connection timed out")), 5000);
        });
        await withTimeout(
          c.call("initialize", {
            clientInfo: { name: "agent-motel-approvals", title: null, version: "0" },
            capabilities: { experimentalApi: true, requestAttestation: false },
          }),
        );
        ws.send(JSON.stringify({ method: "initialized" }));
        return c;
      } catch (error) {
        log(`codex approvals: ${(error as Error).message}`);
        try {
          ws.close();
        } catch {
          // already closed
        }
        return null;
      }
    })().finally(() => {
      connecting = null;
    });
    return connecting;
  };

  const disconnect = () => {
    const c = conn;
    conn = null;
    if (c) {
      try {
        c.ws.close();
      } catch {
        // already closed
      }
    }
    staleWhere("codex approvals were turned off", () => true);
  };

  const sync = async () => {
    if (syncing || stopped) return;
    syncing = true;
    try {
      if (!enabled()) {
        if (conn) disconnect();
        return;
      }
      if (!conn) {
        if (!existsSync(socket())) return;
        conn = await connect();
        if (!conn || stopped) return;
      }
      const c = conn;
      const wanted = new Map(targets().map((t) => [t.threadId, t.agent]));
      for (const [threadId] of c.subscribed) {
        if (wanted.has(threadId)) continue;
        c.subscribed.delete(threadId);
        await withTimeout(c.call("thread/unsubscribe", { threadId })).catch(() => undefined);
        staleWhere("the agent is gone", (r) => r.codex!.threadId === threadId);
      }
      const fresh = [...wanted].filter(([threadId]) => {
        if (c.subscribed.has(threadId)) return false;
        const skippedAt = c.skipped.get(threadId);
        return skippedAt === undefined || Date.now() - skippedAt >= recheckMs;
      });
      if (fresh.length === 0) return;
      // Only rejoin threads the daemon already runs: resuming one it doesn't
      // would load it.
      const loaded = new Set(await loadedThreads(c));
      for (const [threadId, agent] of fresh) {
        if (!loaded.has(threadId)) continue;
        // Mapped first: requests already pending are replayed to a
        // connection as it rejoins, possibly ahead of the resume response.
        c.subscribed.set(threadId, agent);
        const resumed = await withTimeout(c.call("thread/resume", { threadId, excludeTurns: true })).catch((error) => {
          log(`codex approvals: rejoining ${agent}'s thread failed: ${(error as Error).message}`);
          return null;
        });
        if (resumed?.approvalPolicy === "never") {
          c.skipped.set(threadId, Date.now());
          await withTimeout(c.call("thread/unsubscribe", { threadId })).catch(() => undefined);
        }
        if (!resumed || resumed.approvalPolicy === "never") {
          c.subscribed.delete(threadId);
          continue;
        }
        c.skipped.delete(threadId);
      }
    } catch (error) {
      log(`codex approvals: ${(error as Error).message}`);
    } finally {
      syncing = false;
    }
  };

  // Hand each answered request back to Codex on the connection that saw it.
  // The send happens inside the claim, so a failed one is never "applied".
  const deliver = () => {
    const c = conn;
    if (!c || c.ws.readyState !== WebSocket.OPEN) return;
    for (const record of listPermissions()) {
      if (record.state !== "answered" || !mine(record) || record.codex!.connection !== c.epoch) continue;
      if (!c.subscribed.has(record.codex!.threadId)) continue;
      let attempted = false;
      claimAnswer(record.id, (r) => {
        attempted = true;
        try {
          c.ws.send(JSON.stringify({ id: r.codex!.requestId, result: { decision: r.decisions[r.optionId!] } }));
        } catch (error) {
          log(`codex approvals: answering ${r.agent} failed: ${error}`);
          throw error;
        }
      });
      if (attempted) opts.publish("permission-resolved", record.agent);
    }
  };

  const syncTimer = setInterval(() => void sync(), opts.syncMs ?? 2000);
  const pollTimer = setInterval(() => {
    try {
      deliver();
    } catch (error) {
      log(`codex approvals: ${error}`);
    }
  }, opts.pollMs ?? 200);
  void sync();

  return {
    sync,
    deliver,
    stop() {
      stopped = true;
      clearInterval(syncTimer);
      clearInterval(pollTimer);
      const c = conn;
      conn = null;
      if (c) {
        try {
          c.ws.close();
        } catch {
          // already closed
        }
      }
    },
  };
}

async function loadedThreads(c: Connection): Promise<string[]> {
  const ids: string[] = [];
  let cursor: string | null = null;
  do {
    const page: { data?: string[]; nextCursor?: string | null } = await withTimeout(
      c.call("thread/loaded/list", cursor ? { cursor } : {}),
    );
    ids.push(...(page?.data ?? []));
    cursor = page?.nextCursor ?? null;
  } while (cursor);
  return ids;
}

function withTimeout<T>(promise: Promise<T>, ms = 5000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("app-server timed out")), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}
