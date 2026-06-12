import { shQuote } from "./tmux";

// `am -H server <cmd>` / `AM_HOST=server am <cmd>`: run the command on a
// remote am over plain SSH. am stays transport-ignorant — ssh does auth,
// encryption, and the terminal; this just forwards argv.

export function stripHostArgs(argv: string[]): string[] {
  const filtered: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--host" || arg === "-H") {
      i++; // skip the value too
      continue;
    }
    if (arg === "--local" || arg === "-L") continue;
    filtered.push(arg);
  }
  return filtered;
}

// Internal commands run on whatever machine fired them — forwarding a hook
// or click handler over SSH (e.g. via a profile-exported AM_HOST on the
// server itself) would loop or misfire.
export function isForwardable(command: string | undefined): boolean {
  return !command || (!command.startsWith("__") && command !== "hook");
}

export function remoteExec(host: string, argv: string[]): never {
  // Login shell so ~/.bun/bin lands on PATH for non-interactive ssh; argv is
  // re-quoted to survive both ssh's argument join and the remote shell.
  const remote = ["am", ...stripHostArgs(argv)].map(shQuote).join(" ");
  const interactive = !!process.stdin.isTTY && !!process.stdout.isTTY;
  const result = Bun.spawnSync(
    ["ssh", ...(interactive ? ["-t"] : []), host, "--", `sh -lc ${shQuote(remote)}`],
    { stdin: "inherit", stdout: "inherit", stderr: "inherit" },
  );
  process.exit(result.exitCode);
}
