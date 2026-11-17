import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, join, sep } from "node:path";
import { baseDir, planFile, plansDir } from "./paths";

export const PLAN_PROJECTION_FILE_MAX_BYTES = 64 * 1024;
export const PLAN_PROJECTION_SECTION_MAX_BYTES = 2_000;

export type PlanProjectionState = "available" | "missing" | "placeholder" | "invalid" | "unavailable";
export type PlanProjectionReason = "duplicate-headings" | "missing-headings" | "too-large" | "unsafe-path" | "unreadable";

export interface PlanProjection {
  source: "legacy-plan";
  state: PlanProjectionState;
  freshness: "unknown";
  modifiedAt?: string;
  currentStatus?: string;
  nextSteps?: string;
  reason?: PlanProjectionReason;
}

const AGENT_NAME_RE = /^[a-zA-Z0-9_-]+$/;
const PLACEHOLDER_RE = /^(?:not\s+started|[-–—]|todo|tbd)$/i;
const cache = new Map<string, { fingerprint: string; value: PlanProjection }>();

function result(state: PlanProjectionState, fields: Partial<PlanProjection> = {}): PlanProjection {
  return { source: "legacy-plan", state, freshness: "unknown", ...fields };
}

function byteClip(text: string): string {
  const normalized = text.replace(/\r\n?/g, "\n").trim();
  if (Buffer.byteLength(normalized) <= PLAN_PROJECTION_SECTION_MAX_BYTES) return normalized;
  const clipped = Buffer.from(normalized).subarray(0, PLAN_PROJECTION_SECTION_MAX_BYTES - 3)
    .toString("utf8").replace(/�+$/, "").trimEnd();
  return `${clipped}…`;
}

function sections(text: string): Map<string, string[]> {
  const found = new Map<string, string[]>();
  let heading: string | null = null;
  let body: string[] = [];
  let fence: string | null = null;
  const commit = () => {
    if (!heading) return;
    const values = found.get(heading) ?? [];
    values.push(body.join("\n"));
    found.set(heading, values);
  };
  for (const line of text.replace(/\r\n?/g, "\n").split("\n")) {
    const marker = /^\s*(```+|~~~+)/.exec(line)?.[1];
    if (marker) {
      if (!fence) fence = marker[0]!;
      else if (marker[0] === fence) fence = null;
    }
    const match = !fence && /^##\s+(.+?)\s*$/.exec(line);
    if (match) {
      commit();
      const title = match[1]!.trim().toLowerCase();
      heading = title.replace(/\s+[—-]\s+.+$/, "");
      body = [];
    } else if (heading) body.push(line);
  }
  commit();
  return found;
}

export function parseLegacyPlanProjection(text: string, modifiedAt?: string): PlanProjection {
  const found = sections(text);
  const current = found.get("current status") ?? [];
  const next = found.get("next steps") ?? [];
  if (current.length > 1 || next.length > 1) return result("invalid", { modifiedAt, reason: "duplicate-headings" });
  if (current.length !== 1 || next.length !== 1) return result("invalid", { modifiedAt, reason: "missing-headings" });
  const currentStatus = byteClip(current[0]!);
  const nextSteps = byteClip(next[0]!);
  if (!currentStatus || PLACEHOLDER_RE.test(currentStatus)) return result("placeholder", { modifiedAt });
  return result("available", {
    modifiedAt,
    currentStatus,
    ...(nextSteps && !PLACEHOLDER_RE.test(nextSteps) ? { nextSteps } : {}),
  });
}

interface SafePlan {
  path: string;
  stat: ReturnType<typeof statSync>;
  root: { path: string; stat: ReturnType<typeof statSync> };
}

function rootStillMatches(root: SafePlan["root"]): boolean {
  try {
    const current = lstatSync(root.path);
    return current.isDirectory() && !current.isSymbolicLink() &&
      current.dev === root.stat.dev && current.ino === root.stat.ino &&
      realpathSync(root.path) === root.path;
  } catch {
    return false;
  }
}

function safePlan(name: string): SafePlan | PlanProjection {
  if (!AGENT_NAME_RE.test(name)) return result("unavailable", { reason: "unsafe-path" });
  const path = planFile(name);
  let root: SafePlan["root"];
  try {
    const configuredRoot = plansDir();
    const link = lstatSync(configuredRoot);
    if (!link.isDirectory() || link.isSymbolicLink()) return result("unavailable", { reason: "unsafe-path" });
    const canonicalRoot = realpathSync(configuredRoot);
    const expectedRoot = join(realpathSync(baseDir()), "plans");
    const stat = statSync(canonicalRoot);
    if (canonicalRoot !== expectedRoot || !stat.isDirectory() || stat.dev !== link.dev || stat.ino !== link.ino) {
      return result("unavailable", { reason: "unsafe-path" });
    }
    root = { path: canonicalRoot, stat };
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT"
      ? result("missing")
      : result("unavailable", { reason: "unreadable" });
  }
  let link: ReturnType<typeof lstatSync>;
  try {
    link = lstatSync(path);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT"
      ? result("missing")
      : result("unavailable", { reason: "unreadable" });
  }
  if (!link.isFile() || link.isSymbolicLink()) return result("unavailable", { reason: "unsafe-path" });
  try {
    const resolved = realpathSync(path);
    if (dirname(resolved) !== root.path || !resolved.startsWith(root.path + sep) || basename(resolved) !== `${name}.md`) {
      return result("unavailable", { reason: "unsafe-path" });
    }
    const stat = statSync(resolved);
    if (!stat.isFile() || !rootStillMatches(root)) return result("unavailable", { reason: "unsafe-path" });
    return { path: resolved, stat, root };
  } catch {
    return result("unavailable", { reason: "unreadable" });
  }
}

export function readPlanProjection(name: string): PlanProjection {
  const safe = safePlan(name);
  if (!("path" in safe)) return safe;
  const modifiedAt = safe.stat.mtime.toISOString();
  const fingerprint = `${safe.stat.dev}:${safe.stat.ino}:${safe.stat.size}:${safe.stat.mtimeMs}`;
  const cached = cache.get(name);
  if (cached?.fingerprint === fingerprint) return cached.value;
  let value: PlanProjection;
  let fd: number | undefined;
  try {
    if (!rootStillMatches(safe.root)) return result("unavailable", { reason: "unsafe-path" });
    fd = openSync(safe.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    const opened = fstatSync(fd);
    if (!rootStillMatches(safe.root) || !opened.isFile() || opened.dev !== safe.stat.dev || opened.ino !== safe.stat.ino) {
      value = result("unavailable", { reason: "unsafe-path" });
    } else if (opened.size > PLAN_PROJECTION_FILE_MAX_BYTES) {
      value = result("invalid", { modifiedAt: opened.mtime.toISOString(), reason: "too-large" });
    } else {
      const bytes = Buffer.alloc(opened.size);
      let offset = 0;
      while (offset < bytes.length) {
        const count = readSync(fd, bytes, offset, bytes.length - offset, offset);
        if (!count) break;
        offset += count;
      }
      value = parseLegacyPlanProjection(bytes.subarray(0, offset).toString("utf8"), opened.mtime.toISOString());
    }
  } catch (error) {
    value = result("unavailable", {
      modifiedAt,
      reason: (error as NodeJS.ErrnoException).code === "ELOOP" ? "unsafe-path" : "unreadable",
    });
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  cache.set(name, { fingerprint, value });
  return value;
}

export function resetPlanProjectionCacheForTests(): void {
  cache.clear();
}
