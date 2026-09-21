import { afterEach, describe, expect, test } from "bun:test";
import {
  createEventPump,
  hostRenderState,
  refreshHost,
  resetFleetCacheForTests,
  setFleetFetchForTests,
  subscribeFleetCache,
  fleetPickerItem,
  splitSubagentKey,
  subagentKey,
  subagentPickerItems,
  type FleetRow,
} from "../src/fleet";

async function until(cond: () => boolean, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error("condition not reached in time");
    await Bun.sleep(5);
  }
}

function row(name: string, status = "idle"): FleetRow {
  return { name, status, host: "srv" } as unknown as FleetRow;
}

afterEach(() => {
  setFleetFetchForTests();
  resetFleetCacheForTests();
});

describe("createEventPump", () => {
  test("coalesces a burst of events into one refresh", async () => {
    const calls: string[] = [];
    const pump = createEventPump(
      async (host) => {
        calls.push(host);
      },
      20,
      10,
    );
    pump("srv");
    pump("srv");
    pump("srv");
    await Bun.sleep(80);
    expect(calls).toEqual(["srv"]);
  });

  test("an event landing mid-refresh triggers exactly one follow-up", async () => {
    let release: () => void = () => {};
    const calls: string[] = [];
    const pump = createEventPump(
      async (host) => {
        calls.push(host);
        if (calls.length === 1) {
          await new Promise<void>((resolve) => {
            release = resolve;
          });
        }
      },
      10,
      10,
    );
    pump("srv");
    await until(() => calls.length === 1);
    // The first refresh is in flight and predates these events.
    pump("srv");
    pump("srv");
    release();
    await until(() => calls.length === 2);
    await Bun.sleep(60);
    expect(calls).toEqual(["srv", "srv"]);
  });

  test("spaces consecutive fetches for a churning host", async () => {
    const stamps: number[] = [];
    const pump = createEventPump(
      async () => {
        stamps.push(Date.now());
      },
      5,
      60,
    );
    const churn = setInterval(() => pump("srv"), 10);
    try {
      await until(() => stamps.length === 3);
    } finally {
      clearInterval(churn);
    }
    expect(stamps[1]! - stamps[0]!).toBeGreaterThanOrEqual(55);
    expect(stamps[2]! - stamps[1]!).toBeGreaterThanOrEqual(55);
  });

  test("hosts pump independently", async () => {
    const calls: string[] = [];
    const pump = createEventPump(
      async (host) => {
        calls.push(host);
      },
      10,
      10,
    );
    pump("a");
    pump("b");
    await until(() => calls.length === 2);
    expect(calls.sort()).toEqual(["a", "b"]);
  });

  test("a refresh failure does not wedge the pump", async () => {
    let attempts = 0;
    const pump = createEventPump(
      async () => {
        attempts++;
        throw new Error("ssh exploded");
      },
      10,
      10,
    );
    pump("srv");
    await until(() => attempts === 1);
    pump("srv");
    await until(() => attempts === 2);
  });
});

describe("refreshHost", () => {
  test("a changed fetch notifies cache subscribers; an identical one does not", async () => {
    let notified = 0;
    const unsubscribe = subscribeFleetCache(() => notified++);
    try {
      setFleetFetchForTests(async () => [row("alpha")]);
      await refreshHost("srv", { force: true });
      expect(notified).toBe(1);
      await refreshHost("srv", { force: true });
      expect(notified).toBe(1); // same rows — no repaint signal
      setFleetFetchForTests(async () => [row("alpha", "working")]);
      await refreshHost("srv", { force: true });
      expect(notified).toBe(2);
    } finally {
      unsubscribe();
    }
  });

  test("a failed fetch keeps prior rows and okAt", async () => {
    setFleetFetchForTests(async () => [row("alpha")]);
    await refreshHost("srv", { force: true });
    setFleetFetchForTests(async () => null);
    await refreshHost("srv", { force: true });
    let notified = 0;
    const unsubscribe = subscribeFleetCache(() => notified++);
    try {
      setFleetFetchForTests(async () => [row("alpha")]);
      await refreshHost("srv", { force: true });
      // identical to the surviving rows — proves the failure didn't wipe them
      expect(notified).toBe(0);
    } finally {
      unsubscribe();
    }
  });

  test("a forced refresh waits out an in-flight fetch, then fetches again", async () => {
    let release: () => void = () => {};
    let fetches = 0;
    setFleetFetchForTests(async () => {
      fetches++;
      if (fetches === 1) {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return [row("stale")];
      }
      return [row("fresh")];
    });
    const first = refreshHost("srv", { force: true });
    await until(() => fetches === 1);
    const second = refreshHost("srv", { force: true }); // must not be satisfied by fetch #1
    await Bun.sleep(20);
    expect(fetches).toBe(1); // second is waiting, not racing
    release();
    await Promise.all([first, second]);
    expect(fetches).toBe(2);
  });

  test("a non-forced refresh is satisfied by the in-flight fetch", async () => {
    let release: () => void = () => {};
    let fetches = 0;
    setFleetFetchForTests(async () => {
      fetches++;
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return [row("alpha")];
    });
    const first = refreshHost("srv", { force: true });
    await until(() => fetches === 1);
    const second = refreshHost("srv");
    release();
    await Promise.all([first, second]);
    expect(fetches).toBe(1);
  });
});

describe("hostRenderState", () => {
  const now = 1_000_000;

  test("fresh okAt renders rows", () => {
    expect(hostRenderState({ okAt: now - 5000, inFlight: null }, false, now)).toBe("rows");
  });

  test("stale okAt without a stream reads unreachable", () => {
    expect(hostRenderState({ okAt: now - 60_000, inFlight: null }, false, now)).toBe("unreachable");
  });

  test("a healthy push stream keeps a stale-okAt host reachable", () => {
    // The relaxed 15s poll window plus the 10s fetch timeout can outlive the
    // 30s grace — a single slow poll must not flap the host.
    expect(hostRenderState({ okAt: now - 40_000, inFlight: null }, true, now)).toBe("rows");
  });

  test("first fetch in flight stays silent rather than flapping", () => {
    expect(hostRenderState({ okAt: 0, inFlight: Promise.resolve() }, false, now)).toBe("pending");
    expect(hostRenderState(undefined, false, now)).toBe("pending");
  });

  test("a host that never succeeded and has no stream reads unreachable once settled", () => {
    expect(hostRenderState({ okAt: 0, inFlight: null }, false, now)).toBe("unreachable");
  });
});

describe("subagent rows", () => {
  const row: FleetRow = {
    name: "api",
    host: "server",
    status: "working",
    provider: "claude",
    queued: 0,
    updatedAt: "2026-09-21T10:00:00.000Z",
    dir: "/tmp",
    spawnedBy: "lead",
    subagents: {
      active: 2,
      types: "code-review, Explore",
      detail: "2 subagents · code-review, Explore",
      running: [
        { id: "aaaa1111bbbb", type: "Explore", startedAt: "2026-09-21T10:00:00.000Z" },
        { id: "cccc2222dddd", type: "code-review", startedAt: "2026-09-21T10:01:00.000Z" },
      ],
    },
  };

  test("nest under their agent's key and can't be attached to", () => {
    const items = subagentPickerItems(row);
    expect(items.map((i) => i.parent)).toEqual(["server:api", "server:api"]);
    expect(items.map((i) => i.label)).toEqual(["Explore", "code-review"]);
    expect(items.every((i) => i.attachable === false && i.roleFilterable === false)).toBe(true);
    expect(items[0]!.meta?.at(-1)).toBe("output   am peek api --subagent aaaa1111 --follow");
  });

  test("a described subagent is labelled by what it was asked, with its type on the card", () => {
    const described: FleetRow = {
      ...row,
      subagents: {
        active: 1,
        types: "Shepherd PR 74",
        detail: "1 subagent · Shepherd PR 74",
        running: [{ id: "eeee5555", type: "general-purpose", description: "Shepherd PR 74", startedAt: "2026-09-21T10:00:00.000Z" }],
      },
    };
    const [item] = subagentPickerItems(described);
    expect(item!.label).toBe("Shepherd PR 74");
    expect(item!.meta).toContain("type     general-purpose");
    expect(item!.search).toContain("general-purpose");
  });

  test("keys round-trip through the separator", () => {
    const key = subagentKey("server:api", "aaaa1111bbbb");
    expect(splitSubagentKey(key)).toEqual({ agentKey: "server:api", id: "aaaa1111bbbb" });
    expect(splitSubagentKey("server:api")).toBeNull();
  });

  test("an agent's own row no longer nests under whoever spawned it", () => {
    const item = fleetPickerItem(row);
    expect(item.parent).toBeUndefined();
    // Still a fact on the card.
    expect(item.meta?.some((line) => line.startsWith("parent   lead"))).toBe(true);
  });

  test("a remote host that predates running records yields no rows", () => {
    const older: FleetRow = { ...row, subagents: { active: 1, types: "Explore", detail: "1 subagent · Explore" } };
    expect(subagentPickerItems(older)).toEqual([]);
  });
});
