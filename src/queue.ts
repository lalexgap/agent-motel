import { existsSync, readFileSync, renameSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { ensureDirs, queueDir } from "./paths";

function queueFile(name: string): string {
  return join(queueDir(), `${name}.jsonl`);
}

function readLines(name: string): string[] {
  const file = queueFile(name);
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "");
}

export function queueAppend(name: string, message: string): number {
  ensureDirs();
  appendFileSync(queueFile(name), JSON.stringify({ message, queuedAt: new Date().toISOString() }) + "\n");
  return queueDepth(name);
}

export function queueList(name: string): { message: string; queuedAt: string }[] {
  return readLines(name).map((l) => JSON.parse(l));
}

export function queueDepth(name: string): number {
  return readLines(name).length;
}

export function queuePeek(name: string): string | null {
  const head = readLines(name)[0];
  return head === undefined ? null : (JSON.parse(head) as { message: string }).message;
}

// Pop the head atomically: rewrite the remainder to a tmp file, then rename over.
export function queuePop(name: string): string | null {
  const lines = readLines(name);
  const head = lines.shift();
  if (head === undefined) return null;
  const file = queueFile(name);
  if (lines.length === 0) {
    rmSync(file, { force: true });
  } else {
    const tmp = file + ".tmp";
    writeFileSync(tmp, lines.join("\n") + "\n");
    renameSync(tmp, file);
  }
  return (JSON.parse(head) as { message: string }).message;
}

export function queueClear(name: string): void {
  rmSync(queueFile(name), { force: true });
}
