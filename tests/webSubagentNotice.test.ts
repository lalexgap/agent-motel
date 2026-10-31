import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

class Node {
  dataset: Record<string, string> = {};
  children: Node[] = [];
  open = false;
  constructor(readonly tag: string, readonly className = "", readonly text = "") {}
  append(...nodes: Node[]) { this.children.push(...nodes); }
}
const source = readFileSync(new URL("../web/app.js", import.meta.url), "utf8");
const context: any = { el: (tag: string, cls?: string, text?: string) => new Node(tag, cls, text) };
const renderer = source.slice(source.indexOf("function collapsibleMessage("), source.indexOf("function pendingBubble("));
runInNewContext(renderer, context);
const wrapped = (body: string) => `<subagent_notification>\n${body}\n</subagent_notification>`;
const render = (text: string, kind = "user", index = 42): Node => context.chatTurn({ text, kind, index }, "Agent");
// Run the regressions in V8, where the original regex backtracked; Bun uses JavaScriptCore.
const renderWithinTimeout = (text: string): Node => JSON.parse(execFileSync("node", ["--input-type=module", "-e", `
  import { readFileSync } from "node:fs";
  import { runInNewContext } from "node:vm";
  ${Node.toString()}
  const { renderer, text } = JSON.parse(readFileSync(0, "utf8"));
  const turn = runInNewContext(renderer + '\\nchatTurn(entry, "Agent")', {
    entry: { text, kind: "user", index: 42 },
    el: (tag, cls, text) => new Node(tag, cls, text),
  }, { timeout: 1000 });
  process.stdout.write(JSON.stringify(turn));
`], { input: JSON.stringify({ renderer, text }), encoding: "utf8", timeout: 3000 }));

function details(turn: Node) { return turn.children.find(node => node.tag === "details"); }

describe("subagent notifications", () => {
  test("long completed JSON uses a bounded readable preview and retains the entire original message", () => {
    const completion = "Reviewed changes.\n".repeat(70) + "END OF REPORT";
    const text = wrapped(JSON.stringify({ agent_path: "reviewer-id", status: { completed: completion } }));
    const turn = render(text);
    const notice = details(turn)!;
    expect(notice.open).toBe(false);
    expect(turn.children[0]!.text).toBe("Subagent notification");
    expect(notice.dataset.scrollKey).toBe("notice:42");
    const [summary, body] = notice.children;
    expect(summary!.tag).toBe("summary");
    expect(summary!.dataset.scrollKey).toBe("notice-summary:42");
    expect(summary!.children[1]!.text).toStartWith("Reviewed changes. Reviewed changes.");
    expect(summary!.children[1]!.text.length).toBe(141);
    expect(summary!.children[2]!.text).toBe("Read full notification");
    expect(summary!.children[3]!.text).toBe("Collapse notification");
    notice.open = true;
    expect(body!.text).toBe(text);
    expect(body!.dataset.scrollKey).toBe("notice-body:42");
    expect(body!.className).toBe("turn-text");
  });

  test("preserves short notices and ordinary messages without disclosures", () => {
    for (const text of [wrapped('{"status":{"completed":"Done"}}'), "Ordinary message ".repeat(100), "Here is an example:\n" + wrapped("long ".repeat(150))]) {
      const turn = render(text);
      expect(details(turn)).toBeUndefined();
      expect(turn.children[1]!.text).toBe(text);
    }
    expect(details(render(wrapped("long ".repeat(150)), "assistant"))).toBeUndefined();
  });

  test("whitespace-heavy completed JSON renders within a bounded time", () => {
    const text = wrapped(JSON.stringify({ status: { completed: " ".repeat(60000) + "X" } }));
    const notice = details(renderWithinTimeout(text))!;
    expect(notice.open).toBe(false);
    expect(notice.children[0]!.children[1]!.text).toBe("X");
    expect(notice.children[1]!.text).toBe(text);
  });

  test("whitespace-heavy unterminated wrappers render within a bounded time", () => {
    const text = "<subagent_notification>" + " ".repeat(60000) + "X";
    const turn = renderWithinTimeout(text);
    expect(details(turn)).toBeUndefined();
    expect(turn.children[1]!.text).toBe(text);
  });

  test("requires exact wrapper tags around the entire trimmed message", () => {
    const text = wrapped("long ".repeat(150));
    for (const ordinary of ["prefix" + text, text + "suffix", text.slice(1), text.slice(0, -1)]) {
      const turn = render(ordinary);
      expect(details(turn)).toBeUndefined();
      expect(turn.children[1]!.text).toBe(ordinary);
    }
    const padded = " \t\n" + text + "\n\t ";
    expect(details(render(padded))!.children[1]!.text).toBe(padded);
  });

  test("collapses multiline and malformed payloads without requiring a particular JSON schema", () => {
    for (const body of ["line\n".repeat(10), '{"status":null,"report":"' + "x".repeat(700), JSON.stringify({ status: { errored: "error ".repeat(120) } }), "<img src=x onerror=alert(1)>".repeat(30)]) {
      const notice = details(render(wrapped(body)))!;
      expect(notice.open).toBe(false);
      expect(notice.children[1]!.text).toBe(wrapped(body));
      expect(notice.children[0]!.children[1]!.text.length).toBeLessThanOrEqual(141);
    }
  });

  test("length and line thresholds preserve boundary-sized notices", () => {
    expect(details(render(wrapped("x".repeat(600))))).toBeUndefined();
    expect(details(render(wrapped("x".repeat(601))))).toBeDefined();
    expect(details(render(wrapped(Array(8).fill("x").join("\n"))))).toBeUndefined();
    expect(details(render(wrapped(Array(9).fill("x").join("\n"))))).toBeDefined();
  });

  test("trims wrapper whitespace before applying length and line thresholds", () => {
    for (const body of ["x".repeat(600), Array(8).fill("x").join("\n"), ""]) {
      const text = wrapped("\u00a0\n\t" + body + "\t\n\u00a0");
      const turn = render(text);
      expect(details(turn)).toBeUndefined();
      expect(turn.children[1]!.text).toBe(text);
    }
  });
});

test("long initial AGENTS.md instructions collapse with their own label", () => {
  for (const heading of ["# AGENTS.md instructions", "# AGENTS.md instructions for /workspace/repo"]) {
    const text = heading + "\n\n<INSTRUCTIONS>\n" + "Repository guidance.\n".repeat(40) + "</INSTRUCTIONS>";
    const notice = details(render(text))!;
    expect(notice.open).toBe(false);
    expect(notice.children[0]!.children[0]!.text).toBe("AGENTS.md instructions");
    expect(notice.children[0]!.children[2]!.text).toBe("Read full instructions");
    expect(notice.children[1]!.text).toBe(text);
  }
  expect(details(render("# AGENTS.md instructions\nShort guidance"))).toBeUndefined();
  expect(details(render("Please review these instructions\n# AGENTS.md instructions\n" + "guidance ".repeat(100)))).toBeUndefined();
});
