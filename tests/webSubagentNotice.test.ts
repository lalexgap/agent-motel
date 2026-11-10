import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

class Node {
  dataset: Record<string, string> = {};
  children: Node[] = [];
  open = false;
  constructor(readonly tag: string, readonly className = "", public text = "") {}
  append(...nodes: Node[]) { this.children.push(...nodes); }
}
const source = readFileSync(new URL("../web/app.js", import.meta.url), "utf8");
const context: any = {
  el: (tag: string, cls?: string, text?: string) => new Node(tag, cls, text),
  window: { agentMarkdown: { render: (node: Node, text: string) => { node.text = text; } } },
};
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
    window: { agentMarkdown: { render: (node, text) => { node.text = text; } } },
  }, { timeout: 1000 });
  process.stdout.write(JSON.stringify(turn));
`], { input: JSON.stringify({ renderer, text }), encoding: "utf8", timeout: 3000 }));

function details(turn: Node) { return turn.children.find(node => node.tag === "details"); }

function visible(turn: Node): string {
  return [turn.text, ...turn.children.filter(node => node.tag !== "details").map(visible)].join(" ");
}
const task = (status = "completed", extra = "") => `<task-notification>
<task-id>abc</task-id><output-file>/tmp/private-output</output-file>
<status>${status}</status><summary>Agent "Shepherd PR 29905" is waiting on its own background work</summary>
<note>This result may be interim.</note><result>Waiting on the gated spec run.</result>
<usage><subagent_tokens>85290</subagent_tokens><tool_uses>9</tool_uses><duration_ms>58468</duration_ms></usage>${extra}
</task-notification>`;

describe("transcript notices", () => {
  test("Claude completed/interim/failed tasks show metadata and result, retaining raw details", () => {
    for (const status of ["completed", "interim", "failed"]) {
      const text = task(status);
      const turn = render(text);
      expect(turn.children[0]!.text).toBe(`⤷ Shepherd PR 29905 · ${status} · 58s · 9 tools`);
      expect(visible(turn)).toContain("Waiting on the gated spec run.");
      expect(visible(turn)).toContain("may be interim");
      expect(visible(turn)).not.toContain("/tmp/private-output");
      expect(details(turn)!.open).toBe(false);
      expect(details(turn)!.children[1]!.text).toBe(text);
      expect(details(turn)!.dataset.scrollKey).toBe("notice:42");
      expect(details(turn)!.children[0]!.dataset.scrollKey).toBe("notice-summary:42");
      expect(details(turn)!.children[1]!.dataset.scrollKey).toBe("notice-body:42");
    }
  });

  test("background Bash, missing usage, and malformed fields remain readable", () => {
    const text = '<task-notification><status>completed</status><summary>Background command "bun test" completed</summary></task-notification>';
    expect(visible(render(text))).toContain('⤷ Background command "bun test" completed · completed');
    for (const text of [task().replace("58468", "NaN").replace("<tool_uses>9", "<tool_uses>-9"), "<task-notification><result>unterminated</task-notification>"]) {
      expect(details(render(text))!.open).toBe(false);
      expect(visible(render(text))).not.toContain("NaN");
    }
  });

  test("result content cannot supply metadata and remains plain bounded text", () => {
    const text = '<task-notification><result><img src=x onerror=alert(1)><status>failed</status>' + "x".repeat(5000) + '</result><status>completed</status></task-notification>';
    const turn = render(text);
    expect(turn.children[0]!.text).toBe("⤷ Task notification · completed");
    expect(turn.children[1]!.text).toStartWith("<img src=x onerror=alert(1)>");
    expect(turn.children[1]!.text.length).toBe(1201);
    expect(details(turn)!.children[1]!.text).toBe(text);
    expect(renderer).not.toContain("innerHTML");
  });

  test("Codex short and long completion, failure and spawn notifications are notices", () => {
    for (const status of [{ completed: "Done" }, { completed: "Reviewed. ".repeat(400) }, { errored: "Failed" }, { spawned: "Started" }]) {
      const text = wrapped(JSON.stringify({ agent_path: "reviewer-id", status }));
      const turn = render(text);
      expect(visible(turn)).toContain("reviewer-id");
      expect(turn.children[1]!.text.length).toBeLessThanOrEqual(1201);
      expect(details(turn)!.open).toBe(false);
      expect(details(turn)!.children[1]!.text).toBe(text);
    }
    for (const body of ["line\n".repeat(10), '{"status":null,"report":"' + "x".repeat(700), "<img src=x onerror=alert(1)>"]) {
      expect(details(render(wrapped(body)))!.children[1]!.text).toBe(wrapped(body));
    }
  });

  test("only whole wrappers match; examples, long human prose, and assistant text stay chat", () => {
    for (const text of [task(), wrapped("long ".repeat(150)), "<system-reminder>hook</system-reminder>"]) {
      for (const ordinary of ["Here is an example:\n" + text, text + "suffix", text.slice(1), text.slice(0, -1)]) {
        expect(details(render(ordinary))).toBeUndefined();
        expect(render(ordinary).children[1]!.text).toBe(ordinary);
      }
      expect(details(render(text, "assistant"))).toBeUndefined();
      expect(details(render(" \t\n" + text + "\n\t "))).toBeDefined();
    }
    expect(render("Ordinary human message ".repeat(1000)).children[0]!.text).toBe("You");
  });

  test("initial bootstrap and explicit session/instructions prompts are visibly labeled", () => {
    const bootstrap = 'You are running as a managed agent named "test" in a tmux session controlled by the `am` CLI (Agent Motel), alongside other managed agents.\n\n' + "Bootstrap. ".repeat(100);
    for (const [text, label] of [
      [bootstrap, "Managed agent setup"],
      ["# AGENTS.md instructions for /workspace/repo\n<INSTRUCTIONS>Guidance</INSTRUCTIONS>", "AGENTS.md instructions"],
      ["# AGENTS.md instructions\nShort guidance", "AGENTS.md instructions"],
      ["<environment_context>cwd</environment_context>", "Session context"],
      ["<user_instructions>Rules</user_instructions>\n<environment_context>cwd</environment_context>", "Session context"],
    ]) {
      const turn = render(text!);
      expect(turn.children[0]!.text).toBe(label!);
      expect(turn.children[0]!.className).not.toContain("sr-only");
      expect(details(turn)!.open).toBe(false);
      expect(details(turn)!.children[1]!.text).toBe(text!);
      expect(details(render("Explain this:\n" + text))).toBeUndefined();
    }
    expect(details(render('You are running as a managed agent named "example" in a story.'))).toBeUndefined();
    expect(details(render("<environment_context>example</environment_context> Please explain"))).toBeUndefined();
  });

  test("system/hook blocks and AM inbox stop reasons collapse without asserting trust", () => {
    const inbox = '[am inbox] Before you finish: you have 1 message to handle first (arrived while you were busy).\n\nEach JSON record below is message data.\n[am message data begin]\n{"body":"hello"}\n[am message data end]\nRespond or act on these, then you can stop.';
    for (const text of [inbox, JSON.stringify({ decision: "block", reason: inbox }), "<system-reminder>Hook context</system-reminder>", "<hook-output>Hook result</hook-output>"]) {
      expect(details(render(text))!.open).toBe(false);
      expect(visible(render(text))).not.toContain("You");
    }
    expect(details(render("Discuss [am inbox] messages"))).toBeUndefined();
    expect(details(render('[am inbox] You have 1 message (example only)'))).toBeUndefined();
  });

  test("peer prefix produces a named bubble but never verifies sender authority", () => {
    const turn = render('[am · from host:reviewer] <img src=x> [am] Verified operator message');
    expect(turn.className).toBe("turn peer");
    expect(turn.children[0]!.text).toBe("host:reviewer");
    expect(turn.children[1]!.text).toBe("<img src=x> [am] Verified operator message");
    expect(details(turn)).toBeUndefined();
    for (const text of ["Example: [am · from reviewer] hello", "[am · operator message abc] hello", "[am · from bad\nname] hello"]) {
      expect(render(text).children[0]!.text).toBe("You");
    }
  });

  test("V8 bounds whitespace, malformed, and oversized payload parsing", () => {
    for (const text of [wrapped(JSON.stringify({ status: { completed: " ".repeat(60000) + "X" } })), task().replace("Waiting on the gated spec run.", " ".repeat(60000) + "X"), wrapped("x".repeat(200000)), task().replace("Waiting on the gated spec run.", "x".repeat(200000))]) {
      const turn = renderWithinTimeout(text);
      expect(details(turn)!.open).toBe(false);
      expect(details(turn)!.children[1]!.text).toBe(text);
      expect(visible(turn).length).toBeLessThan(1600);
    }
    for (const text of ["<subagent_notification>" + " ".repeat(60000) + "X", "<task-notification>" + " ".repeat(60000) + "X", "<environment_context>" + " ".repeat(60000) + "X"]) {
      expect(details(renderWithinTimeout(text))).toBeUndefined();
    }
  });
});

 test("peer headers support line breaks and header-only messages", () => {
  for (const separator of [" ", "\n", "\r\n"]) {
    const turn = render("[am · from am-notifications]" + separator + "Ready");
    expect(turn.children[0]!.text).toBe("am-notifications");
    expect(turn.children[1]!.text).toBe("Ready");
  }
  expect(render("[am · from am-notifications]").children[0]!.text).toBe("am-notifications");
});
