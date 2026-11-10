import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { FIXTURE_TOKEN, startFixtureServer, type FixtureServer } from "../desktop/fixtures/server";

let fixture: FixtureServer;
beforeAll(() => {
  fixture = startFixtureServer({ port: 0, flipMs: 100 });
});
afterAll(() => fixture.stop());

const get = (path: string, token: string | null = FIXTURE_TOKEN, init: RequestInit = {}) =>
  fetch(fixture.url + path, { ...init, headers: token ? { authorization: `Bearer ${token}` } : {} });
const body = async (path: string): Promise<any> => (await get(path)).json();

describe("fixture am server", () => {
  test("binds loopback and requires the bearer token", async () => {
    expect(fixture.url).toStartWith("http://127.0.0.1:");
    for (const token of [null, "wrong"]) {
      const response = await get("/api/health", token);
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ error: "unauthorized" });
    }
    expect((await get("/api/events", null)).status).toBe(401);
    expect(await body("/api/health")).toEqual({ ok: true, name: "am" });
  });

  test("GET only", async () => {
    expect((await get("/api/agents", FIXTURE_TOKEN, { method: "POST" })).status).toBe(405);
  });

  test("hosts and agents follow the contract shapes", async () => {
    const hosts = await body("/api/hosts");
    expect(hosts.local).toBe("motel");
    expect(hosts.hosts).toContainEqual({ name: "annex", reachable: true });
    const agents = await body("/api/agents");
    expect(Array.isArray(agents.rows)).toBe(true);
    expect(agents.unreachable).toEqual(["lantern"]);
    expect(agents.rows.length).toBeGreaterThanOrEqual(12);
    const statuses = new Set(agents.rows.map((row: { status: string }) => row.status));
    for (const status of ["starting", "idle", "working", "waiting", "needs-attention", "exited", "dead"]) expect(statuses).toContain(status);
    expect(new Set(agents.rows.map((row: { provider: string }) => row.provider))).toEqual(new Set(["claude", "codex"]));
    for (const row of agents.rows) {
      expect(typeof row.name).toBe("string");
      expect(Number.isFinite(Date.parse(row.statusChangedAt))).toBe(true);
      expect(Number.isFinite(Date.parse(row.updatedAt))).toBe(true);
      expect(typeof row.dir).toBe("string");
    }
    expect(agents.rows.some((row: { host?: string; repoRoot?: string }) => !row.host && !row.repoRoot)).toBe(true);
  });

  test("detail and transcript, including a remote host:name key", async () => {
    const detail = await body("/api/agents/harbor-lights");
    expect(detail).toMatchObject({ name: "harbor-lights", status: "working", provider: "claude", queue: [], pane: "", pendingPermissions: 0 });
    const transcript = await body("/api/agents/harbor-lights/transcript");
    expect(transcript.total).toBe(transcript.entries.length);
    const kinds = new Set(transcript.entries.map((entry: { kind: string }) => entry.kind));
    expect(kinds).toEqual(new Set(["user", "assistant", "tool"]));
    const texts = transcript.entries.map((entry: { text?: string }) => entry.text || "");
    expect(texts.some((text: string) => text.startsWith("<task-notification>"))).toBe(true);
    expect(texts.some((text: string) => text.startsWith("[am · from tide-pilot]"))).toBe(true);
    expect(texts.some((text: string) => /^\[am\] PR #12 merged/.test(text))).toBe(true);
    expect(texts.some((text: string) => text.includes("| --- |") && text.includes("```"))).toBe(true);
    const indexes = transcript.entries.map((entry: { index: number }) => entry.index);
    expect(indexes).toEqual([...indexes].sort((a, b) => a - b));
    const remote = await body("/api/agents/" + encodeURIComponent("annex:kelp-forest") + "/transcript");
    expect(remote.provider).toBe("codex");
    expect(remote.entries.length).toBeGreaterThan(0);
    expect((await get("/api/agents/nobody")).status).toBe(404);
  });

  test("events stream sends ready, then fleet events as drift-net flips", async () => {
    const controller = new AbortController();
    const response = await fetch(fixture.url + "/api/events", { headers: { authorization: `Bearer ${FIXTURE_TOKEN}` }, signal: controller.signal });
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let text = "";
    const deadline = Date.now() + 3000;
    while (!/event: fleet\n/.test(text) && Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      text += decoder.decode(value);
    }
    controller.abort();
    expect(text.indexOf("event: ready\n")).toBe(0);
    expect(text).toMatch(/event: fleet\ndata: \{.*"agent":"drift-net"/);
  });
});
