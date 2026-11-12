import { describe, expect, test } from "bun:test";
import { DecisionsInbox, parseDecisionsReport } from "../desktop/src/decisionsInbox";
import { decisionsInboxFixture } from "../desktop/fixtures/decisionsInbox";
import { FIXTURE_TOKEN, startFixtureServer } from "../desktop/fixtures/server";
import { validateApiPath } from "../desktop/src/policy";

describe("decisions inbox requests", () => {
  test("the native GET path policy permits the read endpoint", () => {
    expect(() => validateApiPath("/api/decisions")).not.toThrow();
  });
  test("rejects incompatible server data", () => {
    for (const data of [null, {}, { groups: [], remoteHosts: [], enabled: 1 }, { groups: [{agent: "test", decisions: [null]}], remoteHosts: [], enabled: true }]) {
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
    pending[1]!({ groups: [], remoteHosts: [], enabled: true });
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
  } finally { fixture.stop(); }
});
