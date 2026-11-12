import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const source = readFileSync(new URL("../web/prompts.js", import.meta.url), "utf8");
class Element {
  children: Element[] = [];
  dataset: Record<string, string> = {};
  disabled = false;
  open = false;
  value = "";
  onclick?: () => Promise<void>;
  onsubmit?: (event: { preventDefault(): void }) => void;
  constructor(public tag: string, public className = "", public textContent = "") {}
  append(...nodes: Element[]) { this.children.push(...nodes); }
  prepend(...nodes: Element[]) { this.children.unshift(...nodes); }
  replaceChildren() { this.children = []; }
  setAttribute() {}
  querySelectorAll(selector: string): Element[] {
    return this.children.flatMap(node => [
      ...(selector.split(", ").includes(node.tag) ? [node] : []), ...node.querySelectorAll(selector),
    ]);
  }
  querySelector(selector: string): Element | undefined {
    return this.children.find(node => node.className.split(" ").includes(selector.slice(1))) ?? this.children.flatMap(node => node.querySelector(selector) ?? [])[0];
  }
}
function fixture(fail = false) {
  const calls: unknown[] = [];
  const window: any = { agentTranscript: { el: (tag: string, cls?: string, text?: string) => new Element(tag, cls, text), icon: () => new Element("svg") } };
  runInNewContext(source, { window });
  const call = (name: string) => async (...args: unknown[]) => { calls.push([name, ...args]); if (fail) throw new Error("Prompt changed"); };
  const actions = {
    answerPrompt: (prompt: { id: string }, ...rest: unknown[]) => call("answerPrompt")(prompt.id, ...rest),
    answerPermission: call("answerPermission"),
    refresh: async () => {}, retryLater() {}, openTerminal() {}, onError() {},
  };
  const prompt = { id: "token", kind: "question", title: "Pick a color", options: [{ id: "1", label: "Blue" }, { id: "2", label: "Other", other: true }] };
  const pending = new Element("div");
  const detail: { panePrompt: typeof prompt | null; status: string; pane?: string } = { panePrompt: prompt, status: "working" };
  const render = () => window.agentPrompts.renderPromptCards(pending, { key: "/api/agents/test", detail, permissions: { requests: [] }, ...actions });
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
  expect(f.calls).toEqual([["answerPrompt", "token", "2", "A custom answer"]]);
  expect(input.disabled).toBe(true);
});
test("choice buttons submit the displayed prompt token; failure leaves terminal fallback usable", async () => {
  const f = fixture(true);
  await f.box().querySelectorAll("button")[0]!.onclick!();
  expect(f.calls).toEqual([["answerPrompt", "token", "1", undefined]]);
  expect(f.box().querySelectorAll("button")[0]!.disabled).toBe(true);
  expect(f.box().querySelector(".text-button")!.disabled).toBe(false);
});
test("choice labels use the indexed option grid", () => {
  const f = fixture();
  const choice = f.box().querySelectorAll("button")[0]!;
  expect(choice.children.map(child => [child.className, child.textContent])).toEqual([
    ["question-index", "1"], ["question-label", "Blue"],
  ]);
});
test("a new prompt replaces the old form", () => {
  const f = fixture();
  const old = f.box();
  f.detail.panePrompt = { ...f.detail.panePrompt!, id: "next" };
  f.render();
  expect(f.box()).not.toBe(old);
});
test("fallback raw pane text updates without replacing its open disclosure", () => {
  const f = fixture();
  f.detail.panePrompt = null;
  f.detail.status = "needs-attention";
  f.detail.pane = "first live screen";
  f.render();
  const box = f.box();
  const disclosure = box.querySelectorAll("details")[0]!;
  disclosure.open = true;
  f.detail.pane = "second live screen";
  f.render();
  expect(f.box()).toBe(box);
  expect(disclosure.open).toBe(true);
  expect(disclosure.querySelector(".prompt-raw-pane")?.textContent).toBe("second live screen");
});
test("permission buttons answer through the permission callback and report failures", async () => {
  const calls: unknown[] = [], errors: string[] = [];
  const window: any = { agentTranscript: { el: (tag: string, cls?: string, text?: string) => new Element(tag, cls, text), icon: () => new Element("svg") } };
  runInNewContext(source, { window, document: { createTextNode: (text: string) => new Element("#text", "", text) } });
  const pending = new Element("div");
  const request = { id: "req-1", tool: "Bash", summary: "Bash: ls", options: [{ id: "allow", label: "Allow", kind: "allow" }, { id: "deny", label: "Deny" }] };
  window.agentPrompts.renderPromptCards(pending, {
    key: "k", detail: { panePrompt: null, status: "needs-attention" }, permissions: { requests: [request] },
    answerPrompt: async () => {}, answerPermission: async (...args: unknown[]) => { calls.push(args); throw new Error("Gone"); },
    refresh: async () => {}, retryLater() {}, openTerminal() {}, onError: (message: string) => errors.push(message),
  });
  const buttons = pending.children[0]!.querySelectorAll("button");
  expect(buttons.map(button => [button.className, button.textContent])).toEqual([["primary", "Allow"], ["", "Deny"]]);
  await buttons[1]!.onclick!();
  expect(calls).toEqual([[request, "deny"]]);
  expect(errors).toEqual(["Gone"]);
  expect(buttons.every(button => !button.disabled)).toBe(true);
});
test("the page loads prompts.js after transcript.js and before app.js, and the server serves it", () => {
  const html = readFileSync(new URL("../web/index.html", import.meta.url), "utf8");
  const server = readFileSync(new URL("../src/server.ts", import.meta.url), "utf8");
  expect(html).toContain('<script src="/prompts.js" defer></script>');
  expect(html.indexOf("/transcript.js")).toBeLessThan(html.indexOf("/prompts.js"));
  expect(html.indexOf("/prompts.js")).toBeLessThan(html.indexOf("/app.js"));
  expect(server).toContain('"/prompts.js": "web/prompts.js"');
});
