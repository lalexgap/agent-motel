import { describe, expect, test } from "bun:test";
import {
  asFeedback,
  clipAnsi,
  cycleField,
  editMenuHelp,
  EFFORT_OPTIONS,
  effortOptionsFor,
  effortStripOptions,
  modelOptionsFor,
  feedbackBanner,
  filterPaletteCommands,
  formFields,
  matchesPickerRole,
  nestPickerItems,
  parseMouseEvent,
  pickerRoleFilterOptions,
  preservedFieldIndex,
  renamedPickerKey,
  splitKeys,
  tmuxKeyBar,
  visibleItemsForRole,
  visibleWidth,
  wrapTokens,
} from "../src/picker";
import type { ProviderCatalog } from "../src/catalog";

const GREEN = "\x1b[38;2;158;206;106m";
const YELLOW_C = "\x1b[38;2;224;175;104m";
const RED_C = "\x1b[38;2;247;118;142m";

const RED = "\x1b[31m";
const BG = "\x1b[48;5;236m";
const RESET = "\x1b[0m";

describe("role filtering", () => {
  const items = [
    { name: "review", label: "review", role: "reviewer" },
    { name: "plain", label: "plain" },
    { name: "offline:", label: "offline", roleFilterable: false },
  ];

  test("does not count unreachable placeholders as unassigned agents", () => {
    expect(pickerRoleFilterOptions([items[0]!, items[2]!])).toEqual(["reviewer"]);
    expect(pickerRoleFilterOptions(items)).toEqual(["reviewer", "unassigned"]);
  });

  test("hides placeholders whenever a role filter is active", () => {
    expect(matchesPickerRole(items[2]!, null)).toBe(true);
    expect(matchesPickerRole(items[2]!, "unassigned")).toBe(false);
    expect(matchesPickerRole(items[0]!, "reviewer")).toBe(true);
  });

  test("an active role filter reveals matching exited agents", () => {
    const exited = { name: "old-review", label: "old-review", role: "reviewer", secondary: true };
    expect(visibleItemsForRole([exited], "", false, null)).toEqual([]);
    expect(visibleItemsForRole([exited], "", false, "reviewer")).toEqual([exited]);
  });

  test("can flatten the visible list without parent ordering or guides", () => {
    const child = { name: "child", label: "child", parent: "parent", section: "local" };
    const parent = { name: "parent", label: "parent", section: "local" };
    expect(visibleItemsForRole([child, parent], "", true, null, false)).toEqual([child, parent]);
  });
});

describe("parent nesting", () => {
  test("places descendants after their parent while preserving sibling rank", () => {
    const items = [
      { name: "urgent-child", label: "urgent-child", parent: "parent", section: "local" },
      { name: "root", label: "root", section: "local" },
      { name: "parent", label: "parent", section: "local" },
      { name: "grandchild", label: "grandchild", parent: "urgent-child", section: "local" },
      { name: "later-child", label: "later-child", parent: "parent", section: "local" },
    ];

    expect(nestPickerItems(items).map((item) => [item.name, item.depth ?? 0, item.treePrefix ?? ""])).toEqual([
      ["root", 0, ""],
      ["parent", 0, ""],
      ["urgent-child", 1, "├─ "],
      ["grandchild", 2, "│  └─ "],
      ["later-child", 1, "└─ "],
    ]);
  });

  test("promotes children when their parent is hidden or in another section", () => {
    const child = { name: "child", label: "child", parent: "parent", section: "local" };
    expect(nestPickerItems([child])).toEqual([child]);
    expect(nestPickerItems([
      { name: "parent", label: "parent", section: "remote" },
      child,
    ]).map((item) => [item.name, item.depth ?? 0])).toEqual([["parent", 0], ["child", 0]]);
  });

  test("keeps every agent visible when malformed state contains a cycle", () => {
    const nested = nestPickerItems([
      { name: "alpha", label: "alpha", parent: "beta", section: "local" },
      { name: "beta", label: "beta", parent: "alpha", section: "local" },
    ]);
    expect(nested.map((item) => item.name)).toEqual(["alpha", "beta"]);
  });
});

describe("visibleWidth", () => {
  test("ignores SGR escape sequences", () => {
    expect(visibleWidth("plain")).toBe(5);
    expect(visibleWidth(`${RED}red${RESET} text`)).toBe(8);
    expect(visibleWidth(`${BG}${RED}x${RESET}`)).toBe(1);
  });
});

describe("splitKeys", () => {
  test("splits batched arrows, printables, and enter", () => {
    expect(splitKeys("\x1b[A\x1b[A\r")).toEqual(["\x1b[A", "\x1b[A", "\r"]);
    expect(splitKeys("abc")).toEqual(["a", "b", "c"]);
  });

  test("bare esc stays a single key and CRLF collapses to one enter", () => {
    expect(splitKeys("\x1b")).toEqual(["\x1b"]);
    expect(splitKeys("\r\n")).toEqual(["\r"]);
  });

  test("application-mode (SS3) arrows normalize to CSI form", () => {
    expect(splitKeys("\x1bOC")).toEqual(["\x1b[C"]);
    expect(splitKeys("\x1bOA\x1bOB")).toEqual(["\x1b[A", "\x1b[B"]);
  });
});

describe("parseMouseEvent", () => {
  test("parses SGR button presses and one-based coordinates", () => {
    expect(parseMouseEvent("\x1b[<0;12;7M")).toEqual({
      button: 0,
      x: 12,
      y: 7,
      pressed: true,
    });
  });

  test("distinguishes releases and wheel events", () => {
    expect(parseMouseEvent("\x1b[<0;12;7m")?.pressed).toBe(false);
    expect(parseMouseEvent("\x1b[<64;2;3M")?.button).toBe(64);
  });

  test("rejects incomplete or unrelated input", () => {
    expect(parseMouseEvent("\x1b[<0;12M")).toBeNull();
    expect(parseMouseEvent("j")).toBeNull();
  });
});

describe("wrapTokens", () => {
  test("packs separator-delimited tokens into width-bounded lines", () => {
    expect(wrapTokens("a · b · c", 80)).toEqual(["a · b · c"]);
    expect(wrapTokens("aaaa · bbbb · cccc", 11)).toEqual(["aaaa · bbbb", "cccc"]);
  });

  test("an oversized single token still gets its own line", () => {
    expect(wrapTokens("tiny · enormous-token-here", 10)).toEqual(["tiny", "enormous-token-here"]);
  });
});

describe("asFeedback", () => {
  test("bare strings default to a success", () => {
    expect(asFeedback("stopped x")).toEqual({ text: "stopped x", level: "ok" });
  });
  test("passes structured results through and maps null", () => {
    expect(asFeedback({ text: "boom", level: "error" })).toEqual({ text: "boom", level: "error" });
    expect(asFeedback(null)).toBeNull();
    expect(asFeedback(undefined)).toBeNull();
  });
});

describe("feedbackBanner", () => {
  test("errors lead with ✕ and are colored red", () => {
    const cells = feedbackBanner({ text: "stop failed: nope", level: "error" }, 38);
    expect(cells[0]!.text).toBe("✕ stop failed: nope");
    expect(cells[0]!.style).toBe(RED_C);
  });

  test("warnings use ⚠ yellow, success uses ✓ green, info has no glyph", () => {
    expect(feedbackBanner({ text: "careful", level: "warn" }, 38)[0]).toMatchObject({ text: "⚠ careful", style: YELLOW_C });
    expect(feedbackBanner({ text: "done", level: "ok" }, 38)[0]).toMatchObject({ text: "✓ done", style: GREEN });
    expect(feedbackBanner({ text: "moving x…", level: "info" }, 38)[0]!.text).toBe("moving x…");
  });

  test("continuation lines indent to align under the glyph", () => {
    const cells = feedbackBanner({ text: "alpha bravo charlie delta echo foxtrot", level: "error" }, 16);
    expect(cells.length).toBeGreaterThan(1);
    expect(cells[0]!.text.startsWith("✕ ")).toBe(true);
    expect(cells.slice(1).every((c) => c.text.startsWith("  "))).toBe(true);
  });

  test("strips control bytes from ssh stderr (keeps the words)", () => {
    const cells = feedbackBanner({ text: "boom\r\tbang\x07done", level: "error" }, 40);
    expect(cells.map((c) => c.text).join("\n")).not.toMatch(/[\x00-\x08\x0b-\x1f]/);
    expect(cells[0]!.text).toContain("bang");
  });

  test("errors get a taller ceiling than routine messages", () => {
    const long = Array.from({ length: 60 }, (_, i) => `w${i}`).join(" ");
    const err = feedbackBanner({ text: long, level: "error" }, 10);
    const ok = feedbackBanner({ text: long, level: "ok" }, 10);
    expect(err.length).toBeGreaterThan(ok.length);
    expect(ok.length).toBeLessThanOrEqual(6);
    expect(err.length).toBeLessThanOrEqual(10);
  });
});

describe("formFields", () => {
  test("adds the where field (before dir) only when remotes exist", () => {
    expect(formFields(false)).toEqual(["name", "task", "dir", "provider", "model", "effort"]);
    expect(formFields(true)).toEqual(["name", "task", "where", "dir", "provider", "model", "effort"]);
  });

  test("adds a role selector only when custom roles exist", () => {
    expect(formFields(false, true)).toEqual(["name", "task", "dir", "role", "provider", "model", "effort"]);
    expect(formFields(true, true)).toEqual(["name", "task", "where", "dir", "role", "provider", "model", "effort"]);
  });

  test("preserves focus by field identity when async roles insert a field", () => {
    const before = formFields(true, false);
    const after = formFields(true, true);
    expect(before[5]).toBe("model");
    expect(preservedFieldIndex(before, 5, after)).toBe(6);
    expect(after[preservedFieldIndex(before, 5, after)]).toBe("model");
  });
});

describe("model and effort options", () => {
  const catalogs: ProviderCatalog[] = [
    {
      provider: "codex",
      models: [
        { id: "gpt-5.6-sol", label: "GPT-5.6-Sol", efforts: ["low", "medium", "high", "ultra"] },
        { id: "gpt-5.5", label: "GPT-5.5", efforts: ["low", "medium", "high"] },
      ],
      efforts: ["low", "medium", "high", "ultra"],
      modelsExhaustive: true,
      effortsExhaustive: true,
    },
    {
      provider: "claude",
      models: [{ id: "opus", efforts: [] }],
      efforts: ["low", "medium", "high", "xhigh", "max"],
      modelsExhaustive: false,
      effortsExhaustive: true,
    },
  ];

  test("the model cycle starts on the provider's default", () => {
    const options = modelOptionsFor(catalogs, "codex");
    expect(options[0]!.id).toBe("");
    expect(options.map((o) => o.id)).toEqual(["", "gpt-5.6-sol", "gpt-5.5"]);
  });

  test("without a catalog the model field offers only the default", () => {
    expect(modelOptionsFor([], "codex").map((o) => o.id)).toEqual([""]);
  });

  test("effort options narrow to the selected model", () => {
    expect(effortOptionsFor(catalogs, "codex", "")).toEqual(["default", "low", "medium", "high", "ultra"]);
    expect(effortOptionsFor(catalogs, "codex", "gpt-5.5")).toEqual(["default", "low", "medium", "high"]);
    expect(effortOptionsFor(catalogs, "claude", "opus")).toEqual(["default", "low", "medium", "high", "xhigh", "max"]);
  });

  test("an unreachable catalog leaves the built-in fallback", () => {
    expect(effortOptionsFor([], "claude", "")).toEqual(EFFORT_OPTIONS);
  });

  test("a selected level the list doesn't contain is shown, not hidden", () => {
    // Waiting on a remote catalog: the strip still displays what will be sent.
    expect(effortStripOptions([], "codex", "", "ultra")).toEqual([...EFFORT_OPTIONS, "ultra"]);
    expect(effortStripOptions(catalogs, "codex", "gpt-5.6-sol", "ultra"))
      .toEqual(["default", "low", "medium", "high", "ultra"]);
  });
});

describe("renamedPickerKey", () => {
  test("keeps the remote host qualifier", () => {
    expect(renamedPickerKey("alpha", "omega")).toBe("omega");
    expect(renamedPickerKey("server:alpha", "omega")).toBe("server:omega");
  });
});

describe("editMenuHelp", () => {
  test("surfaces rename in the selected-agent actions", () => {
    expect(editMenuHelp({ rename: () => "ok" })).toContain("n rename");
  });
});

describe("sidebar sort control", () => {
  test("surfaces the within-group activity toggle in the key bar", () => {
    expect(tmuxKeyBar("list", { resort: () => "ok" })).toContain(" s ");
  });
});

describe("sidebar hierarchy control", () => {
  test("surfaces the tree/flat toggle in the key bar", () => {
    expect(tmuxKeyBar("list", {})).toContain(" t ");
    expect(tmuxKeyBar("list", {})).toContain("tree/flat");
  });
});

describe("cycleField", () => {
  test("wraps forward and backward", () => {
    expect(cycleField(0, 3, 1)).toBe(1);
    expect(cycleField(2, 3, 1)).toBe(0); // wrap forward
    expect(cycleField(0, 3, -1)).toBe(2); // wrap backward
    expect(cycleField(1, 4, -1)).toBe(0);
  });
  test("is safe with no fields", () => {
    expect(cycleField(0, 0, 1)).toBe(0);
  });
});

describe("filterPaletteCommands", () => {
  const commands = [
    { id: "create", label: "Create agent", keywords: "new spawn", shortcut: "n" },
    { id: "search", label: "Search conversations", keywords: "chat transcript", shortcut: "/" },
    { id: "all", label: "Show exited agents", keywords: "all dead stopped", shortcut: "a" },
    { id: "stop", label: "Stop api", keywords: "exit kill", shortcut: "e x" },
  ];

  test("matches labels, keywords, shortcuts, and multiple terms", () => {
    expect(filterPaletteCommands(commands, "").map((c) => c.id)).toEqual(["create", "search", "all", "stop"]);
    expect(filterPaletteCommands(commands, "spawn").map((c) => c.id)).toEqual(["create"]);
    expect(filterPaletteCommands(commands, "search chat").map((c) => c.id)).toEqual(["search"]);
    expect(filterPaletteCommands(commands, "e x").map((c) => c.id)).toEqual(["stop"]);
    expect(filterPaletteCommands(commands, "stop").map((c) => c.id)).toEqual(["stop", "all"]);
  });
});

describe("clipAnsi", () => {
  test("passes lines that fit through unchanged", () => {
    const line = `${RED}short${RESET}`;
    expect(clipAnsi(line, 10)).toBe(line);
    expect(clipAnsi(line, 5)).toBe(line);
  });

  test("clips by visible width, keeping escapes intact", () => {
    const clipped = clipAnsi(`${RED}definitely too long${RESET}`, 10);
    expect(visibleWidth(clipped)).toBe(10);
    expect(clipped).toBe(`${RED}definitel…${RESET}`);
  });

  test("never splits an escape sequence at the boundary", () => {
    const clipped = clipAnsi(`abc${BG}def`, 4);
    expect(clipped).toBe(`abc…${BG}`);
  });

  test("preserves styles past the clip point so padding keeps the row's colors", () => {
    // Emulates a form row: typed value, cursor-block bg, row-base restore.
    // Dropping the trailing restore leaked the cursor bg into the padding.
    const clipped = clipAnsi(`${BG}typed value that overflows${RESET}tail`, 10);
    expect(visibleWidth(clipped)).toBe(10);
    expect(clipped.endsWith(RESET)).toBe(true);
  });
});
