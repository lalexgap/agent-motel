import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerWebSocket } from "bun";
import { ensureDirs } from "../src/paths";
import {
  codexApprovalOptions,
  codexApprovalSummary,
  startCodexApprovalWatcher,
  type CodexApprovalWatcher,
} from "../src/codexApprovals";
import { answerPermission, listPermissions, readPermission } from "../src/permissions";

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "am-codex-approvals-"));
  process.env.AGENTMGR_HOME = home;
  ensureDirs();
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  delete process.env.AGENTMGR_HOME;
});

const AVAILABLE = ["accept", { acceptWithExecpolicyAmendment: { execpolicy_amendment: ["touch", "x"] } }, "cancel"];

const commandParams = (threadId: string, extra: Record<string, unknown> = {}) => ({
  kind: "command", threadId, turnId: "turn-1", itemId: "exec-1", startedAtMs: 1_700_000_000_000,
  command: "/bin/bash -lc 'touch x'", cwd: "/w", commandActions: [{ type: "unknown", command: "touch x" }],
  proposedExecpolicyAmendment: ["touch", "x"], availableDecisions: AVAILABLE, ...extra,
});

describe("codex decision options", () => {
  test("offered decisions pass through as options, each sending its own value", () => {
    const { options, decisions } = codexApprovalOptions("item/commandExecution/requestApproval", commandParams("t"));
    expect(options).toEqual([
      { id: "accept", label: "Yes, proceed", kind: "allow" },
      { id: "acceptWithExecpolicyAmendment", label: "Yes, and don't ask again for commands that start with `touch x`", kind: "allow_always" },
      { id: "cancel", label: "No, and tell Codex what to do differently", kind: "deny" },
    ]);
    expect(decisions.acceptWithExecpolicyAmendment).toEqual(AVAILABLE[1]);
    expect(decisions.accept).toBe("accept");
  });

  test("network amendments; unknown decisions are left to the pane; defaults per method", () => {
    const { options, decisions } = codexApprovalOptions("item/commandExecution/requestApproval", {
      availableDecisions: [
        { applyNetworkPolicyAmendment: { network_policy_amendment: { host: "example.com", action: "allow" } } },
        { applyNetworkPolicyAmendment: { network_policy_amendment: { host: "evil.com", action: "deny" } } },
        { somethingNew: {} },
        "decline",
      ],
    });
    expect(options).toEqual([
      { id: "networkPolicy-0", label: "Yes, and always allow network access to example.com", kind: "allow_always" },
      { id: "networkPolicy-1", label: "No, and always block network access to evil.com", kind: "deny" },
      { id: "decline", label: "No, continue without it", kind: "deny" },
    ]);
    expect(Object.keys(decisions)).toEqual(["networkPolicy-0", "networkPolicy-1", "decline"]);
    // Without availableDecisions, only one-off decisions: no standing
    // approval Codex didn't offer.
    expect(codexApprovalOptions("item/fileChange/requestApproval", {}).options.map((o) => o.id)).toEqual([
      "accept", "decline", "cancel",
    ]);
    expect(
      codexApprovalOptions("item/commandExecution/requestApproval", { proposedExecpolicyAmendment: ["touch", "x"] }).options.map((o) => o.id),
    ).toEqual(["accept", "decline", "cancel"]);
  });

  test("summaries", () => {
    expect(codexApprovalSummary("item/commandExecution/requestApproval", commandParams("t", { reason: "needs write" }))).toBe("Bash: touch x (needs write)");
    expect(codexApprovalSummary("item/commandExecution/requestApproval", { command: "ls -la" })).toBe("Bash: ls -la");
    expect(codexApprovalSummary("item/fileChange/requestApproval", {}, ["a.ts", "b.ts"])).toBe("apply_patch: a.ts, b.ts");
  });
});

describe("the daemon's app-server connection", () => {
  let server: ReturnType<typeof Bun.serve> | undefined;
  let client: ServerWebSocket<unknown> | undefined;
  let watcher: CodexApprovalWatcher | undefined;
  let received: any[];

  afterEach(() => {
    watcher?.stop();
    server?.stop(true);
    watcher = undefined;
    server = undefined;
    client = undefined;
  });

  function fakeAppServer(socket: string) {
    received = [];
    server = Bun.serve({
      unix: socket,
      fetch(req, srv) {
        return srv.upgrade(req, { data: undefined }) ? undefined : new Response("no", { status: 400 });
      },
      websocket: {
        open(ws) {
          client = ws;
        },
        message(ws, data) {
          const msg = JSON.parse(String(data));
          received.push(msg);
          if (msg.method === undefined || msg.id === undefined) return; // notifications, our replies
          const reply = (result: unknown) => ws.send(JSON.stringify({ id: msg.id, result }));
          if (msg.method === "thread/loaded/list") reply({ data: ["t1", "t2"], nextCursor: null });
          else if (msg.method === "thread/resume") reply({ approvalPolicy: msg.params.threadId === "t2" ? "never" : "on-request" });
          else reply({});
        },
      },
    });
  }

  const send = (msg: unknown) => client!.send(JSON.stringify(msg));
  async function until<T>(fn: () => T | undefined | null | false, what: string): Promise<T> {
    for (let i = 0; i < 200; i++) {
      const value = fn();
      if (value) return value;
      await Bun.sleep(20);
    }
    throw new Error(`timed out waiting for ${what}`);
  }

  test("records approvals, answers with Codex's value, and retires ones answered elsewhere", async () => {
    const socket = join(home, "app-server.sock");
    fakeAppServer(socket);
    const events: [string, string | undefined][] = [];
    watcher = startCodexApprovalWatcher({
      publish: (event, agent) => events.push([event, agent]),
      socket: () => socket,
      enabled: () => true,
      targets: () => [{ agent: "api", threadId: "t1" }, { agent: "web", threadId: "t2" }, { agent: "cold", threadId: "t9" }],
      syncMs: 60_000,
      pollMs: 20,
    });
    await until(() => received.some((m) => m.method === "thread/resume" && m.params.threadId === "t1"), "rejoin");
    await until(() => received.some((m) => m.method === "thread/unsubscribe" && m.params.threadId === "t2"), "never-policy unsubscribe");
    // A thread the daemon doesn't run isn't loaded by a rejoin.
    expect(received.some((m) => m.method === "thread/resume" && m.params.threadId === "t9")).toBe(false);

    send({ id: 7, method: "item/commandExecution/requestApproval", params: commandParams("t1") });
    send({ id: 8, method: "item/tool/requestUserInput", params: { threadId: "t1" } });
    send({ id: 9, method: "item/commandExecution/requestApproval", params: commandParams("t3") });
    const record = await until(() => listPermissions().find((r) => r.codex?.requestId === 7), "the request");
    expect(record).toMatchObject({
      agent: "api", provider: "codex", tool: "Bash", summary: "Bash: touch x", expiresAt: null, state: "pending",
      createdAt: new Date(1_700_000_000_000).toISOString(),
    });
    expect(events).toContainEqual(["permission-request", "api"]);

    expect(await answerPermission(["api"], record.id, "acceptWithExecpolicyAmendment")).toMatchObject({ ok: true });
    const reply = await until(() => received.find((m) => m.id === 7 && m.result), "the reply");
    expect(reply).toEqual({ id: 7, result: { decision: AVAILABLE[1] } });
    expect(listPermissions()).toHaveLength(1); // nothing for the input request or the unknown thread

    // Answered in the TUI: Codex tells every subscriber.
    send({ id: 10, method: "item/commandExecution/requestApproval", params: commandParams("t1") });
    const second = await until(() => listPermissions().find((r) => r.codex?.requestId === 10), "the second request");
    send({ method: "serverRequest/resolved", params: { threadId: "t1", requestId: 10 } });
    await until(() => readPermission(second.id)!.state === "stale", "pane resolution");
    expect(readPermission(second.id)!.resolution).toBe("answered in the pane");
    expect(await answerPermission(["api"], second.id, "accept")).toMatchObject({ ok: false, reason: "not_pending" });

    send({ id: 11, method: "item/fileChange/requestApproval", params: { threadId: "t1", turnId: "turn-1", itemId: "fc-1" } });
    const third = await until(() => listPermissions().find((r) => r.codex?.requestId === 11), "the third request");
    expect(third.tool).toBe("apply_patch");
    send({ method: "turn/completed", params: { threadId: "t1", turn: { id: "turn-1" } } });
    await until(() => readPermission(third.id)!.state === "stale", "turn end");

    send({ id: 12, method: "item/commandExecution/requestApproval", params: commandParams("t1") });
    const fourth = await until(() => listPermissions().find((r) => r.codex?.requestId === 12), "the fourth request");
    client!.close();
    await until(() => readPermission(fourth.id)!.state === "stale", "connection loss");
    expect(readPermission(fourth.id)!.resolution).toBe("lost the codex app-server connection");
  }, 20_000);

  test("an answer is never sent on a later connection, where its request id means another request", async () => {
    const socket = join(home, "app-server.sock");
    fakeAppServer(socket);
    watcher = startCodexApprovalWatcher({
      publish: () => undefined,
      socket: () => socket,
      enabled: () => true,
      targets: () => [{ agent: "api", threadId: "t1" }],
      syncMs: 60_000,
      pollMs: 60_000, // delivery only when the test says
    });
    await until(() => received.some((m) => m.method === "thread/resume"), "rejoin");
    send({ id: 7, method: "item/commandExecution/requestApproval", params: commandParams("t1") });
    const first = await until(() => listPermissions().find((r) => r.codex?.requestId === 7), "the request");
    const answer = answerPermission(["api"], first.id, "accept", { ackMs: 5000, pollMs: 20 });
    await until(() => readPermission(first.id)!.state === "answered", "the answer");

    // The connection drops before the answer goes out; the watcher rejoins.
    const old = client!;
    old.close();
    await until(() => readPermission(first.id)!.state === "stale", "the answer withdrawn");
    expect(await answer).toMatchObject({ ok: false, reason: "not_pending" });
    expect(readPermission(first.id)!.resolution).toBe("lost the codex app-server connection");
    const before = received.length;
    await watcher.sync();
    await until(() => client !== old && received.slice(before).some((m) => m.method === "thread/resume"), "the rejoin");

    // Same request id, new connection: a different request.
    send({ id: 7, method: "item/commandExecution/requestApproval", params: commandParams("t1", { command: "rm -rf /w" }) });
    const second = await until(() => listPermissions().find((r) => r.codex?.requestId === 7 && r.id !== first.id), "the new request");
    watcher.deliver();
    await Bun.sleep(100);
    expect(received.slice(before).some((m) => m.id === 7 && m.result)).toBe(false);
    expect(readPermission(second.id)!.state).toBe("pending");

    const answered = answerPermission(["api"], second.id, "cancel", { ackMs: 5000, pollMs: 20 });
    await until(() => readPermission(second.id)!.state === "answered", "the second answer");
    watcher.deliver();
    expect(await answered).toMatchObject({ ok: true });
    const reply = await until(() => received.slice(before).find((m) => m.id === 7 && m.result), "the reply");
    expect(reply.result).toEqual({ decision: "cancel" });
  }, 20_000);

  test("off while agents run permissionless: never connects", async () => {
    const socket = join(home, "app-server.sock");
    fakeAppServer(socket);
    watcher = startCodexApprovalWatcher({ publish: () => undefined, socket: () => socket, enabled: () => false, targets: () => [{ agent: "api", threadId: "t1" }] });
    await watcher.sync();
    await Bun.sleep(100);
    expect(client).toBeUndefined();
  });
});
