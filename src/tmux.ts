import { cliEntrypoint } from "./settings";

export const SESSION_PREFIX = "agentmgr-";

export function sessionName(agent: string): string {
  return SESSION_PREFIX + agent;
}

export function tmux(...args: string[]): { exitCode: number; stdout: string; stderr: string } {
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
  configureAgentSession(opts.session);
}

export function killSession(session: string): void {
  tmux("kill-session", "-t", `=${session}`);
}

// The agentmgr scroll bindings, as tmux command argv (sans the leading
// "tmux"). Exported so the local setup (configureAgentSession) and the hub's
// remote ssh assertion (showAgent) stay in lockstep — they drifted once and
// the remote silently kept the wrong behavior.
//
// Why this shape: agent panes are fullscreen TUIs (claude/codex) in the
// ALTERNATE screen with NO tmux scrollback (history_size=0) and their own
// mouse mode, so tmux copy-mode has nothing to show. Route the scroll to the
// APP, per the tmux maintainer's tiered idiom:
//   • mouse_any_flag — the app wants mouse (every claude/codex TUI; also the
//     local nested attach): forward the wheel verbatim with `send -M`.
//   • alternate_on (no mouse) — a fullscreen app reached over ssh, where the
//     wheel can't be re-encoded: send it PageUp/Down, which claude honors.
//   • else — a plain shell pane (normal buffer, real scrollback): copy-mode
//     (-e exits at the bottom, back to live).
// PPage/NPage are bound too: the hub forwards each wheel notch into a remote
// pane as a bare PageUp/Down (mouse mode is lost over the ssh relay), so those
// keys must reach the same logic.
export const SCROLL_BINDINGS: string[][] = [
  ["bind-key", "-T", "agentmgr", "WheelUpPane",
    "if-shell", "-F", "-t=", "#{mouse_any_flag}",
    "send-keys -M -t=",
    "if-shell -F -t= '#{alternate_on}' 'send-keys -t= PPage' 'copy-mode -e'"],
  ["bind-key", "-T", "agentmgr", "WheelDownPane",
    "if-shell", "-F", "-t=", "#{mouse_any_flag}",
    "send-keys -M -t=",
    "if-shell -F -t= '#{alternate_on}' 'send-keys -t= NPage' 'send-keys -X page-down'"],
  ["bind-key", "-T", "agentmgr", "PPage",
    "if-shell", "-F", "-t=", "#{alternate_on}",
    "send-keys -t= PPage",
    "copy-mode -eu"],
  ["bind-key", "-T", "agentmgr", "NPage",
    "if-shell", "-F", "-t=", "#{alternate_on}",
    "send-keys -t= NPage",
    "send-keys -X page-down"],
];

// Per-session setup for agent sessions: ctrl-q detaches (the binding lives in
// a custom key table so other tmux sessions keep their root bindings), and
// the terminal tab/window title shows the agent's name while attached.
export function configureAgentSession(session: string): void {
  tmux("bind-key", "-T", "agentmgr", "C-q", "detach-client");
  // Like send-keys, set-option rejects a bare `=name` target — it needs the
  // `=name:` form for an exact match.
  tmux("set-option", "-t", `=${session}:`, "key-table", "agentmgr");
  tmux("set-option", "-t", `=${session}:`, "set-titles", "on");
  tmux("set-option", "-t", `=${session}:`, "set-titles-string", session.slice(SESSION_PREFIX.length));

  // Mouse mode lets tmux see wheel events at all; only the wheel/page keys are
  // bound (see SCROLL_BINDINGS) — no drag/click interception, no auto-copy.
  // Copying is terminal-native: Shift-drag (Option in iTerm2/Terminal.app),
  // then ⌘C.
  tmux("set-option", "-t", `=${session}:`, "mouse", "on");
  for (const binding of SCROLL_BINDINGS) tmux(...binding);

  // Plain click on a URL opens it; any other click is forwarded to the app
  // untouched. Only the pane id and click coordinates cross the shell
  // boundary — passing the line text itself (#{q:mouse_line}) leaked quoting
  // backslashes into opened URLs; `am __click` captures the pane line
  // directly instead. (OSC 8 hyperlinks — underlined file paths with hidden
  // targets — can only be followed by the terminal itself: cmd/shift-click.)
  const clickHandler = `run-shell -b "${process.execPath} ${cliEntrypoint()} __click #{pane_id} #{mouse_x} #{mouse_y}"`;
  tmux(
    "bind-key", "-T", "agentmgr", "MouseDown1Pane",
    "if-shell", "-F", "-t=", "#{m|r:https?://,#{mouse_line}}",
    clickHandler,
    "send-keys -M -t=",
  );
}

// send-keys targets a pane: the `=` exact-match prefix only resolves there
// when the session name ends with `:`.
function paneTarget(session: string): string {
  return `=${session}:`;
}

export function sendText(session: string, text: string, opts: { enterDelayMs?: number } = {}): void {
  const sent = tmux("send-keys", "-t", paneTarget(session), "-l", "--", text);
  if (sent.exitCode !== 0) throw new Error(`tmux send-keys failed: ${sent.stderr.trim()}`);
  // The codex TUI drops an Enter that lands in the same key batch as the
  // text (bracketed-paste detection); a short beat makes it a keypress.
  if (opts.enterDelayMs) Bun.sleepSync(opts.enterDelayMs);
  tmux("send-keys", "-t", paneTarget(session), "Enter");
}

export function sendEnter(session: string): void {
  tmux("send-keys", "-t", paneTarget(session), "Enter");
}

export function sendEscape(session: string): void {
  tmux("send-keys", "-t", paneTarget(session), "Escape");
}

export function capturePane(session: string, opts: { colors?: boolean } = {}): string[] | null {
  // -e keeps SGR escape sequences so previews render in full color.
  const flags = opts.colors ? ["-p", "-e"] : ["-p"];
  const result = tmux("capture-pane", "-t", paneTarget(session), ...flags);
  if (result.exitCode !== 0) return null;
  const lines = result.stdout.split("\n");
  while (lines.length > 0 && lines[lines.length - 1]!.trim() === "") lines.pop();
  return lines;
}

export function insideTmux(): boolean {
  return !!process.env.TMUX;
}

export function hasAttachedClient(session: string): boolean {
  const result = tmux("list-clients", "-t", `=${session}:`);
  return result.exitCode === 0 && result.stdout.trim() !== "";
}

export function attachOrSwitch(session: string): void {
  const args = insideTmux()
    ? ["switch-client", "-t", `=${session}`]
    : ["attach-session", "-t", `=${session}`];
  Bun.spawnSync(["tmux", ...args], { stdin: "inherit", stdout: "inherit", stderr: "inherit" });
}
