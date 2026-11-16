import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { planDecisionRequests, runDecisionRequests } from "../src/decisionRequests";

const PR = "https://github.com/owner/repo/pull/7";
function store(...decisions: { id: string; question?: string; status?: string; blocking?: boolean; link?: string }[]): string {
  return JSON.stringify({
    version: 1,
    decisions: decisions.map((d) => ({ status: "open", question: `q ${d.id}`, ...d })),
  });
}

describe("planDecisionRequests", () => {
  test("seeds silently on the first scan", () => {
    const plan = planDecisionRequests(new Map([["alpha", store({ id: "d1" })]]), null);
    expect(plan.fresh).toEqual([]);
    expect(plan.open).toEqual({ alpha: ["d1"] });
  });

  test("reports only decisions opened since the last scan", () => {
    const stores = new Map([
      ["alpha", store({ id: "d1" }, { id: "d2" }, { id: "d0", status: "decided" })],
      ["beta", store({ id: "d1" })],
    ]);
    const plan = planDecisionRequests(stores, { alpha: ["d1"] });
    expect(plan.fresh.map((r) => `${r.agent}/${r.decision.id}`)).toEqual(["alpha/d2", "beta/d1"]);
    expect(plan.open).toEqual({ alpha: ["d1", "d2"], beta: ["d1"] });
  });

  test("forgets answered decisions, so the state stays bounded", () => {
    const plan = planDecisionRequests(new Map([["alpha", store({ id: "d1", status: "decided" })]]), { alpha: ["d1"] });
    expect(plan.open).toEqual({});
    expect(plan.fresh).toEqual([]);
  });
});

describe("runDecisionRequests", () => {
  function run(stores: Map<string, string>, stateFile: string) {
    const shown: { title: string; message: string; meta: { agent?: string; url?: string } }[] = [];
    runDecisionRequests({ stateFile, stores, publish: (title, message, meta) => shown.push({ title, message, meta }) });
    return shown;
  }

  test("notifies once per new decision, with its PR as the link", () => {
    const stateFile = join(mkdtempSync(join(tmpdir(), "am-decision-requests-")), "state.json");
    expect(run(new Map([["alpha", store({ id: "d1" })]]), stateFile)).toEqual([]);
    const shown = run(new Map([["alpha", store({ id: "d1" }, { id: "d2", question: "Ship it?", blocking: true, link: PR })]]), stateFile);
    expect(shown).toEqual([{ title: "am: alpha", message: "blocking decision needed: Ship it?", meta: { agent: "alpha", url: PR } }]);
    expect(run(new Map([["alpha", store({ id: "d1" }, { id: "d2" })]]), stateFile)).toEqual([]);
  });

  test("collapses a burst into one notification", () => {
    const stateFile = join(mkdtempSync(join(tmpdir(), "am-decision-requests-")), "state.json");
    run(new Map(), stateFile);
    const shown = run(new Map([["alpha", store({ id: "a" }, { id: "b" })], ["beta", store({ id: "c" }, { id: "d" })]]), stateFile);
    expect(shown).toEqual([{ title: "am: decisions needed", message: "4 new decisions from alpha, beta", meta: {} }]);
  });
});
