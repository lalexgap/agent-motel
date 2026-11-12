import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import {
  ACTIVATION_KEYS,
  actionAvailable,
  AGENT_CHANGED,
  capabilityAvailable,
  chosen,
  defaultHandoverTarget,
  dialogMessage,
  effortChoices,
  keyAfter,
  keyToRelease,
  LIFECYCLE,
  AGENT_REPLACED,
  AGENT_STOPPED,
  modelChoices,
  modelPrecondition,
  moveDir,
  moveHostOptions,
  nameProblem,
  pickCatalog,
  rejectionOutcome,
  resultOutcome,
  selectionAfterRemove,
  SERVER_FAILED,
  SUFFIX,
  UNREACHABLE,
  type ActionSubject,
  type ProviderCatalog,
} from "../desktop/src/actions";
import { TOKEN_REJECTED } from "../desktop/src/composer";
import { AGENT_GONE, CONFIRM_METHODS, CONFIRM_OPEN, precheckFailed } from "../desktop/src/policy";

// The browser UI's own rules, evaluated from web/app.js so the two cannot drift silently.
const source = readFileSync(new URL("../web/app.js", import.meta.url), "utf8");
const slice = (from: string, to: string) => {
  const start = source.indexOf(from);
  const end = source.indexOf(to, start);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
};
const browser = (() => {
  const context: Record<string, unknown> = {};
  runInNewContext(
    slice("function capabilityAvailable(", "function updateAgentActions(") + slice("function modelChoices(", "function replaceOptions(") +
      "this.api = { capabilityAvailable, actionAvailable, modelChoices, effortChoices };",
    context,
  );
  return context.api as {
    capabilityAvailable(row: unknown, capability: string): boolean;
    actionAvailable(row: unknown, action: string): boolean;
    modelChoices(catalog: unknown, current: unknown): { value: string; label: string }[];
    effortChoices(catalog: unknown, modelId: string, current: unknown): { value: string; label: string }[];
  };
})();
// vm objects come from another realm; compare as plain data.
const plain = <T>(value: T): T => JSON.parse(JSON.stringify(value));

const STATUSES = ["starting", "idle", "working", "waiting", "needs-attention", "exited", "dead", "mystery", undefined];
const PROVIDERS = ["claude", "codex", "antigravity", undefined];
const IDENTITIES: Partial<ActionSubject>[] = [
  { name: "harbor-lights" },
  { name: "concierge" },
  { name: "concierge", role: "concierge" },
  { name: "front-desk", role: "concierge" },
  { name: "front-desk", role: { name: "concierge" } },
  { name: "reviewer-1", role: { name: "reviewer" } },
  { name: "odd-role", role: {} },
];
const CAPABILITIES: (Record<string, unknown> | undefined)[] = [
  undefined,
  {},
  { handoff: false },
  { rename: false, move: false },
  { interruptByReceipt: true, handoff: true, rename: true, move: true },
  { interruptByReceipt: false, restart: false, resume: false, stop: false, delete: false },
];
const ACTIONS = ["resume", "restart", "interrupt", "stop", "delete", "rename", "move", "handover", "model", "terminal", "open", "chat", "unknown"];
const CAPABILITY_NAMES = ["remoteControl", "quota", "approvalRelay", "interruptByReceipt", "handoff", "move", "rename", "subagents", "attachments", "restart", "resume"];

function* subjects(): Generator<ActionSubject> {
  for (const status of STATUSES) for (const provider of PROVIDERS) for (const identity of IDENTITIES) for (const capabilities of CAPABILITIES) {
    yield { ...identity, ...(status ? { status: status as ActionSubject["status"] } : {}), ...(provider ? { provider: provider as ActionSubject["provider"] } : {}), ...(capabilities ? { capabilities } : {}) };
  }
}

describe("parity with the browser UI", () => {
  test("actionAvailable and capabilityAvailable agree on every row, detail and action", () => {
    let compared = 0;
    for (const row of subjects()) {
      for (const action of ACTIONS) {
        expect({ row, action, available: actionAvailable(row, action) }).toEqual({ row, action, available: browser.actionAvailable(row, action) });
        compared++;
      }
      for (const capability of CAPABILITY_NAMES) expect(capabilityAvailable(row, capability)).toBe(browser.capabilityAvailable(row, capability));
    }
    for (const action of ACTIONS) {
      expect(actionAvailable(null, action)).toBe(browser.actionAvailable(null, action));
      expect(actionAvailable(undefined, action)).toBe(browser.actionAvailable(undefined, action));
    }
    expect(compared).toBeGreaterThan(10_000);
  });

  const CATALOGS: (ProviderCatalog | null | undefined)[] = [
    undefined,
    null,
    { provider: "claude", models: [], efforts: [] },
    { provider: "claude", models: [{ id: "opus", label: "Opus", efforts: ["low", "high"] }, { id: "sonnet", efforts: [] }], efforts: ["low", "medium", "high"], modelsExhaustive: true, effortsExhaustive: true },
    { provider: "codex", models: [{ id: "gpt-5", efforts: ["minimal", "high"] }, { id: "mini" }], efforts: ["low", "medium", "high"], modelsExhaustive: false, effortsExhaustive: false },
    { provider: "antigravity", models: [{ id: "gemini", label: "" }], efforts: ["low"] },
    { provider: "claude", efforts: ["low"], modelsExhaustive: false } as ProviderCatalog,
  ];
  const CURRENT = [null, undefined, "", "opus", "sonnet", "gpt-5", "mini", "custom-model", "gemini"];
  const EFFORTS = [null, undefined, "", "low", "high", "minimal", "xhigh"];
  const MODEL_IDS = ["", "opus", "sonnet", "gpt-5", "mini", "gemini", "unknown"];

  test("modelChoices agrees for every catalog and configured model", () => {
    for (const catalog of CATALOGS) for (const current of CURRENT)
      expect(modelChoices(catalog, current)).toEqual(plain(browser.modelChoices(catalog, current)));
  });

  test("effortChoices agrees for every catalog, selected model and configured effort", () => {
    for (const catalog of CATALOGS) for (const modelId of MODEL_IDS) for (const current of EFFORTS)
      expect(effortChoices(catalog, modelId, current)).toEqual(plain(browser.effortChoices(catalog, modelId, current)));
  });
});

describe("what the menu and header offer", () => {
  const row = (over: Partial<ActionSubject>): ActionSubject => ({ name: "keeper-log", status: "idle", provider: "claude", ...over });
  const offered = (subject: ActionSubject) => ["handover", "rename", "move", "resume", "restart", "interrupt", "stop", "delete"].filter((action) => actionAvailable(subject, action));

  test("by status, provider and identity", () => {
    expect(offered(row({ status: "working" }))).toEqual(["handover", "rename", "move", "restart", "interrupt", "stop", "delete"]);
    expect(offered(row({ status: "idle" }))).toEqual(["handover", "rename", "move", "restart", "stop", "delete"]);
    expect(offered(row({ status: "exited" }))).toEqual(["handover", "rename", "move", "resume", "delete"]);
    expect(offered(row({ status: "dead" }))).toEqual(["handover", "rename", "move", "resume", "delete"]);
    // Antigravity rows have no capabilities, so the provider fallback hides the native controls.
    expect(offered(row({ status: "working", provider: "antigravity" }))).toEqual(["restart", "stop", "delete"]);
    // The concierge can be moved and removed, as in the browser UI.
    expect(offered(row({ name: "concierge", role: "concierge" }))).toEqual(["move", "restart", "stop", "delete"]);
    expect(offered(row({ name: "front-desk", role: { name: "concierge" } }))).toEqual(["rename", "move", "restart", "stop", "delete"]);
  });

  test("a detail's capabilities can take actions away", () => {
    expect(actionAvailable(row({ capabilities: { handoff: false } }), "handover")).toBe(false);
    expect(actionAvailable(row({ status: "working", capabilities: { interruptByReceipt: false } }), "interrupt")).toBe(false);
    // ...but never give Antigravity the native controls back.
    expect(actionAvailable(row({ provider: "antigravity", capabilities: { handoff: true } }), "handover")).toBe(false);
    expect(actionAvailable(row({ provider: "antigravity", capabilities: { rename: true } }), "rename")).toBe(false);
    // Model change follows Restart: any provider, only while running.
    expect(actionAvailable(row({ provider: "antigravity" }), "model")).toBe(true);
    expect(actionAvailable(row({ status: "exited" }), "model")).toBe(false);
  });

  test("lifecycle actions call the matching bridge methods; only resume is unconfirmed", () => {
    expect(LIFECYCLE).toEqual({ resume: "agents.resume", restart: "agents.restart", interrupt: "agents.interrupt", stop: "agents.stop", delete: "agents.remove" });
    for (const [action, method] of Object.entries(LIFECYCLE))
      expect((CONFIRM_METHODS as readonly string[]).includes(method)).toBe(action !== "resume");
  });
});

describe("an agent shown working while it waits on its subagents", () => {
  // am shows an idle-at-prompt agent with live subagents as working; its stored status stays idle.
  const waiting = { name: "bosun-call", status: "working", rawStatus: "idle", provider: "claude", busyWith: { subagents: 2, background: 0 } } as const;

  test("Interrupt is offered on the displayed status, as in the browser UI", () => {
    expect(actionAvailable(waiting, "interrupt")).toBe(true);
    expect(browser.actionAvailable(waiting, "interrupt")).toBe(true);
    // A stalled agent (needs-attention, stored idle) keeps it too.
    expect(actionAvailable({ ...waiting, status: "needs-attention" }, "interrupt")).toBe(true);
    expect(actionAvailable({ ...waiting, status: "idle", rawStatus: "working" } as ActionSubject, "interrupt")).toBe(false);
  });

  test("the model change echoes the displayed status, never rawStatus", () => {
    const createdAt = "2026-01-01T00:00:00.000Z";
    expect(modelPrecondition({ ...waiting, createdAt }, createdAt)).toEqual({ status: "working" });
    expect(modelPrecondition({ status: "needs-attention", rawStatus: "idle", createdAt }, createdAt)).toEqual({ status: "needs-attention" });
    expect(modelPrecondition({ status: "idle", rawStatus: "working", createdAt }, createdAt)).toEqual({ status: "idle" });
    expect(modelPrecondition({ status: "exited", rawStatus: "idle", createdAt }, createdAt)).toEqual({ error: AGENT_STOPPED });
    expect(modelPrecondition({ ...waiting, createdAt: "2026-01-02T00:00:00.000Z" }, createdAt)).toEqual({ error: AGENT_REPLACED });
  });
});

describe("dialog inputs", () => {
  test("model and effort selection falls back to Provider default", () => {
    const choices = [{ value: "", label: "Provider default" }, { value: "opus", label: "Opus" }];
    expect(chosen(choices, "opus")).toBe("opus");
    expect(chosen(choices, "gone")).toBe("");
    expect(chosen(choices, null)).toBe("");
  });

  test("pickCatalog takes a bare array or {catalogs} and matches the provider", () => {
    const codex = { provider: "codex", models: [], efforts: [] };
    expect(pickCatalog([{ provider: "claude" }, codex], "codex")).toEqual(codex);
    expect(pickCatalog({ catalogs: [codex] }, "codex")).toEqual(codex);
    expect(pickCatalog([codex], "antigravity")).toBeNull();
    expect(pickCatalog(null, "codex")).toBeNull();
    expect(pickCatalog({ error: "x" }, "codex")).toBeNull();
    expect(pickCatalog([null, codex], "codex")).toEqual(codex);
  });

  test("move hosts: a remote agent only comes back here; a local one goes anywhere, unreachable marked", () => {
    const hosts = { local: "gapserver", hosts: [{ name: "annex", reachable: true }, { name: "lantern", reachable: false }] };
    expect(moveHostOptions(hosts, true)).toEqual([{ value: "local", label: "gapserver (this server)", unreachable: false }]);
    expect(moveHostOptions(hosts, false)).toEqual([
      { value: "annex", label: "annex", unreachable: false },
      { value: "lantern", label: "lantern (unreachable)", unreachable: true },
    ]);
    expect(moveHostOptions({ local: "gapserver", hosts: [] }, false)).toEqual([]);
    expect(moveHostOptions(null, false)).toEqual([]);
    expect(moveHostOptions({ local: "", hosts: [] }, true)[0]!.label).toBe("This server (this server)");
  });

  test("move directory: optional, trimmed, absolute, no control characters", () => {
    expect(moveDir("")).toEqual({});
    expect(moveDir("   ")).toEqual({});
    expect(moveDir(" /srv/tide ")).toEqual({ dir: "/srv/tide" });
    expect(moveDir("srv/tide")).toHaveProperty("error");
    expect(moveDir("~/code")).toHaveProperty("error");
    expect(moveDir("/srv/\u0007tide")).toHaveProperty("error");
  });

  test("names: am's rule and the reserved concierge", () => {
    expect(nameProblem("keeper-log_2")).toBeNull();
    expect(nameProblem("")).toBe("Enter a name.");
    expect(nameProblem("has space")).not.toBeNull();
    expect(nameProblem("x".repeat(64))).toBeNull();
    expect(nameProblem("x".repeat(65))).not.toBeNull();
    expect(nameProblem("concierge")).toContain("reserved");
  });

  test("handover defaults to the other provider", () => {
    expect(defaultHandoverTarget("codex")).toBe("claude");
    expect(defaultHandoverTarget("claude")).toBe("codex");
    expect(defaultHandoverTarget(undefined)).toBe("codex");
  });
});

describe("results and failures", () => {
  test("success, a declined confirmation and each status", () => {
    expect(resultOutcome({ status: 200, body: { ok: true } })).toEqual({ kind: "ok", body: { ok: true } });
    expect(resultOutcome({ status: 201, body: { key: "annex:x" } })).toEqual({ kind: "ok", body: { key: "annex:x" } });
    expect(resultOutcome({ cancelled: true })).toEqual({ kind: "cancelled" });
    expect(resultOutcome({ status: 404, body: { error: "no local agent \"x\"" } })).toEqual({ kind: "failed", message: AGENT_GONE, gone: true, advised: true });
    // Stop's own 404 (the bridge already checked the agent exists) is am's lifecycle-busy refusal: show it, and still refresh.
    const busy = "agent \"slipway\" is being stopped, removed, renamed, or restarted — retry";
    expect(resultOutcome({ status: 404, body: { error: busy } }, "agents.stop")).toEqual({ kind: "failed", message: busy, gone: true, advised: true });
    expect(resultOutcome({ status: 404, body: null }, "agents.stop")).toEqual({ kind: "failed", message: AGENT_GONE, gone: true, advised: true });
    expect(resultOutcome({ status: 404, body: { error: "  " } }, "agents.stop")).toEqual({ kind: "failed", message: AGENT_GONE, gone: true, advised: true });
    for (const method of ["agents.resume", "agents.restart", "agents.interrupt", "agents.remove", "agents.rename", "agents.move", "agents.model", "agents.handoff"])
      expect(resultOutcome({ status: 404, body: { error: busy } }, method)).toEqual({ kind: "failed", message: AGENT_GONE, gone: true, advised: true });
    expect(resultOutcome({ status: 409, body: { error: "agent \"slipway\" is being stopped, removed, renamed, or restarted — retry restart" } }))
      .toEqual({ kind: "failed", message: "agent \"slipway\" is being stopped, removed, renamed, or restarted — retry restart" });
    expect(resultOutcome({ status: 500, body: { error: "request failed" } })).toEqual({ kind: "failed", message: SERVER_FAILED, advised: true });
    expect(resultOutcome({ status: 502, body: null })).toEqual({ kind: "failed", message: SERVER_FAILED, advised: true });
    expect(resultOutcome({ status: 502, body: { error: "ssh lantern: timed out" } })).toEqual({ kind: "failed", message: "ssh lantern: timed out" });
    expect(resultOutcome({ status: 400, body: { error: "destination directory must be an absolute path" } }).kind).toBe("failed");
    expect(resultOutcome({ status: 409, body: {} })).toEqual({ kind: "failed", message: "The server returned HTTP 409." });
    expect(resultOutcome({ status: 401, body: null })).toEqual({ kind: "failed", message: TOKEN_REJECTED, tokenRejected: true, advised: true });
  });

  test("bridge rejections show their message; anything else is the network", () => {
    expect(rejectionOutcome(new Error(AGENT_GONE))).toEqual({ kind: "failed", message: AGENT_GONE, gone: true, advised: true });
    for (const message of [CONFIRM_OPEN, precheckFailed(401), "invalid name: concierge", "invalid host: a b", "unknown connection: x", "This confirmation has expired or was already answered", "The connection changed; try again"])
      expect(rejectionOutcome(new Error(message))).toEqual({ kind: "failed", message });
    for (const message of ["The request timed out.", "Could not connect to the server.", "Dev bridge unreachable", "fetch failed"])
      expect(rejectionOutcome(new Error(message))).toEqual({ kind: "failed", message: UNREACHABLE, advised: true });
    expect(rejectionOutcome("plain string")).toEqual({ kind: "failed", message: UNREACHABLE, advised: true });
  });

  test("dialogs append the browser UI's advice unless the message already gives some", () => {
    expect(dialogMessage({ kind: "failed", message: "agent name \"x\" is already used by agent" }, SUFFIX.manage))
      .toBe("agent name \"x\" is already used by agent. Check the agent list before retrying if the connection was interrupted.");
    expect(dialogMessage({ kind: "failed", message: "Already used." }, SUFFIX.handover)).toBe("Already used. Check the agent list before retrying if the request was interrupted.");
    expect(dialogMessage({ kind: "failed", message: SERVER_FAILED, advised: true }, SUFFIX.model)).toBe(SERVER_FAILED);
    expect(AGENT_CHANGED).toBe("Agent status changed. Refresh and try again.");
  });
});

describe("what opens afterwards", () => {
  test("rename: the remote key, else the new local name", () => {
    expect(keyAfter("c1", "rename", { ok: true, oldName: "keeper-log", name: "keeper", live: true })).toBe("c1/keeper");
    expect(keyAfter("c1", "rename", { ok: true, name: "kelp", key: "annex:kelp" })).toBe("c1/annex:kelp");
  });
  test("move and handover: the key, and nothing without one", () => {
    expect(keyAfter("c1", "move", { ok: true, key: "annex:keeper-log", message: "moved" })).toBe("c1/annex:keeper-log");
    expect(keyAfter("c1", "move", { ok: true, key: "keeper-log" })).toBe("c1/keeper-log");
    expect(keyAfter("c1", "handover", { ok: true, name: "keeper-log-codex2", key: "keeper-log-codex2" })).toBe("c1/keeper-log-codex2");
    expect(keyAfter("c1", "handover", { ok: true, name: "x" })).toBeNull();
    expect(keyAfter("c1", "move", null)).toBeNull();
    expect(keyAfter("c1", "rename", { key: "" })).toBeNull();
  });
  test("remove: the overview only when the removed agent was open", () => {
    expect(selectionAfterRemove("c1/keeper-log", "c1/keeper-log")).toBeNull();
    expect(selectionAfterRemove("c1/fog-signal", "c1/keeper-log")).toBeUndefined();
    expect(selectionAfterRemove(null, "c1/keeper-log")).toBeUndefined();
  });
});

describe("held activation keys", () => {
  test("a confirmed method waits for a held Enter or Space; nothing else waits", () => {
    expect(ACTIVATION_KEYS).toEqual(["Enter", " "]);
    for (const method of CONFIRM_METHODS) {
      expect(keyToRelease(method, new Set(["Enter"]))).toBe("Enter");
      expect(keyToRelease(method, new Set([" "]))).toBe(" ");
      expect(keyToRelease(method, new Set())).toBeNull();
      expect(keyToRelease(method, new Set(["Shift", "a"]))).toBeNull();
    }
    for (const method of ["agents.resume", "agents.rename", "agents.handoff", "messages.send", "api.get"])
      expect(keyToRelease(method, new Set(["Enter", " "]))).toBeNull();
  });
});
