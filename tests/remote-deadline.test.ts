import { expect, test } from "bun:test";

function fixture(script: string) {
  const result = Bun.spawnSync([process.execPath, "-e", `import assert from "node:assert/strict"; ${script}`], {
    cwd: new URL("..", import.meta.url).pathname,
    env: { ...process.env, AM_SSH_NO_MUX: "1" },
    timeout: 3000,
  });
  expect(result.stderr.toString()).toBe("");
  expect(result.exitCode).toBe(0);
}

test.each([false, true])("deadline settles with open pipes (child already exited: %s)", exited => {
  fixture(`
    import { runAsync } from "./src/remote";
    let kills = 0, cancellations = 0;
    const pipe = text => new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode(text)); },
      cancel() { cancellations++; return new Promise(() => {}); }
    });
    const stdout = pipe("partial stdout"), stderr = pipe("partial stderr");
    Bun.spawn = () => ({ stdout, stderr, exited: ${exited ? "Promise.resolve(0)" : "new Promise(() => {})"}, kill() { kills++; } });
    const result = await Promise.race([runAsync(["fixture"], { timeoutMs: 20 }), Bun.sleep(150).then(() => "hung")]);
    assert.notEqual(result, "hung", "deadline must not await pipe EOF or process exit");
    assert.equal(result.exitCode, 124);
    assert.equal(result.stdout, "partial stdout");
    assert.match(result.stderr, /partial stderr/);
    assert.equal(cancellations, 2);
    assert.equal(stdout.locked, false);
    assert.equal(stderr.locked, false);
  `);
});

test("deadline bounds a real subprocess whose descendant retains its output pipe", () => {
  fixture(`
    import { runAsync } from "./src/remote";
    const start = performance.now();
    const result = await runAsync(["python3", "-c", "import subprocess; print('partial', flush=True); subprocess.Popen(['sleep', '0.5'])"], { timeoutMs: 100 });
    assert.equal(result.exitCode, 124);
    assert.match(result.stdout, /partial/);
    assert.ok(performance.now() - start < 400, "must not wait for descendant EOF");
  `);
});

test("successful and rejected drains release readers and clear the kill timer", () => {
  fixture(`
    import { runAsync } from "./src/remote";
    let kills = 0;
    const stdout = new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode("ok")); c.close(); } });
    const stderr = new ReadableStream({ start(c) { c.close(); } });
    Bun.spawn = () => ({ stdout, stderr, exited: Promise.resolve(7), kill() { kills++; } });
    assert.deepEqual(await runAsync(["fixture"], { timeoutMs: 20 }), { exitCode: 7, stdout: "ok", stderr: "" });
    await Bun.sleep(40);
    assert.equal(kills, 0);
    assert.equal(stdout.locked, false);
    assert.equal(stderr.locked, false);
    let cancelled = false;
    const broken = new ReadableStream({ start(c) { c.error(new Error("broken pipe")); } });
    const open = new ReadableStream({ cancel() { cancelled = true; } });
    Bun.spawn = () => ({ stdout: broken, stderr: open, exited: new Promise(() => {}), kill() { kills++; } });
    await assert.rejects(runAsync(["fixture"], { timeoutMs: 20 }), /broken pipe/);
    const atFailure = kills;
    await Bun.sleep(40);
    assert.equal(kills, atFailure, "error must clear deadline timer");
    assert.equal(cancelled, true);
    assert.equal(broken.locked, false);
    assert.equal(open.locked, false);
  `);
});

test.each([{ timeoutMs: 80 }, {}])("ordinary commands preserve options: %j", opts => {
  fixture(`
    import { checkedRemoteAm } from "./src/remote";
    const opts = ${JSON.stringify(opts)};
    let passed;
    const result = await checkedRemoteAm("fixture", ["list"], opts, async (_host, _args, options) => {
      passed = options;
      return { exitCode: 0, stdout: "ok", stderr: "" };
    });
    assert.deepEqual(result, { exitCode: 0, stdout: "ok", stderr: "" });
    assert.strictEqual(passed, opts);
    assert.deepEqual(Object.keys(passed), Object.keys(opts));
    if ("timeoutMs" in opts) assert.equal(Number.isInteger(passed.timeoutMs), true);
  `);
});

test.each(["models", "__detail"])("negotiation shares the operation deadline at %s", stage => {
  fixture(`
    import { checkedRemoteAm, runAsync } from "./src/remote";
    const catalog = [{ provider: "antigravity", modelsExhaustive: true, models: [{ id: "gemini-3-pro" }] }];
    const calls = [];
    const start = performance.now();
    const result = await Promise.race([
      checkedRemoteAm("fixture", ["new", "sample", "--antigravity"], { timeoutMs: 80 }, async (_host, args, opts) => {
        calls.push({ command: args[0], timeoutMs: opts.timeoutMs });
        if (args[0] === ${JSON.stringify(stage)}) return runAsync(["sleep", "0.3"], opts);
        await Bun.sleep(15);
        return { exitCode: 0, stdout: args[0] === "models" ? JSON.stringify(catalog) : "created", stderr: "" };
      }),
      Bun.sleep(200).then(() => "hung")
    ]);
    assert.notEqual(result, "hung", "negotiation must use caller deadline");
    assert.equal(result.exitCode, 124);
    assert.ok(performance.now() - start < 190);
    assert.ok(calls.every(c => c.timeoutMs <= 80));
    ${stage === "models" ? 'assert.equal(calls.length, 1, "do not execute after failed probe");' : 'assert.ok(calls[2].timeoutMs < calls[0].timeoutMs, "verification uses remaining budget");'}
  `);
});
