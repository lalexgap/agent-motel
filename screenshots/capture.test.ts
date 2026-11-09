import { test, expect } from "bun:test";
const root = "/home/lagap/code/agent-motel-review-worktrees/remote";
const out = "/tmp/pr150-shepherd-PSv1li";
test.each(["stop", "remove"])("capture isolated terminal %s states", action => {
  const script = `
    import assert from "node:assert/strict";
    import { mock } from "bun:test";
    import { writeFileSync } from "node:fs";
    mock.module("${root}/src/usage", () => ({ startUsagePolling: () => () => {}, usageBadge: () => "" }));
    Object.defineProperty(process.stdin, "isTTY", { value: true });
    process.stdin.setRawMode = () => process.stdin;
    Object.defineProperty(process.stdout, "columns", { value: 100 });
    Object.defineProperty(process.stdout, "rows", { value: 30 });
    let frames = "", resolveAction, calls = 0, selected;
    process.stdout.write = text => { frames += text; return true; };
    const { pick } = await import("${root}/src/picker");
    const items = ["fixture:one", "fixture:two"].map(name => ({ name, label: name, status: "idle", task: "Isolated UI fixture" }));
    const running = pick(() => items, {
      ${action}: () => { calls++; return new Promise(resolve => { resolveAction = resolve; }); },
      select: name => { selected = name; }
    });
    const key = value => process.stdin.emit("data", Buffer.from(value));
    const save = stage => writeFileSync("${out}/${action}-" + stage + ".ansi", frames);
    key("e"); key(${JSON.stringify(action === "stop" ? "x" : "d")});
    ${action === "remove" ? 'assert.equal(calls, 0); save("confirmation"); key("d");' : ""}
    await Bun.sleep(10); assert.equal(calls, 1); save("pending");
    key("j"); key("\\r"); assert.equal(selected, "fixture:two"); save("navigation");
    resolveAction({ text: "${action === "stop" ? "stop" : "rm"} timed out; check the remote agent before retrying", level: "error" });
    await Bun.sleep(10); save("timeout"); key("\\x03"); await running;
  `;
  const result = Bun.spawnSync([process.execPath, "-e", script], { cwd: root, env: { ...process.env, AM_SSH_NO_MUX: "1" }, timeout: 5000 });
  expect(result.stderr.toString()).toBe(""); expect(result.exitCode).toBe(0);
});
