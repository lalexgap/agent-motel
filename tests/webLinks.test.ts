import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

function links() {
  const window: any = {}, clicked: string[] = [];
  class Node {
    tag: string; textContent = ""; href = ""; target = ""; rel = ""; children: Node[] = [];
    constructor(tag: string) { this.tag = tag; }
    replaceChildren() { this.children = []; }
    append(...nodes: Node[]) { this.children.push(...nodes); }
    click() { clicked.push(this.href); }
    remove() {}
  }
  const document = { createElement: (tag: string) => new Node(tag), createTextNode: (text: string) => Object.assign(new Node("text"), { textContent: text }), body: new Node("body") };
  runInNewContext(readFileSync(new URL("../web/links.js", import.meta.url), "utf8"), { window, document, URL });
  return { links: window.agentLinks, document, clicked };
}

test("chat links preserve literal text, balanced URL parentheses and surrounding punctuation", () => {
  const { links: api, document } = links();
  const node = document.createElement("div");
  const text = '<img onerror="alert(1)"> (https://example.com/a_(b)), https://example.org/path?x=1&y=2. javascript:alert(1)';
  api.render(node, text);
  expect(node.children.map(n => n.textContent).join("")).toBe(text);
  const anchors = node.children.filter(n => n.tag === "a");
  expect(anchors.map(n => n.href)).toEqual(["https://example.com/a_(b)", "https://example.org/path?x=1&y=2"]);
  expect(anchors.every(n => n.target === "_blank" && n.rel === "noopener noreferrer")).toBe(true);
  expect(node.children.every(n => ["text", "a"].includes(n.tag))).toBe(true);
});

test("terminal activation requires a user event and allows only credential-free web URLs", () => {
  const { links: api, clicked } = links();
  const event = { isTrusted: true, preventDefault() {} };
  for (const uri of ["javascript:alert(1)", "file:///etc/passwd", "data:text/html,bad", "https://user:pass@example.com", "not a URL"])
    api.open(event, uri);
  api.open({ ...event, isTrusted: false }, "https://example.com/");
  expect(clicked).toEqual([]);
  api.open(event, "https://example.com/pr/42");
  expect(clicked).toEqual(["https://example.com/pr/42"]);
});
