import { expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const enabled = process.env.AM_TEST_SYSTEMD === "1" && process.platform === "linux";
const root = join(import.meta.dir, "..");

async function until<T>(read: () => T, accept: (value: T) => boolean): Promise<T> {
  for (let i = 0; i < 100; i++) {
    const value = read();
    if (accept(value)) return value;
    await Bun.sleep(50);
  }
  throw new Error("Disposable service did not become ready");
}

(enabled ? test : test.skip)("frontend restart/crash and daemon restart preserve the tmux server and pane", async () => {
  const dir = mkdtempSync(join(tmpdir(), "am-lifecycle-"));
  const name = `am-lifecycle-${process.pid}-${Date.now()}`;
  const units = { tmux: `${name}-tmux.service`, daemon: `${name}-daemon.service`, frontend: `${name}-frontend.service` };
  const shims = join(dir, "bin");
  const { mkdirSync } = await import("node:fs");
  mkdirSync(shims);
  for (const [filename, content] of Object.entries({
    systemctl: `#!/bin/sh\naction=$2\nunit=$3\nshift 3\ncase "$unit" in\nam-tmux.service) unit=${units.tmux};;\nam-daemon.service) unit=${units.daemon};;\n*) exit 99;;\nesac\nexec /usr/bin/systemctl --user "$action" "$unit" "$@"\n`,
    tmux: `#!/bin/sh\nexec /usr/bin/tmux -L ${name} "$@"\n`,
  })) {
    writeFileSync(join(shims, filename), content);
    chmodSync(join(shims, filename), 0o755);
  }
  function command(args: string[]): string {
    const result = Bun.spawnSync(args, { env: { ...process.env, AGENTMGR_SYSTEMD: "0" } });
    if (result.exitCode !== 0) throw new Error(`${args.join(" ")}: ${result.stderr.toString()}`);
    return result.stdout.toString().trim();
  }
  const ctl = (...args: string[]) => command(["/usr/bin/systemctl", "--user", ...args]);
  const tmux = (...args: string[]) => command(["/usr/bin/tmux", "-L", name, "-N", ...args]);
  const pid = (unit: string) => ctl("show", unit, "-p", "MainPID", "--value");
  function start(unit: string, args: string[]) {
    command(["systemd-run", "--user", `--unit=${unit}`, "--property=Type=exec", "--property=Restart=on-failure", "--property=RestartSec=100ms",
      `--setenv=AGENTMGR_HOME=${dir}`, "--setenv=AGENTMGR_SYSTEMD=1", `--setenv=PATH=${shims}:${process.env.PATH}`,
      "--setenv=TMUX=", "--setenv=AM_HOST=", "--setenv=AGENTMGR_AGENT=", "--", ...args]);
  }
  writeFileSync(join(dir, "daemon.ts"), `import { runForegroundDaemon } from ${JSON.stringify(join(root, "src/daemon.ts"))}; await runForegroundDaemon();`);
  writeFileSync(join(dir, "frontend.ts"), `
    import { newSession, hasSession } from ${JSON.stringify(join(root, "src/tmux.ts"))};
    import { ensureDaemon } from ${JSON.stringify(join(root, "src/daemon.ts"))};
    if (!await ensureDaemon()) throw new Error("No daemon");
    if (!hasSession("lifecycle-test")) newSession({session:"lifecycle-test",dir:${JSON.stringify(dir)},env:{},command:["sleep","300"]});
    setInterval(() => {}, 1000);
  `);
  try {
    start(units.tmux, ["/usr/bin/tmux", "-L", name, "-f", "/dev/null", "-D"]);
    await until(() => pid(units.tmux), value => value !== "0");
    start(units.daemon, [process.execPath, join(dir, "daemon.ts")]);
    start(units.frontend, [process.execPath, join(dir, "frontend.ts")]);
    await until(() => Bun.spawnSync(["/usr/bin/tmux", "-L", name, "-N", "has-session", "-t", "=lifecycle-test"]).exitCode, value => value === 0);
    const serverPid = tmux("display-message", "-p", "#{pid}");
    const panePid = tmux("display-message", "-p", "-t", "=lifecycle-test:", "#{pane_pid}");
    expect(serverPid).toBe(pid(units.tmux));
    function assertSurvived() {
      expect(tmux("display-message", "-p", "#{pid}")).toBe(serverPid);
      expect(tmux("display-message", "-p", "-t", "=lifecycle-test:", "#{pane_pid}")).toBe(panePid);
      expect(tmux("display-message", "-p", "-t", "=lifecycle-test:", "#{pane_dead}")).toBe("0");
    }
    const frontendPid = pid(units.frontend);
    ctl("restart", units.frontend);
    await until(() => pid(units.frontend), value => value !== "0" && value !== frontendPid);
    assertSurvived();
    const daemonPid = pid(units.daemon);
    ctl("restart", units.daemon);
    await until(() => pid(units.daemon), value => value !== "0" && value !== daemonPid);
    assertSurvived();
    const restartedFrontend = pid(units.frontend);
    ctl("kill", "--kill-whom=main", "--signal=SIGKILL", units.frontend);
    await until(() => pid(units.frontend), value => value !== "0" && value !== restartedFrontend);
    assertSurvived();
    console.log(`Isolated lifecycle check passed: ${name}; server=${serverPid}, pane=${panePid}`);
  } finally {
    Bun.spawnSync(["/usr/bin/systemctl", "--user", "stop", units.frontend, units.daemon, units.tmux]);
    Bun.spawnSync(["/usr/bin/systemctl", "--user", "reset-failed", units.frontend, units.daemon, units.tmux]);
    rmSync(dir, { recursive: true, force: true });
  }
}, 30_000);
