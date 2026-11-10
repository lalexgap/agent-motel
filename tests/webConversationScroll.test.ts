import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

type Entry = { key?: string; wrapKey?: string; wrapped?: boolean; height: number; open?: boolean; children?: Entry[]; tagName?: string; maxHeight?: number };

type Transcript = {
  preserveConversationScroll(view: View, threshold: number): (follow?: boolean) => void;
  toolGroup(entry: { index: number }): Node & { add(entry: { index: number; name: string }): void };
};
function loadTranscript(document: object = {}): Transcript {
  const window: { agentTranscript?: Transcript; agentLinks: object } = { agentLinks: { render() {} } };
  runInNewContext(readFileSync(new URL("../web/transcript.js", import.meta.url), "utf8"), { window, document });
  return window.agentTranscript!;
}
function load() {
  return loadTranscript().preserveConversationScroll;
}

class Node {
  readonly dataset: { scrollKey?: string; wrapKey?: string; wrapped?: string };
  readonly tagName: string;
  readonly children: Node[];
  open: boolean;
  private scroll = 0;
  scrollLeft = 0;

  constructor(readonly view: View, readonly entry: Entry) {
    this.dataset = { scrollKey: entry.key, wrapKey: entry.wrapKey, wrapped: String(entry.wrapped ?? false) };
    this.tagName = entry.tagName ?? (entry.children ? "DETAILS" : "ARTICLE");
    this.open = entry.open ?? false;
    this.children = (entry.children ?? []).map(child => new Node(view, child));
  }

  contains(node: Node): boolean {
    return this === node || this.children.some(child => child.contains(node));
  }

  querySelector(selector: string) {
    expect(selector).toBe('[aria-label="Wrap code lines"]');
    return { click: () => { this.dataset.wrapped = String(this.dataset.wrapped !== "true"); } };
  }

  append(...nodes: Node[]) { this.children.push(...nodes); }

  get scrollTop(): number { return this.scroll; }
  set scrollTop(value: number) {
    const max = this.entry.maxHeight === undefined ? Infinity : this.getBoundingClientRect().height
      ? this.children.reduce((sum, child) => sum + child.height, 0) - this.height : 0;
    this.scroll = Math.max(0, Math.min(value, max));
  }

  get height(): number {
    const height = this.entry.height + (this.open || this.tagName !== "DETAILS"
      ? this.children.reduce((sum, child) => sum + child.height, 0) : 0);
    return Math.min(height, this.entry.maxHeight ?? Infinity);
  }

  getBoundingClientRect() {
    return this.view.rect(this);
  }
}

// Flow layout with nested disclosures; replacing content clamps like a browser.
class View {
  readonly clientHeight = 200;
  readonly top = 75;
  nodes: Node[] = [];
  private scroll = 0;

  constructor(entries: Entry[], scroll = 0) {
    this.replace(entries);
    this.scrollTop = scroll;
  }

  get scrollHeight(): number {
    return this.nodes.reduce((sum, node) => sum + node.height, 0);
  }

  get scrollTop(): number { return this.scroll; }
  set scrollTop(value: number) {
    this.scroll = Math.max(0, Math.min(value, this.scrollHeight - this.clientHeight));
  }

  replace(entries: Entry[]) {
    this.nodes = entries.map(entry => new Node(this, entry));
    this.scrollTop = this.scrollTop;
  }

  getBoundingClientRect() {
    return { top: this.top, bottom: this.top + this.clientHeight, height: this.clientHeight };
  }

  querySelectorAll(selector: string): Node[] {
    const flatten = (nodes: Node[]): Node[] => nodes.flatMap(node => [node, ...flatten(node.children)]);
    if (selector === "[data-scroll-key]") return flatten(this.nodes).filter(node => node.dataset.scrollKey !== undefined);
    expect(selector).toBe("[data-wrap-key]");
    return flatten(this.nodes).filter(node => node.dataset.wrapKey !== undefined);
  }

  node(key: string): Node {
    const node = this.querySelectorAll("[data-scroll-key]").find(node => node.dataset.scrollKey === key);
    if (!node) throw new Error(`Missing fixture node: ${key}`);
    return node;
  }

  offset(key: string): number {
    return this.node(key).getBoundingClientRect().top - this.top;
  }

  rect(target: Node): { top: number; bottom: number; height: number } {
    const locate = (nodes: Node[], start: number): { top: number; bottom: number; height: number } | undefined => {
      let y = start;
      for (const node of nodes) {
        if (node === target) {
          const top = this.top + y - this.scrollTop;
          return { top, bottom: top + node.height, height: node.height };
        }
        if (node.open || node.tagName !== "DETAILS") {
          const found = locate(node.children, y + node.entry.height - node.scrollTop);
          if (found) return found;
        }
        y += node.height;
      }
    };
    return locate(this.nodes, 0) ?? { top: 0, bottom: 0, height: 0 };
  }
}

const turns = (start: number, count: number): Entry[] =>
  Array.from({ length: count }, (_, index) => ({ key: `turn:${start + index}`, height: 100 }));

describe("preserveConversationScroll", () => {
  test("restores a wrapped code block after transcript rerender", () => {
    const view = new View([{ key: "turn:17", height: 100, children: [
      { wrapKey: "turn:17:code:0", wrapped: true, height: 40 },
    ] }]);
    const restore = load()(view, 90);
    view.replace([{ key: "turn:17", height: 100, children: [
      { wrapKey: "turn:17:code:0", wrapped: false, height: 40 },
    ] }, { key: "turn:18", height: 100 }]);
    restore();
    expect(view.querySelectorAll("[data-wrap-key]")[0]!.dataset.wrapped).toBe("true");
  });

  test("appending while scrolled up preserves the partially visible turn", () => {
    const view = new View(turns(0, 10), 235);
    const offset = view.offset("turn:2");
    const restore = load()(view, 90);
    view.replace(turns(0, 12));
    restore();
    expect(view.offset("turn:2")).toBe(offset);
    expect(view.scrollTop).toBe(235);
  });

  test("replacement restores expanded tool groups and calls before positioning the reader", () => {
    const entries = (open: boolean): Entry[] => [
      { key: "group:0", height: 30, open, children: [
        { key: "tool:0", height: 30, open, children: [{ key: "output:0", height: 250 }] },
      ] },
      ...turns(1, 8),
    ];
    const view = new View(entries(true), 345);
    const offset = view.offset("turn:1");
    const restore = load()(view, 90);
    view.replace(entries(false));
    restore();
    expect(view.node("group:0").open).toBe(true);
    expect(view.node("tool:0").open).toBe(true);
    expect(view.offset("turn:1")).toBe(offset);
  });

  test("keeps the reading position inside rebuilt long tool-output panes", () => {
    const entries = (open: boolean): Entry[] => [
      { key: "group:0", height: 30, open, children: [
        { key: "tool:0", height: 30, open, children: [{ key: "output:0", height: 256 }] },
      ] },
      ...turns(1, 8),
    ];
    const view = new View(entries(true), 100);
    view.node("output:0").scrollTop = 480;
    view.node("output:0").scrollLeft = 40;
    const offset = view.offset("output:0");
    const restore = load()(view, 90);
    view.replace(entries(false));
    restore();
    expect(view.node("output:0").scrollTop).toBe(480);
    expect(view.node("output:0").scrollLeft).toBe(40);
    expect(view.offset("output:0")).toBe(offset);
  });

  test("keeps a capped tool list's independent position with collapsed calls after rebuilding", () => {
    const view = new View([]);
    // Real toolGroup over layout nodes; the work list is the capped, independently scrolling box.
    const { toolGroup } = loadTranscript({
      createElement: (tag: string) => {
        const entry: Entry = { tagName: tag.toUpperCase(), height: tag === "details" ? 24 : 0 };
        return Object.defineProperty(new Node(view, entry), "className", {
          set(value: string) { if (value === "work-list") entry.maxHeight = 288; },
        });
      },
      createElementNS: () => Object.assign(new Node(view, { height: 0 }), { setAttribute() {} }),
    });
    const rebuild = (count: number) => {
      const group = toolGroup({ index: 10 });
      for (let index = 10; index < 30; index++) group.add({ index, name: "Task" });
      view.replace(turns(0, 2));
      view.nodes.push(group, ...turns(30, count).map(entry => new Node(view, entry)));
      return { group, list: group.children[1]! };
    };
    const original = rebuild(8);
    original.group.open = true;
    original.list.scrollTop = 144;
    expect(original.list.scrollTop).toBe(144);
    view.scrollTop = 220;
    const offset = view.offset("tool:18");
    const restore = load()(view, 90);
    const updated = rebuild(9);
    expect(updated.list.scrollTop).toBe(0);
    restore();
    expect(updated.group.open).toBe(true);
    expect(updated.list.children.every(call => !call.open)).toBe(true);
    expect(updated.list.scrollTop).toBe(144);
    expect(view.offset("tool:18")).toBe(offset);
    expect(view.scrollTop).toBe(220);
  });

  test("growth above a visible anchor compensates scrollTop", () => {
    const view = new View(turns(0, 10), 235);
    const offset = view.offset("turn:2");
    const restore = load()(view, 90);
    const updated = turns(0, 10);
    updated[0]!.height += 180;
    view.replace(updated);
    restore();
    expect(view.offset("turn:2")).toBe(offset);
    expect(view.scrollTop).toBe(415);
  });

  test("growth inside a visible tool uses the child anchor rather than its enclosing group", () => {
    const entries = (height: number): Entry[] => [
      { key: "group:0", height: 30, open: true, children: [
        { key: "tool:0", height }, { key: "tool:1", height: 120 },
      ] },
      ...turns(2, 8),
    ];
    const view = new View(entries(250), 295);
    const offset = view.offset("tool:1");
    const restore = load()(view, 90);
    view.replace(entries(430));
    restore();
    expect(view.offset("tool:1")).toBe(offset);
    expect(view.scrollTop).toBe(475);
  });

  for (const threshold of [60, 90]) {
    for (const gap of [0, threshold - 1]) {
      test(`follows appended content with ${gap}px remaining at threshold ${threshold}`, () => {
        const view = new View(turns(0, 10), 800 - gap);
        const restore = load()(view, threshold);
        view.replace(turns(0, 12));
        restore();
        expect(view.scrollTop).toBe(1000);
        expect(view.scrollHeight - view.scrollTop - view.clientHeight).toBe(0);
      });
    }

    test(`reader outside the ${threshold}px threshold stays in place`, () => {
      const view = new View(turns(0, 10), 800 - threshold - 1);
      const offset = view.offset("turn:7");
      const restore = load()(view, threshold);
      view.replace(turns(0, 12));
      restore();
      expect(view.offset("turn:7")).toBe(offset);
      expect(view.scrollTop).toBe(800 - threshold - 1);
    });
  }

  test("dock sliding window preserves a surviving visible entry after trimming older messages", () => {
    const view = new View(turns(0, 20), 435);
    const offset = view.offset("turn:4");
    const restore = load()(view, 60);
    view.replace(turns(3, 20));
    restore();
    expect(view.offset("turn:4")).toBe(offset);
    expect(view.scrollTop).toBe(135);
  });

  test("uses the next surviving visible entry when the first visible entry leaves the dock", () => {
    const view = new View(turns(0, 20), 435);
    const offset = view.offset("turn:5");
    const restore = load()(view, 60);
    view.replace(turns(5, 20));
    restore();
    // The requested offset is above the new start, so the browser clamps to zero.
    expect(offset).toBe(65);
    expect(view.offset("turn:5")).toBe(0);
    expect(view.scrollTop).toBe(0);
  });

  test("missing visible anchors fall back to the saved numeric position after layout clamping", () => {
    const view = new View(turns(0, 10), 435);
    const restore = load()(view, 90);
    view.replace(turns(20, 3));
    expect(view.scrollTop).toBe(100);
    view.replace(turns(20, 10));
    restore();
    expect(view.scrollTop).toBe(435);
  });

  test("an unchanged refresh with follow=false does not snap a near-bottom reader", () => {
    const view = new View(turns(0, 10), 765);
    const offset = view.offset("turn:7");
    const restore = load()(view, 90);
    restore(false);
    expect(view.scrollTop).toBe(765);
    expect(view.offset("turn:7")).toBe(offset);
  });
});
