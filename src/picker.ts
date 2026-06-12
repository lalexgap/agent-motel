export interface PickerItem {
  name: string;
  label: string;
  // Right-aligned text at the row's end (status, queue depth).
  right?: string;
  // Extra text the filter matches against (task, dir) besides the name.
  search?: string;
  // Already-formatted detail lines shown in the sidebar under the list for
  // the highlighted item.
  meta?: string[];
  // Group label ("local", a remote host): a dim header row is rendered at
  // each section change when the list spans more than one section.
  section?: string;
}

export interface PickerHandlers {
  // Each returns a feedback message shown in the picker footer.
  stop?: (name: string) => string;
  remove?: (name: string) => string;
  // Live pane content for the highlighted agent, shown in the right pane.
  preview?: (name: string) => string[];
  // Create a new agent; resolves to its name, which the picker then jumps to
  // (or selects, in persistent mode).
  create?: (name: string, task: string | undefined, dir: string | undefined) => Promise<string>;
  // Prefill for the create flow's directory prompt, given the currently
  // highlighted agent (related work usually lives in the same project).
  defaultDir?: (highlighted: string | null) => string;
  // Persistent mode (am ui sidebar): enter calls select instead of resolving
  // the picker, esc calls quit, and the picker keeps running. Returns
  // optional footer feedback.
  select?: (name: string) => string | null;
  quit?: () => void;
  // Fires when the cursor lands on a different item (persistent mode uses
  // this to make the agent pane follow the scroll). Debouncing is the
  // handler's job.
  highlight?: (name: string) => void;
  // Slow actions (ssh moves, provider handoffs): the resolved string lands
  // in the footer when done; rejections surface their message there too.
  move?: (name: string) => string | Promise<string>;
  handoff?: (name: string) => string | Promise<string>;
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
      const csi = /^\x1b\[[0-9;]*[A-Za-z~]/.exec(data.slice(i));
      if (csi) {
        keys.push(csi[0]);
        i += csi[0].length;
        continue;
      }
      // SS3 cursor keys (application mode: ESC O A..D) → CSI form, so the
      // rest of the picker only ever sees one arrow encoding.
      const ss3 = /^\x1bO([A-D])/.exec(data.slice(i));
      if (ss3) {
        keys.push(`\x1b[${ss3[1]}`);
        i += 3;
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
// Autowrap off while the picker owns the screen: a line that overruns the
// width (e.g. a glyph the terminal draws 2 cells wide) must clip, not wrap —
// a wrap scrolls the screen and the whole layout jumps.
const WRAP_OFF = "\x1b[?7l";
const WRAP_ON = "\x1b[?7h";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";
const INVERSE = "\x1b[7m";

const HELP = "f filter · ↑/↓/j/k · enter jumps (ctrl-q returns) · n new · m move · h handoff · x stop · d remove · q/esc quit";

// Pack " · "-separated help tokens into lines that fit the width, so narrow
// panes (the am ui sidebar) show all the keys instead of a clipped line.
export function wrapTokens(text: string, width: number): string[] {
  const lines: string[] = [];
  let line = "";
  for (const token of text.split(" · ")) {
    const candidate = line ? `${line} · ${token}` : token;
    if (line && candidate.length > width) {
      lines.push(line);
      line = token;
    } else {
      line = candidate;
    }
  }
  if (line) lines.push(line);
  return lines;
}

// A sidebar cell: plain text plus an optional style applied after clipping
// and padding, so the width math never has to account for escape codes.
interface Cell {
  text: string;
  style?: string;
}

type Mode = "list" | "filter" | "new-name" | "new-task" | "new-dir";

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
  // The list reloads every second and agents come and go, so the cursor
  // follows a NAME, not an index — otherwise a reload silently moves the
  // cursor (and in persistent mode, the agent pane) to a different agent.
  let cursorName: string | null = items[cursor]?.name ?? null;
  let feedback: string | null = null;
  let confirmRemove: string | null = null;
  let mode: Mode = "list";
  let newName = "";
  let newTask = "";
  let newDir = "";
  let creating = false;
  let lastHighlighted: string | null = null;

  const out = (s: string) => process.stdout.write(s);

  const filtered = () =>
    items.filter((i) => `${i.name} ${i.search ?? ""}`.toLowerCase().includes(filter.toLowerCase()));

  const render = () => {
    const cols = process.stdout.columns ?? 80;
    const rows = process.stdout.rows ?? 24;
    const showPreview = !!handlers.preview && cols >= 28 + MIN_PREVIEW_WIDTH + 2;
    const sidebarWidth = sidebarWidthFor(cols, showPreview);
    const previewWidth = cols - sidebarWidth - 2; // "│ " separator

    const footerLines = creating
      ? [`\x1b[33mcreating "${newName}"…\x1b[0m`]
      : confirmRemove
        ? [`\x1b[31mremove "${confirmRemove}"? d again to confirm\x1b[0m`]
        : feedback
          ? [`\x1b[33m${clipLine(feedback, cols)}\x1b[0m`]
          : wrapTokens(handlers.help ?? HELP, sidebarWidth).map((l) => `${DIM}${clipLine(l, cols)}${RESET}`);
    const bodyRows = Math.max(1, rows - footerLines.length);

    const matches = filtered();
    const tracked = cursorName ? matches.findIndex((i) => i.name === cursorName) : -1;
    if (tracked >= 0) cursor = tracked;
    else if (cursor >= matches.length) cursor = Math.max(0, matches.length - 1);
    const selected = matches[cursor];
    cursorName = selected?.name ?? null;

    if (selected && handlers.highlight && selected.name !== lastHighlighted) {
      lastHighlighted = selected.name;
      handlers.highlight(selected.name);
    }

    const header: Cell =
      mode === "new-name"
        ? { text: `new agent name: ${newName}▌` }
        : mode === "new-task"
          ? { text: `task (optional): ${newTask}▌` }
          : mode === "new-dir"
            ? { text: `dir: ${newDir}▌` }
            : mode === "filter"
            ? { text: `filter: ${filter}▌` }
            : filter
              ? { text: `filter: ${filter} · ⌫ clears` }
              : { text: `agents (${matches.length}) · f filters`, style: DIM };

    // The meta block is sized to the largest meta across ALL items, not the
    // selected one — otherwise the list capacity (and every row below the
    // header) shifts as the cursor moves between agents with more or fewer
    // detail lines.
    const metaHeight = Math.max(0, ...items.map((i) => i.meta?.length ?? 0));
    const metaBlock: Cell[] = metaHeight
      ? [
          { text: "" },
          ...Array.from({ length: metaHeight }, (_, i): Cell => ({
            text: selected?.meta?.[i] ?? "",
            style: DIM,
          })),
        ]
      : [];

    // Section headers are rendered only when the matches span more than one
    // section (a lone "local" header is noise); they consume list rows, so
    // capacity shrinks by the section count.
    const sections = [...new Set(matches.map((i) => i.section ?? ""))];
    const showSections = sections.length > 1;
    const headerRows = showSections ? sections.length : 0;

    // Window the list around the cursor so long agent lists stay navigable.
    const listCapacity = Math.max(1, bodyRows - 1 - metaBlock.length - headerRows);
    let start = 0;
    if (matches.length > listCapacity) {
      start = Math.min(Math.max(0, cursor - Math.floor(listCapacity / 2)), matches.length - listCapacity);
    }

    const side: Cell[] = [header];
    let lastSection: string | null = null;
    matches.slice(start, start + listCapacity).forEach((item, i) => {
      const idx = start + i;
      if (showSections && (item.section ?? "") !== lastSection) {
        lastSection = item.section ?? "";
        const title = ` ${lastSection || "local"} `;
        const dashes = "─".repeat(Math.max(0, sidebarWidth - title.length - 1));
        side.push({ text: `─${title}${dashes}`, style: DIM });
      }
      const prefix = idx === cursor ? "❯ " : "  ";
      const right = item.right ?? "";
      const labelWidth = Math.max(1, sidebarWidth - prefix.length - (right ? right.length + 1 : 0));
      const text = prefix + clipLine(item.label, labelWidth).padEnd(labelWidth) + (right ? " " + right : "");
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

    lines.push(...footerLines);

    // No trailing newline: the footer sits on the last row and writing past
    // it would scroll the alternate screen.
    out("\x1b[H" + lines.map((l) => CLEAR_LINE + l).join("\r\n"));
  };

  process.stdin.setRawMode(true);
  process.stdin.resume();
  out("\x1b]0;am\x07"); // tab title; agent sessions set their own via tmux set-titles
  out(ALT_SCREEN_ON + HIDE_CURSOR + WRAP_OFF);
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
      out(WRAP_ON + ALT_SCREEN_OFF + SHOW_CURSOR);
      resolve(value);
    };

    const submitCreate = () => {
      if (creating || !handlers.create) return;
      creating = true;
      render();
      handlers.create(newName, newTask || undefined, newDir.trim() || undefined).then(
        (created) => {
          if (!handlers.select) return finish(created);
          creating = false;
          mode = "list";
          newName = "";
          newTask = "";
          newDir = "";
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

    // Slow actions (ssh move, handoff): show progress in the footer, resolve
    // into it when done — the picker stays interactive throughout.
    const runDeferred = (working: string, handler: (name: string) => string | Promise<string>) => {
      const target = filtered()[cursor];
      if (!target) return;
      feedback = `${working} ${target.name}…`;
      Promise.resolve()
        .then(() => handler(target.name))
        .then(
          (message) => {
            feedback = message;
            items = load();
            if (!finished) render();
          },
          (error: Error) => {
            feedback = error.message;
            if (!finished) render();
          },
        );
    };

    const onData = (data: Buffer) => {
      for (const key of splitKeys(data.toString())) {
        if (finished) return;
        // A throwing handler must not crash the picker process — in
        // persistent mode that would take the whole sidebar pane down.
        try {
          handleKey(key);
        } catch (error) {
          feedback = (error as Error).message;
          render();
        }
      }
    };

    const moveCursor = (delta: number) => {
      const matches = filtered();
      cursor = Math.min(Math.max(0, cursor + delta), Math.max(0, matches.length - 1));
      cursorName = matches[cursor]?.name ?? null;
    };

    const handleKey = (key: string) => {
      if (key === "\x03") return finish(null); // ctrl-c

      if (mode === "filter") {
        if (key === "\x1b") {
          filter = "";
          mode = "list";
        } else if (key === "\r" || key === "\n") mode = "list";
        else if (key === "\x1b[A") moveCursor(-1);
        else if (key === "\x1b[B") moveCursor(1);
        else if (key === "\x7f" || key === "\b") filter = filter.slice(0, -1);
        else if (key >= " " && !key.startsWith("\x1b")) filter += key;
        return render();
      }

      if (mode !== "list") {
        if (creating) return;
        if (key === "\x1b") {
          mode = "list";
          newName = "";
          newTask = "";
          newDir = "";
          feedback = null;
        } else if (key === "\r" || key === "\n") {
          if (mode === "new-name") {
            if (!/^[a-zA-Z0-9_-]+$/.test(newName)) {
              feedback = "name must be alphanumeric with dashes/underscores";
            } else {
              feedback = null;
              mode = "new-task";
            }
          } else if (mode === "new-task") {
            mode = "new-dir";
            newDir = handlers.defaultDir?.(cursorName) ?? "";
          } else {
            return submitCreate(); // renders itself
          }
        } else if (key === "\x7f" || key === "\b") {
          if (mode === "new-name") newName = newName.slice(0, -1);
          else if (mode === "new-task") newTask = newTask.slice(0, -1);
          else newDir = newDir.slice(0, -1);
        } else if (key >= " " && !key.startsWith("\x1b")) {
          if (mode === "new-name") newName += key;
          else if (mode === "new-task") newTask += key;
          else newDir += key;
        }
        return render();
      }

      const pendingConfirm = confirmRemove;
      confirmRemove = null;

      if (key === "\x1b" || key === "q") {
        // esc/q: in persistent mode hand off to quit (detach) and keep running.
        if (handlers.quit) handlers.quit();
        else return finish(null);
      } else if (key === "\r" || key === "\n" || (key === "\x1b[C" && !!handlers.select)) {
        // Enter jumps (or locks into the agent pane in persistent mode,
        // where → does the same).
        const match = filtered()[cursor];
        if (match) {
          if (!handlers.select) return finish(match.name);
          feedback = handlers.select(match.name);
          items = load();
        }
      } else if (key === "f" || key === "/") {
        mode = "filter";
        feedback = null;
      } else if ((key === "\x0e" || key === "n") && handlers.create) {
        mode = "new-name";
        newName = "";
        newTask = "";
        feedback = null;
      } else if ((key === "\x18" || key === "x") && handlers.stop) {
        runAction(handlers.stop);
      } else if (key === "m" && handlers.move) {
        runDeferred("moving", handlers.move);
      } else if (key === "h" && handlers.handoff) {
        runDeferred("handing off", handlers.handoff);
      } else if ((key === "\x04" || key === "d") && handlers.remove) {
        // twice on the same item to confirm
        const target = filtered()[cursor];
        if (target && pendingConfirm === target.name) runAction(handlers.remove);
        else if (target) confirmRemove = target.name;
      } else if (key === "\x1b[A" || key === "k") moveCursor(-1);
      else if (key === "\x1b[B" || key === "j") moveCursor(1);
      else if (key === "\x7f" || key === "\b") filter = "";
      render();
    };

    process.stdin.on("data", onData);
  });

  return result;
}
