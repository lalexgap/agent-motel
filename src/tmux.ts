export const SESSION_PREFIX = "agentmgr-";

export function sessionName(agent: string): string {
  return SESSION_PREFIX + agent;
}

function tmux(...args: string[]): { exitCode: number; stdout: string; stderr: string } {
  const result = Bun.spawnSync(["tmux", ...args]);
  return {
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}

export function hasSession(session: string): boolean {
  // `=` forces an exact-name match instead of tmux's prefix matching.
  return tmux("has-session", "-t", `=${session}`).exitCode === 0;
}

export function shQuote(arg: string): string {
  return `'${arg.replaceAll("'", `'\\''`)}'`;
}

export function newSession(opts: {
  session: string;
  dir: string;
  env: Record<string, string>;
  command: string[];
}): void {
  const envFlags = Object.entries(opts.env).flatMap(([k, v]) => ["-e", `${k}=${v}`]);
  // tmux joins trailing words with spaces and runs them through sh -c,
  // so quote each word ourselves to survive spaces/quotes in messages.
  const command = opts.command.map(shQuote).join(" ");
  const result = tmux("new-session", "-d", "-s", opts.session, "-c", opts.dir, ...envFlags, command);
  if (result.exitCode !== 0) {
    throw new Error(`tmux new-session failed: ${result.stderr.trim()}`);
  }
  installDetachKey(opts.session);
}

export function killSession(session: string): void {
  tmux("kill-session", "-t", `=${session}`);
}

// ctrl-q detaches from agent sessions (no prefix needed). The binding lives
// in a custom key table applied per-session, so other tmux sessions on the
// same server keep their normal root bindings.
export function installDetachKey(session: string): void {
  tmux("bind-key", "-T", "agentmgr", "C-q", "detach-client");
  // Like send-keys, set-option rejects a bare `=name` target — it needs the
  // `=name:` form for an exact match.
  tmux("set-option", "-t", `=${session}:`, "key-table", "agentmgr");
}

// send-keys targets a pane: the `=` exact-match prefix only resolves there
// when the session name ends with `:`.
function paneTarget(session: string): string {
  return `=${session}:`;
}

export function sendText(session: string, text: string): void {
  const sent = tmux("send-keys", "-t", paneTarget(session), "-l", "--", text);
  if (sent.exitCode !== 0) throw new Error(`tmux send-keys failed: ${sent.stderr.trim()}`);
  tmux("send-keys", "-t", paneTarget(session), "Enter");
}

export function sendEscape(session: string): void {
  tmux("send-keys", "-t", paneTarget(session), "Escape");
}

export function capturePane(session: string): string[] | null {
  const result = tmux("capture-pane", "-t", paneTarget(session), "-p");
  if (result.exitCode !== 0) return null;
  const lines = result.stdout.split("\n");
  while (lines.length > 0 && lines[lines.length - 1]!.trim() === "") lines.pop();
  return lines;
}

export function insideTmux(): boolean {
  return !!process.env.TMUX;
}

export function attachOrSwitch(session: string): void {
  const args = insideTmux()
    ? ["switch-client", "-t", `=${session}`]
    : ["attach-session", "-t", `=${session}`];
  Bun.spawnSync(["tmux", ...args], { stdin: "inherit", stdout: "inherit", stderr: "inherit" });
}
