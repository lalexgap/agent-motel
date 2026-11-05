import { describe, expect, test } from "bun:test";
import { buildPromptKeys, detectClaudePrompt } from "../src/panePrompts";

// Reconstructed from installed Claude 2.1.318 embedded W7/Qe/Fi/M4 source,
// not recordings of a running agent. W7 renders the tabs, numbered rows,
// inline Other placeholder, Chat row and Enter/navigation/Esc footer.
const question = `Earlier conversation
──────────────────────────────
← ☐ Color ✔ Submit →

Which color?

❯ 1. Blue
     Calm
  2. Green
     Fresh
  3. Type something.
──────────────────────────────
  4. Chat about this

Enter to select · ↑/↓ to navigate · Esc to cancel`;

const permission = `──────────────────────────────
Bash command

  pwd

Do you want to proceed?
❯ 1. Yes
  2. Yes, and don't ask again for this command
  3. No

Esc to cancel · Tab to amend`;

function parse(pane = question) {
  const prompt = detectClaudePrompt(pane);
  expect(prompt).not.toBeNull();
  return prompt!;
}

describe("detectClaudePrompt", () => {
  test("recognizes a selected question with descriptions and Other", () => {
    const prompt = parse();
    expect(prompt.kind).toBe("question");
    expect(prompt.title).toBe("Which color?");
    expect(prompt.selected).toBe("1");
    expect(prompt.options).toEqual([
      { id: "1", label: "Blue", description: "Calm" },
      { id: "2", label: "Green", description: "Fresh" },
      { id: "3", label: "Other", other: true },
    ]);
    expect(prompt.id).toMatch(/^[a-f0-9]{64}$/);
    expect(prompt.raw).toContain("Chat about this");
  });

  test("recognizes permissions and keeps complete command context in the fingerprint", () => {
    const prompt = parse(permission);
    expect(prompt.kind).toBe("permission");
    expect(prompt.title).toBe("Do you want to proceed?");
    expect(prompt.options).toHaveLength(3);
    expect(prompt.id).not.toBe(parse(permission.replace("pwd", "ls")).id);
  });

  test("normalizes SGR, CRLF and trailing padding without discarding dialog details", () => {
    const pane = question.replace("Blue", "\x1b[36mBlue\x1b[0m").replaceAll("\n", "  \r\n") + "\r\n  \r\n";
    expect(parse(pane)).toEqual(parse());
  });

  test("hash covers title, descriptions, tabs, options, selected row and footer", () => {
    for (const changed of [
      question.replace("Which color?", "Which theme?"),
      question.replace("Calm", "Bright"),
      question.replace("Color ✔", "Theme ✔"),
      question.replace("Green", "Red"),
      question.replace("❯ 1.", "  1.").replace("  2.", "❯ 2."),
      question.replace("↑/↓ to navigate", "Tab/Arrow keys to navigate"),
    ]) expect(parse(changed).id).not.toBe(parse().id);
  });

  test("retains multiline titles and descriptions", () => {
    const prompt = parse(question.replace("Which color?", "Which color\nshould we use?").replace("     Calm", "     Calm\n     and quiet"));
    expect(prompt.title).toBe("Which color\nshould we use?");
    expect(prompt.options[0]?.description).toBe("Calm\nand quiet");
  });

  test.each([
    ["no footer", question.slice(0, question.lastIndexOf("Enter to select"))],
    ["no selected item", question.replace("❯ 1.", "  1.")],
    ["two selected items", question.replace("  2.", "❯ 2.")],
    ["answered history above composer", question + "\n❯ "],
    ["answered history above output", question + "\nWorking…"],
    ["clipped top of options", question.slice(question.indexOf("  2."))],
    ["missing middle option", question.replace("  2. Green\n     Fresh\n", "")],
    ["duplicate index", question.replace("  2.", "  1.")],
    ["selected Chat", question.replace("❯ 1.", "  1.").replace("  4.", "❯ 4.")],
    ["populated Other", question.replace("Type something.", "my typed answer")],
    ["multi-select checkboxes", question.replace("1. Blue", "1. ☐ Blue")],
    ["multi-select ASCII checkboxes", question.replace("1. Blue", "1. [ ] Blue")],
    ["multi-select footer", question.replace("Enter to select", "Space to toggle · Enter to select")],
    ["scroll indicator", question.replace("  2.", "↓ 2.")],
    ["unknown footer", question.replace("Esc to cancel", "Esc to close")],
    ["vim editor", question.replace("Enter to select", "-- INSERT -- · Enter to select")],
    ["terminal controls", question.replace("Blue", "\x1b[2JBlue")],
    ["markdown quotation", question.split("\n").map(line => "> " + line).join("\n")],
    ["ordinary list", "Choose one:\n1. Blue\n2. Green"],
    ["unknown permission heading", permission.replace("Do you want to proceed?", "Choose a theme")],
    ["disabled permission", permission.replace("1. Yes", "1. Yes (disabled)")],
    ["clipped permission", permission.replace("Do you want to proceed?", "This terminal is too small. Do you want to proceed?")],
    ["feedback input", permission.replace("3. No", "3. tell Claude what to do differently")],
  ])("rejects %s", (_name, pane) => {
    expect(detectClaudePrompt(pane)).toBeNull();
  });
});

describe("buildPromptKeys", () => {
  test("navigates then submits once, without numeric shortcut submission", () => {
    expect(buildPromptKeys(parse(), { optionId: "2" })).toEqual([{ key: "Down" }, { key: "Enter" }]);
    expect(buildPromptKeys(parse(), { optionId: "1" })).toEqual([{ key: "Enter" }]);
    expect(buildPromptKeys(parse(permission), { optionId: "3" })).toEqual([{ key: "Down" }, { key: "Down" }, { key: "Enter" }]);
  });

  test("moves up from the actual selection", () => {
    const prompt = parse(question.replace("❯ 1.", "  1.").replace("  2.", "❯ 2."));
    expect(buildPromptKeys(prompt, { optionId: "1" })).toEqual([{ key: "Up" }, { key: "Enter" }]);
  });

  test("Other focuses the inline input, inserts literal text, then submits once", () => {
    expect(buildPromptKeys(parse(), { optionId: "3", text: "紫色 $(literal)" })).toEqual([
      { key: "Down" }, { key: "Down" }, { text: "紫色 $(literal)" }, { key: "Enter" },
    ]);
    const focused = parse(question.replace("❯ 1.", "  1.").replace("  3.", "❯ 3."));
    expect(buildPromptKeys(focused, { optionId: "3", text: "red" })).toEqual([{ text: "red" }, { key: "Enter" }]);
    expect(buildPromptKeys(focused, { optionId: "2" })).toEqual([{ key: "Up" }, { key: "Enter" }]);
  });

  test.each(["", " ", "a\nb", "a\rb", "\x1b[A", "a\tb", "\x00", "\x7f", "\x85", "\u2028", "a".repeat(2001)])("rejects invalid Other text %j", text => {
    expect(() => buildPromptKeys(parse(), { optionId: "3", text })).toThrow();
  });

  test("rejects invalid option, unexpected text, missing Other text and modified prompt", () => {
    expect(() => buildPromptKeys(parse(), { optionId: "4" })).toThrow();
    expect(() => buildPromptKeys(parse(), { optionId: "2", text: "red" })).toThrow();
    expect(() => buildPromptKeys(parse(), { optionId: "3" })).toThrow();
    expect(() => buildPromptKeys({ ...parse(), selected: "2" }, { optionId: "1" })).toThrow();
    expect(() => buildPromptKeys({ ...parse(), raw: question + "\n❯ " }, { optionId: "1" })).toThrow();
  });
});
