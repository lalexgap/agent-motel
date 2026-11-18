import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

class Node {
  dataset: Record<string, string> = {};
  children: Node[] = [];
  open = false;
  className = "";
  text = "";
  attrs: Record<string, string> = {};
  listeners: Record<string, () => unknown> = {};
  type = "";
  disabled = false;
  tabIndex = -1;
  constructor(readonly tag: string) {}
  get textContent() { return this.text + this.children.map(node => node.textContent).join(""); }
  set textContent(text: string) { this.text = text; }
  append(...nodes: Node[]) { this.children.push(...nodes); }
  replaceChildren() { this.children = []; this.text = ""; }
  setAttribute(name: string, value: string) { this.attrs[name] = value; }
  addEventListener(name: string, handler: () => unknown) { this.listeners[name] = handler; }
}
const source = readFileSync(new URL("../web/app.js", import.meta.url), "utf8");
const renderer = readFileSync(new URL("../web/transcript.js", import.meta.url), "utf8");
const stubs = () => ({
  document: { createElement: (tag: string) => new Node(tag) },
  window: {
    agentMarkdown: {
      render: (node: Node, text: string) => { node.text = text; },
      codeTokens: () => new Set<number>(),
    },
    agentLinks: { render: (node: Node, text: string) => { node.text = text; } },
  } as any,
});
const { document, window } = stubs();
runInNewContext(renderer, { document, window });
const context: any = { el: window.agentTranscript.el, chatTurn: window.agentTranscript.chatTurn };
// pendingBubble and queuedMessageKey stay in app.js on top of the shared chatTurn.
runInNewContext(source.slice(source.indexOf("function queuedMessageKey("), source.indexOf("function queueAsideItem(")), context);
const wrapped = (body: string) => `<subagent_notification>\n${body}\n</subagent_notification>`;
const render = (text: string, kind = "user", index = 42): Node => context.chatTurn({ text, kind, index }, "Agent");
const actual = (() => {
  const document = {
    createElement: (tag: string) => new Node(tag),
    createTextNode: (text: string) => Object.assign(new Node("text"), { textContent: text }),
  };
  const window: any = { navigator: {} };
  const sandbox = { document, window, URL };
  for (const file of ["links.js", "markdown.js", "transcript.js"])
    runInNewContext(readFileSync(new URL("../web/" + file, import.meta.url), "utf8"), sandbox);
  return (text: string) => window.agentTranscript.chatTurn({ text, kind: "user", index: 42 }, "Agent") as Node;
})();
// Run the regressions in V8, where the original regex backtracked; Bun uses JavaScriptCore.
const renderWithinTimeout = (text: string): Node => JSON.parse(execFileSync("node", ["--input-type=module", "-e", `
  import { readFileSync } from "node:fs";
  import { runInNewContext } from "node:vm";
  ${Node.toString()}
  const stubs = ${stubs.toString()};
  const { renderer, text } = JSON.parse(readFileSync(0, "utf8"));
  const turn = runInNewContext(renderer + '\\nwindow.agentTranscript.chatTurn(entry, "Agent")', {
    entry: { text, kind: "user", index: 42 },
    ...stubs(),
  }, { timeout: 1000 });
  process.stdout.write(JSON.stringify(turn));
`], { input: JSON.stringify({ renderer, text }), encoding: "utf8", timeout: 3000 }));

function details(turn: Node) { return turn.children.find(node => node.tag === "details"); }
function allDetails(node: Node): Node[] {
  return node.children.flatMap(child => [...(child.tag === "details" ? [child] : []), ...allDetails(child)]);
}

function visible(turn: Node): string {
  const children = turn.tag === "details" && !turn.open ? turn.children.slice(0, 1) : turn.children;
  return [turn.text, ...children.map(visible)].join(" ");
}
const task = (status = "completed", extra = "") => `<task-notification>
<task-id>abc</task-id><output-file>/tmp/private-output</output-file>
<status>${status}</status><summary>Agent "Shepherd PR 29905" is waiting on its own background work</summary>
<note>This result may be interim.</note><result>Waiting on the gated spec run.</result>
<usage><subagent_tokens>85290</subagent_tokens><tool_uses>9</tool_uses><duration_ms>58468</duration_ms></usage>${extra}
</task-notification>`;

describe("transcript notices", () => {
  test("question replies show questions and answers without the transport wrapper or IDs", () => {
    const text = `<send_user_message_question_reply>${JSON.stringify([
      { question: "Does Firefox work?", answer: "Firefox seems to work okay.", questionItemId: "private-call-id" },
      { question: "Browser?", answer: "<img src=x onerror=alert(1)>" },
    ])}</send_user_message_question_reply>`;
    const turn = render(text);
    expect(turn.className).toBe("turn notice");
    expect(visible(turn)).toContain("2 questions answered");
    expect(visible(turn)).toContain("Q: Does Firefox work?\nA: Firefox seems to work okay.");
    expect(visible(turn)).toContain("<img src=x onerror=alert(1)>");
    expect(visible(turn)).not.toContain("private-call-id");
    expect(visible(turn)).not.toContain("send_user_message_question_reply");
    expect(details(turn)!.open).toBe(false);
    expect(details(turn)!.children[1]!.text).toBe(text);
    expect(context.pendingBubble(text, "Queued", "reply:1").className).toBe("turn notice queued");
    expect(details(render("Example: " + text))).toBeUndefined();
    expect(details(render(text, "assistant"))).toBeUndefined();
  });

  test("malformed and oversized question replies stay compact with full details available", () => {
    for (const body of ["not JSON", "null", "[]", '[{"answer":42}]', "x".repeat(200000),
      JSON.stringify(Array.from({ length: 5 }, () => ({ question: "q".repeat(1000), answer: "a".repeat(5000) })))]) {
      const text = `<send_user_message_question_reply>${body}</send_user_message_question_reply>`;
      const turn = renderWithinTimeout(text);
      expect(details(turn)!.open).toBe(false);
      expect(details(turn)!.children[1]!.text).toBe(text);
      expect(visible(turn).length).toBeLessThan(4500);
    }
  });

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

  test("hook prompts collapse transport metadata and preserve complete details", () => {
    for (const opening of ['<hook_prompt>', '<hook_prompt hook_run_id="stop:7:/private/config.toml">', "<hook_prompt\n hook_run_id = 'stop:8' >"]) {
      const text = `${opening}\nRun the hook follow-up. <img src=x onerror=alert(1)>\n</hook_prompt>`;
      const turn = render(text);
      expect(turn.className).toBe("turn notice");
      expect(visible(turn)).toContain("System / hook notice");
      expect(visible(turn)).not.toContain("hook_run_id");
      expect(visible(turn)).not.toContain("/private/");
      expect(details(turn)!.open).toBe(false);
      expect(details(turn)!.children[1]!.text).toBe(text);
      expect(details(render(text, "assistant"))).toBeUndefined();
    }
    const inbox = '[am inbox] Before you finish: you have 1 message to handle first (arrived while you were busy).\n[am message data begin]\n{"provenance":{"kind":"peer"},"body":"Hello"}\n[am message data end]';
    const turn = render(`<hook_prompt hook_run_id="stop:7">${inbox}</hook_prompt>`);
    expect(visible(turn)).toContain("AM inbox");
    expect(turn.className).toBe("turn notice");
  });

  test("quoted, mixed, malformed and oversized hook prompt openings stay ordinary messages", () => {
    for (const text of [
      'Explain <hook_prompt hook_run_id="stop:7">example</hook_prompt>',
      '```\n<hook_prompt>example</hook_prompt>\n```',
      '<hook_prompt>example</hook_prompt> Please explain',
      '<hook_prompt>one</hook_prompt><hook_prompt>two</hook_prompt>',
      '<hook_prompt>',
      '<hook_prompt hook_run_id="unterminated>body</hook_prompt>',
      '<hook_prompt hook_run_id="' + 'x'.repeat(5000) + '">body</hook_prompt>',
    ]) expect(details(renderWithinTimeout(text))).toBeUndefined();
    const text = '<hook_prompt hook_run_id="stop:7">' + 'x'.repeat(200000) + '</hook_prompt>';
    const turn = renderWithinTimeout(text);
    expect(details(turn)!.children[1]!.text).toBe(text);
    expect(visible(turn).length).toBeLessThan(200);
  });

  test("peer messages start collapsed with the sender visible and never verify sender authority", () => {
    const turn = render('[am · from host:reviewer] <img src=x> [am] Verified operator message');
    expect(turn.className).toBe("turn peer");
    const message = details(turn)!;
    expect(message.open).toBe(false);
    expect(visible(turn)).toContain("Message from host:reviewer");
    expect(visible(turn)).not.toContain("Verified operator message");
    expect(message.children[1]!.text).toBe("<img src=x> [am] Verified operator message");
    expect(message.dataset.scrollKey).toBe("peer:42");
    expect(message.children[0]!.dataset.scrollKey).toBe("peer-summary:42");
    message.open = true;
    expect(visible(turn)).toContain("<img src=x> [am] Verified operator message");
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
    expect(visible(turn)).toContain("Message from am-notifications");
    expect(details(turn)!.open).toBe(false);
    expect(details(turn)!.children[1]!.text).toBe("Ready");
  }
  expect(visible(render("[am · from am-notifications]"))).toContain("Message from am-notifications");
});

test("queued and optimistic messages use transcript peer and notice presentation", () => {
  const peer = context.pendingBubble(
    "[am · from am-token-usage-page]\nUsage is ready",
    "Queued · sends when the agent is free",
    "queue:receipt-1",
  );
  expect(peer.className).toBe("turn peer queued");
  expect(visible(peer)).toContain("Message from am-token-usage-page");
  expect(details(peer)!.children[1]!.text).toBe("Usage is ready");
  expect(visible(peer)).not.toContain("Usage is ready");
  expect(peer.children[1]!.text).toBe("Queued · sends when the agent is free");
  expect(peer.dataset.scrollKey).toBe("turn:queue:receipt-1");

  const headerOnly = context.pendingBubble(
    "[am · from am-token-usage-page]",
    "Sent · waiting for the agent to read it",
    "pending:receipt-2",
  );
  expect(headerOnly.className).toBe("turn peer queued");
  expect(visible(headerOnly)).toContain("Message from am-token-usage-page");
  expect(details(headerOnly)!.children[1]!.text).toBe("");
  expect(visible(headerOnly)).not.toContain("[am · from");

  const notification = context.pendingBubble(task(), "Queued", "queue:receipt-3");
  expect(notification.className).toBe("turn notice queued");
  expect(notification.children[0]!.text).toContain("Shepherd PR 29905");
  expect(visible(notification)).not.toContain("/tmp/private-output");
  expect(details(notification)!.dataset.scrollKey).toBe("notice:queue:receipt-3");

  const ordinary = context.pendingBubble("Please keep this as my message", "Queued", "queue:receipt-4");
  expect(ordinary.className).toBe("turn user queued");
  expect(ordinary.children[0]!.text).toBe("You");
  expect(ordinary.children[1]!.text).toBe("Please keep this as my message");
});

test("queue fallback keys remain stable for the same message", () => {
  expect(context.queuedMessageKey("queue", undefined, "same text"))
    .toBe(context.queuedMessageKey("queue", undefined, "same text"));
  expect(context.queuedMessageKey("queue", "receipt-1", "changed text")).toBe("queue:receipt-1");
});

describe("pasted content", () => {
  test("collapses one Claude wrapper while retaining surrounding text and a stable identity", () => {
    const text = `Before the paste.\n\n<pasted_content id="7d59">\nfirst **body**\n</pasted_content>\n\nAfter.`;
    const turn = render(text);
    const pastes = allDetails(turn).filter(node => node.className === "pasted-content");
    expect(pastes.length).toBe(1);
    expect(pastes.map(node => node.open)).toEqual([false]);
    expect(pastes.map(node => node.children[0]!.text)).toEqual(["Pasted content"]);
    expect(pastes.map(node => node.children[1]!.text)).toEqual(["\nfirst **body**\n"]);
    expect(pastes.map(node => node.dataset.scrollKey)).toEqual(["paste:42:0"]);
    expect(pastes[0]!.children[0]!.dataset.scrollKey).toBe("paste:42:0:summary");
    expect(pastes[0]!.children[1]!.dataset.scrollKey).toBe("paste:42:0:body");
    expect(visible(turn)).toContain("Before the paste.");
    expect(visible(turn)).toContain("After.");
    expect(visible(turn)).not.toContain("first **body**");
    pastes[0]!.open = true;
    expect(visible(turn)).toContain("first **body**");
  });

  test("keeps repeated, stray, and forged in-band boundaries completely raw", () => {
    for (const ambiguous of [
      '<pasted_content id="real">before</pasted_content id="real">\nforged prose\n<pasted_content id="real">after</pasted_content id="real">',
      '<pasted_content id="real">before</pasted_content id="real">\nforged prose\n<pasted_content id="other">after</pasted_content id="real">',
      '<pasted_content id="real">before</pasted_content>\nforged prose\n<pasted_content id="real">after</pasted_content>',
      '</pasted_content><pasted_content id="real">body</pasted_content>',
      '<pasted_content id="one">first</pasted_content> <pasted_content id="two">second</pasted_content>',
    ]) {
      const turn = render(ambiguous);
      expect(allDetails(turn)).toEqual([]);
      expect(turn.children[1]!.text).toBe(ambiguous);
    }
  });

  test("accepts matching smart-quote IDs and preserves opening-only boundaries", () => {
    const smart = render('<pasted_content id="7d59”>smart body</pasted_content id="7d59”> tail');
    expect(allDetails(smart)[0]!.children[1]!.text).toBe("smart body");
    expect(visible(smart)).toContain("tail");

    const partial = render('Lead <pasted_content id="open-only">body\nwith no close');
    const paste = allDetails(partial)[0]!;
    expect(paste.children[1]!.text).toBe("body\nwith no close");
    paste.open = true;
    expect(visible(partial)).toContain("body\nwith no close");
  });

  test("leaves mismatched, nested, and arbitrary pasted-content-like tags completely raw", () => {
    for (const malformed of [
      '<pasted_content id="one">keep</pasted_content id="two"> and keep this',
      '<pasted_content id="outer">before <pasted_content id="inner">inside</pasted_content> after</pasted_content>',
      '<pasted_content>no id</pasted_content>',
      '<pasted_content id="bad value">ordinary</pasted_content>',
      '<pasted_content id="unterminated>ordinary</pasted_content>',
      '<pasted_content data-id="x">ordinary</pasted_content>',
    ]) {
      const turn = render(malformed);
      expect(allDetails(turn)).toEqual([]);
      expect(turn.children[1]!.text).toBe(malformed);
    }
  });

  test("keeps fenced and inline code literals unchanged and renders malicious bodies as text", () => {
    const literal = '`<pasted_content id="inline">x</pasted_content>`\n\n```xml\n<pasted_content id="fenced">\ny\n</pasted_content>\n```';
    expect(allDetails(render(literal))).toEqual([]);
    expect(render(literal).children[1]!.text).toBe(literal);

    const attack = '<pasted_content id="safe"><img src=x onerror=alert(1)><script>alert(1)</script></pasted_content>';
    const turn = render(attack);
    const paste = allDetails(turn)[0]!;
    expect(paste.children[1]!.text).toBe('<img src=x onerror=alert(1)><script>alert(1)</script>');
    const tags: string[] = [];
    const walk = (node: Node) => { tags.push(node.tag); node.children.forEach(walk); };
    walk(turn);
    expect(tags).not.toContain("img");
    expect(tags).not.toContain("script");
    expect(renderer).not.toContain("innerHTML");
  });

  test("uses actual Markdown code scopes for quoted and listed fences and separate paragraphs", () => {
    for (const literal of [
      '> ~~~\n> <pasted_content id="quoted">body</pasted_content>\n> ~~~',
      '- example\n  ~~~\n  <pasted_content id="listed">body</pasted_content>\n  ~~~',
      '`<pasted_content id="inline">body</pasted_content>`',
    ]) {
      const turn = actual(literal);
      expect(allDetails(turn).filter(node => node.className === "pasted-content")).toEqual([]);
      expect(turn.textContent).toContain("<pasted_content");
    }
    const separate = actual('`unclosed\n\n<pasted_content id="real">body</pasted_content>`');
    const paste = allDetails(separate).filter(node => node.className === "pasted-content");
    expect(paste.length).toBe(1);
    expect(paste[0]!.children[1]!.textContent).toBe("body");
  });

  test("assistant messages and existing notice classification stay unchanged", () => {
    const wrapped = '<pasted_content id="x">body</pasted_content>';
    expect(allDetails(render(wrapped, "assistant"))).toEqual([]);
    expect(render(wrapped, "assistant").children[1]!.text).toBe(wrapped);
    const notice = render(task().replace("This result may be interim.", wrapped));
    expect(notice.className).toBe("turn notice");
    expect(allDetails(notice).filter(node => node.className === "pasted-content")).toEqual([]);
  });

  test("bounds pathological candidate and unmatched-backtick scanning", () => {
    const text = "prefix " + ("`".repeat(99) + " < ").repeat(800) + '<pasted_content id="last">body</pasted_content>';
    const start = performance.now();
    const turn = renderWithinTimeout(text);
    expect(performance.now() - start).toBeLessThan(3000);
    expect(allDetails(turn).filter(node => node.className === "pasted-content").length).toBe(1);
    const oversized = '<pasted_content id="large">' + "x".repeat(100000) + "</pasted_content>";
    const raw = renderWithinTimeout(oversized);
    expect(allDetails(raw)).toEqual([]);
    expect(raw.children[1]!.text).toBe(oversized);
    const collisions = Array.from({ length: 16 }, (_, index) =>
      `\uE000paste${index.toString(16).padStart(2, "0")}\uE001`).join("") +
      '<pasted_content id="collision">body</pasted_content>';
    const collisionStart = performance.now();
    const collisionRaw = renderWithinTimeout(collisions);
    expect(performance.now() - collisionStart).toBeLessThan(3000);
    expect(allDetails(collisionRaw)).toEqual([]);
    expect(collisionRaw.children[1]!.text).toBe(collisions);
    const rendered = "plain text ".repeat(8000) + '<pasted_content id="bounded">body</pasted_content>';
    const renderStart = performance.now();
    expect(allDetails(actual(rendered)).filter(node => node.className === "pasted-content").length).toBe(1);
    expect(performance.now() - renderStart).toBeLessThan(3000);
  });
});


test("AM pull-request lifecycle updates collapse generated follow-up text", () => {
  for (const [event, status] of [["merged at " + "a".repeat(40) + " on 2026-11-10T12:00:00Z", "merged"], ["closed without merging", "closed"], ["reopened", "reopened"]]) {
    const text = `[am] PR #42 ${event}\nRepository: example/repo\nhttps://github.com/example/repo/pull/42\nGenerated follow-up instructions.`;
    const turn = render(text);
    expect(turn.children[0]!.text).toBe(`↗ PR #42 · ${status}`);
    expect(visible(turn)).toContain("example/repo");
    expect(visible(turn)).toContain("[Open pull request](https://github.com/example/repo/pull/42)");
    expect(visible(turn)).not.toContain("Generated follow-up");
    expect(details(turn)!.open).toBe(false);
    expect(details(turn)!.children[1]!.text).toBe(text);
  }
  expect(details(render("[am] PR #42 reopened"))).toBeDefined();
  for (const text of ["Please explain [am] PR #42 reopened", "[am] PR #42 is an example"]) {
    expect(details(render(text))).toBeUndefined();
    expect(render(text).children[0]!.text).toBe("You");
  }
  for (const url of ["https://evil.example/pull/42", "https://github.com/example/repo/pull/43"]) {
    expect(visible(render(`[am] PR #42 reopened\nRepository: example/repo\n${url}`))).not.toContain("Open pull request");
  }
});
