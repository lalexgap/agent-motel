export interface PickerItem {
  name: string;
  label: string;
  // Extra text the filter matches against (task, dir) besides the name.
  search?: string;
}

export interface PickerHandlers {
  // Each returns a feedback message shown in the picker footer.
  stop?: (name: string) => string;
  remove?: (name: string) => string;
  // Live pane content for the highlighted agent, shown under the list.
  preview?: (name: string) => string[];
}

export function clipLine(line: string, width: number): string {
  return line.length > width ? line.slice(0, Math.max(0, width - 1)) + "…" : line;
}

const PREVIEW_MAX_LINES = 14;
const REFRESH_MS = 1000;

const HIDE_CURSOR = "\x1b[?25l";
const SHOW_CURSOR = "\x1b[?25h";
const CLEAR_LINE = "\x1b[2K";

const HELP = "(type to filter · ↑/↓ · enter jumps (ctrl-q returns) · ctrl-x stop · ctrl-d remove · esc)";

export async function pick(
  load: () => PickerItem[],
  handlers: PickerHandlers = {},
  initial?: string,
): Promise<string | null> {
  let items = load();
  if (items.length === 0) return null;
  if (!process.stdin.isTTY) throw new Error("interactive picker needs a TTY (use `am ls` / `am j <name>`)");

  let filter = "";
  let cursor = Math.max(0, items.findIndex((i) => i.name === initial));
  let renderedLines = 0;
  let feedback: string | null = null;
  let confirmRemove: string | null = null;

  const out = (s: string) => process.stdout.write(s);

  const filtered = () =>
    items.filter((i) => `${i.name} ${i.search ?? ""}`.toLowerCase().includes(filter.toLowerCase()));

  const render = () => {
    if (renderedLines > 0) out(`\x1b[${renderedLines}A`);
    const matches = filtered();
    if (cursor >= matches.length) cursor = Math.max(0, matches.length - 1);
    const cols = process.stdout.columns ?? 80;
    const rows = process.stdout.rows ?? 24;

    const footer = confirmRemove
      ? `\x1b[31mremove "${confirmRemove}"? ctrl-d again to confirm\x1b[0m`
      : feedback
        ? `\x1b[33m${feedback}\x1b[0m`
        : `\x1b[2m${HELP}\x1b[0m`;

    const lines = [
      `filter: ${filter}\x1b[0m`,
      ...matches.map((item, i) =>
        i === cursor ? `\x1b[7m❯ ${clipLine(item.label, cols - 3)}\x1b[0m` : `  ${clipLine(item.label, cols - 3)}`,
      ),
      ...(matches.length === 0 ? ["  (no matches)"] : []),
      footer,
    ];

    const selected = matches[cursor];
    if (handlers.preview && selected) {
      // Leave one row of headroom: overflowing the terminal height would
      // scroll and break the cursor-up redraw math.
      const available = Math.min(PREVIEW_MAX_LINES, rows - 1 - lines.length - 1);
      if (available > 0) {
        const content = handlers.preview(selected.name).slice(-available);
        lines.push(`\x1b[2m${"─".repeat(Math.min(cols - 1, 60))} ${selected.name}\x1b[0m`);
        for (const line of content) lines.push(`\x1b[2m${clipLine(line, cols - 1)}\x1b[0m`);
      }
    }

    // Pad with blank lines so shrinking the match list leaves no stale rows.
    while (lines.length < renderedLines) lines.push("");
    out(lines.map((l) => CLEAR_LINE + "\r" + l).join("\n") + "\n");
    renderedLines = lines.length;
  };

  process.stdin.setRawMode(true);
  process.stdin.resume();
  out("\x1b]0;am\x07"); // tab title; agent sessions set their own via tmux set-titles
  out(HIDE_CURSOR);
  render();

  // Keep statuses, queue depths, and the preview live while the picker is open.
  const refresh = setInterval(() => {
    items = load();
    render();
  }, REFRESH_MS);

  const result = await new Promise<string | null>((resolve) => {
    const runAction = (handler: (name: string) => string) => {
      const target = filtered()[cursor];
      if (!target) return;
      feedback = handler(target.name);
      items = load();
      if (items.length === 0) return finish(null);
    };

    const onData = (data: Buffer) => {
      const key = data.toString();
      const pendingConfirm = confirmRemove;
      confirmRemove = null;

      if (key === "\x03" || key === "\x1b") return finish(null); // ctrl-c / esc
      if (key === "\r" || key === "\n") {
        const match = filtered()[cursor];
        return finish(match ? match.name : null);
      }
      if (key === "\x18" && handlers.stop) {
        // ctrl-x
        runAction(handlers.stop);
      } else if (key === "\x04" && handlers.remove) {
        // ctrl-d, twice on the same item to confirm
        const target = filtered()[cursor];
        if (target && pendingConfirm === target.name) runAction(handlers.remove);
        else if (target) confirmRemove = target.name;
      } else if (key === "\x1b[A") cursor = Math.max(0, cursor - 1);
      else if (key === "\x1b[B") cursor = Math.min(filtered().length - 1, cursor + 1);
      else if (key === "\x7f" || key === "\b") filter = filter.slice(0, -1);
      else if (key >= " " && !key.startsWith("\x1b")) filter += key;
      render();
    };

    const finish = (value: string | null) => {
      clearInterval(refresh);
      process.stdin.off("data", onData);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      // Erase the picker so the attach starts on a clean screen.
      out(`\x1b[${renderedLines}A`);
      for (let i = 0; i < renderedLines; i++) out(CLEAR_LINE + "\n");
      out(`\x1b[${renderedLines}A` + SHOW_CURSOR);
      resolve(value);
    };

    process.stdin.on("data", onData);
  });

  return result;
}
