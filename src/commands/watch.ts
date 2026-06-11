import { daemonRequest, ensureDaemon } from "../daemon";
import { formatRows, type AgentRow } from "./ls";

const CLEAR_LINE = "\x1b[2K";

// Live status table, fed by the daemon over its unix socket.
export async function watchCommand(): Promise<void> {
  if (!(await ensureDaemon())) throw new Error("daemon failed to start");

  let renderedLines = 0;
  process.stdout.write("\x1b[?25l"); // hide cursor
  const restore = () => {
    process.stdout.write("\x1b[?25h\n");
    process.exit(0);
  };
  process.on("SIGINT", restore);
  process.on("SIGTERM", restore);

  while (true) {
    const res = await daemonRequest("/agents");
    if (!res?.ok) throw new Error("lost connection to daemon");
    const rows = (await res.json()) as AgentRow[];

    const lines = [...formatRows(rows), "\x1b[2m(watching via daemon · ctrl-c to exit)\x1b[0m"];
    if (renderedLines > 0) process.stdout.write(`\x1b[${renderedLines}A`);
    while (lines.length < renderedLines) lines.push("");
    process.stdout.write(lines.map((l) => CLEAR_LINE + "\r" + l).join("\n") + "\n");
    renderedLines = lines.length;

    await Bun.sleep(1000);
  }
}
