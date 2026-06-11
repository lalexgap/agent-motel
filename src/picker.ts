export interface PickerItem {
  name: string;
  label: string;
  // Extra text the filter matches against (task, dir) besides the name.
  search?: string;
  // Already-formatted detail lines shown in the sidebar under the list for
  // the highlighted item.
  meta?: string[];
}

export interface PickerHandlers {
  // Each returns a feedback message shown in the picker footer.
  stop?: (name: string) => string;
  remove?: (name: string) => string;
  // Live pane content for the highlighted agent, shown in the right pane.
  preview?: (name: string) => string[];
  // Create a new agent; resolves to its name, which the picker then jumps to
  // (or selects, in persistent mode).
  create?: (name: string, task?: string) => Promise<string>;
  // Persistent mode (am ui sidebar): enter calls select instead of resolving
  // the picker, esc calls quit, and the picker keeps running. Returns
  // optional footer feedback.
  select?: (name: string) => string | null;
  quit?: () => void;
  // Footer help text override (persistent mode has different key semantics).
  help?: string;
}

export function clipLine(line: string, width: number): string {
  return line.length > width ? line.slice(0, Math.max(0, width - 1)) + "…" : line;
}

const SGR_RE = /\x1b\[[0-9;]*m/g;

export function visibleWidth(line: string): number {
  return line.replace(SGR_RE, "").length;
}

// Raw stdin can batch several keys into one chunk (key repeat, paste,
// send-keys) — split it into individual keys so none get dropped.
export function splitKeys(data: string): string[] {
  const keys: string[] = [];
  for (let i = 0; i < data.length; ) {
    if (data[i] === "\x1b") {
      const match = /^\x1b\[[0-9;]*[A-Za-z~]/.exec(data.slice(i));
      if (match) {
        keys.push(match[0]);
        i += match[0].length;
        continue;
      }
      keys.push("\x1b");
      i++;
      continue;
    }
    if (data[i] === "\r" && data[i + 1] === "\n") {
      keys.push("\r");
      i += 2;
      continue;
    }
    keys.push(data[i]!);
    i++;
  }
  return keys;
}

// clipLine for lines carrying SGR color codes (tmux capture-pane -e):
// escapes are zero-width and never split mid-sequence.
export function clipAnsi(line: string, width: number): string {
  if (visibleWidth(line) <= width) return line;
  let out = "";
  let visible = 0;
  for (let i = 0; i < line.length; ) {
    const match = /^\x1b\[[0-9;]*m/.exec(line.slice(i));
    if (match) {
      out += match[0];
      i += match[0].length;
      continue;
    }
    if (visible >= Math.max(0, width - 1)) break;
    out += line[i];
    visible++;
    i++;
  }
  return out + "…";
}

// Sidebar width: enough for name + status, capped so the preview keeps room.
export function sidebarWidthFor(cols: number, withPreview: boolean): number {
  if (!withPreview) return cols;
  return Math.max(28, Math.min(48, Math.floor(cols * 0.38)));
}

const REFRESH_MS = 1000;
const MIN_PREVIEW_WIDTH = 24;

const HIDE_CURSOR = "\x1b[?25l";
const SHOW_CURSOR = "\x1b[?25h";
const ALT_SCREEN_ON = "\x1b[?1049h";
const ALT_SCREEN_OFF = "\x1b[?1049l";
const CLEAR_LINE = "\x1b[2K";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";
const INVERSE = "\x1b[7m";

const HELP = "type to filter · ↑/↓ · enter jumps (ctrl-q returns) · ctrl-n new · ctrl-x stop · ctrl-d remove · esc";

// A sidebar cell: plain text plus an optional style applied after clipping
// and padding, so the width math never has to account for escape codes.
interface Cell {
  text: string;
  style?: string;
}

type Mode = "list" | "new-name" | "new-task";

export async function pick(
  load: () => PickerItem[],
  handlers: PickerHandlers = {},
  initial?: string,
): Promise<string | null> {
  let items = load();
  if (items.length === 0 && !handlers.create) return null;
  if (!process.stdin.isTTY) throw new Error("interactive picker needs a TTY (use `am ls` / `am j <name>`)");

  let filter = "";
  let cursor = Math.max(0, items.findIndex((i) => i.name === initial));
  let feedback: string | null = null;
  let confirmRemove: string | null = null;
  let mode: Mode = "list";
  let newName = "";
  let newTask = "";
  let creating = false;

  const out = (s: string) => process.stdout.write(s);

  const filtered = () =>
    items.filter((i) => `${i.name} ${i.search ?? ""}`.toLowerCase().includes(filter.toLowerCase()));

  const render = () => {
    const cols = process.stdout.columns ?? 80;
    const rows = process.stdout.rows ?? 24;
    const showPreview = !!handlers.preview && cols >= 28 + MIN_PREVIEW_WIDTH + 2;
    const sidebarWidth = sidebarWidthFor(cols, showPreview);
    const previewWidth = cols - sidebarWidth - 2; // "│ " separator
    const bodyRows = Math.max(1, rows - 1); // last row is the footer

    const matches = filtered();
    if (cursor >= matches.length) cursor = Math.max(0, matches.length - 1);
    const selected = matches[cursor];

    const header: Cell =
      mode === "new-name"
        ? { text: `new agent name: ${newName}▌` }
        : mode === "new-task"
          ? { text: `task (optional): ${newTask}▌` }
          : { text: `filter: ${filter}▌` };

    const metaBlock: Cell[] = selected?.meta?.length
      ? [{ text: "" }, ...selected.meta.map((m): Cell => ({ text: m, style: DIM }))]
      : [];

    // Window the list around the cursor so long agent lists stay navigable.
    const listCapacity = Math.max(1, bodyRows - 1 - metaBlock.length);
    let start = 0;
    if (matches.length > listCapacity) {
      start = Math.min(Math.max(0, cursor - Math.floor(listCapacity / 2)), matches.length - listCapacity);
    }

    const side: Cell[] = [header];
    matches.slice(start, start + listCapacity).forEach((item, i) => {
      const idx = start + i;
      const text = `${idx === cursor ? "❯ " : "  "}${item.label}`;
      side.push(idx === cursor ? { text, style: INVERSE } : { text });
    });
    if (matches.length === 0) {
      side.push({
        text: items.length === 0 ? "  (no agents — ctrl-n creates one)" : "  (no matches)",
        style: DIM,
      });
    }
    side.push(...metaBlock);

    const previewLines =
      showPreview && selected && handlers.preview ? handlers.preview(selected.name).slice(-bodyRows) : [];

    const lines: string[] = [];
    for (let r = 0; r < bodyRows; r++) {
      const cell = side[r] ?? { text: "" };
      const padded = clipLine(cell.text, sidebarWidth).padEnd(sidebarWidth);
      let line = cell.style ? cell.style + padded + RESET : padded;
      if (showPreview) {
        // Preview lines keep their own colors; RESET stops any unclosed
        // attribute from bleeding into the next row.
        line += DIM + "│ " + RESET + clipAnsi(previewLines[r] ?? "", previewWidth) + RESET;
      }
      lines.push(line);
    }

    const footer = creating
      ? `\x1b[33mcreating "${newName}"…\x1b[0m`
      : confirmRemove
        ? `\x1b[31mremove "${confirmRemove}"? ctrl-d again to confirm\x1b[0m`
        : feedback
          ? `\x1b[33m${clipLine(feedback, cols)}\x1b[0m`
          : `${DIM}${clipLine(handlers.help ?? HELP, cols)}${RESET}`;
    lines.push(footer);

    // No trailing newline: the footer sits on the last row and writing past
    // it would scroll the alternate screen.
    out("\x1b[H" + lines.map((l) => CLEAR_LINE + l).join("\r\n"));
  };

  process.stdin.setRawMode(true);
  process.stdin.resume();
  out("\x1b]0;am\x07"); // tab title; agent sessions set their own via tmux set-titles
  out(ALT_SCREEN_ON + HIDE_CURSOR);
  render();

  // Keep statuses, queue depths, and the preview live while the picker is open.
  const refresh = setInterval(() => {
    items = load();
    render();
  }, REFRESH_MS);
  const onResize = () => render();
  process.stdout.on("resize", onResize);

  const result = await new Promise<string | null>((resolve) => {
    let finished = false;
    const finish = (value: string | null) => {
      finished = true;
      clearInterval(refresh);
      process.stdout.off("resize", onResize);
      process.stdin.off("data", onData);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      out(ALT_SCREEN_OFF + SHOW_CURSOR);
      resolve(value);
    };

    const submitCreate = () => {
      if (creating || !handlers.create) return;
      creating = true;
      render();
      handlers.create(newName, newTask || undefined).then(
        (created) => {
          if (!handlers.select) return finish(created);
          creating = false;
          mode = "list";
          newName = "";
          newTask = "";
          feedback = handlers.select(created);
          items = load();
          render();
        },
        (error: Error) => {
          // Back to the name prompt with the input intact so it can be fixed.
          creating = false;
          mode = "new-name";
          feedback = error.message;
          items = load();
          render();
        },
      );
    };

    const runAction = (handler: (name: string) => string) => {
      const target = filtered()[cursor];
      if (!target) return;
      feedback = handler(target.name);
      items = load();
      if (items.length === 0 && !handlers.create) return finish(null);
    };

    const onData = (data: Buffer) => {
      for (const key of splitKeys(data.toString())) {
        if (finished) return;
        handleKey(key);
      }
    };

    const handleKey = (key: string) => {
      if (key === "\x03") return finish(null); // ctrl-c

      if (mode !== "list") {
        if (creating) return;
        if (key === "\x1b") {
          mode = "list";
          newName = "";
          newTask = "";
          feedback = null;
        } else if (key === "\r" || key === "\n") {
          if (mode === "new-name") {
            if (!/^[a-zA-Z0-9_-]+$/.test(newName)) {
              feedback = "name must be alphanumeric with dashes/underscores";
            } else {
              feedback = null;
              mode = "new-task";
            }
          } else {
            return submitCreate(); // renders itself
          }
        } else if (key === "\x7f" || key === "\b") {
          if (mode === "new-name") newName = newName.slice(0, -1);
          else newTask = newTask.slice(0, -1);
        } else if (key >= " " && !key.startsWith("\x1b")) {
          if (mode === "new-name") newName += key;
          else newTask += key;
        }
        return render();
      }

      const pendingConfirm = confirmRemove;
      confirmRemove = null;

      if (key === "\x1b") {
        // esc: in persistent mode hand off to quit (detach) and keep running.
        if (handlers.quit) handlers.quit();
        else return finish(null);
      } else if (key === "\r" || key === "\n") {
        const match = filtered()[cursor];
        if (match) {
          if (!handlers.select) return finish(match.name);
          feedback = handlers.select(match.name);
          items = load();
        }
      } else if (key === "\x0e" && handlers.create) {
        // ctrl-n
        mode = "new-name";
        newName = "";
        newTask = "";
        feedback = null;
      } else if (key === "\x18" && handlers.stop) {
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

    process.stdin.on("data", onData);
  });

  return result;
}
