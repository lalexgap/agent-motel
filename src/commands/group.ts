import { createGroup, deleteGroup, listGroups, setAgentGroup, withGroupsTransaction, type AgentGroup } from "../groups";
import { resolveAgent } from "../state";
import { loadConfig } from "../config";
import { splitFleetKey } from "../fleet";
import { sshAmAsync } from "../remote";

export interface FleetGroup extends AgentGroup { host?: string }

export async function fleetGroups(localOnly = false, run = sshAmAsync): Promise<{ groups: FleetGroup[]; unreachable: string[] }> {
  const groups: FleetGroup[] = listGroups();
  const unreachable: string[] = [];
  if (!localOnly) await Promise.all((loadConfig().remotes ?? []).map(async (host) => {
    try {
      const result = await run(host, ["group", "list", "--json", "--local-only"], { timeoutMs: 4000 });
      if (result.exitCode !== 0) throw new Error(result.stderr);
      const data = JSON.parse(result.stdout);
      if (!Array.isArray(data.groups)) throw new Error("invalid groups response");
      const remote = data.groups.map((group: AgentGroup) => {
        if (!group || typeof group.name !== "string" || typeof group.memberCount !== "number") throw new Error("invalid group");
        return { name: group.name, memberCount: group.memberCount, host };
      });
      groups.push(...remote);
    } catch { unreachable.push(host); }
  }));
  groups.sort((a, b) => a.name.localeCompare(b.name) || (a.host ?? "").localeCompare(b.host ?? ""));
  return { groups, unreachable: unreachable.sort() };
}

export async function assignGroup(key: string, group?: string, create = false, run = sshAmAsync): Promise<string> {
  const { host, name } = splitFleetKey(key);
  if (!name) throw new Error("agent name is required");
  if (host) {
    const args = group ? ["group", "set", name, group, ...(create ? ["--create"] : [])] : ["group", "clear", name];
    const result = await run(host, args, { timeoutMs: 5000 });
    if (result.exitCode !== 0) throw new Error(result.stderr.trim() || `group assignment failed on ${host}; check its am version`);
  } else {
    withGroupsTransaction(() => setAgentGroup(resolveAgent(name).name, group, create));
  }
  return `${key} → ${group ?? "Ungrouped"}`;
}

export async function groupCommand(action: string | undefined, args: string[], opts: { json?: boolean; localOnly?: boolean; create?: boolean } = {}): Promise<void> {
  if (!action || action === "list" || action === "ls") {
    const result = await fleetGroups(opts.localOnly);
    if (opts.json) console.log(JSON.stringify(result, null, 2));
    else {
      for (const group of result.groups) console.log(`${group.name}  ${group.memberCount} agents  (${group.host ?? "local"})`);
      if (!result.groups.length) console.log("no groups — create one with am group create <name>");
      for (const host of result.unreachable) console.log(`(${host}: groups unavailable — unreachable or older am)`);
    }
    return;
  }
  const name = args[0];
  if (!name) throw new Error(`am group ${action} requires a name`);
  if (action === "create") {
    createGroup(name);
    console.log(`created group "${name}"`);
  } else if (action === "delete" || action === "rm") {
    deleteGroup(name);
    console.log(`deleted group "${name}"`);
  } else if (action === "set") {
    if (!args[1]) throw new Error("usage: am group set <agent> <group> [--create]");
    console.log(await assignGroup(name, args[1], opts.create));
  } else if (action === "clear") {
    console.log(await assignGroup(name));
  } else throw new Error(`unknown group action "${action}" — use create, list, set, clear, or delete`);
}
