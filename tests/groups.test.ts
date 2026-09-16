import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { agentGroup, createGroup, deleteGroup, listGroups, setAgentGroup, withGroupsTransaction } from "../src/groups";
import { readAgent, removeAgent, writeAgent, type AgentState } from "../src/state";
import { assignGroup, fleetGroups } from "../src/commands/group";
import { renameAgent } from "../src/commands/rename";
import { importPayload } from "../src/commands/move";
import { restoreCommand } from "../src/commands/restore";
import { destroyAgent } from "../src/commands/rm";
import { readTrashedState, trashState } from "../src/trash";
import { filterRowsByGroup, type AgentRow } from "../src/commands/ls";
import { fleetPickerItem, sectionFor, showSubjects, sortFleetRows, toggleGroupMode } from "../src/fleet";
import { editGroup, groupChoices } from "../src/groupUi";
import { remoteNewCommandArgs } from "../src/commands/ui";

let home: string;
let previous: string | undefined;
const entry = resolve(import.meta.dir, "../src/index.ts");

beforeEach(() => {
  previous = process.env.AGENTMGR_HOME;
  home = mkdtempSync(join(tmpdir(), "am-groups-"));
  process.env.AGENTMGR_HOME = home;
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  if (previous === undefined) delete process.env.AGENTMGR_HOME;
  else process.env.AGENTMGR_HOME = previous;
  showSubjects();
  toggleGroupMode();
});
function agent(name: string): AgentState {
  const now = new Date().toISOString();
  return { name, status: "exited", tmuxSession: `am-test-groups-${process.pid}-${name}`, dir: home, createdAt: now, updatedAt: now };
}
function cli(...args: string[]) {
  return Bun.spawn([process.execPath, entry, "-L", ...args], { env: { ...process.env, AGENTMGR_HOME: home }, stdout: "pipe", stderr: "pipe" });
}
async function result(proc: ReturnType<typeof cli>) {
  const [code, out, err] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  return { code, out, err };
}

describe("subject groups", () => {
  test("legacy agents remain ungrouped and definitions can be empty", () => {
    writeAgent(agent("portal"));
    expect(readAgent("portal")?.group).toBeUndefined();
    createGroup("advertiser-portal");
    createGroup("advertiser-portal");
    expect(listGroups()).toEqual([{ name: "advertiser-portal", memberCount: 0 }]);
    deleteGroup("advertiser-portal");
    expect(listGroups()).toEqual([]);
  });

  test("validates names and refuses deletion of a nonempty group", async () => {
    for (const name of ["", "UPPER", "../escape", "a b", "a--b", "ungrouped", "x".repeat(65)]) expect(() => createGroup(name)).toThrow();
    writeAgent(agent("portal"));
    await expect(assignGroup("portal", "missing")).rejects.toThrow("unknown group");
    await assignGroup("portal", "advertiser-portal", true);
    expect(() => deleteGroup("advertiser-portal")).toThrow("not empty");
    await assignGroup("portal");
    await assignGroup("portal");
    deleteGroup("advertiser-portal");
  });

  test("stale status writes cannot undo assignment or resurrect cleared membership", async () => {
    writeAgent(agent("portal"));
    const stale = readAgent("portal")!;
    await assignGroup("portal", "advertiser-portal", true);
    writeAgent({ ...stale, status: "working" });
    const grouped = readAgent("portal")!;
    expect(grouped.group).toBe("advertiser-portal");
    await assignGroup("portal");
    writeAgent({ ...grouped, status: "idle" });
    expect(readAgent("portal")?.group).toBeUndefined();
    expect(JSON.parse(readFileSync(join(home, "agents/portal.json"), "utf8")).group).toBeUndefined();
  });

  test("resolves aliases and prefixes, and fails ambiguous assignments without creating a group", async () => {
    writeAgent({ ...agent("portal-api"), aliases: ["old-api"] });
    writeAgent(agent("portal-ui"));
    await expect(assignGroup("portal", "ambiguous", true)).rejects.toThrow("ambiguous");
    expect(listGroups()).toEqual([]);
    await assignGroup("old-api", "advertiser-portal", true);
    await assignGroup("portal-u", "advertiser-portal");
    expect(listGroups()).toEqual([{ name: "advertiser-portal", memberCount: 2 }]);
  });

  test("rename and removal/restore preserve membership", async () => {
    writeAgent(agent("portal"));
    await assignGroup("portal", "advertiser-portal", true);
    await renameAgent("portal", "portal-next");
    expect(agentGroup("portal")).toBeUndefined();
    expect(readAgent("portal-next")?.group).toBe("advertiser-portal");
    await assignGroup("portal", "billing", true);
    expect(agentGroup("portal-next")).toBe("billing");
    trashState(readAgent("portal-next")!);
    removeAgent("portal-next");
    expect(agentGroup("portal-next")).toBeUndefined();
    deleteGroup("billing");
    await restoreCommand("portal-next", { resume: false });
    expect(readAgent("portal-next")?.group).toBe("billing");
    expect(listGroups().find((group) => group.name === "billing")?.memberCount).toBe(1);
  });

  test("removal snapshots the latest assignment even when its state was read earlier", async () => {
    const stale = agent("portal");
    writeAgent(stale);
    await assignGroup("portal", "advertiser-portal", true);
    destroyAgent(stale, { clean: false });
    expect(readTrashedState("portal")?.group).toBe("advertiser-portal");
    expect(agentGroup("portal")).toBeUndefined();
  });

  test("move import creates missing definitions and handles legacy payloads", () => {
    importPayload(JSON.stringify({ state: { ...agent("portal"), group: "advertiser-portal" }, queue: [] }));
    expect(readAgent("portal")?.group).toBe("advertiser-portal");
    importPayload(JSON.stringify({ state: agent("legacy"), queue: [] }));
    expect(readAgent("legacy")?.group).toBeUndefined();
    expect(() => importPayload(JSON.stringify({ state: { ...agent("invalid"), group: "../bad" } }))).toThrow();
    expect(readAgent("invalid")).toBeNull();
  });

  test("a failed transaction rolls back membership and new definitions", () => {
    createGroup("first");
    setAgentGroup("portal", "first");
    expect(() => withGroupsTransaction(() => {
      setAgentGroup("portal", "second", true);
      throw new Error("rollback");
    })).toThrow("rollback");
    expect(agentGroup("portal")).toBe("first");
    expect(listGroups()).toEqual([{ name: "first", memberCount: 1 }]);
  });

  test("concurrent CLI assignments do not lose members", async () => {
    const names = Array.from({ length: 6 }, (_, i) => `portal-${i}`);
    names.forEach((name) => writeAgent(agent(name)));
    const results = await Promise.all(names.map((name) => result(cli("group", "set", name, "advertiser-portal", "--create"))));
    expect(results.map((r) => ({ code: r.code, err: r.err }))).toEqual(names.map(() => ({ code: 0, err: "" })));
    expect(listGroups()).toEqual([{ name: "advertiser-portal", memberCount: 6 }]);
    const listed = await result(cli("ls", "--local-only", "--json", "--group", "advertiser-portal"));
    expect(listed.code).toBe(0);
    expect(JSON.parse(listed.out).map((row: AgentRow) => row.name)).toEqual(names);
  });

  test("assignment racing deletion cannot leave a dangling membership", async () => {
    writeAgent(agent("portal"));
    createGroup("advertiser-portal");
    const [assigned, deleted] = await Promise.all([
      result(cli("group", "set", "portal", "advertiser-portal")),
      result(cli("group", "delete", "advertiser-portal")),
    ]);
    expect([assigned.code, deleted.code].sort()).toEqual([0, 1]);
    expect(agentGroup("portal") ? listGroups() : []).toEqual(assigned.code === 0 ? [{ name: "advertiser-portal", memberCount: 1 }] : []);
  });

  test("unknown --group fails before launching an agent", async () => {
    const res = await result(cli("new", "portal", "--group", "missing", "--no-jump"));
    expect(res.code).toBe(1);
    expect(res.err).toContain("unknown group");
    expect(readAgent("portal")).toBeNull();
  });

  test("CLI JSON and local-only discovery preserve empty groups", async () => {
    expect((await result(cli("group", "create", "advertiser-portal"))).code).toBe(0);
    const res = await result(cli("group", "list", "--json", "--local-only"));
    expect(JSON.parse(res.out)).toEqual({ groups: [{ name: "advertiser-portal", memberCount: 0 }], unreachable: [] });
    expect(await fleetGroups(true)).toEqual(JSON.parse(res.out));
  });

  test("UI actions share CLI state, create-and-assign, and clear membership", async () => {
    writeAgent(agent("portal"));
    await editGroup("create", "advertiser-portal");
    expect(groupChoices("set")).toContain("advertiser-portal");
    await editGroup("set", "advertiser-portal", "portal");
    await editGroup("set", "billing", "portal");
    expect(readAgent("portal")?.group).toBe("billing");
    await editGroup("set", "ungrouped", "portal");
    await editGroup("delete", "billing");
    expect(readAgent("portal")?.group).toBeUndefined();
    await expect(editGroup("create", "unknown-host:foo")).rejects.toThrow("unknown host");
  });

  test("remote assignments route to the owner and failures do not change local membership", async () => {
    writeAgent(agent("portal"));
    await assignGroup("portal", "local-subject", true);
    const calls: string[][] = [];
    const run = async (host: string, args: string[]) => {
      calls.push([host, ...args]);
      return { exitCode: 0, stdout: "assigned", stderr: "" };
    };
    await assignGroup("server:portal", "remote-subject", true, run);
    await assignGroup("server:portal", undefined, false, run);
    expect(calls).toEqual([
      ["server", "group", "set", "portal", "remote-subject", "--create"],
      ["server", "group", "clear", "portal"],
    ]);
    await expect(assignGroup("server:portal", "remote-subject", false, async () => ({ exitCode: 1, stdout: "", stderr: "unsupported command" }))).rejects.toThrow("unsupported command");
    expect(agentGroup("portal")).toBe("local-subject");
  });

  test("fleet group discovery reports unavailable hosts and discards malformed responses", async () => {
    createGroup("portal");
    writeFileSync(join(home, "config.json"), JSON.stringify({ remotes: ["server", "old", "broken"] }));
    const data = await fleetGroups(false, async (host, args) => {
      expect(args).toEqual(["group", "list", "--json", "--local-only"]);
      return host === "old" ? { exitCode: 1, stdout: "", stderr: "unsupported" } : {
        exitCode: 0, stderr: "", stdout: JSON.stringify({ groups: host === "server"
          ? [{ name: "portal", memberCount: 2 }]
          : [{ name: "partial", memberCount: 1 }, null] }),
      };
    });
    expect(data).toEqual({ groups: [{ name: "portal", memberCount: 0 }, { name: "portal", memberCount: 2, host: "server" }], unreachable: ["broken", "old"] });
  });

  test("subjects combine hosts, sort Ungrouped last, and remain searchable", () => {
    const row = (name: string, group?: string, host?: string) => ({ ...agent(name), provider: "codex" as const, queued: 0, group, host });
    const rows = [row("none"), row("remote", "portal", "server"), row("api", "portal"), row("billing", "billing")];
    expect(sortFleetRows(rows, "subject").map((r) => r.name)).toEqual(["billing", "api", "remote", "none"]);
    expect(sectionFor(rows[1]!, "subject")).toBe("portal");
    expect(filterRowsByGroup(rows, "portal")).toHaveLength(2);
    expect(filterRowsByGroup(rows, "ungrouped").map((r) => r.name)).toEqual(["none"]);
    showSubjects();
    const item = fleetPickerItem(rows[1]!);
    expect(item.label).toBe("remote@server");
    expect(item.search).toContain("portal");
    expect(item.meta).toContain("group    portal");
    expect(remoteNewCommandArgs({ name: "portal", group: "portal" })).toContain("--group");
  });
});
