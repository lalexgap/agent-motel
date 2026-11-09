import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const source = readFileSync(new URL("../web/app.js", import.meta.url), "utf8");

function dock(rows: any[], conciergeKey = "server:concierge") {
  const elements = new Map<string, any>();
  const $ = (id: string) => {
    if (!elements.has(id)) elements.set(id, { textContent: "", hidden: false });
    return elements.get(id);
  };
  const state = { rows, conciergeKey };
  const context = { $, state, key: (row: any) => row.host ? `${row.host}:${row.name}` : row.name,
    statusName: (status: string) => status === "idle" ? "Available" : "Stopped" };
  const start = source.indexOf("function renderDockIdentity(");
  expect(start).toBeGreaterThanOrEqual(0);
  runInNewContext(source.slice(start, source.indexOf("async function refreshDock(", start)), context);
  const render = () => runInNewContext("renderDockIdentity()", context);
  render();
  return { $, state, render };
}

test.each(["claude", "codex", "antigravity"])("dock uses the resolved host's %s concierge", provider => {
  const view = dock([
    { name: "concierge", provider: "codex", status: "exited" },
    { name: "concierge", host: "server", provider, status: "idle" },
  ]);
  expect(view.$("dock-provider").textContent.toLowerCase()).toBe(provider);
  expect(view.$("dock-location").textContent).toBe("server · Available");
  view.$("dock-status").textContent = "Message accepted";
  view.render();
  expect(view.$("dock-provider").textContent.toLowerCase()).toBe(provider);
  expect(view.$("dock-status").textContent).toBe("Message accepted");
  view.state.rows = [];
  view.render();
  expect(view.$("dock-provider").textContent).toBe("Unknown provider");
  expect(view.$("dock-location").textContent).toBe("server · Unavailable");
});

test("local concierge identity and status do not use a remote namesake", () => {
  const view = dock([{ name: "concierge", provider: "claude", status: "exited" }], "concierge");
  expect(view.$("dock-provider").textContent).toBe("Claude");
  expect(view.$("dock-location").textContent).toBe("This server · Stopped");
});
