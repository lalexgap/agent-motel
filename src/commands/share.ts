import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { expandHome, sharedDir } from "../paths";
import { localHostIdentity } from "../config";
import { parseJsonl, recordComms, resolveSender } from "../comms";
import { notify } from "../notify";

const MAX_SHARE_BYTES = 100_000_000;

export interface ArtifactEntry {
  at: string;
  name: string;
  origPath: string;
  size: number;
  mtimeMs: number;
  message?: string;
  host: string;
}

function manifestFile(owner: string): string {
  return join(sharedDir(owner), "manifest.jsonl");
}

export function artifactCopyPath(owner: string, name: string): string {
  return join(sharedDir(owner), "files", name);
}

export function readManifest(owner: string): ArtifactEntry[] {
  const file = manifestFile(owner);
  if (!existsSync(file)) return [];
  return parseJsonl<ArtifactEntry>(readFileSync(file, "utf8"));
}

export function latestArtifacts(owner: string, entries: ArtifactEntry[]): ArtifactEntry[] {
  const byName = new Map<string, ArtifactEntry>();
  for (const entry of entries) byName.set(entry.name, entry);
  return [...byName.values()].filter((e) => existsSync(artifactCopyPath(owner, e.name)));
}

export function shareAnnouncement(name: string, message?: string): string {
  const msg = message?.trim();
  return msg ? `shared ${name} — ${msg}` : `shared ${name}`;
}

export async function shareCommand(filePath: string, message: string | undefined, opts: { from?: string } = {}): Promise<void> {
  const src = resolve(expandHome(filePath));
  if (!existsSync(src) || !statSync(src).isFile()) {
    throw new Error(`not a file: ${src}`);
  }
  const stat = statSync(src);
  if (stat.size > MAX_SHARE_BYTES) {
    throw new Error(`too large to share (${Math.round(stat.size / 1_000_000)} MB) — scp it manually`);
  }

  const owner = resolveSender(opts.from) ?? "operator";
  if (!/^[a-zA-Z0-9_-]+$/.test(owner)) {
    throw new Error("artifact owner must be alphanumeric with dashes/underscores");
  }
  const name = basename(src);
  const dest = artifactCopyPath(owner, name);
  mkdirSync(join(sharedDir(owner), "files"), { recursive: true });
  copyFileSync(src, dest);
  appendFileSync(
    manifestFile(owner),
    JSON.stringify({
      at: new Date().toISOString(),
      name,
      origPath: src,
      size: stat.size,
      mtimeMs: statSync(dest).mtimeMs,
      message: message?.trim() || undefined,
      host: localHostIdentity(),
    } satisfies ArtifactEntry) + "\n",
  );

  const announcement = shareAnnouncement(name, message);
  if (owner !== "operator") {
    recordComms({ at: new Date().toISOString(), from: owner, to: "operator", kind: "share", body: announcement });
  }
  notify(`am: ${owner}`, `${announcement} · am open ${owner}`, { agent: owner === "operator" ? undefined : owner, kind: "share" });
  console.log(`shared ${name} → ${dest}`);
  console.log(`the operator can open it from their machine with \`am open ${owner}\``);
}
