import { loadConfig } from "./config";

export interface Embedder {
  id: string;
  embed(texts: string[], type: "document" | "query", signal?: AbortSignal): Promise<number[][]>;
}

export function createEmbedder(): Embedder {
  const config = loadConfig().embeddings;
  const provider = config?.provider ?? "openai";
  if (provider !== "openai" && provider !== "openrouter") {
    throw new Error("Embeddings require openai or openrouter. Claude/Anthropic API keys do not support embeddings.");
  }
  const model = config?.model ?? (provider === "openai" ? "text-embedding-3-small" : "openai/text-embedding-3-small");
  const keyEnv = config?.apiKeyEnv ?? (provider === "openai" ? "OPENAI_API_KEY" : "OPENROUTER_API_KEY");
  const key = process.env[keyEnv]?.trim();
  if (!key) throw new Error(`Set ${keyEnv} to use ${provider} embeddings. Claude/Anthropic keys cannot generate embeddings.`);
  const url = provider === "openai" ? "https://api.openai.com/v1/embeddings" : "https://openrouter.ai/api/v1/embeddings";
  return {
    id: `${provider}:${model}:v1`,
    async embed(texts, _type, signal) {
      const timeout = AbortSignal.timeout(30_000);
      const response = await fetch(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model,
          input: texts,
          encoding_format: "float",
        }),
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error(`${provider} embeddings failed (HTTP ${response.status}). Check the API key, model, and quota.`);
      }
      const body = await response.json() as { data?: { index: number; embedding: number[] }[] };
      if (!Array.isArray(body.data) || body.data.length !== texts.length) {
        throw new Error(`${provider} returned an invalid embedding response.`);
      }
      const rows = body.data.sort((a, b) => a.index - b.index);
      const dimensions = rows[0]?.embedding?.length;
      if (!dimensions || rows.some((row, i) => row.index !== i || !Array.isArray(row.embedding)
        || row.embedding.length !== dimensions || row.embedding.some((n) => !Number.isFinite(n)))) {
        throw new Error(`${provider} returned invalid embedding vectors.`);
      }
      return rows.map(({ embedding }) => normalizeVector(embedding));
    },
  };
}

export function normalizeVector(vector: number[]): number[] {
  const norm = Math.sqrt(vector.reduce((sum, n) => sum + n * n, 0));
  if (!Number.isFinite(norm) || norm === 0) throw new Error("Invalid zero or non-finite embedding vector.");
  return vector.map((n) => n / norm);
}
