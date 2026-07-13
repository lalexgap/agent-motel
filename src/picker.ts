import { completeDir, completeDirRemote } from "./dirComplete";
import { localAgentMatches, search } from "./search";

export interface PickerItem {
  name: string;
  label: string;
  // Leading status glyph, colored (iconStyle) independently of the label so
  // state reads at a glance. On the highlighted row the inverse bar owns the
  // colors, so the glyph there renders plain.
  icon?: string;
  iconStyle?: string;
  // Right-aligned text at the row's end (host, provider, queue depth), with an
  // optional color applied on non-highlighted rows.
  right?: string;
  rightStyle?: string;
  // Extra text the filter matches against (task, dir) besides the name.
  search?: string;
  // Already-formatted detail lines shown in the sidebar under the list for
  // the highlighted item.
  meta?: string[];
  // Group label ("local", a remote host): a dim header row is rendered at
  // each section change when the list spans more than one section.
  section?: string;
  // Hidden by default (exited agents); shown when toggled with `a` or when a
  // text filter is active — explicitly searching should find everything.
  secondary?: boolean;
}

export function visibleItems(items: PickerItem[], filter: string, showAll: boolean): PickerItem[] {
  return items
    .filter((i) => `${i.name} ${i.search ?? ""}`.toLowerCase().includes(filter.toLowerCase()))
    .filter((i) => showAll || filter !== "" || !i.secondary);
}

// Action results render as a colored banner under the header. A bare string
// is treated as a success; tag a severity to render it red (error), yellow
// (warn/confirm), or dim (info/in-progress) instead.
export type FeedbackLevel = "info" | "ok" | "warn" | "error";
export interface FeedbackResult {
  text: string;
  level: FeedbackLevel;
}
export type Feedback = string | FeedbackResult;

export function asFeedback(f: Feedback | null | undefined): FeedbackResult | null {
  if (f == null) return null;
  return typeof f === "string" ? { text: f, level: "ok" } : f;
}

export interface PickerHandlers {
  // Each returns a feedback message shown as a banner under the header.
  stop?: (name: string) => Feedback;
  remove?: (name: string) => Feedback;
  // Live pane content for the highlighted agent, shown in the right pane.
  preview?: (name: string) => string[];
  // Create a new agent; resolves to its key (name locally, host:name remote),
  // which the picker then jumps to (or selects, in persistent mode). host is
  // undefined for local, or a configured remote alias chosen in the flow.
  create?: (
    name: string,
    task: string | undefined,
    dir: string | undefined,
    host: string | undefined,
    provider: string | undefined,
    model: string | undefined,
    effort: string | undefined,
  ) => Promise<string>;
  // Configured remote hosts. When non-empty, the create flow adds a
  // "where" step (local vs a remote) after the dir prompt.
  remotes?: string[];
  // Prefill for the create flow's directory prompt, given the currently
  // highlighted agent (related work usually lives in the same project).
  defaultDir?: (highlighted: string | null) => string;
  // Persistent mode (am ui sidebar): enter calls select instead of resolving
  // the picker, esc calls quit, and the picker keeps running. Returns
  // optional banner feedback.
  select?: (name: string) => Feedback | null;
  quit?: () => void;
  // Fires when the cursor lands on a different item (persistent mode uses
  // this to make the agent pane follow the scroll). Debouncing is the
  // handler's job.
  highlight?: (name: string) => void;
  // Slow actions (ssh moves, provider handoffs): the resolved message lands
  // in the banner when done; rejections surface (as errors) there too.
  move?: (name: string) => Feedback | Promise<Feedback>;
  handoff?: (name: string) => Feedback | Promise<Feedback>;
  clone?: (name: string) => Feedback | Promise<Feedback>;
  // Toggle the list grouping (host ↔ directory); returns banner feedback.
  regroup?: () => Feedback;
  // Relocate an agent to a new directory (r key opens a prefilled prompt).
  cd?: (name: string, dir: string) => Feedback | Promise<Feedback>;
  cdPrefill?: (name: string) => string;
  // Split-view hub: report whether the sidebar pane currently has input focus,
  // with a short label for the indicator the picker draws at the top. Polled on
  // the refresh tick and after a lock-in. null = not a split view (no indicator).
  activity?: () => { active: boolean; text: string } | null;
  // Footer help text override (persistent mode has different key semantics).
  help?: string;
  // Provider preselected in the create form (config's defaultProvider). Falls
  // back to the first PROVIDER_OPTIONS entry when unset or unrecognized.
  defaultProvider?: string;
  // The create flow opens a full-screen form. The sidebar paints only its own
  // ~38-col pane, so the hub zooms that pane (tmux resize-pane -Z) while the
  // form is up and un-zooms when it closes. Called with true on open, false on
  // close (create success, cancel/esc, ctrl-c). `am pick` is already
  // fullscreen, so it leaves this unset (no-op).
  onForm?: (active: boolean) => void;
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
      // SGR mouse reports (ESC [ < b;x;y M/m) must stay whole tokens: split
      // apart, their trailing M/m would fire hotkeys and digits would type
      // into inputs — wheel-scrolling over the sidebar was triggering moves.
      const mouse = /^\x1b\[<[0-9;]+[Mm]/.exec(data.slice(i));
      if (mouse) {
        keys.push(mouse[0]);
        i += mouse[0].length;
        continue;
      }
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
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";

const FB_GLYPH: Record<FeedbackLevel, string> = { info: "", ok: "✓", warn: "⚠", error: "✕" };
const FB_COLOR: Record<FeedbackLevel, string> = { info: DIM, ok: GREEN, warn: YELLOW, error: RED };
// Errors carry detail (ssh stderr) worth more room than a routine toast.
const ERROR_FEEDBACK_LINES = 10;

const HELP = "↑/↓/j/k · enter jumps (ctrl-q returns) · f filter · g group · a all · n new · e edit… · q/esc quit";

const MAX_FEEDBACK_LINES = 6;

// Word-wrap feedback/error messages so they aren't clipped to one line in a
// narrow sidebar; respects embedded newlines, caps the height with an
// ellipsis line.
export function wrapText(text: string, width: number, maxLines: number): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split("\n")) {
    let line = "";
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      const candidate = line ? `${line} ${word}` : word;
      if (line && candidate.length > width) {
        lines.push(line);
        line = word;
      } else {
        line = candidate;
      }
    }
    lines.push(line);
  }
  // Hard-split any single word longer than the width.
  const split = lines.flatMap((l) => {
    const out: string[] = [];
    for (let i = 0; i < Math.max(1, Math.ceil(l.length / Math.max(1, width))); i++) {
      out.push(l.slice(i * width, (i + 1) * width));
    }
    return out;
  });
  if (split.length > maxLines) return [...split.slice(0, maxLines - 1), "…"];
  return split;
}

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

// The colored banner shown under the header for an action's result. Control
// bytes from ssh stderr are stripped, the severity glyph leads the first line,
// continuations are indented to align under the text. Errors get more lines.
export function feedbackBanner(fb: FeedbackResult, width: number): Cell[] {
  const glyph = FB_GLYPH[fb.level] ? `${FB_GLYPH[fb.level]} ` : "";
  const clean = fb.text.replace(/\t/g, " ").replace(/[\x00-\x08\x0b-\x1f]/g, "");
  const maxLines = fb.level === "error" ? ERROR_FEEDBACK_LINES : MAX_FEEDBACK_LINES;
  const wrapped = wrapText(clean, Math.max(1, width - glyph.length), maxLines);
  const indent = " ".repeat(glyph.length);
  return wrapped.map((line, i) => ({ text: (i === 0 ? glyph : indent) + line, style: FB_COLOR[fb.level] }));
}

type Mode = "list" | "filter" | "search" | "new-form" | "cd-dir" | "edit";

export function hasEditActions(handlers: PickerHandlers): boolean {
  return !!(handlers.move || handlers.clone || handlers.handoff || handlers.cd || handlers.stop || handlers.remove);
}

// The edit menu's footer line, built from whichever actions are wired.
export function editMenuHelp(handlers: PickerHandlers): string {
  const keys = [
    handlers.move && "m move",
    handlers.clone && "c clone",
    handlers.handoff && "h handoff",
    handlers.cd && "r cd",
    handlers.stop && "x stop",
    handlers.remove && "d remove",
  ].filter(Boolean);
  return [...keys, "esc back"].join(" · ");
}

// The create form's fields. "where" (local vs a configured remote) only
// appears when remotes exist, mirroring the old stepped flow. Provider/model/
// effort are always shown — they apply equally to local and remote spawns.
export function formFields(hasRemotes: boolean): string[] {
  // "where" (location) sits just before "dir" so you pick the host first — the
  // dir field then completes against that host on the first Tab.
  return hasRemotes
    ? ["name", "task", "where", "dir", "provider", "model", "effort"]
    : ["name", "task", "dir", "provider", "model", "effort"];
}

// Provider cycle (mirrors the Where field). The first entry is the default.
export const PROVIDER_OPTIONS = ["claude", "codex"];
// Effort cycle; "default" means omit the flag and let the provider decide.
export const EFFORT_OPTIONS = ["default", "low", "medium", "high"];

// Tab / Shift-Tab / ↑ / ↓ move the focus ring around the form, wrapping.
export function cycleField(idx: number, count: number, delta: number): number {
  if (count <= 0) return 0;
  return (((idx + delta) % count) + count) % count;
}

export async function pick(
  load: () => PickerItem[],
  handlers: PickerHandlers = {},
  initial?: string,
): Promise<string | null> {
  let items = load();
  if (items.length === 0 && !handlers.create) return null;
  if (!process.stdin.isTTY) throw new Error("interactive picker needs a TTY (use `am ls` / `am j <name>`)");

  let filter = "";
  // Chat search (`/`): a separate axis from the name/task substring `filter`.
  // chatMatch is the live result of running `am search` over local agents' full
  // conversations — name → matching snippet; null when not chat-searching.
  // chatOrder preserves the search ranking. The list derives from CURRENT items
  // each render (so status glyphs stay live), restricted to these names.
  let chatQuery = "";
  let chatMatch: Map<string, string> | null = null;
  let chatOrder: string[] = [];
  let cursor = Math.max(0, items.findIndex((i) => i.name === initial));
  // The list reloads every second and agents come and go, so the cursor
  // follows a NAME, not an index — otherwise a reload silently moves the
  // cursor (and in persistent mode, the agent pane) to a different agent.
  let cursorName: string | null = items[cursor]?.name ?? null;
  let feedback: FeedbackResult | null = null;
  let confirmRemove: string | null = null;
  let mode: Mode = "list";
  let newName = "";
  let newTask = "";
  let newDir = "";
  // Where to spawn: index into hostOptions ("local" + configured remotes).
  // The "where" step is only shown when at least one remote is configured.
  const hostOptions = ["local", ...(handlers.remotes ?? [])];
  let newHostIdx = 0;
  // Provider (Claude/Codex) and reasoning effort cycle like Where; model is
  // free text (blank = the provider's default model). The initial selection
  // follows config's defaultProvider so the form opens on the user's default.
  const defaultProviderIdx = Math.max(0, PROVIDER_OPTIONS.indexOf(handlers.defaultProvider ?? PROVIDER_OPTIONS[0]!));
  let newProviderIdx = defaultProviderIdx;
  let newModel = "";
  let newEffortIdx = 0;
  // Full-screen create form: which field has the focus ring, and the dir
  // autocomplete candidates to display (when the last Tab was ambiguous).
  const fields = formFields(hostOptions.length > 1);
  let formIdx = 0;
  let formCandidates: string[] = [];
  // Remote Dir completion runs over ssh: dirQuerying drives the "(querying …)"
  // line, and dirQueryGen is bumped on every dir edit / focus move / new query
  // so a slow round-trip that lands after the input changed is discarded.
  let dirQuerying = false;
  let dirQueryGen = 0;
  let cdDir = "";
  let cdTarget: string | null = null;
  let creating = false;
  let lastHighlighted: string | null = null;
  // Hub focus indicator: which pane is driving the keyboard. Refreshed on the
  // load tick and right after a lock-in (cheap tmux poll); null off the hub.
  let activity = handlers.activity?.() ?? null;
  const refreshActivity = () => {
    activity = handlers.activity?.() ?? null;
  };

  const out = (s: string) => process.stdout.write(s);

  // Zoom/un-zoom the sidebar pane around the full-screen form. Guarded: a
  // throwing handler must never take the picker process down.
  const setForm = (active: boolean) => {
    try {
      handlers.onForm?.(active);
    } catch {
      /* the form still works unzoomed; swallow */
    }
  };

  let showAll = false;
  const filtered = () => {
    if (chatMatch) {
      // Chat-search owns the list: show every agent whose conversation matched
      // (exited included), in search-rank order, with the snippet surfaced as
      // the first meta line for the highlighted row.
      const byName = new Map(items.map((i) => [i.name, i]));
      return chatOrder
        .map((name) => byName.get(name))
        .filter((i): i is PickerItem => !!i)
        .map((i) => ({ ...i, meta: [`match    ${chatMatch!.get(i.name) ?? ""}`, ...(i.meta ?? [])] }));
    }
    return visibleItems(items, filter, showAll);
  };

  // Run `am search` over local agents' chats for the current query. Synchronous
  // (ripgrep does the whole corpus in tens of ms) so it can run per keystroke
  // without an async dance. Local registered agents only — they're the rows the
  // picker can actually select; history/remote stay on the `am search` CLI.
  const runChatSearch = () => {
    const query = chatQuery.trim();
    if (!query) {
      chatMatch = null;
      chatOrder = [];
      return;
    }
    try {
      const { order, snippets } = localAgentMatches(search(query, { limit: 100 }));
      chatMatch = snippets;
      chatOrder = order;
    } catch {
      chatMatch = null;
      chatOrder = [];
    }
  };

  // The full-screen create form. Shows every field at once with a focus ring,
  // rendered across the whole (zoomed) pane rather than the list's narrow
  // column. Returns the screen as an array of rows.
  const renderForm = (cols: number, rows: number): string[] => {
    const labels: Record<string, string> = {
      name: "Name",
      task: "Task (optional)",
      dir: "Dir",
      provider: "Provider",
      model: "Model (optional)",
      effort: "Effort (optional)",
      where: "Where",
    };
    const labelW = 18;
    const margin = "  ";

    // The Where/Provider/Effort fields render as an arrow-cycled option strip,
    // highlighting the selection (inverse when focused, [bracketed] otherwise).
    const optionStrip = (options: string[], selected: number, focused: boolean): string =>
      options
        .map((o, oi) => (oi === selected ? (focused ? `${INVERSE} ${o} ${RESET}` : `[${o}]`) : ` ${o} `))
        .join(" ");

    const fieldRow = (field: string, i: number): string => {
      const focused = i === formIdx;
      const marker = focused ? `${GREEN}❯${RESET} ` : "  ";
      const label = focused ? labels[field]!.padEnd(labelW) : `${DIM}${labels[field]!.padEnd(labelW)}${RESET}`;
      let value: string;
      if (field === "name") value = newName + (focused ? "▌" : "");
      else if (field === "task") value = newTask + (focused ? "▌" : "");
      else if (field === "dir") value = newDir + (focused ? "▌" : "");
      else if (field === "model")
        value = newModel ? newModel + (focused ? "▌" : "") : (focused ? "▌" : "") + `${DIM}(default)${RESET}`;
      else if (field === "provider") value = optionStrip(PROVIDER_OPTIONS, newProviderIdx, focused);
      else if (field === "effort") value = optionStrip(EFFORT_OPTIONS, newEffortIdx, focused);
      else value = optionStrip(hostOptions, newHostIdx, focused);
      return marker + label + value;
    };

    const lines: string[] = [];
    lines.push("");
    lines.push(`${margin}${GREEN}Create agent${RESET}`);
    lines.push("");
    fields.forEach((f, i) => lines.push(margin + fieldRow(f, i)));
    lines.push("");

    const active: FeedbackResult | null = creating
      ? { text: `creating "${newName}"…`, level: "info" }
      : feedback;
    if (active) {
      for (const cell of feedbackBanner(active, Math.min(cols - 2, 100))) {
        lines.push(margin + (cell.style ?? "") + cell.text + RESET);
      }
      lines.push("");
    }

    // Dir autocomplete candidates, packed into columns across the wide pane.
    if (formCandidates.length) {
      lines.push(`${margin}${DIM}${formCandidates.length} matches:${RESET}`);
      const colW = Math.min(cols - 4, Math.max(...formCandidates.map((c) => c.length)) + 2);
      const perRow = Math.max(1, Math.floor((cols - margin.length) / colW));
      const shown = formCandidates.slice(0, perRow * 8); // cap the height
      for (let i = 0; i < shown.length; i += perRow) {
        lines.push(margin + shown.slice(i, i + perRow).map((c) => c.padEnd(colW)).join(""));
      }
      if (shown.length < formCandidates.length) lines.push(`${margin}${DIM}…${RESET}`);
    }

    // Remote Dir completion is mid-flight: tell the user which host we're asking.
    if (dirQuerying) {
      lines.push(`${margin}${DIM}querying ${hostOptions[newHostIdx]}…${RESET}`);
    }

    const footer = [
      "Tab next/complete dir",
      "⇧Tab back",
      "←/→ change",
      "Enter create",
      "Esc cancel",
    ]
      .filter(Boolean)
      .join(" · ");
    const footerLines = wrapTokens(footer, cols - 2).map((l) => `${DIM}${l}${RESET}`);

    // Pad the middle so the footer sits on the last rows.
    while (lines.length < Math.max(0, rows - footerLines.length)) lines.push("");
    lines.push(...footerLines);
    return lines.slice(0, rows).map((l) => clipAnsi(l, cols));
  };

  const render = () => {
    const cols = process.stdout.columns ?? 80;
    const rows = process.stdout.rows ?? 24;

    if (mode === "new-form") {
      out("\x1b[H" + renderForm(cols, rows).map((l) => CLEAR_LINE + l).join("\r\n"));
      return;
    }

    const showPreview = !!handlers.preview && cols >= 28 + MIN_PREVIEW_WIDTH + 2;
    const sidebarWidth = sidebarWidthFor(cols, showPreview);
    const previewWidth = cols - sidebarWidth - 2; // "│ " separator

    // The active message renders as a colored banner under the header (near
    // the cursor), not buried in the footer. The footer always shows help.
    const active: FeedbackResult | null = creating
      ? { text: `creating "${newName}"…`, level: "info" }
      : confirmRemove
        ? { text: `remove "${confirmRemove}"? d again to confirm`, level: "warn" }
        : feedback;
    const footerHelp =
      mode === "edit"
        ? `edit ${visibleItems(items, filter, showAll)[cursor]?.name ?? ""}: ${editMenuHelp(handlers)}`
        : (handlers.help ?? HELP);
    const footerLines = wrapTokens(footerHelp, sidebarWidth).map((l) => `${DIM}${clipLine(l, cols)}${RESET}`);
    const bodyRows = Math.max(1, rows - footerLines.length);
    const bannerBlock: Cell[] = active ? feedbackBanner(active, sidebarWidth) : [];

    const matches = filtered();
    const tracked = cursorName ? matches.findIndex((i) => i.name === cursorName) : -1;
    if (tracked >= 0) cursor = tracked;
    else if (cursor >= matches.length) cursor = Math.max(0, matches.length - 1);
    const selected = matches[cursor];
    cursorName = selected?.name ?? null;

    if (selected && handlers.highlight && selected.name !== lastHighlighted) {
      lastHighlighted = selected.name;
      handlers.highlight(selected.name);
      // Publish the highlighted agent as this pane's title so the hub's
      // set-titles-string (#{pane_title}) shows it while you browse the
      // sidebar. Keys are fleet keys (host:name); show the bare agent name to
      // match the agent pane's own title. Skip group headers (name ends ":").
      const bare = selected.name.split(":").pop() ?? "";
      if (bare) out(`\x1b]0;${bare}\x07`);
    }

    const header: Cell =
      mode === "cd-dir"
        ? { text: `cd to: ${cdDir}▌` }
        : mode === "search"
          ? { text: `search chats: ${chatQuery}▌` }
          : mode === "filter"
            ? { text: `filter: ${filter}▌` }
            : chatMatch
              ? { text: `search: ${chatQuery} (${matches.length}) · esc clears`, style: DIM }
              : filter
                ? { text: `filter: ${filter} · ⌫ clears` }
                : {
                    text: (() => {
                      const exited = items.filter((i) => i.secondary).length;
                      const hint = showAll ? " · all" : exited > 0 ? ` · ${exited} exited (a shows)` : "";
                      return `agents (${matches.length})${hint} · f filters · / search`;
                    })(),
                    style: DIM,
                  };

    // The meta block is sized to the largest meta across ALL items, not the
    // selected one — otherwise the list capacity (and every row below the
    // header) shifts as the cursor moves between agents with more or fewer
    // detail lines.
    // +1 while chat-searching: filtered() prepends a "match" snippet line to
    // each row's meta, one more than any raw item carries.
    const metaHeight = Math.max(0, ...items.map((i) => i.meta?.length ?? 0)) + (chatMatch ? 1 : 0);
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

    // Hub focus indicator (a top row): a calm dim line when the sidebar drives
    // the keyboard, a loud bar when input is going to the locked-in session.
    const indicator: Cell | null = activity
      ? activity.active
        ? { text: `● ${activity.text}`, style: DIM }
        : { text: `▶ ${activity.text}`, style: "\x1b[30;43m" } // black on yellow
      : null;

    // Window the list around the cursor so long agent lists stay navigable.
    // The indicator, banner and meta block consume rows just like the header.
    const listCapacity = Math.max(
      1,
      bodyRows - 1 - (indicator ? 1 : 0) - bannerBlock.length - metaBlock.length - headerRows,
    );
    let start = 0;
    if (matches.length > listCapacity) {
      start = Math.min(Math.max(0, cursor - Math.floor(listCapacity / 2)), matches.length - listCapacity);
    }

    const side: Cell[] = indicator ? [indicator, header, ...bannerBlock] : [header, ...bannerBlock];
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
      const icon = item.icon ?? "";
      const iconWidth = icon ? visibleWidth(icon) + 1 : 0; // glyph + space
      const labelWidth = Math.max(1, sidebarWidth - prefix.length - iconWidth - (right ? right.length + 1 : 0));
      const label = clipLine(item.label, labelWidth).padEnd(labelWidth);
      if (idx === cursor) {
        // The inverse bar highlights the whole row; keep it free of inner
        // color/RESETs (a RESET would cut the inverse off mid-line).
        const text = prefix + (icon ? icon + " " : "") + label + (right ? " " + right : "");
        side.push({ text, style: INVERSE });
      } else {
        const iconSeg = icon ? (item.iconStyle ?? "") + icon + RESET + " " : "";
        const rightSeg = right ? " " + (item.rightStyle ?? "") + right + RESET : "";
        side.push({ text: prefix + iconSeg + label + rightSeg });
      }
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
      // Cells may carry embedded SGR (colored status glyph): clip and pad by
      // VISIBLE width so escape codes don't throw off the column math.
      const clipped = visibleWidth(cell.text) > sidebarWidth ? clipAnsi(cell.text, sidebarWidth) : cell.text;
      const padded = clipped + " ".repeat(Math.max(0, sidebarWidth - visibleWidth(clipped)));
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
    refreshActivity();
    render();
  }, REFRESH_MS);
  const onResize = () => render();
  process.stdout.on("resize", onResize);

  const result = await new Promise<string | null>((resolve) => {
    let finished = false;
    const finish = (value: string | null) => {
      finished = true;
      if (mode === "new-form") setForm(false); // un-zoom if we exit mid-form
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
      const host = hostOptions[newHostIdx] === "local" ? undefined : hostOptions[newHostIdx];
      const provider = PROVIDER_OPTIONS[newProviderIdx];
      const effort = EFFORT_OPTIONS[newEffortIdx] === "default" ? undefined : EFFORT_OPTIONS[newEffortIdx];
      handlers.create(newName, newTask || undefined, newDir.trim() || undefined, host, provider, newModel.trim() || undefined, effort).then(
        (created) => {
          if (!handlers.select) return finish(created);
          creating = false;
          mode = "list";
          newName = "";
          newTask = "";
          newDir = "";
          newHostIdx = 0;
          newProviderIdx = defaultProviderIdx;
          newModel = "";
          newEffortIdx = 0;
          formIdx = 0;
          formCandidates = [];
          dirQuerying = false;
          dirQueryGen++;
          setForm(false); // un-zoom the sidebar pane
          feedback = asFeedback(handlers.select(created));
          items = load();
          render();
        },
        (error: Error) => {
          // Stay in the form with the input intact so it can be fixed; keep
          // the pane zoomed (the form is still up).
          creating = false;
          mode = "new-form";
          formIdx = Math.max(0, fields.indexOf("name"));
          feedback = { text: error.message, level: "error" };
          items = load();
          render();
        },
      );
    };

    const runAction = (handler: (name: string) => Feedback) => {
      const target = filtered()[cursor];
      if (!target) return;
      feedback = asFeedback(handler(target.name));
      items = load();
      if (items.length === 0 && !handlers.create) return finish(null);
    };

    // Slow actions (ssh move, handoff): show progress in the footer, resolve
    // into it when done — the picker stays interactive throughout.
    const runDeferred = (working: string, handler: (name: string) => Feedback | Promise<Feedback>) => {
      const target = filtered()[cursor];
      if (!target) return;
      feedback = { text: `${working} ${target.name}…`, level: "info" };
      Promise.resolve()
        .then(() => handler(target.name))
        .then(
          (message) => {
            feedback = asFeedback(message);
            items = load();
            if (!finished) render();
          },
          (error: Error) => {
            feedback = { text: error.message, level: "error" };
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
          feedback = { text: (error as Error).message, level: "error" };
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

      // Mouse: the wheel scrolls the list; every other mouse event is
      // swallowed so clicks/drags never alias into hotkeys.
      const mouse = /^\x1b\[<([0-9]+);/.exec(key);
      if (mouse) {
        const button = Number(mouse[1]);
        if (key.endsWith("M") && (button === 64 || button === 65)) {
          moveCursor(button === 64 ? -1 : 1);
          render();
        }
        return;
      }

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

      if (mode === "search") {
        // Esc clears the chat search entirely; Enter keeps the matched list up
        // (mode → list) so you can navigate and jump/resume a result. Editing
        // the query re-runs the search synchronously (ripgrep is fast).
        if (key === "\x1b") {
          chatQuery = "";
          runChatSearch();
          mode = "list";
        } else if (key === "\r" || key === "\n") {
          mode = "list";
        } else if (key === "\x1b[A") moveCursor(-1);
        else if (key === "\x1b[B") moveCursor(1);
        else {
          if (key === "\x7f" || key === "\b") chatQuery = chatQuery.slice(0, -1);
          else if (key >= " " && !key.startsWith("\x1b")) chatQuery += key;
          else return render();
          runChatSearch();
        }
        return render();
      }

      if (mode === "edit") {
        const target = filtered()[cursor];
        const pending = confirmRemove;
        confirmRemove = null;
        if (key === "\x1b" || key === "q" || !target) {
          mode = "list";
        } else if (key === "m" && handlers.move) {
          mode = "list";
          runDeferred("moving", handlers.move);
        } else if (key === "c" && handlers.clone) {
          mode = "list";
          runDeferred("cloning", handlers.clone);
        } else if (key === "h" && handlers.handoff) {
          mode = "list";
          runDeferred("handing off", handlers.handoff);
        } else if (key === "r" && handlers.cd) {
          mode = "cd-dir";
          cdTarget = target.name;
          cdDir = handlers.cdPrefill?.(target.name) ?? "";
        } else if (key === "x" && handlers.stop) {
          mode = "list";
          runAction(handlers.stop);
        } else if (key === "d" && handlers.remove) {
          // twice on the same item to confirm
          if (pending === target.name) {
            mode = "list";
            runAction(handlers.remove);
          } else {
            confirmRemove = target.name;
          }
        }
        return render();
      }

      // The full-screen create form: every field shown at once with a focus
      // ring. Tab/Shift-Tab (and ↑/↓) move between fields, Enter creates, Esc
      // cancels (un-zooming the pane). Tab on the Dir field autocompletes.
      if (mode === "new-form") {
        if (creating) return;
        const field = fields[formIdx]!;
        const moveField = (delta: number) => {
          formIdx = cycleField(formIdx, fields.length, delta);
          formCandidates = [];
          dirQueryGen++; // discard any in-flight remote completion
        };
        if (key === "\x1b") {
          mode = "list";
          newName = "";
          newTask = "";
          newDir = "";
          newHostIdx = 0;
          newProviderIdx = defaultProviderIdx;
          newModel = "";
          newEffortIdx = 0;
          formIdx = 0;
          formCandidates = [];
          dirQuerying = false;
          dirQueryGen++;
          feedback = null;
          setForm(false); // un-zoom the sidebar pane
        } else if (key === "\r" || key === "\n") {
          if (!/^[a-zA-Z0-9_-]+$/.test(newName)) {
            feedback = { text: "name must be alphanumeric with dashes/underscores", level: "error" };
            formIdx = Math.max(0, fields.indexOf("name"));
          } else {
            feedback = null;
            return submitCreate();
          }
        } else if (key === "\t") {
          // Tab on the Dir field completes; if it makes no progress (already
          // complete, no matches) it falls through to moving focus, so Tab-Tab
          // still advances. Local completion is synchronous; when Where points
          // at a remote, the dir lives on that host, so completion is one ssh
          // round-trip — fired here and applied when it resolves.
          const completeHost = hostOptions[newHostIdx] === "local" ? undefined : hostOptions[newHostIdx];
          const applyCompletion = (value: string, candidates: string[]) => {
            if (value !== newDir || candidates.length) {
              newDir = value;
              formCandidates = candidates;
            } else {
              moveField(1);
            }
          };
          if (field !== "dir") {
            moveField(1);
          } else if (!completeHost) {
            const { value, candidates } = completeDir(newDir);
            applyCompletion(value, candidates);
          } else if (!dirQuerying) {
            const gen = ++dirQueryGen;
            dirQuerying = true;
            formCandidates = [];
            feedback = null;
            completeDirRemote(completeHost, newDir, { timeoutMs: 4000 }).then(
              ({ value, candidates }) => {
                if (finished || gen !== dirQueryGen) return;
                dirQuerying = false;
                // Only apply if focus is still on the (unchanged) Dir field.
                if (mode === "new-form" && fields[formIdx] === "dir") applyCompletion(value, candidates);
                render();
              },
              (error: Error) => {
                if (finished || gen !== dirQueryGen) return;
                dirQuerying = false;
                feedback = { text: error.message, level: "warn" };
                render();
              },
            );
          }
        } else if (key === "\x1b[Z") {
          moveField(-1); // shift-tab
        } else if (key === "\x1b[B") {
          moveField(1); // ↓
        } else if (key === "\x1b[A") {
          moveField(-1); // ↑
        } else if (key === "\x1b[C" || key === "\x1b[D") {
          // ←/→ cycle the option-strip fields (provider, effort, where);
          // ignored on text fields.
          const dir = key === "\x1b[C" ? 1 : -1;
          if (field === "provider") newProviderIdx = cycleField(newProviderIdx, PROVIDER_OPTIONS.length, dir);
          else if (field === "effort") newEffortIdx = cycleField(newEffortIdx, EFFORT_OPTIONS.length, dir);
          else if (field === "where") newHostIdx = cycleField(newHostIdx, hostOptions.length, dir);
        } else if (key === "\x7f" || key === "\b") {
          if (field === "name") newName = newName.slice(0, -1);
          else if (field === "task") newTask = newTask.slice(0, -1);
          else if (field === "model") newModel = newModel.slice(0, -1);
          else if (field === "dir") {
            newDir = newDir.slice(0, -1);
            formCandidates = [];
            dirQueryGen++; // input changed: discard any in-flight completion
          }
        } else if (key >= " " && !key.startsWith("\x1b")) {
          if (field === "name") newName += key;
          else if (field === "task") newTask += key;
          else if (field === "model") newModel += key;
          else if (field === "dir") {
            newDir += key;
            formCandidates = [];
            dirQueryGen++; // input changed: discard any in-flight completion
          }
          // provider/effort/where take no text — they're arrow-navigated.
        }
        return render();
      }

      if (mode === "cd-dir") {
        if (key === "\x1b") {
          mode = "list";
          cdDir = "";
          cdTarget = null;
          feedback = null;
        } else if (key === "\r" || key === "\n") {
          const target = cdTarget;
          const dir = cdDir.trim();
          mode = "list";
          cdDir = "";
          cdTarget = null;
          if (target && handlers.cd) {
            feedback = { text: `moving ${target} to ${dir}…`, level: "info" };
            Promise.resolve()
              .then(() => handlers.cd!(target, dir))
              .then(
                (message) => {
                  feedback = asFeedback(message);
                  items = load();
                  if (!finished) render();
                },
                (error: Error) => {
                  feedback = { text: error.message, level: "error" };
                  if (!finished) render();
                },
              );
          }
        } else if (key === "\x7f" || key === "\b") {
          cdDir = cdDir.slice(0, -1);
        } else if (key >= " " && !key.startsWith("\x1b")) {
          cdDir += key;
        }
        return render();
      }

      const pendingConfirm = confirmRemove;
      confirmRemove = null;

      if (key === "\x1b" && chatMatch) {
        // A chat search is showing: esc clears it back to the full list rather
        // than quitting the picker.
        chatQuery = "";
        runChatSearch();
        feedback = null;
      } else if (key === "\x1b" || key === "q") {
        // esc/q: in persistent mode hand off to quit (detach) and keep running.
        if (handlers.quit) handlers.quit();
        else return finish(null);
      } else if (key === "\r" || key === "\n" || (key === "\x1b[C" && !!handlers.select)) {
        // Enter jumps (or locks into the agent pane in persistent mode,
        // where → does the same).
        const match = filtered()[cursor];
        if (match) {
          if (!handlers.select) return finish(match.name);
          feedback = asFeedback(handlers.select(match.name));
          items = load();
          // Focus just moved to the agent pane — reflect it without waiting a tick.
          refreshActivity();
        }
      } else if (key === "f") {
        mode = "filter";
        feedback = null;
      } else if (key === "/") {
        mode = "search";
        feedback = null;
      } else if ((key === "\x0e" || key === "n") && handlers.create) {
        mode = "new-form";
        newName = "";
        newTask = "";
        newDir = handlers.defaultDir?.(cursorName) ?? "";
        newHostIdx = 0;
        newProviderIdx = defaultProviderIdx;
        newModel = "";
        newEffortIdx = 0;
        formIdx = 0;
        formCandidates = [];
        dirQuerying = false;
        dirQueryGen++;
        feedback = null;
        setForm(true); // zoom the sidebar pane to full screen
      } else if (key === "a") {
        showAll = !showAll;
        feedback = null;
      } else if (key === "g" && handlers.regroup) {
        feedback = asFeedback(handlers.regroup());
        items = load();
      } else if (key === "e" && hasEditActions(handlers)) {
        // Agent-mutating actions live one level down: e opens the edit menu
        // for the highlighted agent, keeping the top level to view keys.
        if (filtered()[cursor]) {
          mode = "edit";
          feedback = null;
        }
      } else if (key === "\x1b[A" || key === "k") moveCursor(-1);
      else if (key === "\x1b[B" || key === "j") moveCursor(1);
      // PageUp/PageDown: over the hub the sidebar doesn't run mouse mode, so
      // the outer tmux forwards each wheel notch into this pane as a bare
      // PageUp/Down. Move one row per notch — same as the SGR-mouse path
      // above — so wheel-scrolling the sidebar tracks like a list scroll.
      else if (key === "\x1b[5~") moveCursor(-1);
      else if (key === "\x1b[6~") moveCursor(1);
      else if (key === "\x7f" || key === "\b") {
        if (chatMatch) {
          chatQuery = "";
          runChatSearch();
        } else filter = "";
      }
      render();
    };

    process.stdin.on("data", onData);
  });

  return result;
}
