import { describe, expect, test } from "bun:test";
import {
  AGENT_MENU_GROUPS,
  allowDefaultMenu,
  copyNameText,
  menuSections,
  placeMenu,
  pointInRects,
  type AgentMenuItem,
} from "../desktop/src/contextMenu";
import type { AgentRow } from "../desktop/src/types";

const row = (over: Partial<AgentRow> = {}): AgentRow => ({
  name: "harbor-lights",
  status: "idle",
  statusChangedAt: "2026-01-01T00:00:00Z",
  provider: "claude",
  dir: "/tmp/harbor",
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
  ...over,
});
const item = (id: string, group: AgentMenuItem["group"], over: Partial<AgentMenuItem> = {}): AgentMenuItem => ({
  id, label: id, group, run: () => {}, ...over,
});

describe("default web view menu", () => {
  test("only in editable controls or on a selection under the pointer", () => {
    expect(allowDefaultMenu({ editable: false, inSelection: false })).toBe(false);
    expect(allowDefaultMenu({ editable: true, inSelection: false })).toBe(true);
    expect(allowDefaultMenu({ editable: false, inSelection: true })).toBe(true);
    expect(allowDefaultMenu({ editable: true, inSelection: true })).toBe(true);
  });

  test("a point is inside a selection when it falls in one of its rects, edges included", () => {
    const rects = [{ left: 10, top: 10, right: 100, bottom: 30 }, { left: 10, top: 30, right: 50, bottom: 50 }];
    expect(pointInRects(10, 10, rects)).toBe(true);
    expect(pointInRects(40, 45, rects)).toBe(true);
    expect(pointInRects(80, 45, rects)).toBe(false);
    expect(pointInRects(5, 20, rects)).toBe(false);
    expect(pointInRects(20, 20, [])).toBe(false);
  });
});

describe("agent menu items", () => {
  test("groups render in a fixed order whatever the registration order, empty groups dropped", () => {
    const items = [item("remove", "danger"), item("copy-name", "copy"), item("open", "open"), item("stop", "lifecycle"), item("terminal", "open")];
    const sections = menuSections(items, row(), "home/harbor-lights");
    expect(sections.map((section) => section.group)).toEqual(["open", "lifecycle", "copy", "danger"]);
    expect(sections[0]!.entries.map((entry) => entry.item.id)).toEqual(["open", "terminal"]);
    expect(AGENT_MENU_GROUPS).toEqual(["open", "manage", "lifecycle", "copy", "danger"]);
  });

  test("visible hides an item, enabled greys it out, both see the row and key", () => {
    const seen: string[] = [];
    const items = [
      item("resume", "lifecycle", { visible: (agent) => agent.status === "exited" }),
      item("stop", "lifecycle", { enabled: (agent, key) => (seen.push(key), agent.status !== "exited") }),
    ];
    const live = menuSections(items, row(), "home/harbor-lights");
    expect(live[0]!.entries.map(({ item: entry, enabled }) => [entry.id, enabled])).toEqual([["stop", true]]);
    const stopped = menuSections(items, row({ status: "exited" }), "home/harbor-lights");
    expect(stopped[0]!.entries.map(({ item: entry, enabled }) => [entry.id, enabled])).toEqual([["resume", true], ["stop", false]]);
    expect(seen).toEqual(["home/harbor-lights", "home/harbor-lights"]);
  });

  test("no visible items, no sections", () => {
    expect(menuSections([item("resume", "lifecycle", { visible: () => false })], row(), "home/x")).toEqual([]);
  });
});

describe("Copy name", () => {
  test("the bare name for a local agent, host:name for a remote one", () => {
    expect(copyNameText("home/harbor-lights")).toBe("harbor-lights");
    expect(copyNameText("home/annex:kelp-forest")).toBe("annex:kelp-forest");
    expect(copyNameText("home/concierge")).toBe("concierge");
  });
});

describe("menu placement", () => {
  const viewport = { width: 1000, height: 700 };
  const size = { width: 180, height: 80 };
  test("opens at the point when it fits", () => {
    expect(placeMenu({ x: 100, y: 200 }, size, viewport)).toEqual({ left: 100, top: 200 });
  });
  test("shifts left and up to stay 8px inside the window", () => {
    expect(placeMenu({ x: 990, y: 690 }, size, viewport)).toEqual({ left: 812, top: 612 });
  });
  test("never goes past the top-left margin", () => {
    expect(placeMenu({ x: -20, y: 2 }, size, viewport)).toEqual({ left: 8, top: 8 });
    expect(placeMenu({ x: 50, y: 50 }, { width: 2000, height: 2000 }, viewport)).toEqual({ left: 8, top: 8 });
  });
});
