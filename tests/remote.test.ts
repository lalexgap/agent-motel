import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isForwardable, sshAmTtyCommand, stripHostArgs, type SshResult } from "../src/remote";
import { shQuote } from "../src/tmux";

const remoteModule = new URL("../src/remote.ts", import.meta.url).pathname;
import { chooseOpener } from "../src/commands/click";
import { buildNotifyCommand } from "../src/notify";
import type { Config } from "../src/config";

describe("stripHostArgs", () => {
  test("removes --host/-H with value and --local/-L", () => {
    expect(stripHostArgs(["-H", "box", "ls", "--json"])).toEqual(["ls", "--json"]);
    expect(stripHostArgs(["new", "x", "--host", "box", "-m", "hi"])).toEqual(["new", "x", "-m", "hi"]);
    expect(stripHostArgs(["-L", "ls"])).toEqual(["ls"]);
    expect(stripHostArgs(["ls"])).toEqual(["ls"]);
  });
});

describe("isForwardable", () => {
  test("user commands forward, internals never do", () => {
    expect(isForwardable(undefined)).toBe(true); // bare am → remote hub
    expect(isForwardable("ls")).toBe(true);
    expect(isForwardable("new")).toBe(true);
    expect(isForwardable("hook")).toBe(false);
    expect(isForwardable("__deliver")).toBe(false);
    expect(isForwardable("__click")).toBe(false);
    expect(isForwardable("__daemon")).toBe(false);
  });
});

// The transfers run against a stub `ssh` on PATH that executes the remote
// command in a shell, exactly as a real sshd would — so the quoting these
// helpers do is checked for real, without a network.
describe("file transfer over ssh", () => {
  let dir: string;
  const weird = "a file 'with' spaces.png"; // the names scp's SFTP mode chokes on

  // The helpers spawn whichever `ssh` their own environment resolves, so the
  // call has to happen in a child process carrying the stubbed PATH.
  const transfer = (call: string): SshResult => {
    const script = `import { sshPullFile, sshPushFile } from ${JSON.stringify(remoteModule)};
      console.log(JSON.stringify(await ${call}));`;
    const run = Bun.spawnSync(["bun", "-e", script], {
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, AM_SSH_NO_MUX: "1" },
    });
    return JSON.parse(run.stdout.toString()) as SshResult;
  };
  const q = (s: string) => JSON.stringify(s);

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "am-xfer-"));
    writeFileSync(join(dir, "ssh"), '#!/bin/bash\nexec bash -c "${!#}"\n'); // last arg = the remote command
    chmodSync(join(dir, "ssh"), 0o755);
  });

  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  test("pull copies bytes verbatim, even for shell-hostile names", () => {
    const src = join(dir, weird);
    writeFileSync(src, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff]));
    const dest = join(dir, "pulled.png");
    const result = transfer(`sshPullFile("host", ${q(src)}, ${q(dest)}, { timeoutMs: 20000 })`);
    expect(result.exitCode).toBe(0);
    expect(readFileSync(dest)).toEqual(readFileSync(src));
  });

  test("a failed pull reports the remote error and leaves no partial file", () => {
    const dest = join(dir, "missing.png");
    const missing = join(dir, "does-not-exist.png");
    const result = transfer(`sshPullFile("host", ${q(missing)}, ${q(dest)}, { timeoutMs: 20000 })`);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("No such file");
    expect(existsSync(dest)).toBe(false);
    expect(existsSync(`${dest}.part`)).toBe(false);
  });

  test("push writes to the remote path", () => {
    const src = join(dir, "outgoing.bin");
    writeFileSync(src, Buffer.from([1, 2, 3, 0, 4]));
    const dest = join(dir, `pushed ${weird}`);
    const result = transfer(`sshPushFile("host", ${q(src)}, ${q(dest)}, { timeoutMs: 20000 })`);
    expect(result.exitCode).toBe(0);
    expect(readFileSync(dest)).toEqual(readFileSync(src));
  });
});

describe("chooseOpener", () => {
  test("open on macOS, xdg-open with a display, null headless", () => {
    expect(chooseOpener({ platform: "darwin", has: () => false, display: false })).toBe("open");
    expect(chooseOpener({ platform: "linux", has: () => true, display: true })).toBe("xdg-open");
    expect(chooseOpener({ platform: "linux", has: () => true, display: false })).toBeNull();
    expect(chooseOpener({ platform: "linux", has: () => false, display: true })).toBeNull();
  });
});

describe("buildNotifyCommand", () => {
  const base: Config = { defaultProvider: "codex", conciergeProvider: "codex", notifyOnIdle: true, idleNotifyMinSeconds: 30, remoteControl: true, apiPort: 8787, apiBind: "127.0.0.1", worktreeByDefault: true, skipPermissions: true, commsMaxPerWindow: 5, commsWindowSeconds: 60, outboxTtlHours: 48, outboxPollSeconds: 2, outboxPollMaxSeconds: 30, tunnelPort: 2222, showUsage: true, gcAgentDays: 7, gcTrashDays: 30 };

  test("notifyCommand wins on any platform", () => {
    const config = { ...base, notifyCommand: "curl -d \"$AM_MESSAGE\" ntfy.sh/x" };
    expect(buildNotifyCommand("t", "m", config, { platform: "linux", has: () => false })).toEqual([
      "sh", "-c", 'curl -d "$AM_MESSAGE" ntfy.sh/x',
    ]);
    expect(buildNotifyCommand("t", "m", config, { platform: "darwin", has: () => true })![0]).toBe("sh");
  });

  test("macOS: terminal-notifier with sender, else osascript", () => {
    const withSender = { ...base, notifySender: "com.mitchellh.ghostty" };
    expect(buildNotifyCommand("t", "m", withSender, { platform: "darwin", has: () => true })![0]).toBe("terminal-notifier");
    expect(buildNotifyCommand("t", "m", withSender, { platform: "darwin", has: () => false })![0]).toBe("osascript");
    expect(buildNotifyCommand("t", "m", base, { platform: "darwin", has: () => true })![0]).toBe("osascript");
  });

  test("linux: notify-send when present, else silent null", () => {
    expect(buildNotifyCommand("t", "m", base, { platform: "linux", has: () => true })).toEqual([
      "notify-send", "t", "m",
    ]);
    expect(buildNotifyCommand("t", "m", base, { platform: "linux", has: () => false })).toBeNull();
  });
});

describe("sshAmTtyCommand", () => {
  test("survives a pane's shell: ssh gets a tty and a login-shell am", () => {
    const dir = mkdtempSync(join(tmpdir(), "am-tty-"));
    writeFileSync(join(dir, "ssh"), '#!/bin/bash\nprintf "%s\\n" "$@"\n');
    chmodSync(join(dir, "ssh"), 0o755);
    const mux = process.env.AM_SSH_NO_MUX;
    process.env.AM_SSH_NO_MUX = "1";
    try {
      const command = sshAmTtyCommand("server", ["peek", "api", "--subagent", "abc", "--follow"]);
      const run = Bun.spawnSync(["bash", "-c", command], {
        env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, AM_SSH_NO_MUX: "1" },
      });
      expect(run.stdout.toString().trimEnd().split("\n")).toEqual([
        "-t",
        "server",
        "--",
        `bash -lc ${shQuote("'am' 'peek' 'api' '--subagent' 'abc' '--follow'")}`,
      ]);
    } finally {
      if (mux === undefined) delete process.env.AM_SSH_NO_MUX;
      else process.env.AM_SSH_NO_MUX = mux;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
