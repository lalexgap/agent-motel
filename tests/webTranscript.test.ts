import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

class Node {
  className = "";
  textContent = "";
  title = "";
  children: Node[] = [];
  dataset: Record<string, string> = {};
  constructor(readonly tag: string) {}
  append(...nodes: Node[]) { this.children.push(...nodes); }
  setAttribute() {}
}

type Entry = { index: number; kind: string; text?: string; name?: string; input?: string; output?: string };
type Transcript = {
  renderEntries(view: Node, entries: Entry[], options: { agentName: string; readBoundary?: number | null }): void;
};

function load(): Transcript {
  const window: { agentTranscript?: Transcript; agentMarkdown: object; agentLinks: object } = {
    agentMarkdown: { render: (node: Node, text: string) => { node.textContent = text; } },
    agentLinks: { render: (node: Node, text: string) => { node.textContent = text; } },
  };
  const document = { createElement: (tag: string) => new Node(tag), createElementNS: (_: string, tag: string) => new Node(tag) };
  runInNewContext(readFileSync(new URL("../web/transcript.js", import.meta.url), "utf8"), { window, document });
  return window.agentTranscript!;
}

const shape = (view: Node) => view.children.map(node =>
  node.className === "work-group" ? `tools:${node.children[1]!.children.map(call => call.dataset.scrollKey).join(",")}` :
  node.className === "unread-marker" ? "unread" : node.dataset.scrollKey ?? node.tag);
const user = (index: number): Entry => ({ index, kind: "user", text: "Question " + index });
const assistant = (index: number): Entry => ({ index, kind: "assistant", text: "Answer " + index });
const tool = (index: number): Entry => ({ index, kind: "tool", name: "Bash", input: JSON.stringify({ command: "ls" }), output: "ok" });

describe("renderEntries", () => {
  test("groups consecutive tool calls and renders other entries as turns", () => {
    const view = new Node("div");
    load().renderEntries(view, [user(0), tool(1), tool(2), assistant(3), tool(4)], { agentName: "Agent" });
    expect(shape(view)).toEqual(["turn:0", "tools:tool:1,tool:2", "turn:3", "tools:tool:4"]);
    expect(view.children[1]!.children[0]!.children[1]!.textContent).toBe("Ran 2 commands");
    expect(view.children[2]!.children[0]!.textContent).toBe("Agent");
  });

  test("inserts the unread marker once, before the first entry past the boundary, and splits a tool run", () => {
    const view = new Node("div");
    load().renderEntries(view, [user(0), tool(1), tool(2), tool(3), assistant(4)], { agentName: "Agent", readBoundary: 1 });
    expect(shape(view)).toEqual(["turn:0", "tools:tool:1", "unread", "tools:tool:2,tool:3", "turn:4"]);
    expect(view.children[2]!.textContent).toBe("New since your last visit");
  });

  test("omits the marker without a boundary or when nothing is past it", () => {
    for (const readBoundary of [null, undefined, 4]) {
      const view = new Node("div");
      load().renderEntries(view, [user(0), tool(1), assistant(4)], { agentName: "Agent", readBoundary });
      expect(shape(view)).toEqual(["turn:0", "tools:tool:1", "turn:4"]);
    }
  });

  test("appends to the view without clearing what is already there", () => {
    const view = new Node("div");
    view.append(new Node("p"));
    load().renderEntries(view, [user(0)], { agentName: "Agent" });
    expect(shape(view)).toEqual(["p", "turn:0"]);
  });
});

test("the page loads transcript.js after markdown.js and before app.js, and the server serves it", () => {
  const html = readFileSync(new URL("../web/index.html", import.meta.url), "utf8");
  const server = readFileSync(new URL("../src/server.ts", import.meta.url), "utf8");
  expect(html).toContain('<script src="/transcript.js" defer></script>');
  expect(html.indexOf("/markdown.js")).toBeLessThan(html.indexOf("/transcript.js"));
  expect(html.indexOf("/transcript.js")).toBeLessThan(html.indexOf("/app.js"));
  expect(server).toContain('"/transcript.js": "web/transcript.js"');
});
