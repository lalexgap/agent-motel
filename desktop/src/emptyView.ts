// The main area with no agent open: fleet counts and the keyboard primer.
import { $, dot, h } from "./dom";
import { countStatuses } from "./fleet";
import { allRows, loadProblem, state, subscribe } from "./state";
import { registerMainView } from "./views";

function renderEmpty(): void {
  const rows = allRows();
  const counts = countStatuses(rows);
  const list = $("am-empty-counts");
  const loaded = [...state.conns.values()].every((conn) => conn.loaded);
  const problem = rows.length ? null : loadProblem();
  $("am-empty-title").textContent = rows.length ? `${rows.length} agent${rows.length === 1 ? "" : "s"} in the fleet`
    : loaded ? "No agents yet" : problem ? "Couldn't load the fleet" : "Loading the fleet…";
  $("am-empty-sub").textContent = rows.length ? "Pick an agent in the sidebar to read its conversation."
    : loaded ? "Agents you start with am new show up here." : problem ?? "";
  const entries: [string, string][] = [
    ["needs-attention", "Needs attention"], ["working", "Working"], ["waiting", "Waiting"], ["starting", "Starting"], ["idle", "Idle"], ["exited", "Exited"], ["dead", "Offline"],
  ];
  list.replaceChildren(...entries.filter(([status]) => counts[status as keyof typeof counts] > 0 || ["working", "idle", "needs-attention"].includes(status)).map(([status, label]) => {
    const item = h("li");
    item.append(dot(status), h("span", "", label), h("b", "", String(counts[status as keyof typeof counts])));
    return item;
  }));
}

export function initEmptyView(): void {
  registerMainView({ id: "empty", element: $("am-empty"), onShow: renderEmpty });
  subscribe("fleet", () => {
    if (!state.selected) renderEmpty();
  });
}
