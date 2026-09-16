import { search, type SearchResult, type SearchSnippet } from "../search";
import { searchWithEmbeddings } from "../semanticSearch";
import { relativeTime, shortenHome, STATUS_COLORS, STATUS_ICONS } from "./ls";

const RESET = "\x1b[0m";
const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const HIGHLIGHT = "\x1b[30;43m"; // black on yellow — marks the matched span
const SCOPE_GLYPH = { trash: "🗑", history: "±" } as const;
const ROLE_LABEL = { user: "you", assistant: "agent", tool: "tool" } as const;

export interface SearchCmdOptions {
  semantic?: boolean;
  hybrid?: boolean;
  all?: boolean;
  fleet?: boolean;
  localOnly?: boolean;
  json?: boolean;
  limit?: number;
}

export async function searchCommand(query: string, opts: SearchCmdOptions): Promise<void> {
  if (opts.semantic && opts.hybrid) throw new Error("Choose --semantic or --hybrid, not both.");
  if (opts.limit !== undefined && (!Number.isInteger(opts.limit) || opts.limit < 1)) {
    throw new Error("--limit must be a positive integer.");
  }
  const results = opts.semantic || opts.hybrid
    ? await searchWithEmbeddings(query, { ...opts, onWarning: (message) => console.error(`Search: ${message}`) })
    : search(query, opts);

  if (opts.json) {
    console.log(JSON.stringify(results, null, 2));
    return;
  }

  if (results.length === 0) {
    const where = opts.all ? "any session" : "registered agents or trash (try --all for history)";
    console.log(`no matches for "${query}" in ${where}`);
    return;
  }

  const out: string[] = [];
  for (const r of results) {
    out.push(headerLine(r));
    out.push(`   ${DIM}${locationLine(r)}${RESET}`);
    out.push(`   ${DIM}▸${RESET} ${BOLD}${r.command}${RESET}`);
    for (const s of r.snippets) out.push(`   ${snippetLine(s)}`);
    out.push("");
  }
  console.log(out.join("\n").replace(/\n$/, ""));
}

function headerLine(r: SearchResult): string {
  const glyph =
    r.status !== undefined
      ? `${STATUS_COLORS[r.status]}${STATUS_ICONS[r.status]}${RESET}`
      : `${DIM}${SCOPE_GLYPH[r.scope as "trash" | "history"] ?? "·"}${RESET}`;
  const title = r.agentName ?? `session ${shortId(r.sessionId)}`;
  const badges = [
    r.host ? `@${r.host}` : "",
    r.scope === "trash" ? "removed" : r.scope === "history" ? "history" : "",
    r.status ? r.status : "",
    r.provider === "codex" ? "codex" : "",
  ].filter(Boolean);
  const badge = badges.length ? ` ${DIM}${badges.join(" · ")}${RESET}` : "";
  const count = r.score !== undefined ? "semantic" : `${r.matchCount} match${r.matchCount === 1 ? "" : "es"}`;
  const when = r.updatedAt > 0 ? ` · ${relativeTime(new Date(r.updatedAt).toISOString())}` : "";
  return `${glyph} ${BOLD}${title}${RESET}${badge}  ${DIM}${count}${when}${RESET}`;
}

function locationLine(r: SearchResult): string {
  if (r.dir) return shortenHome(r.dir);
  if (r.sessionId) return r.sessionId;
  return "";
}

function snippetLine(s: SearchSnippet): string {
  const role = `${DIM}${ROLE_LABEL[s.kind]}${RESET} `;
  if (s.matchLen === 0) return `${role}${s.text}`;
  const pre = s.text.slice(0, s.matchStart);
  const hit = s.text.slice(s.matchStart, s.matchStart + s.matchLen);
  const post = s.text.slice(s.matchStart + s.matchLen);
  return `${role}${pre}${HIGHLIGHT}${hit}${RESET}${post}`;
}

function shortId(id?: string): string {
  return id ? id.slice(0, 8) : "?";
}
