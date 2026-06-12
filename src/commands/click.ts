import { tmux } from "../tmux";

// Mouse-click URL handling. tmux's mouse_word splits URLs on its default
// word-separators, and passing #{mouse_line} through run-shell means shell
// quoting (#{q:} escapes leak literal backslashes into the text — they were
// showing up %5C-encoded in opened URLs). So the binding passes only the
// pane id and click coordinates, and the line is captured here, shell-free.

const URL_RE = /https?:\/\/[^\s'"()\[\]{}<>]+/g;

export function extractUrlAt(line: string, x: number): string | null {
  for (const match of line.matchAll(URL_RE)) {
    const url = match[0].replace(/[\\.,;:!?]+$/, ""); // shed trailing punctuation/escapes
    if (x >= match.index && x < match.index + url.length) return url;
  }
  return null;
}

export interface OpenerEnv {
  platform: NodeJS.Platform;
  has: (binary: string) => boolean;
  display: boolean;
}

// On a headless server there's no browser (and "opening" would happen on the
// wrong machine anyway) — null means fall back to the tmux buffer.
export function chooseOpener(env: OpenerEnv): string | null {
  if (env.platform === "darwin") return "open";
  if (env.display && env.has("xdg-open")) return "xdg-open";
  return null;
}

export function clickCommand(paneId: string, x: number, y: number): void {
  if (!/^%\d+$/.test(paneId) || x < 0 || y < 0) return;
  const captured = tmux("capture-pane", "-p", "-t", paneId);
  if (captured.exitCode !== 0) return;
  // capture-pane prints the visible rows in order; mouse_y is the 0-based
  // visible row that was clicked.
  const line = captured.stdout.split("\n")[y] ?? "";
  const url = extractUrlAt(line, x);
  if (!url) return;

  const opener = chooseOpener({
    platform: process.platform,
    has: (binary) => !!Bun.which(binary),
    display: !!(process.env.DISPLAY || process.env.WAYLAND_DISPLAY),
  });
  if (opener) {
    Bun.spawn({ cmd: [opener, url], stdin: "ignore", stdout: "ignore", stderr: "ignore" }).unref();
    return;
  }
  // Headless: stash the URL in the tmux buffer and say so. (When connected
  // over SSH, cmd/shift-click in the local terminal opens URLs laptop-side.)
  tmux("set-buffer", "--", url);
  tmux("display-message", "-t", paneId, `am: copied to tmux buffer — ${url}`);
}
