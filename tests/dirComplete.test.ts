import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import {
  completeDir,
  completeDirRemote,
  resolveDirCompletion,
  splitDirInput,
  type RemoteRunner,
} from "../src/dirComplete";
import type { SshResult } from "../src/remote";

describe("splitDirInput", () => {
  test("splits the last segment off as the prefix, keeping the head", () => {
    expect(splitDirInput("/a/b/pre")).toEqual({ dir: "/a/b", prefix: "pre", head: "/a/b/" });
  });
  test("a trailing slash means list the dir with an empty prefix", () => {
    expect(splitDirInput("/a/b/")).toEqual({ dir: "/a/b/", prefix: "", head: "/a/b/" });
  });
  test("a bare segment has no head and lists the current dir", () => {
    expect(splitDirInput("pre")).toEqual({ dir: ".", prefix: "pre", head: "" });
  });
  test("keeps ~ literal for the backend to expand", () => {
    expect(splitDirInput("~/proj/fo")).toEqual({ dir: "~/proj", prefix: "fo", head: "~/proj/" });
  });
});

describe("resolveDirCompletion", () => {
  test("one match completes and appends a trailing slash", () => {
    expect(resolveDirCompletion(["beta"], "/r/be")).toEqual({ value: "/r/beta/", candidates: [] });
  });
  test("several matches complete to the common prefix and list candidates", () => {
    expect(resolveDirCompletion(["alphabet", "alpha"], "/r/alph")).toEqual({
      value: "/r/alpha",
      candidates: ["alpha", "alphabet"],
    });
  });
  test("no match leaves the input untouched", () => {
    expect(resolveDirCompletion(["alpha"], "/r/zzz")).toEqual({ value: "/r/zzz", candidates: [] });
  });
  test("filters entries by the input's prefix", () => {
    // entries that don't share the prefix are ignored (remote glob is the
    // primary filter; this is the shared safety net).
    expect(resolveDirCompletion(["beta", "alpha"], "/r/al")).toEqual({ value: "/r/alpha/", candidates: [] });
  });
});

describe("completeDir (local)", () => {
  let root: string;
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "am-complete-"));
    mkdirSync(join(root, "alpha"));
    mkdirSync(join(root, "alphabet"));
    mkdirSync(join(root, "beta"));
    mkdirSync(join(root, "solo"));
    mkdirSync(join(root, "solo", "nested"));
    writeFileSync(join(root, "alphafile"), "x"); // a file, must be ignored
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  test("uniquely completes a directory and appends a trailing slash", () => {
    expect(completeDir(join(root, "be"))).toEqual({ value: join(root, "beta") + "/", candidates: [] });
  });

  test("a unique match descends past a same-named file (dirs only)", () => {
    expect(completeDir(join(root, "so"))).toEqual({ value: join(root, "solo") + "/", candidates: [] });
  });

  test("ambiguous prefix completes to the common prefix and lists candidates", () => {
    const res = completeDir(join(root, "alph"));
    expect(res.value).toBe(join(root, "alpha"));
    expect(res.candidates).toEqual(["alpha", "alphabet"]);
  });

  test("a trailing slash lists the directory's subdirectories", () => {
    const res = completeDir(join(root, "solo") + "/");
    expect(res.candidates).toEqual([]); // single subdir → unique completion
    expect(res.value).toBe(join(root, "solo", "nested") + "/");
  });

  test("files are excluded from matches", () => {
    const res = completeDir(join(root, "alpha"));
    expect(res.candidates).not.toContain("alphafile");
  });

  test("no match leaves the input untouched", () => {
    expect(completeDir(join(root, "zzz"))).toEqual({ value: join(root, "zzz"), candidates: [] });
  });

  test("an unreadable directory is a no-op", () => {
    expect(completeDir("/no/such/path/here/xy")).toEqual({ value: "/no/such/path/here/xy", candidates: [] });
  });

  test("expands ~ for reading but preserves the literal ~ in the value", () => {
    const res = completeDir("~/");
    expect(res.value.startsWith("~/")).toBe(true);
    expect(homedir().length).toBeGreaterThan(0);
  });
});

describe("completeDirRemote", () => {
  // A fake ssh runner that records what it was asked to run and returns a
  // canned result — keeps the test off the network.
  const fakeRunner = (
    result: Partial<SshResult>,
    sink?: { host?: string; command?: string; timeoutMs?: number },
  ): RemoteRunner => {
    return async (host, command, opts) => {
      if (sink) {
        sink.host = host;
        sink.command = command;
        sink.timeoutMs = opts?.timeoutMs;
      }
      return { exitCode: 0, stdout: "", stderr: "", ...result };
    };
  };

  test("parses newline-separated basenames and resolves the completion", async () => {
    const run = fakeRunner({ stdout: "alpha\nalphabet\n" });
    const res = await completeDirRemote("server", "/work/alph", { run });
    expect(res).toEqual({ value: "/work/alpha", candidates: ["alpha", "alphabet"] });
  });

  test("a single basename completes with a trailing slash", async () => {
    const run = fakeRunner({ stdout: "beta\n" });
    expect(await completeDirRemote("server", "/work/be", { run })).toEqual({
      value: "/work/beta/",
      candidates: [],
    });
  });

  test("an empty listing is a no-op, not an error", async () => {
    const run = fakeRunner({ stdout: "" });
    expect(await completeDirRemote("server", "/work/zzz", { run })).toEqual({
      value: "/work/zzz",
      candidates: [],
    });
  });

  test("passes user input only as positional argv, never as shell code", async () => {
    const sink: { command?: string } = {};
    // A prefix loaded with shell metacharacters must round-trip as data.
    const run = fakeRunner({ stdout: "" }, sink);
    await completeDirRemote("server", "/work/$(rm -rf ~); ", { run });
    expect(sink.command).toContain("'bash' '-c'");
    // The dangerous segment is single-quoted as one positional arg, not bare.
    expect(sink.command).toContain("'$(rm -rf ~); '");
    // The script reads its inputs positionally ($1/$2), so they are never eval'd.
    expect(sink.command).toContain("d=$1; p=$2;");
  });

  test("expands ~ on the remote side and globs by prefix", async () => {
    const sink: { command?: string } = {};
    const run = fakeRunner({ stdout: "" }, sink);
    await completeDirRemote("server", "~/proj/fo", { run });
    // dir (~/proj) and prefix (fo) are passed as the trailing positional args.
    expect(sink.command!.endsWith("'~/proj' 'fo'")).toBe(true);
    // Remote-side tilde expansion against the remote $HOME.
    expect(sink.command).toContain('case "$d" in "~") d=$HOME;;');
  });

  test("forwards the timeout to the runner", async () => {
    const sink: { timeoutMs?: number } = {};
    const run = fakeRunner({ stdout: "" }, sink);
    await completeDirRemote("server", "/work/x", { run, timeoutMs: 1234 });
    expect(sink.timeoutMs).toBe(1234);
  });

  test("throws when the host is unreachable", async () => {
    const run = fakeRunner({ exitCode: 255, stderr: "ssh: connect to host server: No route" });
    await expect(completeDirRemote("server", "/work/x", { run })).rejects.toThrow(/couldn't reach server/);
  });

  test("throws a timeout when the runner reports 124", async () => {
    const run = fakeRunner({ exitCode: 124 });
    await expect(completeDirRemote("server", "/work/x", { run })).rejects.toThrow(/timed out/);
  });
});
