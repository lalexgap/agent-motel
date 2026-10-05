import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tryAcquireFileLock, withFileLock } from "../src/filelock";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "am-lock-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

test("excludes another owner and preserves its lock after repeated release", () => {
  const file = join(dir, "lock");
  const release = tryAcquireFileLock(file)!;
  const inode = statSync(file).ino;
  expect(tryAcquireFileLock(file)).toBeNull();
  release();
  const nextRelease = tryAcquireFileLock(file)!;
  try {
    release();
    expect(tryAcquireFileLock(file)).toBeNull();
    expect(statSync(file).ino).toBe(inode);
  } finally {
    nextRelease();
  }
});

test("releases the lock when the callback throws", () => {
  const file = join(dir, "lock");
  expect(() => withFileLock(file, () => { throw new Error("failed"); })).toThrow("failed");
  const release = tryAcquireFileLock(file);
  expect(release).not.toBeNull();
  release!();
});

test("the kernel releases a crashed process's lock", async () => {
  const file = join(dir, "lock");
  const ready = join(dir, "ready");
  const child = Bun.spawn([process.execPath, "-e", `
    import { tryAcquireFileLock } from ${JSON.stringify(new URL("../src/filelock.ts", import.meta.url).href)};
    import { writeFileSync } from "node:fs";
    const release = tryAcquireFileLock(${JSON.stringify(file)});
    if (!release) process.exit(1);
    writeFileSync(${JSON.stringify(ready)}, "");
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
  `], { stdout: "pipe", stderr: "pipe" });
  try {
    const deadline = Date.now() + 3000;
    while (!existsSync(ready)) {
      if (Date.now() > deadline) throw new Error("lock owner did not start");
      await Bun.sleep(5);
    }
    expect(tryAcquireFileLock(file)).toBeNull();
    child.kill("SIGKILL");
    await child.exited;
    const release = tryAcquireFileLock(file);
    expect(release).not.toBeNull();
    release!();
  } finally {
    child.kill();
    await child.exited;
  }
});
