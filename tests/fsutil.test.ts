import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { writeJsonAtomic } from "../src/fsutil";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("durable atomic writes fail before rename when the file cannot be synced", () => {
  const root = mkdtempSync(join(tmpdir(), "am-fsync-test-"));
  roots.push(root);
  const file = join(root, "state.json");
  writeFileSync(file, '{"version":"old"}\n');
  expect(() => writeJsonAtomic(file, { version: "new" }, {
    durable: true,
    syncPath: () => { throw new Error("fsync failed"); },
  })).toThrow("fsync failed");
  expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ version: "old" });
});

test("durable atomic writes surface a directory sync failure after rename", () => {
  const root = mkdtempSync(join(tmpdir(), "am-fsync-test-"));
  roots.push(root);
  const file = join(root, "state.json");
  const synced: string[] = [];
  expect(() => writeJsonAtomic(file, { version: "new" }, {
    durable: true,
    syncPath: path => {
      synced.push(path);
      if (path === dirname(file)) throw new Error("directory fsync failed");
    },
  })).toThrow("directory fsync failed");
  expect(synced).toEqual([`${file}.${process.pid}.tmp`, dirname(file)]);
  expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ version: "new" });
});
