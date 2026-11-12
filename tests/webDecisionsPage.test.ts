import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

class Node {
  children: (Node | string)[] = [];
  attrs = new Map<string, string>();
  dataset: Record<string, string> = {};
  className = "";
  id = "";
  type = "";
  value = "";
  placeholder = "";
  autocomplete = "";
  href = "";
  target = "";
  rel = "";
  title = "";
  hidden = false;
  checked = false;
  disabled = false;
  onclick?: (event?: any) => any;
  oninput?: (event: any) => any;
  onchange?: (event: any) => any;
  classList = {
    toggle: (name: string, force: boolean) => {
      const names = new Set(this.className.split(/\s+/).filter(Boolean));
      if (force) names.add(name); else names.delete(name);
      this.className = [...names].join(" ");
    },
  };
  constructor(readonly tag: string) {}
  set textContent(value: string) { this.children = [String(value)]; }
  get textContent(): string { return this.children.map((child) => typeof child === "string" ? child : child.textContent).join(""); }
  set innerHTML(_: string) { throw new Error("innerHTML must not be used"); }
  append(...nodes: (Node | string)[]) { this.children.push(...nodes); }
  replaceChildren(...nodes: (Node | string)[]) { this.children = nodes; }
  setAttribute(name: string, value: string) { this.attrs.set(name, value); }
  removeAttribute(name: string) { this.attrs.delete(name); }
  all(): Node[] { return this.children.flatMap((child) => typeof child === "string" ? [] : [child, ...child.all()]); }
  querySelector(selector: string): Node | null {
    if (selector.startsWith("#")) return [this, ...this.all()].find((node) => node.id === selector.slice(1)) ?? null;
    return null;
  }
  find(className: string): Node[] { return [this, ...this.all()].filter((node) => node.className.split(/\s+/).includes(className)); }
}

const document = {
  createElement: (tag: string) => new Node(tag),
  createTextNode: (text: string) => text,
};
const window: any = {};
const cardSource = readFileSync(new URL("../web/decisions.js", import.meta.url), "utf8");
const pageSource = readFileSync(new URL("../web/decisionsPage.js", import.meta.url), "utf8");
runInNewContext(cardSource, { window, document, URL });
runInNewContext(pageSource, { window, document, URL });
const page = window.agentDecisionsPage;

const report = {
  enabled: true,
  remoteHosts: ["laptop"],
  groups: [
    { agent: "api<img>", decisions: [
      { id: "d-1", question: "Ship <script>alert(1)</script>?", options: ["yes<img>", "no"], recommendation: "yes", why: "needed", blocking: true, link: "javascript:alert(1)", prs: [], asked_at: "2026-01-01T00:00:00Z" },
      { id: "d-2", question: "Pick database", options: ["sqlite"], recommendation: null, why: null, blocking: false, link: null, prs: [], asked_at: "2026-01-02T00:00:00Z" },
    ] },
  ],
};

function setup() {
  const root = new Node("section");
  page.buildPage(root);
  return root;
}

test("shared page is pure DOM and filters decisions without interpreting hostile text", () => {
  expect(pageSource).not.toMatch(/innerHTML|insertAdjacentHTML|outerHTML|\bfetch\(|EventSource|localStorage|\bapi\(/);
  expect(page.visibleGroups(report.groups, "sqlite", false)[0].decisions.map((d: any) => d.id)).toEqual(["d-2"]);
  expect(page.visibleGroups(report.groups, "api<img>", true)[0].decisions.map((d: any) => d.id)).toEqual(["d-1"]);
  const root = setup();
  const opened: string[] = [];
  const actions = { refresh() {}, setQuery() {}, setBlockingOnly() {}, openAgent: (name: string) => opened.push(name) };
  page.render(root, { report, loading: false, error: null, query: "", blockingOnly: false }, actions);
  expect(root.find("decision-question")[0].textContent).toBe("Ship <script>alert(1)</script>?");
  expect(root.find("decision-option")[0].textContent).toBe("yes<img>");
  expect(root.all().some((node) => ["script", "img"].includes(node.tag))).toBe(false);
  expect(root.find("decision-answer")).toHaveLength(0);
  expect(root.find("decision-link")).toHaveLength(0);
  expect(root.find("decision-link-text")[0].textContent).toBe("javascript:alert(1)");
  root.find("decisions-open-agent")[0].onclick!();
  expect(opened).toEqual(["api<img>"]);
  expect(root.querySelector("#decisions-coverage")!.textContent).toContain("Connect to those servers directly");
});

test("unchanged and partial-error results preserve DOM and filter focus controls", () => {
  const root = setup();
  const actions = { refresh() {}, setQuery() {}, setBlockingOnly() {}, openAgent() {} };
  const data = { report, loading: false, error: null, query: "", blockingOnly: false };
  page.render(root, data, actions);
  const toolbar = root.children[0];
  const renderedGroup = root.querySelector("#decisions-inbox-list")!.children[0];
  page.render(root, data, actions);
  expect(root.children[0]).toBe(toolbar);
  expect(root.querySelector("#decisions-inbox-list")!.children[0]).toBe(renderedGroup);
  page.render(root, { ...data, error: "offline" }, actions);
  expect(root.querySelector("#decisions-inbox-list")!.children[0]).toBe(renderedGroup);
  expect(root.querySelector("#decisions-status")!.textContent).toContain("Showing earlier results");
});

test("loading, error, empty, filtered-empty and disabled states are distinct", () => {
  const root = setup();
  const actions = { refresh() {}, setQuery() {}, setBlockingOnly() {}, openAgent() {} };
  page.render(root, { report: null, loading: true, error: null, query: "", blockingOnly: false }, actions);
  expect(root.querySelector("#decisions-inbox-list")!.textContent).toBe("Loading decisions…");
  page.render(root, { report: null, loading: false, error: "offline", query: "", blockingOnly: false }, actions);
  expect(root.querySelector("#decisions-inbox-list")!.textContent).toBe("The decisions inbox is unavailable.");
  page.render(root, { report: { enabled: true, remoteHosts: [], groups: [] }, loading: false, error: null, query: "", blockingOnly: false }, actions);
  expect(root.querySelector("#decisions-inbox-list")!.textContent).toBe("No open decisions on this server.");
  page.render(root, { report, loading: false, error: null, query: "missing", blockingOnly: false }, actions);
  expect(root.querySelector("#decisions-inbox-list")!.textContent).toBe("No decisions match these filters.");
  page.render(root, { report: { enabled: false, remoteHosts: [], groups: [] }, loading: false, error: null, query: "", blockingOnly: false }, actions);
  expect(root.querySelector("#decisions-inbox-list")!.textContent).toBe("Decisions are disabled on this server.");
});
