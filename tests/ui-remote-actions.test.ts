import { expect, test } from "bun:test";

function fixture(script: string) {
  const result = Bun.spawnSync([process.execPath, "-e", `import assert from "node:assert/strict"; import { mock } from "bun:test"; ${script}`], {
    cwd: new URL("..", import.meta.url).pathname,
    env: { ...process.env, AM_SSH_NO_MUX: "1" },
    timeout: 5000,
  });
  expect(result.stderr.toString()).toBe("");
  expect(result.exitCode).toBe(0);
}

test("hub stop/remove use async SSH with deadlines and recover from timeout", () => {
  fixture(`
    const tmux = await import("./src/tmux"), remote = await import("./src/remote"), daemon = await import("./src/daemon");
    let handlers, calls = [];
    mock.module("./src/picker", () => ({ pick: async (_load, h) => { handlers = h; } }));
    mock.module("./src/daemon", () => ({ ...daemon, ensureDaemon: async () => {}, watchDaemonEvents: () => () => {} }));
    mock.module("./src/tmux", () => ({ ...tmux, tmux: () => ({ exitCode: 0, stdout: "", stderr: "" }) }));
    mock.module("./src/remote", () => ({
      ...remote,
      sshAm() { throw new Error("blocking SSH used"); },
      sshAmAsync: async (host, args, opts) => { calls.push({ host, args, opts }); await Bun.sleep(20); return { exitCode: 124, stdout: "", stderr: "" }; }
    }));
    const { sidebarCommand } = await import("./src/commands/ui");
    await sidebarCommand();
    for (const action of ["stop", "remove"]) {
      const pending = handlers[action]("fixture:sample");
      assert.ok(pending instanceof Promise);
      const result = await pending;
      assert.equal(result.level, "error");
      assert.match(result.text, /timed out/i);
    }
    assert.deepEqual(calls.map(c => c.args), [["stop", "sample"], ["rm", "sample"]]);
    assert.ok(calls.every(c => c.opts.timeoutMs > 0 && c.opts.timeoutMs <= 60000));
  `);
});

test.each(["stop", "remove"])("picker renders progress and accepts input during pending %s", action => {
  fixture(`
    mock.module("./src/usage", () => ({ startUsagePolling: () => () => {}, usageBadge: () => "" }));
    Object.defineProperty(process.stdin, "isTTY", { value: true });
    process.stdin.setRawMode = () => process.stdin;
    let frames = "", selected, resolveAction, calls = 0;
    process.stdout.write = text => { frames += text; return true; };
    const { pick } = await import("./src/picker");
    const items = ["fixture:one", "fixture:two"].map(name => ({ name, label: name, status: "idle", task: "" }));
    const running = pick(() => items, {
      ${action}: () => { calls++; return new Promise(resolve => { resolveAction = resolve; }); },
      select: name => { selected = name; }
    });
    const key = value => process.stdin.emit("data", Buffer.from(value));
    key("e"); key(${JSON.stringify(action === "stop" ? "x" : "d")});
    ${action === "remove" ? 'assert.equal(calls, 0, "first d only confirms"); key("d");' : ""}
    await Bun.sleep(10);
    assert.equal(calls, 1);
    assert.ok(/${action === "stop" ? "stopping" : "removing"}/.test(frames), "progress must render");
    key("j"); key("\\r");
    assert.equal(selected, "fixture:two", "input stays live while action pending");
    resolveAction({ text: "remote operation timed out", level: "error" });
    await Bun.sleep(10);
    assert.match(frames, /remote operation timed out/);
    key("\\x03");
    await running;
  `);
});
