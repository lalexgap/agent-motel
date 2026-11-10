import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

class Node {
  tag: string; textContent = ""; href = ""; target = ""; rel = ""; className = ""; children: Node[] = []; attrs: Record<string, string> = {};
  type = ""; disabled = false; tabIndex = -1;
  listeners: Record<string, () => unknown> = {};
  addEventListener(name: string, handler: () => unknown) { this.listeners[name] = handler; }
  click() { return this.listeners.click?.(); }
  constructor(tag: string) { this.tag = tag; }
  replaceChildren() { this.children = []; }
  append(...nodes: Node[]) { this.children.push(...nodes); }
  setAttribute(name: string, value: string) { this.attrs[name] = value; }
}

function render(text: string, clipboard?: { writeText: (text: string) => unknown }) {
  const window: any = { navigator: { clipboard } };
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
  expect([...tags].sort()).toEqual(["button", "code", "div", "p", "pre", "span", "strong", "text"]);
});

test("renders blocks: headings, fences, quotes, rules, ordered and nested lists, tables", () => {
  expect(body("## Title\n\nLine one\nline two")).toBe("<h4>Title</h4><p>Line one\nline two</p>");
  expect(html(render("```ts\nconst a = **1**;\n```").children[0]!.children[1]!)).toBe("<pre><code>const a = **1**;</code></pre>");
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

function codeParts(block: Node) {
  const [wrap, copy, status] = block.children[0]!.children;
  return { wrap: wrap!, copy: copy!, status: status!, pre: block.children[1]! };
}

test("code controls are accessible and wrap only their own block", async () => {
  const root = render("```\none\n```\n\n~~~\ntwo\n~~~");
  const first = codeParts(root.children[0]!);
  const second = codeParts(root.children[1]!);
  expect(first.wrap.type).toBe("button");
  expect(first.copy.type).toBe("button");
  expect(first.wrap.attrs["aria-label"]).toBe("Wrap code lines");
  expect(first.copy.attrs["aria-label"]).toBe("Copy code");
  expect(first.status.attrs.role).toBe("status");
  expect(first.status.attrs["aria-live"]).toBe("polite");
  expect(first.pre.tabIndex).toBe(0);
  expect(first.wrap.attrs["aria-pressed"]).toBe("false");
  await first.wrap.click();
  expect(first.wrap.attrs["aria-pressed"]).toBe("true");
  expect(first.pre.className).toBe("md-code-wrapped");
  expect(second.pre.className).toBe("");
  expect(second.wrap.attrs["aria-pressed"]).toBe("false");
  await first.wrap.click();
  expect(first.pre.className).toBe("");
  expect(first.wrap.attrs["aria-pressed"]).toBe("false");
});

test("copy preserves raw code, whitespace and links, excluding controls", async () => {
  const raw = '  <img src=x onerror=alert(1)>\n\tconst x = "**raw**";\nhttps://example.com/a\n';
  const copied: string[] = [];
  const block = render("```html\n" + raw + "\n```", { writeText: async text => { copied.push(text); } }).children[0]!;
  const { wrap, copy, status, pre } = codeParts(block);
  await wrap.click();
  await copy.click();
  expect(copied).toEqual([raw]);
  expect(status.textContent).toBe("Copied!");
  expect(copy.disabled).toBe(false);
  expect(pre.children[0]!.children.some(node => node.tag === "a")).toBe(true);
  expect(pre.children[0]!.children.some(node => node.tag === "img")).toBe(false);
});

test("clipboard absence, synchronous errors and rejections allow manual copy and retry", async () => {
  for (const clipboard of [undefined, { writeText() { throw new Error("denied"); } },
    { writeText: async () => { throw new Error("denied"); } }]) {
    const { copy, status, pre } = codeParts(render("```\nkeep me\n```", clipboard).children[0]!);
    await copy.click();
    expect(status.textContent).toBe("Could not copy. Select the code and copy manually.");
    expect(copy.disabled).toBe(false);
    expect(html(pre)).toBe("<pre><code>keep me</code></pre>");
    if (clipboard) {
      clipboard.writeText = async () => {};
      await copy.click();
      expect(status.textContent).toBe("Copied!");
    }
  }
});

test("pending clipboard operations suppress duplicates and leave other blocks usable", async () => {
  let complete!: () => void;
  const copied: string[] = [];
  const clipboard = { writeText: (text: string) => {
    copied.push(text);
    return new Promise<void>(resolve => { complete = resolve; });
  } };
  const root = render("```\nfirst\n```\n```\nsecond\n```", clipboard);
  const first = codeParts(root.children[0]!);
  const second = codeParts(root.children[1]!);
  const pending = first.copy.click();
  expect(first.copy.disabled).toBe(true);
  expect(first.status.textContent).toBe("Copying…");
  await first.copy.click();
  expect(copied).toEqual(["first"]);
  expect(second.copy.disabled).toBe(false);
  expect(second.status.textContent).toBe("");
  complete();
  await pending;
  expect(first.copy.disabled).toBe(false);
  const next = second.copy.click();
  complete();
  await next;
  expect(copied).toEqual(["first", "second"]);
});

test("empty and unclosed fences have controls while inline code and tables stay unchanged", async () => {
  const copied: string[] = [];
  for (const [source, expected] of [["```\n```", ""], ["~~~js\nunfinished", "unfinished"]]) {
    const { copy } = codeParts(render(source!, { writeText: async text => { copied.push(text); } }).children[0]!);
    await copy.click();
    expect(copied.at(-1)).toBe(expected);
  }
  const root = render("`inline`\n\n| a | b |\n|---|---|\n| 1 | 2 |");
  expect(root.children[0]!.children.some(node => node.tag === "button")).toBe(false);
  expect(root.children[1]!.className).toBe("md-table");
  expect(root.children[1]!.children[0]!.tag).toBe("table");
});
