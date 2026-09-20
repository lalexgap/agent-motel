import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { createEmbedder, normalizeVector, type Embedder } from "../src/embeddings";
import { chunkText, indexConversations, mergeHybrid, searchWithEmbeddings, semanticSearch } from "../src/semanticSearch";
import { search } from "../src/search";
import { writeAgent } from "../src/state";

let home: string;
let oldHome: string | undefined;
let oldKey: string | undefined;
let requests: string[][];
let embedder: Embedder;
let fetchSpy: ReturnType<typeof spyOn> | undefined;

beforeEach(() => {
  oldHome = process.env.AGENTMGR_HOME;
  oldKey = process.env.AM_TEST_EMBEDDING_KEY;
  home = mkdtempSync(join(tmpdir(), "am-embedding-"));
  process.env.AGENTMGR_HOME = home;
  requests = [];
  embedder = {
    id: "test:model:v1",
    async embed(texts) {
      requests.push(texts);
      return texts.map((text) => /retry|reliability|reconnect/i.test(text) ? [1, 0] : [0, 1]);
    },
  };
});

afterEach(() => {
  fetchSpy?.mockRestore();
  fetchSpy = undefined;
  if (oldHome === undefined) delete process.env.AGENTMGR_HOME;
  else process.env.AGENTMGR_HOME = oldHome;
  if (oldKey === undefined) delete process.env.AM_TEST_EMBEDDING_KEY;
  else process.env.AM_TEST_EMBEDDING_KEY = oldKey;
  rmSync(home, { recursive: true, force: true });
});

function line(text: string): string {
  return JSON.stringify({ type: "user", message: { content: text } }) + "\n";
}

function agent(name: string, content: string, provider: "claude" | "codex" = "claude"): string {
  const path = join(home, `${name}.jsonl`);
  writeFileSync(path, content);
  writeAgent({ name, provider, transcriptPath: path, sessionId: name, status: "exited", dir: home,
    tmuxSession: `agentmgr-${name}`, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
  return path;
}

function mockFetch(implementation: (...args: Parameters<typeof fetch>) => ReturnType<typeof fetch>) {
  fetchSpy = spyOn(globalThis, "fetch").mockImplementation(Object.assign(implementation, { preconnect: fetch.preconnect }));
}

function configure(provider = "openrouter") {
  writeFileSync(join(home, "config.json"), JSON.stringify({ embeddings: { provider, apiKeyEnv: "AM_TEST_EMBEDDING_KEY" } }));
  process.env.AM_TEST_EMBEDDING_KEY = "test-key";
}

test("OpenRouter uses its endpoint, model and key and restores response order", async () => {
  configure();
  mockFetch(async (url, init) => {
    expect(url).toBe("https://openrouter.ai/api/v1/embeddings");
    expect(init?.headers).toMatchObject({ Authorization: "Bearer test-key" });
    expect(JSON.parse(init?.body as string)).toEqual({ model: "openai/text-embedding-3-small", input: ["first", "second"], encoding_format: "float" });
    return Response.json({ data: [{ index: 1, embedding: [0, 2] }, { index: 0, embedding: [3, 0] }] });
  });
  expect(await createEmbedder().embed(["first", "second"], "document")).toEqual([[1, 0], [0, 1]]);
});

test("direct OpenAI uses the direct endpoint and unprefixed model", async () => {
  configure("openai");
  mockFetch(async (url, init) => {
    expect(url).toBe("https://api.openai.com/v1/embeddings");
    expect(JSON.parse(init?.body as string).model).toBe("text-embedding-3-small");
    return Response.json({ data: [{ index: 0, embedding: [1, 0] }] });
  });
  await createEmbedder().embed(["query"], "query");
});

test("missing keys and unsupported Claude provider fail before a request", () => {
  configure();
  delete process.env.AM_TEST_EMBEDDING_KEY;
  expect(createEmbedder).toThrow("Set AM_TEST_EMBEDDING_KEY");
  configure("claude");
  expect(createEmbedder).toThrow("Claude/Anthropic API keys do not support embeddings");
});

test("provider errors do not echo response bodies or keys", async () => {
  configure();
  fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(new Response("test-key", { status: 401 }));
  await expect(createEmbedder().embed(["query"], "query")).rejects.toThrow("HTTP 401");
});

test("malformed and zero vectors are rejected", async () => {
  configure();
  fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ data: [{ index: 4, embedding: [1, 0] }] }));
  await expect(createEmbedder().embed(["query"], "query")).rejects.toThrow("invalid embedding vectors");
  expect(() => normalizeVector([0, 0])).toThrow("Invalid zero");
});

test("concept search finds a differently worded conversation and preserves actions", async () => {
  agent("ui", line("change the sidebar color"));
  agent("delivery", line("retry dropped messages"));
  await indexConversations({}, embedder);
  expect(search("reliability")).toHaveLength(0);
  const results = await semanticSearch("reliability", {}, embedder);
  expect(results[0]?.agentName).toBe("delivery");
  expect(results[0]?.command).toBe("am resume delivery");
  expect(results[0]?.snippets[0]?.text).toBe("retry dropped messages");
  expect(results[0]?.snippets[0]?.matchLen).toBe(0);
});

test("unchanged files and existing chunks do not incur document requests again", async () => {
  const file = agent("delivery", line("retry messages"));
  expect((await indexConversations({}, embedder)).embedded).toBe(1);
  expect((await indexConversations({}, embedder)).skipped).toBe(1);
  appendFileSync(file, line("reconnect clients") + line("retry messages"));
  expect((await indexConversations({}, embedder)).embedded).toBe(1);
  expect(requests).toEqual([["retry messages"], ["reconnect clients"]]);
});

test("only complete conversation entries are embedded for Claude and Codex", async () => {
  const file = agent("claude", line("<system-reminder>noise</system-reminder>")
    + JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", content: "tool noise" }] } }) + "\n"
    + line("real question") + line("partial record").trimEnd());
  agent("codex", JSON.stringify({ type: "response_item", payload: { type: "message", role: "assistant", content: [{ text: "real answer" }] } }) + "\n", "codex");
  await indexConversations({}, embedder);
  expect(requests.flat().sort()).toEqual(["real answer", "real question"]);
  appendFileSync(file, "\n");
  await indexConversations({}, embedder);
  expect(requests.flat()).toContain("partial record");
});

test("rewritten transcripts replace stale chunks and new models get separate indexes", async () => {
  const file = agent("delivery", line("retry messages"));
  await indexConversations({}, embedder);
  writeFileSync(file, line("new sidebar color"));
  await indexConversations({}, embedder);
  const results = await semanticSearch("reliability", {}, embedder);
  expect(results[0]?.snippets[0]?.text).toBe("new sidebar color");
  const other = { ...embedder, id: "test:other:v1" };
  await expect(semanticSearch("reliability", {}, other)).rejects.toThrow("No indexed conversations");
  expect((await indexConversations({}, other)).embedded).toBe(1);
});

test("failed embedding batches leave the previous complete index searchable", async () => {
  const file = agent("delivery", line("retry messages"));
  await indexConversations({}, embedder);
  appendFileSync(file, line("reconnect clients"));
  const failing = { ...embedder, embed: async () => { throw new Error("quota"); } };
  await expect(indexConversations({}, failing)).rejects.toThrow("quota");
  expect((await semanticSearch("reliability", {}, embedder))[0]?.snippets).toHaveLength(1);
  expect((await indexConversations({}, embedder)).embedded).toBe(1);
});

test("deleted transcripts are removed from search and index records", async () => {
  const file = agent("delivery", line("retry messages"));
  agent("ui", line("sidebar"));
  await indexConversations({}, embedder);
  rmSync(file);
  await indexConversations({}, embedder);
  expect((await semanticSearch("reliability", {}, embedder)).map((r) => r.agentName)).toEqual(["ui"]);
  const db = new Database(join(home, "search.sqlite"));
  expect(db.query("SELECT * FROM search_chunks WHERE file = ?").all(file)).toHaveLength(0);
  db.close();
});

test("hybrid falls back to literal results when embeddings cannot run", async () => {
  configure();
  delete process.env.AM_TEST_EMBEDDING_KEY;
  agent("delivery", line("retry messages"));
  const warnings: string[] = [];
  const results = await searchWithEmbeddings("retry", { hybrid: true, onWarning: (message) => warnings.push(message) });
  expect(results[0]?.agentName).toBe("delivery");
  expect(warnings[0]).toContain("AM_TEST_EMBEDDING_KEY");
  await expect(searchWithEmbeddings("retry")).rejects.toThrow("AM_TEST_EMBEDDING_KEY");
});

test("hybrid promotes agreements without duplicate agent rows", async () => {
  agent("delivery", line("retry messages"));
  agent("ui", line("sidebar"));
  await indexConversations({}, embedder);
  const semantic = await semanticSearch("reliability", {}, embedder);
  const merged = mergeHybrid(search("retry"), semantic);
  expect(merged.map((r) => r.agentName)).toEqual(["delivery", "ui"]);
});

test("Unicode chunks are bounded, overlap and do not break surrogate pairs", () => {
  const text = "😀".repeat(2400);
  const chunks = chunkText("user", text);
  expect(chunks).toHaveLength(3);
  expect(chunks.every((c) => Array.from(c.text).length <= 1200)).toBe(true);
  expect(chunks[0]?.text).toBe("😀".repeat(1200));
});

test("a changed index reports staleness without hiding existing results", async () => {
  const file = agent("delivery", line("retry messages"));
  await indexConversations({}, embedder);
  appendFileSync(file, line("reconnect clients"));
  const warnings: string[] = [];
  const results = await semanticSearch("reliability", { onWarning: (message) => warnings.push(message) }, embedder);
  expect(results[0]?.agentName).toBe("delivery");
  expect(warnings[0]).toContain("1 conversations are new or changed");
});

test("initial task changes are indexed even when the transcript is unchanged", async () => {
  agent("delivery", "");
  const stateFile = join(home, "agents", "delivery.json");
  const state = JSON.parse(await Bun.file(stateFile).text());
  writeAgent({ ...state, task: "retry messages" });
  expect((await indexConversations({}, embedder)).embedded).toBe(1);
  writeAgent({ ...state, task: "reconnect clients" });
  expect((await indexConversations({}, embedder)).embedded).toBe(1);
  expect((await semanticSearch("reliability", {}, embedder))[0]?.snippets[0]?.text).toBe("reconnect clients");
});

test("hybrid cancellation is propagated instead of showing stale literal results", async () => {
  configure();
  agent("delivery", line("retry messages"));
  await indexConversations({}, { ...embedder, id: "openrouter:openai/text-embedding-3-small:v1" });
  const controller = new AbortController();
  mockFetch(async (_url, init) => {
    expect(init?.signal).toBeDefined();
    controller.abort();
    throw new DOMException("Aborted", "AbortError");
  });
  await expect(searchWithEmbeddings("retry", { hybrid: true, signal: controller.signal })).rejects.toThrow("Aborted");
});
