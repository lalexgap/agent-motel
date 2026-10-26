import { rmSync } from "node:fs";
import { daemonLogFile, daemonPidFile, daemonSocket } from "../paths";
import { daemonHealth, ensureDaemon, readDaemonPid } from "../daemon";
import { managedServices, serviceAction } from "../services";

export async function daemonCommand(action: string | undefined): Promise<void> {
  switch (action ?? "status") {
    case "start": {
      if (!managedServices() && await daemonHealth()) {
        console.log("daemon already running");
        return;
      }
      if (!(await ensureDaemon())) throw new Error("daemon failed to start");
      const health = await daemonHealth();
      console.log(`daemon started (pid ${health?.pid})`);
      break;
    }
    case "stop": {
      if (managedServices()) {
        serviceAction("daemon", "stop");
        console.log("daemon service stopped");
        return;
      }
      const health = await daemonHealth();
      const pid = health?.pid ?? readDaemonPid();
      if (!pid) {
        console.log("daemon not running");
        return;
      }
      process.kill(pid, "SIGTERM");
      rmSync(daemonSocket(), { force: true });
      rmSync(daemonPidFile(), { force: true });
      console.log(`daemon stopped (pid ${pid})`);
      break;
    }
    case "status": {
      const health = await daemonHealth();
      if (health) {
        console.log(`daemon running (pid ${health.pid}, since ${health.startedAt})`);
        console.log(`socket: ${daemonSocket()}`);
        console.log(`log:    ${daemonLogFile()}`);
      } else {
        console.log("daemon not running — start it with `am daemon start`");
      }
      break;
    }
    default:
      throw new Error(`unknown daemon action "${action}" (start|stop|status)`);
  }
}
