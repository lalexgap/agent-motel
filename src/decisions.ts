import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { notificationPrUrl } from "./notifications";

// Read-only view of the decisions skill's per-agent store (agent-skills
// `decision` CLI). That store is the source of truth; am never writes it.

export interface OpenDecision {
  id: string;
  question: string;
  blocking: boolean;
  askedAt?: string;
  link?: string;
  // Canonical PR URLs this decision is about: explicit `prs`, else a PR `link`.
  prs: string[];
}

const STORE_VERSION = 1;
const MAX_BYTES = 512 * 1024;

export function decisionsHome(): string {
  return process.env.DECISIONS_HOME || join(process.env.HOME ?? homedir(), ".local", "state", "agent-decisions");
}

// Mirrors the CLI's file naming.
function slug(name: string): string {
  return name.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[-.]+|[-.]+$/g, "") || "agent";
}

// Accepts a PR URL with a trailing path, query or fragment (`/files`, `#discussion_r1`).
function prUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const match = /^(https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/[1-9][0-9]*)(?:[/?#].*)?$/.exec(value.trim());
  return match ? notificationPrUrl(match[1]) : undefined;
}

export function parseOpenDecisions(text: string): OpenDecision[] {
  let store: any;
  try { store = JSON.parse(text); } catch { return []; }
  if (!store || typeof store !== "object" || store.version !== STORE_VERSION || !Array.isArray(store.decisions)) return [];
  const open: OpenDecision[] = [];
  for (const item of store.decisions) {
    if (!item || item.status !== "open" || typeof item.id !== "string" || typeof item.question !== "string") continue;
    const tagged = ((Array.isArray(item.prs) ? item.prs : [item.pr]) as unknown[]).map(prUrl).filter((url): url is string => !!url);
    const link = prUrl(item.link);
    open.push({
      id: item.id.slice(0, 40),
      question: item.question.replace(/\s+/g, " ").trim().slice(0, 300),
      blocking: item.blocking === true,
      ...(typeof item.asked_at === "string" && Number.isFinite(Date.parse(item.asked_at)) ? { askedAt: item.asked_at } : {}),
      ...(typeof item.link === "string" && /^https:\/\//.test(item.link) ? { link: item.link.slice(0, 500) } : {}),
      prs: [...new Set(tagged.length ? tagged : link ? [link] : [])],
    });
  }
  return open;
}

export function readOpenDecisions(agent: string): OpenDecision[] {
  try {
    const text = readFileSync(join(decisionsHome(), `${slug(agent)}.json`), "utf8");
    return text.length > MAX_BYTES ? [] : parseOpenDecisions(text);
  } catch { return []; }
}
