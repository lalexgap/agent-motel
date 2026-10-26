import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export function managedServices(): boolean {
  if (process.env.AGENTMGR_SYSTEMD !== undefined) return process.env.AGENTMGR_SYSTEMD === "1";
  if (process.platform !== "linux" || process.env.AGENTMGR_HOME) return false;
  return existsSync(join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "systemd/user/am-tmux.service"));
}

export function serviceAction(service: "tmux" | "daemon", action: "start" | "stop"): void {
  const result = Bun.spawnSync(["systemctl", "--user", action, `am-${service}.service`]);
  if (result.exitCode !== 0) {
    throw new Error(`Cannot ${action} am-${service}.service: ${result.stderr.toString().trim()}. See docs/service-lifecycle.md.`);
  }
}

export function servicePid(service: "tmux" | "daemon"): number {
  const result = Bun.spawnSync(["systemctl", "--user", "show", `am-${service}.service`, "--property=MainPID", "--value"]);
  const pid = Number(result.stdout.toString().trim());
  if (result.exitCode !== 0 || !Number.isInteger(pid) || pid <= 0) {
    throw new Error(`am-${service}.service has no running main process. See docs/service-lifecycle.md.`);
  }
  return pid;
}

export function ensureTmuxService(): void {
  serviceAction("tmux", "start");
  const expected = servicePid("tmux");
  // Type=exec starts before the server has bound its socket.
  for (let i = 0; i < 100; i++) {
    const result = Bun.spawnSync(["tmux", "-N", "display-message", "-p", "#{pid}"]);
    if (result.exitCode === 0) {
      if (Number(result.stdout.toString().trim()) === expected) return;
      throw new Error("An unmanaged tmux server owns this socket; preserve its sessions and follow docs/service-lifecycle.md before migrating.");
    }
    Bun.sleepSync(20);
  }
  throw new Error("am-tmux.service did not make its socket available. See docs/service-lifecycle.md.");
}
