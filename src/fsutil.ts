import { closeSync, mkdirSync, openSync, readFileSync, readSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

// Shared file primitives for am's on-disk state. Several processes (hooks,
// the CLI, the daemon) read and write the same small files concurrently, so
// every JSON read must tolerate a torn document and every write must land
// atomically.

// Read a JSON file, treating missing/torn/corrupt as absent — one bad byte
// must never brick the caller.
export function readJsonOrNull<T>(file: string): T | null {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch {
    return null;
  }
}

// Unique tmp + rename: a reader never sees a torn write, and two concurrent
// writers can't interleave into invalid JSON — last rename wins with a
// complete document either way.
export function writeJsonAtomic(file: string, value: unknown, opts: { pretty?: boolean } = {}): void {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, opts.pretty === false ? undefined : 2) + "\n");
  renameSync(tmp, file);
}

// The last maxBytes of a file as text. When the read is truncated, the first
// (possibly torn) line is dropped so line-oriented callers only ever see
// complete lines. Null when unreadable.
export function readFileTail(file: string, maxBytes: number): string | null {
  try {
    const size = statSync(file).size;
    const length = Math.min(maxBytes, size);
    const fd = openSync(file, "r");
    try {
      const buf = Buffer.alloc(length);
      readSync(fd, buf, 0, length, size - length);
      let text = buf.toString("utf8");
      if (length < size) {
        const nl = text.indexOf("\n");
        text = nl === -1 ? "" : text.slice(nl + 1);
      }
      return text;
    } finally {
      closeSync(fd);
    }
  } catch {
    return null;
  }
}

// Append fd for a detached process's output, rotating a grown log to .old
// first. Rotation here only bounds the file across restarts; a long-lived
// writer must bound its own growth (see the daemon's reconcile loop).
export function openLogFd(file: string, maxBytes: number): number {
  mkdirSync(dirname(file), { recursive: true });
  try {
    if (statSync(file).size > maxBytes) renameSync(file, `${file}.old`);
  } catch {
    // no log yet
  }
  return openSync(file, "a");
}
