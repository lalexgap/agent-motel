import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const source = readFileSync(new URL("../web/app.js", import.meta.url), "utf8");
const html = readFileSync(new URL("../web/index.html", import.meta.url), "utf8");
const selectorSource = source.slice(source.indexOf("let modelDialog = null;"), source.indexOf("let manageAgent = null;"));

class FakeOption {
  constructor(readonly text: string, readonly value: string) {}
}

function fixture(api: (path: string, body?: unknown) => Promise<any>) {
  const nodes = new Map<string, any>();
  const node = (id: string) => {
    if (!nodes.has(id)) nodes.set(id, {
      value: "", textContent: "", disabled: false, open: false,
      replaceChildren(...children: any[]) { this.options = children; },
      reset() {},
      showModal() { this.open = true; },
      close() { this.open = false; this.onclose?.(); },
    });
    return nodes.get(id);
  };
  const state = {
    selected: "laptop:agent", authenticated: true, sessionEpoch: 4,
    detailCapabilities: { name: "laptop:agent", detail: { provider: "codex", model: "gpt-current", effort: "high" } },
  };
  const notices: string[] = [];
  let refreshes = 0;
  const context: any = {
    state, $: node, Option: FakeOption, api,
    pendingActions: new Set<string>(),
    notice: (message: string) => notices.push(message),
    refresh: async () => { refreshes++; },
    encodeURIComponent,
  };
  runInNewContext(selectorSource, context);
  return { context, state, node, notices, refreshes: () => refreshes };
}

const catalog = {
  provider: "codex", modelsExhaustive: true, effortsExhaustive: true,
  efforts: ["low", "medium", "high"],
  models: [
    { id: "gpt-current", label: "Current", efforts: ["low", "high"] },
    { id: "gpt-next", label: "Next", efforts: ["medium"] },
  ],
};

test("model dialog offers provider defaults, retains supported settings and narrows effort by model", async () => {
  const f = fixture(async () => [catalog]);
  await f.node("change-model-agent").onclick();
  expect(f.node("model-select").options.map((option: FakeOption) => [option.text, option.value])).toEqual([
    ["Provider default", ""], ["Current", "gpt-current"], ["Next", "gpt-next"],
  ]);
  expect(f.node("model-select").value).toBe("gpt-current");
  expect(f.node("model-effort").value).toBe("high");
  f.node("model-select").value = "gpt-next";
  f.node("model-select").onchange();
  expect(f.node("model-effort").options.map((option: FakeOption) => option.value)).toEqual(["", "medium"]);
  expect(f.node("model-effort").value).toBe("");
  expect(f.node("model-submit").disabled).toBe(false);
});

test("closed and superseded dialogs ignore stale catalogs while load failures stay readable", async () => {
  let resolveFirst!: (value: unknown) => void;
  const first = new Promise(resolve => { resolveFirst = resolve; });
  let requests = 0;
  const f = fixture(async () => ++requests === 1 ? first : Promise.reject(new Error("host unavailable")));
  const stale = f.node("change-model-agent").onclick();
  f.node("close-model-dialog").onclick();
  resolveFirst([catalog]);
  await stale;
  expect(f.node("model-dialog").open).toBe(false);
  expect(f.node("model-submit").disabled).toBe(true);

  await f.node("change-model-agent").onclick();
  expect(f.node("model-error").textContent).toBe("Models could not be loaded: host unavailable");
  expect(f.node("model-submit").disabled).toBe(true);
});

test("catalog responses cannot cross a logout session or agent selection switch", async () => {
  const pending: ((value: unknown) => void)[] = [];
  const f = fixture(() => new Promise(resolve => pending.push(resolve)));

  const loggedOut = f.node("change-model-agent").onclick();
  f.state.sessionEpoch++;
  f.state.authenticated = false;
  pending.shift()!([catalog]);
  await loggedOut;
  expect(f.node("model-submit").disabled).toBe(true);

  f.state.authenticated = true;
  f.state.selected = "laptop:agent";
  f.state.detailCapabilities = { name: "laptop:agent", detail: { provider: "codex", model: "gpt-current", effort: "high" } };
  const switched = f.node("change-model-agent").onclick();
  f.state.selected = "other-host:agent";
  pending.shift()!([catalog]);
  await switched;
  expect(f.node("model-submit").disabled).toBe(true);
  expect(f.node("model-select").options.map((option: FakeOption) => option.text)).toEqual(["Loading models…"]);
});

test("submit is an explicit restart confirmation, blocks duplicates and reports refusal", async () => {
  let rejectRestart!: (error: Error) => void;
  const restart = new Promise((_resolve, reject) => { rejectRestart = reject; });
  const calls: { path: string; body?: unknown }[] = [];
  const f = fixture(async (path, body) => {
    calls.push({ path, body });
    return path.startsWith("/api/models") ? [catalog] : restart;
  });
  await f.node("change-model-agent").onclick();
  f.node("model-select").value = "gpt-next";
  f.node("model-select").onchange();
  f.node("model-effort").value = "medium";
  const event = { preventDefault() {} };
  const pending = f.node("model-form").onsubmit(event);
  await f.node("model-form").onsubmit(event);
  expect(calls.filter(call => call.path.endsWith("/model"))).toEqual([{
    path: "/api/agents/laptop%3Aagent/model", body: { model: "gpt-next", effort: "medium" },
  }]);
  expect(f.node("model-submit").textContent).toBe("Restarting…");
  rejectRestart(new Error("selection rejected"));
  await pending;
  expect(f.node("model-error").textContent).toContain("selection rejected");
  expect(f.node("model-error").textContent).toContain("Refresh and check");
  expect(f.node("model-submit").textContent).toBe("Restart with model");
  expect(f.node("model-dialog").open).toBe(true);

  f.node("model-submit").textContent = "Restarting…";
  await f.node("change-model-agent").onclick();
  expect(f.node("model-submit").textContent).toBe("Restart with model");
});

test("dialog copy states the restart and last-turn display behavior", () => {
  expect(html).toContain("Restarting interrupts the current turn. The conversation and queued messages are retained.");
  expect(html).toContain("can lag until the agent replies again");
  expect(html).toContain('id="model-submit" type="submit" disabled>Restart with model</button>');
  expect(html).toContain('id="model-select" disabled');
  expect(html).not.toContain('id="model-select" required');
});
