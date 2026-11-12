import { afterEach, beforeEach, describe, expect, test, spyOn } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  agentPresence,
  agentRows,
  backgroundCount,
  busyPresence,
  displayStatus,
  paneWaitingInfo,
  STALLED_AFTER_MS,
  STALLED_FORGET_MS,
  waitingOnReason,
  type BusyInput,
} from "../src/commands/ls";
import { stopIfIdle } from "../src/commands/rm";
import { statusMatches, waitForStatus } from "../src/commands/wait";
import { drainStranded } from "../src/daemon";
import { deliverNext, releaseDeliverLock } from "../src/deliver";
import { ensureDirs } from "../src/paths";
import { queueAppend, queueDepth } from "../src/queue";
import { readAgent, writeAgent } from "../src/state";
import {
  closeOpenSubagents,
  completionAfter,
  foldEvents,
  lastReportedStop,
  QUIET_AFTER_MS,
  recordSubagentStart,
  recordSubagentStop,
  splitLive,
  type SubagentRecord,
} from "../src/subagents";
import { buildFleetSummary } from "../src/summary";

const NOW = Date.parse("2026-11-12T12:00:00Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const MIN = 60_000;

function sub(id: string, extra: Partial<SubagentRecord> = {}): SubagentRecord {
  return { id, type: "general-purpose", startedAt: ago(5 * MIN), ...extra };
}

function input(extra: Partial<BusyInput> = {}): BusyInput {
  return { status: "idle", idleSince: ago(20 * MIN), live: [], quiet: [], now: NOW, ...extra };
}

describe("busyPresence — what an idle agent is shown as", () => {
  test("live subagents make it working, with what it waits on", () => {
    const shown = busyPresence(input({
      live: [sub("a", { type: "shepherd", description: "Shepherd PR 29905" }), sub("b", { type: "reviewer" })],
    }));
    expect(shown).toEqual({
      status: "working",
      reason: "waiting on 2 subagents (Shepherd PR 29905, reviewer)",
      busyWith: { subagents: 2, background: 0 },
    });
  });

  test("background shells ride along in the count and the reason", () => {
    const shown = busyPresence(input({ status: "waiting", background: 2, live: [sub("a", { type: "shepherd" })] }));
    expect(shown.status).toBe("working");
    expect(shown.reason).toBe("waiting on 1 subagent (shepherd) and 2 shells");
    expect(shown.busyWith).toEqual({ subagents: 1, background: 2 });
  });

  test("shells alone stay waiting: a long-lived shell is not a turn in progress", () => {
    expect(busyPresence(input({ status: "waiting", background: 1 }))).toEqual({
      status: "waiting",
      busyWith: { subagents: 0, background: 1 },
    });
  });

  test("a wake-up timer is waiting on nothing that runs", () => {
    expect(busyPresence(input({ status: "waiting", background: 0 }))).toEqual({ status: "waiting", busyWith: undefined });
  });

  test("nothing running is plain idle", () => {
    expect(busyPresence(input())).toEqual({ status: "idle" });
  });

  test("a subagent that went silent does not pin the agent as working", () => {
    const shown = busyPresence(input({
      quiet: [sub("a", { description: "Shepherd PR 74" })],
      quietSince: NOW - 34 * MIN,
    }));
    expect(shown.status).toBe("needs-attention");
    expect(shown.stalled).toBe(true);
    expect(shown.reason).toBe("subagent silent for 34m, agent still waiting on it (Shepherd PR 74)");
    expect(shown.busyWith).toBeUndefined();
  });

  test("a live subagent beside a silent one is still work in progress", () => {
    const shown = busyPresence(input({ live: [sub("a")], quiet: [sub("b")], quietSince: NOW - 40 * MIN }));
    expect(shown.status).toBe("working");
    expect(shown.busyWith).toEqual({ subagents: 1, background: 0 });
  });

  test("a subagent that finished on an idle parent is flagged once the grace runs out", () => {
    const stop = sub("a", { description: "Shepherd PR 74", endedAt: ago(12 * MIN), endedBy: "stop" });
    const shown = busyPresence(input({ lastStop: stop }));
    expect(shown).toEqual({
      status: "needs-attention",
      stalled: true,
      reason: "subagent finished 12m ago, agent never resumed (Shepherd PR 74)",
    });
  });

  test("…but not while the parent can still be on its way to picking it up", () => {
    const stop = sub("a", { endedAt: ago(STALLED_AFTER_MS - MIN), endedBy: "stop" });
    expect(busyPresence(input({ lastStop: stop })).status).toBe("idle");
  });

  test("a turn since the subagent ended clears it: the idle is newer than the stop", () => {
    const stop = sub("a", { endedAt: ago(30 * MIN), endedBy: "stop" });
    expect(busyPresence(input({ lastStop: stop, idleSince: ago(25 * MIN) })).status).toBe("idle");
  });

  test("something else due to wake it (a shell, a timer) is not stalled", () => {
    const stop = sub("a", { endedAt: ago(12 * MIN), endedBy: "stop" });
    expect(busyPresence(input({ status: "waiting", background: 1, lastStop: stop })).status).toBe("waiting");
  });

  test("the flag is forgotten after a day", () => {
    const stop = sub("a", { startedAt: ago(STALLED_FORGET_MS + 60 * MIN), endedAt: ago(STALLED_FORGET_MS + MIN), endedBy: "stop" });
    expect(busyPresence(input({ lastStop: stop, idleSince: ago(STALLED_FORGET_MS + 30 * MIN) })).status).toBe("idle");
    expect(busyPresence(input({ quiet: [sub("a")], quietSince: NOW - STALLED_FORGET_MS - MIN })).status).toBe("idle");
  });
});

describe("waitingOnReason", () => {
  test("names each kind once and caps the list", () => {
    const live = ["Shepherd PR 1", "Shepherd PR 2", "reviewer", "reviewer", "engineer", "Explore"].map((description, i) =>
      sub(String(i), { description }));
    expect(waitingOnReason(live)).toBe("waiting on 6 subagents (Shepherd PR 1, Shepherd PR 2, reviewer +2)");
  });

  test("clips a long description", () => {
    const reason = waitingOnReason([sub("a", { description: "x".repeat(200) })]);
    expect(reason.length).toBeLessThan(90);
    expect(reason).toContain("…");
  });
});

describe("background shells in the pane indicator", () => {
  const SEP = "─".repeat(40);

  test("counts shells in each wording", () => {
    expect(backgroundCount("bypass permissions on · 2 shells · ← 1 agent")).toBe(2);
    expect(backgroundCount("1 shell")).toBe(1);
    expect(backgroundCount("3 background tasks running")).toBe(3);
    expect(backgroundCount("2 bashes running · 30k tokens")).toBe(2);
    expect(backgroundCount("background task running")).toBe(1);
    expect(backgroundCount("next wake-up in 4m")).toBe(0);
  });

  test("paneWaitingInfo carries the count", () => {
    expect(paneWaitingInfo([SEP, "  ⏵⏵ bypass permissions on · 2 shells"]).background).toBe(2);
    expect(paneWaitingInfo([SEP, "  ✶ next wake-up in 4m"]).background).toBe(0);
  });
});

describe("splitLive", () => {
  const fresh = NOW - MIN;
  const stale = NOW - QUIET_AFTER_MS - MIN;

  test("a subagent that wrote recently is live, a silent one is quiet", () => {
    const { live, quiet } = splitLive([{ id: "a", lastActivity: fresh }, { id: "b", lastActivity: stale }], NOW);
    expect(live.map((s) => s.id)).toEqual(["a"]);
    expect(quiet.map((s) => s.id)).toEqual(["b"]);
  });

  test("a silent subagent with a live one under it is live: it is waiting on its own", () => {
    const { live, quiet } = splitLive([
      { id: "shepherd", lastActivity: stale },
      { id: "reviewer", parentId: "shepherd", lastActivity: stale },
      { id: "nested", parentId: "reviewer", lastActivity: fresh },
      { id: "other", lastActivity: stale },
    ], NOW);
    expect(live.map((s) => s.id)).toEqual(["shepherd", "reviewer", "nested"]);
    expect(quiet.map((s) => s.id)).toEqual(["other"]);
  });

  test("a parent cycle in the sidecars cannot hang it", () => {
    const { live } = splitLive([
      { id: "a", parentId: "b", lastActivity: stale },
      { id: "b", parentId: "a", lastActivity: fresh },
    ], NOW);
    expect(live.map((s) => s.id)).toEqual(["a", "b"]);
  });
});

describe("how a subagent closed", () => {
  test("a reported stop and a turn-boundary sweep are told apart", () => {
    const records = foldEvents([
      { ev: "start", id: "a", type: "shepherd", at: ago(20 * MIN) },
      { ev: "start", id: "b", type: "Explore", at: ago(20 * MIN) },
      { ev: "stop", id: "a", at: ago(15 * MIN) },
      { ev: "turn-end", at: ago(10 * MIN) },
    ]);
    expect(records.map((r) => r.endedBy)).toEqual(["stop", "turn"]);
  });

  test("a restart under the same id is open again", () => {
    const records = foldEvents([
      { ev: "start", id: "a", at: ago(20 * MIN) },
      { ev: "stop", id: "a", at: ago(15 * MIN) },
      { ev: "start", id: "a", at: ago(14 * MIN) },
    ]);
    expect(records[0]!.endedAt).toBeUndefined();
    expect(records[0]!.endedBy).toBeUndefined();
  });

  test("compaction's rewrite keeps a sweep a sweep", () => {
    const records = foldEvents([
      { ev: "start", id: "a", at: ago(20 * MIN) },
      { ev: "stop", id: "a", at: ago(15 * MIN), turn: true },
    ]);
    expect(records[0]!.endedBy).toBe("turn");
  });

  test("lastReportedStop skips sweeps and the provider's startless helpers", () => {
    const records = foldEvents([
      { ev: "start", id: "real", type: "shepherd", at: ago(30 * MIN) },
      { ev: "stop", id: "real", at: ago(20 * MIN) },
      { ev: "start", id: "swept", at: ago(18 * MIN) },
      { ev: "turn-end", at: ago(15 * MIN) },
      // No start: the provider's own post-turn helper.
      { ev: "stop", id: "helper", at: ago(5 * MIN) },
    ]);
    expect(lastReportedStop(records)?.id).toBe("real");
    expect(lastReportedStop([])).toBeNull();
  });

  test("a notification found late is stamped with when it arrived", () => {
    const at = ago(40 * MIN);
    const line = JSON.stringify({ timestamp: at, content: "<task-notification>\n<task-id>abc</task-id>\n<status>completed</status>\n<summary>done</summary>" });
    expect(completionAfter([line], "abc", ago(60 * MIN))).toEqual({ status: "completed", summary: "done", at });
  });
});

describe("statusMatches", () => {
  test("an agent shown as working on its subagents is idle to a caller asking for idle", () => {
    expect(statusMatches("working", "idle", "idle")).toBe(true);
    expect(statusMatches("working", "working", "idle")).toBe(true);
    expect(statusMatches("needs-attention", "idle", "idle")).toBe(true);
  });

  test("a turn in progress, or a gone session, is not", () => {
    expect(statusMatches("working", "idle", "working")).toBe(false);
    expect(statusMatches("working", "idle")).toBe(false);
    expect(statusMatches("dead", "idle", "idle")).toBe(false);
  });
});

// A parent at its prompt with a background subagent running, on a fake tmux.
describe("an idle parent with a live subagent", () => {
  let home: string;
  let oldPath: string | undefined;
  let spawnSpy: ReturnType<typeof spyOn> | undefined;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "am-presence-"));
    process.env.AGENTMGR_HOME = home;
    oldPath = process.env.PATH;
    ensureDirs();
    writeFileSync(join(home, "input"), "");
    writeFileSync(join(home, "footer"), "  ⏵⏵ bypass permissions on · ← 1 agent · ↓ to manage");
    writeFileSync(join(home, "tmux"), `#!/bin/sh
case "$1" in
  has-session) exit 0 ;;
  display-message) echo 'server:session:pane:1' ;;
  capture-pane)
    echo '────────────────────'
    printf '❯ '; cat "$AGENTMGR_HOME/input"; echo
    echo '────────────────────'
    cat "$AGENTMGR_HOME/footer"; echo
    ;;
  send-keys)
    if [ "$4" = '-l' ]; then printf '%s' "$6" >> "$AGENTMGR_HOME/input"; else printf '' > "$AGENTMGR_HOME/input"; fi
    ;;
esac
exit 0
`);
    chmodSync(join(home, "tmux"), 0o755);
    process.env.PATH = `${home}:${oldPath}`;
    const spawn = Bun.spawnSync.bind(Bun);
    spawnSpy = spyOn(Bun, "spawnSync").mockImplementation((cmd: any, opts?: any) =>
      Array.isArray(cmd) && cmd[0] === "tmux"
        ? spawn([join(home, "tmux"), ...cmd.slice(1)], { ...opts, env: { ...process.env } })
        : spawn(cmd, opts));
  });

  afterEach(() => {
    spawnSpy?.mockRestore();
    releaseDeliverLock("api");
    process.env.PATH = oldPath;
    rmSync(home, { recursive: true, force: true });
    delete process.env.AGENTMGR_HOME;
  });

  // Each test gets its own tmux session name: the pane scrape is cached by it.
  let serial = 0;
  function parent(idleFor = 5 * MIN): void {
    const idleSince = new Date(Date.now() - idleFor).toISOString();
    writeAgent({
      name: "api",
      provider: "claude",
      status: "idle",
      statusChangedAt: idleSince,
      tmuxSession: `agentmgr-presence-${++serial}`,
      dir: home,
      createdAt: idleSince,
      updatedAt: idleSince,
    });
  }
  const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * MIN).toISOString();

  test("is shown as working, while its stored status stays idle", () => {
    parent();
    recordSubagentStart("api", { id: "s1", type: "shepherd", description: "Shepherd PR 29905", at: minutesAgo(3) });
    recordSubagentStart("api", { id: "r1", type: "reviewer", at: minutesAgo(2) });

    const presence = agentPresence(readAgent("api")!);
    expect(presence.status).toBe("working");
    expect(presence.rawStatus).toBe("idle");
    expect(presence.reason).toBe("waiting on 2 subagents (Shepherd PR 29905, reviewer)");
    expect(presence.busyWith).toEqual({ subagents: 2, background: 0 });
    expect(displayStatus(readAgent("api")!)).toBe("working");
    // Showing it never rewrites the state file.
    expect(readAgent("api")!.status).toBe("idle");
  });

  test("its row carries the derived status, the raw one and what it waits on", () => {
    parent();
    recordSubagentStart("api", { id: "s1", type: "shepherd", description: "Shepherd PR 29905", at: minutesAgo(3) });
    const row = agentRows().find((r) => r.name === "api")!;
    expect(row).toMatchObject({
      status: "working",
      rawStatus: "idle",
      statusReason: "waiting on 1 subagent (Shepherd PR 29905)",
      statusDetail: "waiting on 1 subagent (Shepherd PR 29905)",
      busyWith: { subagents: 1, background: 0 },
    });
    expect(row.subagents?.active).toBe(1);

    const summary = buildFleetSummary({ rows: [row], unreachable: [] } as any);
    expect(summary.active.map((item) => [item.name, item.reason])).toEqual([["api", "waiting on 1 subagent (Shepherd PR 29905)"]]);
    expect(summary.idle).toEqual([]);
    expect(summary.attention).toEqual([]);
  });

  test("still takes a queued message: delivery acts on the stored idle", async () => {
    parent();
    recordSubagentStart("api", { id: "s1", type: "shepherd", at: minutesAgo(3) });
    expect(displayStatus(readAgent("api")!)).toBe("working");

    const id = queueAppend("api", "peer note");
    const drain = drainStranded(readAgent("api")!);
    expect(drain).not.toBeNull();
    expect(await drain).toEqual({ status: "submitted", id });
    expect(queueDepth("api")).toBe(0);
  });

  test("am wait --status idle is satisfied by it", async () => {
    parent();
    recordSubagentStart("api", { id: "s1", type: "shepherd", at: minutesAgo(3) });
    expect(await waitForStatus("api", "idle", 2000)).toBe("reached");
    expect(await waitForStatus("api", "working", 2000)).toBe("reached");
  });

  test("a conditional stop refuses: it would take the subagents down with it", async () => {
    parent();
    recordSubagentStart("api", { id: "s1", type: "shepherd", description: "Shepherd PR 74", at: minutesAgo(3) });
    expect(await stopIfIdle(readAgent("api")!)).toEqual({
      ok: false,
      reason: "busy",
      error: 'agent "api" is working — waiting on 1 subagent (Shepherd PR 74)',
    });
    expect(readAgent("api")!.status).toBe("idle");
  });

  test("…and goes through once the subagent has reported and the parent took its turn", async () => {
    parent();
    recordSubagentStart("api", { id: "s1", type: "shepherd", at: minutesAgo(3) });
    recordSubagentStop("api", { id: "s1", at: minutesAgo(2) });
    writeAgent({ ...readAgent("api")!, statusChangedAt: minutesAgo(1) });
    expect(displayStatus(readAgent("api")!)).toBe("idle");
    expect(await stopIfIdle(readAgent("api")!)).toEqual({ ok: true });
  });

  test("a subagent silent past the window stops counting, and is flagged instead", async () => {
    parent(50 * MIN);
    recordSubagentStart("api", { id: "s1", type: "shepherd", description: "Shepherd PR 74", at: minutesAgo(45) });
    const presence = agentPresence(readAgent("api")!);
    expect(presence.status).toBe("needs-attention");
    expect(presence.stalled).toBe(true);
    expect(presence.busyWith).toBeUndefined();
    expect(presence.reason).toBe("subagent silent for 45m, agent still waiting on it (Shepherd PR 74)");
    const row = agentRows().find((r) => r.name === "api")!;
    expect(buildFleetSummary({ rows: [row], unreachable: [] } as any).attention.map((item) => item.name)).toEqual(["api"]);
    // Nothing is running, so nothing blocks the stop.
    expect(await stopIfIdle(readAgent("api")!)).toEqual({ ok: true });
  });

  test("a subagent that finished on a parent that never resumed is flagged", () => {
    parent(40 * MIN);
    recordSubagentStart("api", { id: "s1", type: "shepherd", description: "Shepherd PR 74", at: minutesAgo(45) });
    recordSubagentStop("api", { id: "s1", at: minutesAgo(15) });
    const presence = agentPresence(readAgent("api")!);
    expect(presence.status).toBe("needs-attention");
    expect(presence.reason).toBe("subagent finished 15m ago, agent never resumed (Shepherd PR 74)");
  });

  test("a subagent the turn boundary swept up is not a missed report", () => {
    parent(40 * MIN);
    recordSubagentStart("api", { id: "s1", type: "Explore", at: minutesAgo(45) });
    closeOpenSubagents("api", { at: minutesAgo(39) });
    expect(displayStatus(readAgent("api")!)).toBe("idle");
  });

  test("background shells alone read as waiting, with the count", () => {
    writeFileSync(join(home, "footer"), "  ⏵⏵ bypass permissions on · 2 shells · ↓ to manage");
    parent();
    const presence = agentPresence(readAgent("api")!);
    expect(presence.status).toBe("waiting");
    expect(presence.busyWith).toEqual({ subagents: 0, background: 2 });
  });

  test("a turn in progress is working on its own account, with no busyWith", () => {
    parent();
    writeAgent({ ...readAgent("api")!, status: "working" });
    recordSubagentStart("api", { id: "s1", type: "Explore", at: minutesAgo(1) });
    const row = agentRows().find((r) => r.name === "api")!;
    expect(row.status).toBe("working");
    expect(row.rawStatus).toBe("working");
    expect(row.busyWith).toBeUndefined();
    expect(row.statusDetail).toBe("1 subagent · Explore");
  });

  test("a raw needs-attention wins over live subagents", () => {
    parent();
    writeAgent({ ...readAgent("api")!, status: "needs-attention", statusReason: "approval requested — Bash" });
    recordSubagentStart("api", { id: "s1", type: "shepherd", at: minutesAgo(1) });
    const presence = agentPresence(readAgent("api")!);
    expect(presence.status).toBe("needs-attention");
    expect(presence.reason).toBe("approval requested — Bash");
  });
});

describe("a gone parent", () => {
  let home: string;
  let spawnSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "am-presence-gone-"));
    process.env.AGENTMGR_HOME = home;
    ensureDirs();
    spawnSpy = spyOn(Bun, "spawnSync").mockImplementation((argv: any) => ({
      exitCode: argv[0] === "tmux" && argv.includes("has-session") ? 1 : 0,
      stdout: Buffer.from(""),
      stderr: Buffer.from(""),
    }) as any);
  });

  afterEach(() => {
    spawnSpy.mockRestore();
    rmSync(home, { recursive: true, force: true });
    delete process.env.AGENTMGR_HOME;
  });

  test("an exited or dead parent is never working on a ledger left open", () => {
    const at = new Date().toISOString();
    for (const [name, status] of [["gone", "exited"], ["lost", "idle"]] as const) {
      writeAgent({ name, provider: "claude", status, statusChangedAt: at, tmuxSession: `agentmgr-${name}`, dir: home, createdAt: at, updatedAt: at });
      recordSubagentStart(name, { id: "s1", type: "shepherd", at });
    }
    expect(agentPresence(readAgent("gone")!)).toMatchObject({ status: "exited", rawStatus: "exited" });
    expect(agentPresence(readAgent("lost")!)).toMatchObject({ status: "dead", rawStatus: "idle" });
    for (const row of agentRows()) {
      expect(row.busyWith).toBeUndefined();
      expect(row.subagents).toBeUndefined();
    }
  });
});
