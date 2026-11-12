import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { startApiServer, type ApiServerHandle } from "../src/server";
import { writeAgent } from "../src/state";
import { decisionsPageLink, validDecisionsAgent } from "../src/webDecisions";

const TOKEN = "test-key-with-at-least-24-characters";
const ORIGIN = "https://am.example.test";
const SECRET = "https://drop.example.test/q/SECRET-token-123";

let home: string;
let bin: string;
let server: ApiServerHandle;
const saved = { PATH: process.env.PATH, HOME: process.env.HOME, DECISIONS_HOME: process.env.DECISIONS_HOME, AGENTMGR_HOME: process.env.AGENTMGR_HOME };

// A stand-in for the `drop` CLI; the real one would mint or print a live secret link.
function fakeDrop(script: string) {
  const path = join(bin, "drop");
  writeFileSync(path, `#!/bin/sh\nprintf '%s\\n' "$@" > "${join(home, "drop-argv")}"\n${script}\n`);
  chmodSync(path, 0o755);
}

function writeStore(name: string, decisions: unknown[]) {
  writeFileSync(join(process.env.DECISIONS_HOME!, `${name}.json`), JSON.stringify({ version: 1, agent: name, decisions }));
}

function seedAgent(name: string, status: "idle" | "exited" = "idle") {
  const now = new Date().toISOString();
  writeAgent({ name, status, dir: "/tmp", tmuxSession: `agentmgr-${name}`, createdAt: now, updatedAt: now });
}

const bearer = { authorization: `Bearer ${TOKEN}` };
function post(body: unknown, headers: Record<string, string> = bearer) {
  return fetch(`${server.url}/api/decisions/link`, {
    method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body),
  });
}
function getInbox(headers: Record<string, string> = bearer) {
  return fetch(`${server.url}/api/decisions`, { headers });
}
async function browserCookie(): Promise<string> {
  const login = await fetch(`${server.url}/auth/login`, {
    method: "POST", headers: { origin: ORIGIN, "content-type": "application/json" }, body: JSON.stringify({ token: TOKEN }),
  });
  return login.headers.get("set-cookie")!.split(";")[0]!;
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "am-web-decisions-"));
  bin = join(home, "bin");
  mkdirSync(bin);
  mkdirSync(join(home, "decisions"));
  mkdirSync(join(home, "am"));
  process.env.AGENTMGR_HOME = join(home, "am");
  process.env.DECISIONS_HOME = join(home, "decisions");
  process.env.HOME = home;
  process.env.PATH = `${bin}:/usr/bin:/bin`;
  server = startApiServer({ port: 0, hostname: "127.0.0.1", token: TOKEN, webOrigin: ORIGIN });
});

afterEach(() => {
  server.stop();
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(home, { recursive: true, force: true });
});

describe("POST /api/decisions/link", () => {
  test("requires authentication", async () => {
    fakeDrop(`echo ${SECRET}`);
    const response = await post({}, {});
    expect(response.status).toBe(401);
    expect(await response.text()).not.toContain("SECRET");
    expect((await post({}, { authorization: "Bearer wrong" })).status).toBe(401);
  });

  test("browser sessions need the matching Origin, like every other POST", async () => {
    fakeDrop(`echo ${SECRET}`);
    const cookie = await browserCookie();
    expect((await post({}, { cookie })).status).toBe(403);
    expect((await post({}, { cookie, origin: "https://evil.test" })).status).toBe(403);
    const ok = await post({}, { cookie, origin: ORIGIN });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ url: SECRET });
    // GET is not a way around the origin check.
    expect((await fetch(`${server.url}/api/decisions/link`, { headers: { cookie } })).status).toBe(404);
  });

  test("returns the url with no-store, passing --agent as its own argument", async () => {
    fakeDrop(`echo "$HOME" >/dev/null; echo '${SECRET}?agent=api'`);
    const response = await post({ agent: "api" });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ url: `${SECRET}?agent=api` });
    expect(readFileSync(join(home, "drop-argv"), "utf8")).toBe("decisions\n--agent\napi\n");
    await post({});
    expect(readFileSync(join(home, "drop-argv"), "utf8")).toBe("decisions\n");
  });

  test("validates the agent name before it reaches argv", async () => {
    fakeDrop(`echo ${SECRET}`);
    for (const agent of ["--new", "a b", "../x", "foo-", ".x", "x".repeat(101), "", 3, "host:name", "$(id)"]) {
      const response = await post({ agent });
      expect(response.status).toBe(400);
      expect((await response.json()).reason).toBe("invalid_agent");
    }
    expect((await post(null)).status).toBe(400);
    expect((await post([])).status).toBe(400);
    expect(() => readFileSync(join(home, "drop-argv"))).toThrow();
    expect(validDecisionsAgent("api_2.x")).toBe(true);
  });

  test("missing drop is a 404 with a reason; ~/.local/bin/drop is the fallback", async () => {
    const missing = await post({});
    expect(missing.status).toBe(404);
    expect(missing.headers.get("cache-control")).toBe("no-store");
    expect((await missing.json()).reason).toBe("drop_missing");
    const local = join(home, ".local", "bin");
    mkdirSync(local, { recursive: true });
    writeFileSync(join(local, "drop"), `#!/bin/sh\necho ${SECRET}\n`);
    chmodSync(join(local, "drop"), 0o755);
    expect(await (await post({})).json()).toEqual({ url: SECRET });
  });

  test("a failing drop or one with no https line is a 503 that never echoes its output", async () => {
    fakeDrop(`echo ${SECRET}; echo boom >&2; exit 2`);
    const failed = await post({});
    expect(failed.status).toBe(503);
    const body = await failed.text();
    expect(JSON.parse(body).reason).toBe("drop_failed");
    expect(body).not.toContain("SECRET");
    expect(body).not.toContain("boom");
    fakeDrop(`echo http://drop.example.test/q/SECRET`);
    const bad = await post({});
    expect(bad.status).toBe(503);
    expect((await bad.json()).reason).toBe("drop_bad_output");
  });

  test("a hung drop is killed after the timeout", async () => {
    fakeDrop(`sleep 5; echo ${SECRET}`);
    const started = Date.now();
    const result = await decisionsPageLink(undefined, 200);
    expect(result).toMatchObject({ ok: false, status: 503, reason: "drop_timeout" });
    expect(JSON.stringify(result)).not.toContain("SECRET");
    expect(Date.now() - started).toBeLessThan(3000);
  });

  test("the url appears in neither fleet rows nor the event stream", async () => {
    fakeDrop(`echo ${SECRET}`);
    seedAgent("api");
    writeStore("api", [{ id: "d-1", status: "open", question: "Ship it?", blocking: true }]);
    expect((await post({ agent: "api" })).status).toBe(200);
    expect(await (await fetch(`${server.url}/api/agents`, { headers: bearer })).text()).not.toContain("SECRET");
    const cookie = await browserCookie();
    const events = await fetch(`${server.url}/api/web-events?agent=api`, { headers: { cookie, origin: ORIGIN } });
    expect(events.status).toBe(200);
    const reader = events.body!.getReader();
    const first = new TextDecoder().decode((await reader.read()).value);
    await reader.cancel();
    expect(first).toContain("event: ready");
    expect(first).not.toContain("SECRET");
  });
});

describe("GET /api/agents/:name/decisions", () => {
  test("returns open decisions only, blocking first; requires auth and a local agent", async () => {
    seedAgent("api");
    writeStore("api", [
      { id: "d-1", status: "open", question: "Later?", asked_at: "2026-01-01T00:00:00Z", options: ["a", 3, "b"] },
      { id: "d-2", status: "decided", question: "Done?" },
      { id: "d-3", status: "open", question: "Now?", blocking: true, why: "needs a call", recommendation: "yes", link: "https://example.test/x", prs: ["https://github.com/o/r/pull/1"] },
    ]);
    expect((await fetch(`${server.url}/api/agents/api/decisions`)).status).toBe(401);
    expect((await fetch(`${server.url}/api/agents/missing/decisions`, { headers: bearer })).status).toBe(404);
    expect((await fetch(`${server.url}/api/agents/..%2Fx/decisions`, { headers: bearer })).status).toBe(400);
    const body = await (await fetch(`${server.url}/api/agents/api/decisions`, { headers: bearer })).json();
    expect(body).toEqual({ decisions: [
      { id: "d-3", question: "Now?", options: [], recommendation: "yes", why: "needs a call", blocking: true, link: "https://example.test/x", prs: ["https://github.com/o/r/pull/1"], asked_at: null },
      { id: "d-1", question: "Later?", options: ["a", "b"], recommendation: null, why: null, blocking: false, link: null, prs: [], asked_at: "2026-01-01T00:00:00Z" },
    ] });
  });

  test("remote agents return an empty list marked remote, without ssh", async () => {
    writeFileSync(join(process.env.AGENTMGR_HOME!, "config.json"), JSON.stringify({ remotes: ["laptop"] }));
    const body = await (await fetch(`${server.url}/api/agents/laptop:api/decisions`, { headers: bearer })).json();
    expect(body).toEqual({ decisions: [], remote: true });
  });

  test("decisions turned off in config read as none", async () => {
    seedAgent("api");
    writeStore("api", [{ id: "d-1", status: "open", question: "Q?" }]);
    writeFileSync(join(process.env.AGENTMGR_HOME!, "config.json"), JSON.stringify({ decisions: false }));
    expect(await (await fetch(`${server.url}/api/agents/api/decisions`, { headers: bearer })).json()).toEqual({ decisions: [] });
  });
});

describe("GET /api/decisions", () => {
  test("requires auth and returns all local open stores with no-store, without running drop", async () => {
    seedAgent("stopped", "exited");
    writeStore("stopped", [
      { id: "d-2", status: "open", question: "Later", asked_at: "2026-02-02T00:00:00Z" },
      { id: "d-1", status: "open", question: "Block", blocking: true, asked_at: "2026-03-01T00:00:00Z" },
      { id: "d-3", status: "decided", question: "Secret", answer: "never expose" },
    ]);
    writeStore("orphan", [{ id: "d-4", status: "open", question: "Orphan?", asked_at: 42, answer: "also secret" }]);
    fakeDrop(`echo ${SECRET}; echo called > "${join(home, "drop-called")}"`);
    writeFileSync(join(process.env.AGENTMGR_HOME!, "config.json"), JSON.stringify({ remotes: ["laptop", "build", "laptop"] }));

    expect((await getInbox({})).status).toBe(401);
    const response = await getInbox();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      groups: [
        { agent: "stopped", decisions: [
          { id: "d-1", question: "Block", options: [], recommendation: null, why: null, blocking: true, link: null, prs: [], asked_at: "2026-03-01T00:00:00Z" },
          { id: "d-2", question: "Later", options: [], recommendation: null, why: null, blocking: false, link: null, prs: [], asked_at: "2026-02-02T00:00:00Z" },
        ] },
        { agent: "orphan", decisions: [
          { id: "d-4", question: "Orphan?", options: [], recommendation: null, why: null, blocking: false, link: null, prs: [], asked_at: null },
        ] },
      ],
      remoteHosts: ["laptop", "build"], enabled: true, complete: true,
    });
    expect(() => readFileSync(join(home, "drop-called"))).toThrow();
  });

  test("uses the safe filename as agent identity and skips malformed or hostile filenames", async () => {
    writeFileSync(join(process.env.DECISIONS_HOME!, "safe.json"), JSON.stringify({
      version: 1, agent: "<img src=x onerror=alert(1)>", host: "secret", answer: "secret",
      decisions: [{ id: "d-1", status: "open", question: "<script>alert(1)</script>" }],
    }));
    writeStore("bad name", [{ id: "d-2", status: "open", question: "No" }]);
    writeFileSync(join(process.env.DECISIONS_HOME!, "broken.json"), "{");
    const body = await (await getInbox()).json() as { groups: unknown[] };
    expect(body.groups).toEqual([{ agent: "safe", decisions: [{
      id: "d-1", question: "<script>alert(1)</script>", options: [], recommendation: null, why: null,
      blocking: false, link: null, prs: [], asked_at: null,
    }] }]);
    expect(JSON.stringify(body)).not.toContain("onerror");
    expect(JSON.stringify(body)).not.toContain("secret");
  });

  test("decisions false returns the distinct disabled contract", async () => {
    writeStore("api", [{ id: "d-1", status: "open", question: "Hidden" }]);
    writeFileSync(join(process.env.AGENTMGR_HOME!, "config.json"), JSON.stringify({ decisions: false, remotes: ["laptop"] }));
    expect(await (await getInbox()).json()).toEqual({ groups: [], remoteHosts: ["laptop"], enabled: false, complete: true });
  });
});

test("web fleet rows carry the decision fields, exited agents included", async () => {
  seedAgent("api", "exited");
  seedAgent("quiet");
  writeStore("api", [
    { id: "d-1", status: "open", question: "First?", asked_at: "2026-01-01T00:00:00Z" },
    { id: "d-2", status: "open", question: "Blocking?", blocking: true, asked_at: "2026-01-02T00:00:00Z" },
  ]);
  const { rows } = await (await fetch(`${server.url}/api/agents`, { headers: bearer })).json() as { rows: Record<string, unknown>[] };
  expect(rows.find((row) => row.name === "api")).toMatchObject({
    status: "exited", openDecisions: 2, blockingDecisions: 1, oldestDecisionAt: "2026-01-01T00:00:00Z", firstDecision: "Blocking?",
  });
  const quiet = rows.find((row) => row.name === "quiet")!;
  expect(quiet).toMatchObject({ openDecisions: 0, blockingDecisions: 0 });
  expect(quiet).not.toHaveProperty("firstDecision");
});

describe("web/decisions.js", () => {
  class Node {
    children: (Node | string)[] = [];
    attrs = new Map<string, string>();
    className = "";
    disabled = false;
    href = "";
    target = "";
    rel = "";
    type = "";
    title = "";
    onclick?: () => Promise<void>;
    constructor(public tag: string) {}
    set textContent(value: string) { this.children = [String(value)]; }
    get textContent(): string { return this.children.map((c) => (typeof c === "string" ? c : c.textContent)).join(""); }
    set innerHTML(_: string) { throw new Error("innerHTML must not be used"); }
    append(...nodes: (Node | string)[]) { this.children.push(...nodes); }
    setAttribute(name: string, value: string) { this.attrs.set(name, value); }
    removeAttribute(name: string) { this.attrs.delete(name); }
    all(): Node[] { return this.children.flatMap((c) => (typeof c === "string" ? [] : [c, ...c.all()])); }
    find(cls: string): Node[] { return this.all().filter((n) => n.className.split(" ").includes(cls)); }
  }
  const source = readFileSync(new URL("../web/decisions.js", import.meta.url), "utf8");
  const window: any = {};
  runInNewContext(source, { window, URL, document: { createElement: (tag: string) => new Node(tag), createTextNode: (text: string) => text } });
  const D = window.agentDecisions;
  const NOW = Date.parse("2026-07-22T12:00:00.000Z");
  const decision = (extra: Record<string, unknown> = {}) => ({
    id: "d-3", question: "Ship <b>it</b>?", options: ["<img src=x onerror=alert(1)>", "no"], recommendation: "yes", why: "why <i>", blocking: true,
    link: "https://example.test/ctx", prs: [], asked_at: "2026-07-22T10:00:00.000Z", ...extra,
  });

  test("never touches the network or app globals", () => {
    expect(source).not.toMatch(/fetch\(|api\(|innerHTML|insertAdjacentHTML|window\.open|\bstate\.|\bnotice\(|refreshDetail/);
  });

  test("nothing open renders nothing", () => {
    expect(D.renderDecisionCard([], { agent: "api" })).toBeNull();
    expect(D.renderDecisionCard(undefined, { agent: "api" })).toBeNull();
  });

  test("agent text stays text, with the blocking marker, age, options and context link", () => {
    const card = D.renderDecisionCard([decision()], { agent: "api", now: NOW }) as Node;
    expect(card.className).toBe("decisions-card blocking");
    expect(card.find("decisions-title")[0]!.textContent).toBe("1 decision waiting on you");
    expect(card.find("decision-question")[0]!.children).toEqual(["Ship <b>it</b>?"]);
    expect(card.all().some((n) => ["b", "i", "img"].includes(n.tag))).toBe(false);
    expect(card.find("decision-option").map((n) => n.textContent)).toEqual(["<img src=x onerror=alert(1)>", "no"]);
    expect(card.find("decision-option").every((n) => n.tag === "li")).toBe(true);
    expect(card.find("decision-blocking")[0]!.textContent).toBe("Blocking");
    expect(card.find("decision-age")[0]!.textContent).toBe("asked 2h ago");
    expect(card.find("decision-why")[0]!.textContent).toBe("Why why <i>");
    expect(card.find("decision-recommendation")[0]!.textContent).toBe("Recommends yes");
    const link = card.find("decision-link")[0]!;
    expect([link.tag, link.href, link.target, link.rel]).toEqual(["a", "https://example.test/ctx", "_blank", "noopener noreferrer"]);
  });

  test("non-http links are not linked", () => {
    for (const link of ["javascript:alert(1)", "data:text/html,x", "file:///etc/passwd", "not a url"]) {
      const card = D.renderDecisionCard([decision({ link })], { agent: "api", now: NOW }) as Node;
      expect(card.all().some((n) => n.tag === "a")).toBe(false);
      expect(card.find("decision-link-text")[0]!.textContent).toBe(link);
    }
    expect(D.safeLink("http://x.test/a")).toBe("http://x.test/a");
  });

  test("the answer button calls back with the decision and agent, busy until it settles", async () => {
    const calls: unknown[] = [];
    let settle!: () => void;
    const first = decision(), second = decision({ id: "d-4", blocking: false });
    const card = D.renderDecisionCard([first, second], {
      agent: "api", now: NOW,
      onAnswer: (d: unknown, agent: string) => { calls.push([d, agent]); return new Promise<void>((resolve) => { settle = resolve; }); },
    }) as Node;
    const buttons = card.find("decision-answer");
    expect(buttons.map((b) => b.textContent)).toEqual(["Answer on the decisions page", "Answer on the decisions page"]);
    const clicked = buttons[1]!.onclick!();
    const duplicate = buttons[1]!.onclick!();
    expect(buttons[1]!.disabled).toBe(true);
    expect(calls).toEqual([[second, "api"]]);
    settle();
    await Promise.all([clicked, duplicate]);
    expect(buttons[1]!.disabled).toBe(false);
  });

  test("an unavailable page disables the buttons with its explanation", () => {
    const card = D.renderDecisionCard([decision()], { agent: "api", now: NOW, unavailable: "Not set up here.", onAnswer() {} }) as Node;
    const button = card.find("decision-answer")[0]!;
    expect([button.disabled, button.title]).toEqual([true, "Not set up here."]);
    expect(card.find("decisions-unavailable")[0]!.textContent).toBe("Not set up here.");
  });

  test("answer controls only render when the host supplies a callback", () => {
    const readonly = D.renderDecisionCard([decision()], { agent: "api", showAnswer: false }) as Node;
    const defaultCard = D.renderDecisionCard([decision()], { agent: "api" }) as Node;
    expect(readonly.find("decision-answer")).toHaveLength(0);
    expect(defaultCard.find("decision-answer")).toHaveLength(0);
  });

  test("the page loads decisions.js before app.js and the server serves it", () => {
    const html = readFileSync(new URL("../web/index.html", import.meta.url), "utf8");
    const serverSource = readFileSync(new URL("../src/server.ts", import.meta.url), "utf8");
    expect(html).toContain('<script src="/decisions.js" defer></script>');
    expect(html).toContain('<script src="/decisionsPage.js" defer></script>');
    expect(html.indexOf("/decisions.js")).toBeLessThan(html.indexOf("/app.js"));
    expect(html.indexOf("/decisions.js")).toBeLessThan(html.indexOf("/decisionsPage.js"));
    expect(html.indexOf("/decisionsPage.js")).toBeLessThan(html.indexOf("/app.js"));
    expect(serverSource).toContain('"/decisions.js": "web/decisions.js"');
    expect(serverSource).toContain('"/decisionsPage.js": "web/decisionsPage.js"');
  });
});
