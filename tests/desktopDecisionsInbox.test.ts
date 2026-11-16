import { describe, expect, test } from "bun:test";
import { DecisionsInbox, parseDecisionsReport } from "../desktop/src/decisionsInbox";
import { DecisionReports } from "../desktop/src/decisionReports";
import { newConnState } from "../desktop/src/state";
import { ownsDecisionCardMutation } from "../desktop/src/decisionCardState";
import { decisionsInboxFixture } from "../desktop/fixtures/decisionsInbox";
import { FIXTURE_TOKEN, startFixtureServer } from "../desktop/fixtures/server";
import { validateApiPath } from "../desktop/src/policy";
import { decisionsScreen, isDecisionsChanged } from "../desktop/src/decisionsView";

describe("decisions inbox requests", () => {
  test("replacing a saved server clears its count and selected inbox and rejects late old responses", async () => {
    const pending: ((report: unknown) => void)[] = [];
    const reports = new DecisionReports(() => new Promise((resolve) => pending.push(resolve)), () => {});
    const saved = { id: "one", name: "One", url: "https://old.example", hasToken: true };
    const connection = newConnState(saved);
    reports.setConnections([[saved.id, connection]]);
    const inbox = new DecisionsInbox((id, latest) => reports.fetch(id, latest), () => {});
    inbox.select(saved.id, reports.identity(saved.id));
    const initial = inbox.refresh();
    pending[0]!(decisionsInboxFixture());
    await initial;
    expect(reports.count()).toBeGreaterThan(0);
    const identity = reports.identity(saved.id);
    connection.agentsApplied++;
    reports.setConnections([[saved.id, connection]]);
    expect(reports.identity(saved.id)).toBe(identity);
    expect(pending).toHaveLength(1);
    const old = inbox.refresh();
    connection.conn = { ...saved, url: "https://new.example" };
    reports.setConnections([[saved.id, connection]]);
    inbox.select(saved.id, reports.identity(saved.id));
    expect(reports.count()).toBe(0);
    expect(inbox.report).toBeNull();
    expect(inbox.loading).toBe(false);
    const current = inbox.refresh();
    pending[1]!(decisionsInboxFixture());
    await old;
    expect(inbox.report).toBeNull();
    expect(reports.count()).toBe(0);
    pending[2]!({ groups: [], remoteHosts: [], enabled: true, complete: true });
    await current;
    expect(inbox.report?.groups).toEqual([]);
    expect(reports.count()).toBe(0);
    reports.setConnections([[saved.id, newConnState(connection.conn)]]);
    expect(reports.identity(saved.id)).not.toBe(identity);
    expect(pending).toHaveLength(4);
    pending[3]!({ groups: [], remoteHosts: [], enabled: true, complete: true });
  });
  test("recognizes only the decisions-changed fleet event", () => {
    expect(isDecisionsChanged({ event: "fleet", data: { event: "decisions-changed" } })).toBe(true);
    expect(isDecisionsChanged({ event: "fleet", data: { event: "status" } })).toBe(false);
    expect(isDecisionsChanged({ event: "decisions-changed", data: {} })).toBe(false);
    expect(isDecisionsChanged({ event: "fleet", data: null })).toBe(false);
  });
  test("opens decisions from setup only when a saved server exists", () => {
    expect(decisionsScreen("setup", 1)).toBe("fleet");
    expect(decisionsScreen("setup", 0)).toBe("setup");
    expect(decisionsScreen("fleet", 0)).toBe("fleet");
  });
  test("counts canonical reports for every server before the inbox opens", async () => {
    const archived = decisionsInboxFixture();
    const other = { groups: [{ agent: "other", decisions: archived.groups[0]!.decisions.slice(0, 1) }], remoteHosts: ["mirror"], enabled: true, complete: true };
    const reports = new DecisionReports(async (connection) => connection === "one" ? archived : other, () => {});
    reports.setConnections(["one", "two"]);
    await Promise.all([reports.refresh("one"), reports.refresh("two")]);
    const expected = archived.groups.reduce((total, group) => total + group.decisions.length, 0) + 1;
    expect(reports.count()).toBe(expected);
  });
  test("an event refresh supersedes an older count request without duplicating ordinary refreshes", async () => {
    const pending: ((report: unknown) => void)[] = [];
    let calls = 0;
    const reports = new DecisionReports(() => new Promise((resolve) => { calls++; pending.push(resolve); }), () => {});
    reports.setConnections(["one"]);
    void reports.refresh("one");
    expect(calls).toBe(1);
    const latest = reports.refresh("one", true);
    expect(calls).toBe(2);
    pending[1]!({ groups: [], remoteHosts: [], enabled: true, complete: true });
    await latest;
    pending[0]!(decisionsInboxFixture());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(reports.count()).toBe(0);
  });
  test("drops a removed server's late result even when the same id is saved again", async () => {
    const pending: ((report: unknown) => void)[] = [];
    const reports = new DecisionReports(() => new Promise((resolve) => pending.push(resolve)), () => {});
    reports.setConnections(["one"]);
    reports.setConnections([]);
    reports.setConnections(["one"]);
    pending[1]!({ groups: [{ agent: "current", decisions: decisionsInboxFixture().groups[0]!.decisions.slice(0, 1) }], remoteHosts: [], enabled: true, complete: true });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(reports.count()).toBe(1);
    pending[0]!(decisionsInboxFixture());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(reports.count()).toBe(1);
  });
  test("card mutations require the original target and generation", () => {
    expect(ownsDecisionCardMutation(2, 2, 4, 4, "local:a", "local:a", "local:a")).toBe(true);
    expect(ownsDecisionCardMutation(2, 3, 4, 4, "local:a", "local:b", "local:b")).toBe(false);
    expect(ownsDecisionCardMutation(2, 2, 4, 4, "local:a", "local:a", "local:b")).toBe(false);
  });
  test("the native GET path policy permits the read endpoint", () => {
    expect(() => validateApiPath("/api/decisions")).not.toThrow();
  });
  test("rejects incompatible server data", () => {
    for (const data of [null, {}, { groups: [], remoteHosts: [], enabled: 1, complete: true }, { groups: [{agent: "test", decisions: [null]}], remoteHosts: [], enabled: true, complete: true }]) {
      expect(() => parseDecisionsReport(data)).toThrow();
    }
    expect(parseDecisionsReport(decisionsInboxFixture()).groups).toHaveLength(3);
  });
  test("changing servers drops a late result and clears the previous server's decisions", async () => {
    const pending: ((data: unknown) => void)[] = [];
    const inbox = new DecisionsInbox(() => new Promise((resolve) => pending.push(resolve)), () => {});
    inbox.select("one");
    const one = inbox.refresh();
    inbox.select("two");
    const two = inbox.refresh();
    pending[1]!({ groups: [], remoteHosts: [], enabled: true, complete: true });
    await two;
    pending[0]!(decisionsInboxFixture());
    await one;
    expect(inbox.connection).toBe("two");
    expect(inbox.report?.groups).toHaveLength(0);
    expect(inbox.loading).toBe(false);
    inbox.select(null);
    expect(inbox.report).toBeNull();
  });
  test("keeps the last good list on a failed refresh and does not duplicate requests", async () => {
    let fail = false;
    let calls = 0;
    const inbox = new DecisionsInbox(async () => {
      calls++;
      if (fail) throw new Error("Server offline");
      return decisionsInboxFixture();
    }, () => {});
    inbox.select("one");
    await Promise.all([inbox.refresh(), inbox.refresh()]);
    expect(calls).toBe(1);
    fail = true;
    await inbox.refresh();
    expect(inbox.report?.groups).toHaveLength(3);
    expect(inbox.error).toBe("Server offline");
    expect(inbox.loading).toBe(false);
  });
  test("a post-mutation refresh invalidates an older periodic response", async () => {
    const pending: ((data: unknown) => void)[] = [];
    const inbox = new DecisionsInbox(() => new Promise((resolve) => pending.push(resolve)), () => {});
    inbox.select("one");
    const stale = inbox.refresh();
    const latest = inbox.refreshLatest();
    pending[1]!({ groups: [], remoteHosts: [], enabled: true, complete: true });
    await latest;
    pending[0]!(decisionsInboxFixture());
    await stale;
    expect(inbox.report?.groups).toEqual([]);
    expect(inbox.loading).toBe(false);
  });
});


test("fixture inbox and agent cards expose the same open questions without permitting anonymous reads", async () => {
  const fixture = startFixtureServer({ port: 0 });
  try {
    const headers = { authorization: `Bearer ${FIXTURE_TOKEN}` };
    expect((await fetch(fixture.url + "/api/decisions")).status).toBe(401);
    const response = await fetch(fixture.url + "/api/decisions", { headers });
    expect(response.headers.get("cache-control")).toBe("no-store");
    const report = parseDecisionsReport(await response.json());
    const card = await (await fetch(fixture.url + "/api/agents/chart-table/decisions", { headers })).json() as { decisions: {id: string}[] };
    expect(card.decisions.map((d: {id: string}) => d.id)).toEqual(report.groups.find((g) => g.agent === "chart-table")!.decisions.map((d) => d.id));
    expect(await (await fetch(fixture.url + "/api/agents/annex:paper-crane/decisions", { headers })).json()).toEqual({ decisions: [], remote: true });
    expect(report.groups.some((g) => g.agent === "archived-design")).toBe(true);
    const mutation = async (body: unknown) => fetch(fixture.url + "/api/decisions/answer", {
      method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify(body),
    });
    expect(await (await mutation({ agent: "chart-table", id: "d-1", action: "answer", answer: "Keep the legend" })).json())
      .toEqual({ ok: true, changed: true, status: "decided" });
    expect(await (await mutation({ agent: "chart-table", id: "d-2", action: "withdraw", reason: "Covered elsewhere" })).json())
      .toEqual({ ok: true, changed: true, status: "withdrawn" });
    expect((await mutation({ agent: "chart-table", id: "d-1", action: "withdraw" })).status).toBe(409);
    expect(await (await fetch(fixture.url + "/api/agents/chart-table/decisions", { headers })).json()).toEqual({ decisions: [] });
  } finally { fixture.stop(); }
});
