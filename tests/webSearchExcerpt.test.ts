import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

function load() {
  const nodes: any[] = [];
  const make = (tag: string) => ({ tag, textContent: "", children: [] as any[], append(...n: any[]) { this.children.push(...n); } });
  const document = {
    getElementById: () => ({}),
    createElement: make,
    createTextNode: (text: string) => Object.assign(make("text"), { textContent: text }),
  };
  const context: any = { document, nodes };
  runInNewContext(readFileSync(new URL("../web/search.js", import.meta.url), "utf8") + "\nthis.searchExcerpt = searchExcerpt; this.highlightInto = highlightInto;", context);
  return { ...context, make };
}

test("search excerpts centre on the first match and collapse whitespace", () => {
  const { searchExcerpt } = load();
  const text = "intro ".repeat(80) + "the deploy\n\nstep " + "tail ".repeat(80);
  const excerpt = searchExcerpt(text, ["deploy"], 120);
  expect(excerpt.startsWith("…")).toBe(true);
  expect(excerpt.endsWith("…")).toBe(true);
  expect(excerpt).toContain("the deploy step");
  expect(excerpt.length).toBeLessThanOrEqual(122);
  expect(searchExcerpt("short task", ["missing"])).toBe("short task");
});

test("highlighting marks every term case-insensitively as text, never markup", () => {
  const { highlightInto, make } = load();
  const node = highlightInto(make("p"), "Deploy <b>x</b> then deploy.", ["deploy", "<b>"]);
  expect(node.children.map((n: any) => `${n.tag}:${n.textContent}`)).toEqual(["text:", "mark:Deploy", "text: ", "mark:<b>", "text:x</b> then ", "mark:deploy", "text:."]);
});
