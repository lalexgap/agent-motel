import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = join(import.meta.dir, "..");

async function run(code: string, options: { failStart?: boolean; socketPid?: string; managed?: string } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "am-services-"));
  const log = join(dir, "calls");
  for (const [name, script] of Object.entries({
    systemctl: `#!/bin/sh\nprintf 'systemctl %s\\n' "$*" >> "$SERVICE_TEST_LOG"\nif [ "$2" = show ]; then echo 4242; elif [ "$SERVICE_TEST_FAIL" = 1 ]; then echo unavailable >&2; exit 1; fi\n`,
    tmux: `#!/bin/sh\nprintf 'tmux %s\\n' "$*" >> "$SERVICE_TEST_LOG"\ncase "$*" in *display-message*) echo "$SERVICE_TEST_PID";; esac\n`,
  })) {
    writeFileSync(join(dir, name), script);
    chmodSync(join(dir, name), 0o755);
  }
  try {
    const child = Bun.spawn([process.execPath, "-e", code], {
      cwd: root,
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, AGENTMGR_HOME: dir,
        AGENTMGR_SYSTEMD: options.managed ?? "1", SERVICE_TEST_LOG: log,
        SERVICE_TEST_FAIL: options.failStart ? "1" : "0", SERVICE_TEST_PID: options.socketPid ?? "4242" },
      stdout: "pipe", stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    return { stdout, stderr, exitCode, calls: readFileSync(log, "utf8") };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("managed service startup", () => {
  test("new sessions require the service and disable implicit server startup", async () => {
    const result = await run('import { tmux } from "./src/tmux"; tmux("new-session", "-d", "-s", "test")');
    expect(result.exitCode).toBe(0);
    expect(result.calls).toContain("systemctl --user start am-tmux.service");
    expect(result.calls).toContain("tmux -N new-session");
    expect(result.calls).toContain("tmux -N display-message");
  });

  test("a failed service start never falls back to starting tmux", async () => {
    const result = await run('import { tmux } from "./src/tmux"; tmux("new-session", "-d")', { failStart: true });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("Cannot start am-tmux.service");
    expect(result.calls).not.toContain("tmux ");
  });

  test("an existing server with a different owner blocks new sessions", async () => {
    const result = await run('import { tmux } from "./src/tmux"; tmux("new-session", "-d")', { socketPid: "3333" });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("unmanaged tmux server");
    expect(result.calls).not.toContain("new-session");
  });

  test("read-only tmux calls cannot auto-create a server or start a unit", async () => {
    const result = await run('import { hasSession } from "./src/tmux"; hasSession("test")');
    expect(result.calls).toContain("tmux -N has-session");
    expect(result.calls).not.toContain("systemctl");
  });

  test("legacy mode does not invoke systemd", async () => {
    const result = await run('import { tmux } from "./src/tmux"; tmux("new-session", "-d")', { managed: "0" });
    expect(result.exitCode).toBe(0);
    expect(result.calls).toContain("tmux new-session");
    expect(result.calls).not.toContain("systemctl");
  });

  test("daemon startup fails closed when its unit cannot start", async () => {
    const result = await run('import { ensureDaemon } from "./src/daemon"; await ensureDaemon()', { failStart: true });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("Cannot start am-daemon.service");
    expect(result.calls).toBe("systemctl --user start am-daemon.service\n");
  });

  test("managed daemon startup rejects a healthy socket belonging to another process", async () => {
    const result = await run(`
      import { daemonSocket } from "./src/paths";
      import { ensureDaemon } from "./src/daemon";
      const server = Bun.serve({unix: daemonSocket(), fetch: () => Response.json({pid: 3333})});
      try { await ensureDaemon(); } finally { server.stop(true); }
    `);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("unmanaged daemon owns the socket");
    expect(result.calls).toContain("systemctl --user start am-daemon.service");
  });

  test("daemon stop targets the unit instead of killing a recorded PID", async () => {
    const result = await run('import { daemonCommand } from "./src/commands/daemon"; await daemonCommand("stop")');
    expect(result.exitCode).toBe(0);
    expect(result.calls).toBe("systemctl --user stop am-daemon.service\n");
  });
});

async function daemonProcess(home: string) {
  return Bun.spawn([process.execPath, "-e", 'import { runForegroundDaemon } from "./src/daemon"; await runForegroundDaemon()'], {
    cwd: root, env: { ...process.env, AGENTMGR_HOME: home, AGENTMGR_SYSTEMD: "0" }, stdout: "pipe", stderr: "pipe",
  });
}

async function health(home: string): Promise<{ pid: number } | null> {
  try {
    const res = await fetch("http://am/health", { unix: join(home, "daemon.sock"), signal: AbortSignal.timeout(100) });
    return await res.json() as { pid: number };
  } catch { return null; }
}

test("concurrent foreground daemons keep a single socket owner", async () => {
  const dir = mkdtempSync(join(tmpdir(), "am-daemon-owner-"));
  const children = await Promise.all([daemonProcess(dir), daemonProcess(dir)]);
  try {
    let owner: { pid: number } | null = null;
    for (let i = 0; i < 100 && !owner; i++) {
      owner = await health(dir);
      if (!owner) await Bun.sleep(20);
    }
    expect(owner).not.toBeNull();
    const loser = children.find(child => child.pid !== owner!.pid)!;
    expect(await loser.exited).not.toBe(0);
    expect(await new Response(loser.stderr).text()).toContain("Another daemon owns daemon.lock");
    expect((await health(dir))?.pid).toBe(owner!.pid);
    expect(readFileSync(join(dir, "daemon.pid"), "utf8").trim()).toBe(String(owner!.pid));
  } finally {
    for (const child of children) if (child.exitCode === null) child.kill();
    await Promise.all(children.map(child => child.exited));
    rmSync(dir, { recursive: true, force: true });
  }
});

test("foreground startup does not unlink a socket owned by an older daemon", async () => {
  const dir = mkdtempSync(join(tmpdir(), "am-old-daemon-"));
  const server = Bun.serve({ unix: join(dir, "daemon.sock"), fetch: () => Response.json({ pid: process.pid }) });
  const child = await daemonProcess(dir);
  try {
    expect(await child.exited).not.toBe(0);
    expect(await new Response(child.stderr).text()).toContain("already owns the socket");
    expect((await health(dir))?.pid).toBe(process.pid);
  } finally {
    if (child.exitCode === null) child.kill();
    await child.exited;
    server.stop(true);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("foreground startup recovers when daemon.pid was reused by an unrelated live process", async () => {
  const dir = mkdtempSync(join(tmpdir(), "am-reused-pid-"));
  const unrelated = Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1000)", "not__daemon"], { stdout: "ignore", stderr: "pipe" });
  writeFileSync(join(dir, "daemon.pid"), `${unrelated.pid}\n`);
  // A crashed daemon can leave both an unusable socket path and a stale PID.
  writeFileSync(join(dir, "daemon.sock"), "stale");
  const child = await daemonProcess(dir);
  try {
    let owner: { pid: number } | null = null;
    for (let i = 0; i < 100 && !owner; i++) {
      owner = await health(dir);
      if (!owner) await Bun.sleep(20);
    }
    expect(owner?.pid).toBe(child.pid);
    expect(readFileSync(join(dir, "daemon.pid"), "utf8").trim()).toBe(String(child.pid));
    expect(unrelated.exitCode).toBeNull();
  } finally {
    if (child.exitCode === null) child.kill();
    if (unrelated.exitCode === null) unrelated.kill();
    await Promise.all([child.exited, unrelated.exited]);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("foreground startup preserves an unhealthy legacy daemon without a lock", async () => {
  const dir = mkdtempSync(join(tmpdir(), "am-unhealthy-legacy-"));
  const socket = join(dir, "daemon.sock");
  const legacy = Bun.spawn([process.execPath, "-e", `
    import { writeFileSync } from "node:fs";
    Bun.serve({ unix: ${JSON.stringify(socket)}, fetch: () => new Response("unhealthy", { status: 503 }) });
    writeFileSync(${JSON.stringify(join(dir, "daemon.pid"))}, String(process.pid) + "\\n");
    console.log("ready");
  `, "__daemon"], { stdout: "pipe", stderr: "pipe" });
  let child: Awaited<ReturnType<typeof daemonProcess>> | undefined;
  try {
    const reader = legacy.stdout.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain("ready");
    reader.releaseLock();
    const inode = statSync(socket).ino;
    child = await daemonProcess(dir);
    expect(await child.exited).not.toBe(0);
    expect(await new Response(child.stderr).text()).toContain(`Daemon PID ${legacy.pid} is still alive`);
    expect(statSync(socket).ino).toBe(inode);
    expect(readFileSync(join(dir, "daemon.pid"), "utf8").trim()).toBe(String(legacy.pid));
    expect((await fetch("http://am/health", { unix: socket, signal: AbortSignal.timeout(100) })).status).toBe(503);
    expect(legacy.exitCode).toBeNull();
  } finally {
    if (child?.exitCode === null) child.kill();
    if (legacy.exitCode === null) legacy.kill();
    await Promise.all([child?.exited, legacy.exited]);
    rmSync(dir, { recursive: true, force: true });
  }
});
