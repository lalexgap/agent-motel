import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

class Node {
  tag: string; textContent = ""; href = ""; target = ""; rel = ""; className = ""; children: Node[] = []; attrs: Record<string, string> = {};
  constructor(tag: string) { this.tag = tag; }
  replaceChildren() { this.children = []; }
  append(...nodes: Node[]) { this.children.push(...nodes); }
  setAttribute(name: string, value: string) { this.attrs[name] = value; }
}

function render(text: string) {
  const window: any = {};
  const document = { createElement: (tag: string) => new Node(tag), createTextNode: (text: string) => Object.assign(new Node("text"), { textContent: text }) };
  for (const file of ["links.js", "markdown.js"])
    runInNewContext(readFileSync(new URL("../web/" + file, import.meta.url), "utf8"), { window, document, URL });
  return window.agentMarkdown.render(new Node("div"), text) as Node;
}
const html = (node: Node): string => node.tag === "text" ? node.textContent :
  node.tag === "a" ? `<a href="${node.href}">${node.textContent}</a>` :
  `<${node.tag}>${node.textContent}${node.children.map(html).join("")}</${node.tag}>`;
const body = (text: string) => render(text).children.map(html).join("");

test("renders inline emphasis, code and safe links", () => {
  expect(body("- **Server:** running `e51663c` and *ok*")).toBe("<ul><li><strong>Server:</strong> running <code>e51663c</code> and <em>ok</em></li></ul>");
  expect(body("see [PR](https://github.com/a/b/pull/1) or https://x.dev/y.")).toBe('<p>see <a href="https://github.com/a/b/pull/1">PR</a> or <a href="https://x.dev/y">https://x.dev/y</a>.</p>');
  expect(body("[bad](javascript:alert(1))")).toBe("<p>[bad](javascript:alert(1))</p>");
  expect(body("snake_case_name and 2*3*4")).toBe("<p>snake_case_name and 2*3*4</p>");
});

test("never creates elements from agent-supplied markup", () => {
  const tags = new Set<string>();
  const walk = (node: Node) => { tags.add(node.tag); node.children.forEach(walk); };
  walk(render('<img src=x onerror="alert(1)"> **<script>x</script>**\n```\n<b>raw</b>\n```'));
  expect([...tags].sort()).toEqual(["code", "div", "p", "pre", "strong", "text"]);
});

test("renders blocks: headings, fences, quotes, rules, ordered and nested lists, tables", () => {
  expect(body("## Title\n\nLine one\nline two")).toBe("<h4>Title</h4><p>Line one\nline two</p>");
  expect(body("```ts\nconst a = **1**;\n```")).toBe("<pre><code>const a = **1**;</code></pre>");
  expect(body("> quoted **bit**\n\n---")).toBe("<blockquote><p>quoted <strong>bit</strong></p></blockquote><hr></hr>");
  expect(body("1. one\n2. two\n   - nested\n3. three")).toBe("<ol><li>one</li><li>two<ul><li>nested</li></ul></li><li>three</li></ol>");
  expect(body("| a | b |\n|---|:-:|\n| `x` | y |")).toBe("<div><table><thead><tr><th>a</th><th>b</th></tr></thead><tbody><tr><td><code>x</code></td><td>y</td></tr></tbody></table></div>");
});

test("keeps an ordered list's starting number", () => {
  const list = render("3. three\n4. four").children[0]!;
  expect(list.tag).toBe("ol");
  expect(list.attrs.start).toBe("3");
});

test("strips closing heading hashes and keeps URLs with emphasis markers whole", () => {
  expect(body("## Title ##")).toBe("<h4>Title</h4>");
  expect(body("# C# #")).toBe("<h3>C#</h3>");
  const tests = "https://github.com/o/r/blob/main/src/__tests__/x.test.ts";
  const init = "https://x.dev/pkg/__init__.py";
  expect(body(`see ${tests} and ${init}`)).toBe(`<p>see <a href="${tests}">${tests}</a> and <a href="${init}">${init}</a></p>`);
  expect(body("https://x.dev/a/*b*/c.")).toBe('<p><a href="https://x.dev/a/*b*/c">https://x.dev/a/*b*/c</a>.</p>');
  expect(body("**https://x.dev** `https://y.dev/__a__`")).toBe('<p><strong><a href="https://x.dev/">https://x.dev</a></strong> <code>https://y.dev/__a__</code></p>');
  const link = render("[PR](https://x.dev/p)").children[0]!.children.find(node => node.tag === "a") as any;
  expect([link.tag, link.href, link.title]).toEqual(["a", "https://x.dev/p", "https://x.dev/p"]);
});

test("keeps balanced trailing brackets and trims unbalanced ones", () => {
  expect(body("https://en.wikipedia.org/wiki/Foo_(bar)")).toBe('<p><a href="https://en.wikipedia.org/wiki/Foo_(bar)">https://en.wikipedia.org/wiki/Foo_(bar)</a></p>');
  expect(body("(see https://a.dev/x)")).toBe('<p>(see <a href="https://a.dev/x">https://a.dev/x</a>)</p>');
  expect(body("[https://a.dev/x])")).toBe('<p>[<a href="https://a.dev/x">https://a.dev/x</a>])</p>');
});

test("renders pathological input quickly without overflowing the stack", () => {
  const inputs = [
    "# a" + " ".repeat(20000) + "b",
    "para\n# a" + " ".repeat(20000) + "b",
    "a|b\n" + " ".repeat(80000) + "x",
    ">".repeat(5000) + " deep",
    Array.from({ length: 300 }, (_, i) => " ".repeat(i * 2) + "- x").join("\n"),
    Array.from({ length: 10 }, () => "[a](" + "x".repeat(9990)).join("\n\n"),
    "**a ".repeat(30000),
    "**a ".repeat(20000),
    "http://a" + ")".repeat(40000),
    "http://a" + ".".repeat(40000) + "x",
  ];
  for (const input of inputs) {
    const start = performance.now();
    expect(() => render(input)).not.toThrow();
    expect(performance.now() - start).toBeLessThan(500);
  }
  expect(body(">>>> deep")).toBe("<blockquote><blockquote><blockquote><blockquote><p>deep</p></blockquote></blockquote></blockquote></blockquote>");
});

test("keeps parentheses inside markdown link destinations", () => {
  expect(body("[w](https://en.wikipedia.org/wiki/Foo_(bar))")).toBe('<p><a href="https://en.wikipedia.org/wiki/Foo_(bar)">w</a></p>');
  expect(body("[w](https://x.dev/(a)b)")).toBe('<p><a href="https://x.dev/(a)b">w</a></p>');
});

test("renders oversized text as one plain paragraph", () => {
  const nodes = render("**a**\n" + "x ".repeat(50001)).children;
  expect(nodes.map(node => node.tag)).toEqual(["p"]);
});

test("link text that looks like an address shows the real destination", () => {
  expect(body("[https://github.com/me](https://evil.example/x)")).toBe('<p><a href="https://evil.example/x">https://evil.example/x</a></p>');
  expect(body("[PR](https://github.com/a/b/pull/1)")).toBe('<p><a href="https://github.com/a/b/pull/1">PR</a></p>');
});
