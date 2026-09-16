import { createGroup, deleteGroup, listGroups } from "./groups";
import { assignGroup, fleetGroups, type FleetGroup } from "./commands/group";
import { refreshHost, showSubjects, splitFleetKey, subjectView } from "./fleet";
import { loadConfig } from "./config";
import { sshAmAsync } from "./remote";
import type { PickerHandlers } from "./picker";

let remoteGroups: FleetGroup[] = [];
let refreshed = 0;
let fetching = false;

function cachedGroups(): FleetGroup[] {
  if (!fetching && Date.now() - refreshed > 5000) {
    fetching = true;
    void fleetGroups().then((result) => {
      remoteGroups = result.groups.filter((group) => group.host);
    }).catch(() => {}).finally(() => { fetching = false; refreshed = Date.now(); });
  }
  return [...listGroups(), ...remoteGroups];
}

export function groupChoices(action: "create" | "set" | "delete"): string[] {
  const groups = cachedGroups();
  if (action === "create") return [];
  if (action === "delete") return groups.filter((group) => !group.memberCount).map((group) => group.host ? `${group.host}:${group.name}` : group.name);
  return ["ungrouped", ...new Set(groups.map((group) => group.name))];
}

export async function editGroup(action: "create" | "set" | "delete", value: string, agent?: string): Promise<string> {
  if (action === "set") {
    if (!agent) throw new Error("select an agent first");
    const result = await assignGroup(agent, value === "ungrouped" ? undefined : value, true);
    const { host } = splitFleetKey(agent);
    if (host) await refreshHost(host, { force: true });
    refreshed = 0;
    showSubjects();
    return result;
  }
  const colon = value.indexOf(":");
  const host = colon >= 0 ? value.slice(0, colon) : undefined;
  const name = colon >= 0 ? value.slice(colon + 1) : value;
  if (host !== undefined) {
    if (!(loadConfig().remotes ?? []).includes(host)) throw new Error(`unknown host "${host}"`);
    const result = await sshAmAsync(host, ["group", action, name], { timeoutMs: 5000 });
    if (result.exitCode !== 0) throw new Error(result.stderr.trim() || `group ${action} failed on ${host}`);
  } else if (action === "create") createGroup(name);
  else deleteGroup(name);
  refreshed = 0;
  showSubjects();
  return `${action === "create" ? "created" : "deleted"} group ${value}`;
}

export const groupPickerHandlers: Pick<PickerHandlers, "editGroup" | "groupChoices" | "subjectSections" | "newGroupOptions"> = {
  editGroup,
  groupChoices,
  newGroupOptions: (host) => cachedGroups().filter((group) => group.host === host).map((group) => group.name),
  subjectSections: () => subjectView() ? [...new Set(cachedGroups().map((group) => group.name))].sort() : undefined,
};
