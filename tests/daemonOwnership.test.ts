import { expect, test } from "bun:test";
import { recordedPidMayOwnDaemon } from "../src/daemon";

async function idleProcess(argument: string) {
  const child = Bun.spawn([process.execPath, "-e", 'console.log("ready"); setInterval(() => {}, 1000)', argument], { stdout: "pipe", stderr: "ignore" });
  const reader = child.stdout.getReader();
  await reader.read();
  reader.releaseLock();
  return child;
}

test("a reused PID with an unrelated command is not a daemon owner", async () => {
  const child = await idleProcess("not__daemon");
  try {
    expect(recordedPidMayOwnDaemon(child.pid)).toBe(false);
    expect(child.exitCode).toBeNull();
  } finally {
    child.kill();
    await child.exited;
  }
});

test("an unresponsive legacy __daemon process remains a possible owner", async () => {
  const child = await idleProcess("__daemon");
  try {
    expect(recordedPidMayOwnDaemon(child.pid)).toBe(true);
    expect(child.exitCode).toBeNull();
  } finally {
    child.kill();
    await child.exited;
  }
});

test("an exited process is not a daemon owner", async () => {
  const child = Bun.spawn([process.execPath, "-e", ""], { stdout: "ignore", stderr: "ignore" });
  await child.exited;
  expect(recordedPidMayOwnDaemon(child.pid)).toBe(false);
});
