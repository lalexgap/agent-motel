import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const source = readFileSync(new URL("../web/app.js", import.meta.url), "utf8");
class Element {
  children: Element[] = [];
  dataset: Record<string, string> = {};
  disabled = false;
  value = "";
  onclick?: () => Promise<void>;
  onsubmit?: (event: { preventDefault(): void }) => void;
  constructor(public tag: string, public className = "", public textContent = "") {}
  append(...nodes: Element[]) { this.children.push(...nodes); }
  replaceChildren() { this.children = []; }
  setAttribute() {}
  querySelectorAll(selector: string): Element[] {
    return this.children.flatMap(node => [
      ...(selector.split(", ").includes(node.tag) ? [node] : []), ...node.querySelectorAll(selector),
    ]);
  }
  querySelector(selector: string): Element | undefined {
    return this.children.find(node => node.className === selector.slice(1)) ?? this.children.flatMap(node => node.querySelector(selector) ?? [])[0];
  }
}
function fixture(fail = false) {
  const calls: unknown[] = [];
  const context: any = {
    el: (tag: string, cls?: string, text?: string) => new Element(tag, cls, text),
    api: async (...args: unknown[]) => { calls.push(args); if (fail) throw new Error("Prompt changed"); },
    refreshDetail: async () => {}, scheduleRefresh() {}, setDetailMode() {}, updateAgentView() {},
    permissionBox: () => new Element("div"),
  };
  runInNewContext(source.slice(source.indexOf("function promptTerminalButton"), source.indexOf("// AskUserQuestion arrives")), context);
  const prompt = { id: "token", kind: "question", title: "Pick a color", options: [{ id: "1", label: "Blue" }, { id: "2", label: "Other", other: true }] };
  const pending = new Element("div");
  const detail = { panePrompt: prompt, status: "working" };
  const render = () => context.renderPromptCards(pending, detail, { requests: [] }, "/api/agents/test");
  render();
  return { calls, pending, detail, render, box: () => pending.children[0]! };
}
test("polling preserves Other draft and sends it only through the prompt endpoint", async () => {
  const f = fixture();
  const input = f.box().querySelectorAll("input")[0]!;
  input.value = "A custom answer";
  f.render();
  expect(f.box().querySelectorAll("input")[0]).toBe(input);
  f.box().querySelectorAll("form")[0]!.onsubmit!({ preventDefault() {} });
  await Promise.resolve();
  expect(f.calls).toEqual([["/api/agents/test/prompt", { id: "token", optionId: "2", text: "A custom answer" }]]);
  expect(input.disabled).toBe(true);
});
test("choice buttons submit the displayed prompt token; failure leaves terminal fallback usable", async () => {
  const f = fixture(true);
  await f.box().querySelectorAll("button")[0]!.onclick!();
  expect(f.calls).toEqual([["/api/agents/test/prompt", { id: "token", optionId: "1" }]]);
  expect(f.box().querySelectorAll("button")[0]!.disabled).toBe(true);
  expect(f.box().querySelector(".text-button")!.disabled).toBe(false);
});
test("a new prompt replaces the old form", () => {
  const f = fixture();
  const old = f.box();
  f.detail.panePrompt = { ...f.detail.panePrompt, id: "next" };
  f.render();
  expect(f.box()).not.toBe(old);
});
