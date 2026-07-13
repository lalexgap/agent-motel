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
  // Display status powers the header rollup and the selected item's detail
  // card. It stays a string so the picker remains independent of AgentState.
  status?: string;
  statusLabel?: string;
  // Row styling is split into the activity column and compact provider chip.
  labelStyle?: string;
  badge?: string;
  badgeStyle?: string;
  // Tag color when the row is selected (the design brightens cdx to blue on
  // the selection fill); falls back to badgeStyle.
  badgeSelectedStyle?: string;
  queueDepth?: number;
  // Right-aligned activity text, with an optional color on unselected rows.
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
  // Used only for the create card's consequence preview.
  worktreeByDefault?: boolean;
  // The create flow opens a full-screen form. The sidebar paints only its own
  // ~44-col pane, so the hub zooms that pane (tmux resize-pane -Z) while the
  // form is up and un-zooms when it closes. Called with true on open, false on
  // close (create success, cancel/esc, ctrl-c). `am pick` is already
  // fullscreen, so it leaves this unset (no-op).
  onForm?: (active: boolean) => void;
  // Split-view hub: receive the contextual key bar as a tmux status-format
  // string. When set, the picker stops painting its in-pane footer and the
  // hub shows the bar on its status line, spanning the full window width.
  setKeyBar?: (format: string) => void;
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

export interface MouseEvent {
  button: number;
  x: number;
  y: number;
  pressed: boolean;
}

// SGR mouse reports use one-based screen coordinates. Keeping the parser
// separate from input dispatch makes malformed/partial reports harmless and
// keeps the hit-testing code readable.
export function parseMouseEvent(key: string): MouseEvent | null {
  const match = /^\x1b\[<([0-9]+);([0-9]+);([0-9]+)([Mm])$/.exec(key);
  if (!match) return null;
  return {
    button: Number(match[1]),
    x: Number(match[2]),
    y: Number(match[3]),
    pressed: match[4] === "M",
  };
}

// clipLine for lines carrying SGR color codes (tmux capture-pane -e):
// escapes are zero-width and never split mid-sequence.
export function clipAnsi(line: string, width: number): string {
  if (visibleWidth(line) <= width) return line;
  let out = "";
  let tail = "";
  let visible = 0;
  for (let i = 0; i < line.length; ) {
    const match = /^\x1b\[[0-9;]*m/.exec(line.slice(i));
    if (match) {
      // Styles past the clip point still apply to whatever renders after the
      // clipped text — dropping them leaks an open color (e.g. the form's
      // cursor block background) into the padding of the rest of the row.
      if (visible >= Math.max(0, width - 1)) tail += match[0];
      else out += match[0];
      i += match[0].length;
      continue;
    }
    if (visible >= Math.max(0, width - 1)) {
      i++;
      continue;
    }
    out += line[i];
    visible++;
    i++;
  }
  return out + "…" + tail;
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
// Basic button tracking plus SGR coordinates. SGR avoids the old protocol's
// coordinate limit and is what tmux's `send-keys -M` forwards to the picker.
const MOUSE_ON = "\x1b[?1000h\x1b[?1006h";
const MOUSE_OFF = "\x1b[?1006l\x1b[?1000l";
const CLEAR_LINE = "\x1b[2K";
// Autowrap off while the picker owns the screen: a line that overruns the
// width (e.g. a glyph the terminal draws 2 cells wide) must clip, not wrap —
// a wrap scrolls the screen and the whole layout jumps.
const WRAP_OFF = "\x1b[?7l";
const WRAP_ON = "\x1b[?7h";
const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const NORMAL_WEIGHT = "\x1b[22m";
const fg = (hex: string) => {
  const [r, g, b] = hex.match(/[0-9a-f]{2}/gi)!.map((v) => parseInt(v, 16));
  return `\x1b[38;2;${r};${g};${b}m`;
};
const bg = (hex: string) => {
  const [r, g, b] = hex.match(/[0-9a-f]{2}/gi)!.map((v) => parseInt(v, 16));
  return `\x1b[48;2;${r};${g};${b}m`;
};

// Tokyo Night surfaces, one constant per design role: #1a1b26 main pane,
// #16161e darkest chrome (sidebar / key bar / form dialog), #1f2335 the
// borderless details panel, #283457 selection fills, #2e2a1e the amber tint
// under needs-attention rows. Rules and frames are all #3b4261.
export const THEME = {
  app: bg("1a1b26") + fg("a9b1d6"),
  sidebar: bg("16161e") + fg("a9b1d6"),
  card: bg("1f2335") + fg("a9b1d6"),
  form: bg("16161e") + fg("a9b1d6"),
  selected: bg("283457") + fg("c0caf5"),
  attention: bg("2e2a1e"),
  keycap: bg("24283b") + fg("c0caf5"),
  text: fg("a9b1d6"),
  bright: fg("c0caf5"),
  muted: fg("565f89"),
  faint: fg("414868"),
  border: fg("3b4261"),
  blue: fg("7aa2f7"),
  cyan: fg("7dcfff"),
  green: fg("9ece6a"),
  yellow: fg("e0af68"),
  red: fg("f7768e"),
  purple: fg("bb9af7"),
  orange: fg("ff9e64"),
} as const;

const DIM = THEME.muted;
const GREEN = THEME.green;
const YELLOW = THEME.yellow;
const RED = THEME.red;

const FB_GLYPH: Record<FeedbackLevel, string> = { info: "", ok: "✓", warn: "⚠", error: "✕" };
const FB_COLOR: Record<FeedbackLevel, string> = { info: DIM, ok: GREEN, warn: YELLOW, error: RED };
// Errors carry detail (ssh stderr) worth more room than a routine toast.
const ERROR_FEEDBACK_LINES = 10;

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

function padAnsi(text: string, width: number): string {
  const clipped = visibleWidth(text) > width ? clipAnsi(text, width) : text;
  return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
}

function alignAnsi(left: string, right: string, width: number): string {
  const gap = width - visibleWidth(left) - visibleWidth(right);
  if (gap >= 1) return left + " ".repeat(gap) + right;
  const rightWidth = Math.min(width, visibleWidth(right));
  if (rightWidth >= width) return padAnsi(right, width);
  return padAnsi(left, width - rightWidth - 1) + " " + padAnsi(right, rightWidth);
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

type Mode = "list" | "filter" | "search" | "new-form" | "cd-dir" | "edit" | "help";

interface KeyHint {
  key: string;
  label: string;
}

function keyBarHints(mode: Mode, handlers: PickerHandlers, active: boolean): { label: string; hints: KeyHint[] } {
  let label = mode === "new-form" ? "CREATE" : mode.toUpperCase().replace("-DIR", "");
  let hints: KeyHint[];
  if (!active) {
    label = "AGENT";
    hints = [{ key: "ctrl-q", label: "sidebar" }];
  } else if (mode === "new-form") {
    hints = [
      { key: "↑↓", label: "field" },
      { key: "←→", label: "option" },
      { key: "tab", label: "complete" },
      { key: "⏎", label: "create" },
      { key: "esc", label: "cancel" },
    ];
  } else if (mode === "edit") {
    hints = [
      ...(handlers.move ? [{ key: "m", label: "move" }] : []),
      ...(handlers.clone ? [{ key: "c", label: "clone" }] : []),
      ...(handlers.handoff ? [{ key: "h", label: "handoff" }] : []),
      ...(handlers.cd ? [{ key: "r", label: "cd" }] : []),
      ...(handlers.stop ? [{ key: "x", label: "stop" }] : []),
      ...(handlers.remove ? [{ key: "d", label: "remove" }] : []),
      { key: "esc", label: "back" },
    ];
  } else if (mode === "filter" || mode === "search" || mode === "cd-dir") {
    hints = [
      { key: "⏎", label: mode === "cd-dir" ? "move" : "apply" },
      ...(mode === "cd-dir" ? [] : [{ key: "↑↓", label: "preview" }]),
      { key: "esc", label: "cancel" },
    ];
  } else if (mode === "help") {
    hints = [{ key: "? / esc", label: "close" }];
  } else {
    hints = [
      { key: "↑↓", label: "preview" },
      { key: "⏎", label: handlers.select ? "lock in" : "jump" },
      ...(handlers.create ? [{ key: "n", label: "new" }] : []),
      { key: "f", label: "filter" },
      ...(handlers.regroup ? [{ key: "g", label: "group" }] : []),
      ...(hasEditActions(handlers) ? [{ key: "e", label: "edit" }] : []),
      { key: "?", label: "keys" },
    ];
    label = "SIDEBAR";
  }
  return { label, hints };
}

function keyBar(mode: Mode, handlers: PickerHandlers, width: number, active = true): Cell[] {
  const { label, hints } = keyBarHints(mode, handlers, active);
  const prefix = `${bg("7aa2f7")}${fg("16161e")}${BOLD} ${label} ${NORMAL_WEIGHT}${THEME.sidebar}`;
  const tokens = hints.map(({ key, label: hintLabel }) =>
    `${THEME.keycap} ${key} ${THEME.sidebar} ${THEME.muted}${hintLabel}${THEME.sidebar}`,
  );
  const lines: string[] = [];
  let line = prefix;
  for (const token of tokens) {
    const candidate = `${line}  ${token}`;
    if (visibleWidth(line) > 0 && visibleWidth(candidate) > width) {
      lines.push(line);
      line = token;
    } else {
      line = candidate;
    }
  }
  if (line) lines.push(line);
  return lines.map((text) => ({ text, style: THEME.sidebar }));
}

// The key bar as a tmux status-format string, for the hub: painting it on the
// hub's status line makes it span the full window (sidebar + agent pane) like
// the design, instead of stopping at the sidebar's right edge. The trailing
// "?" hint right-aligns, matching the mockup.
export function tmuxKeyBar(mode: Mode, handlers: PickerHandlers, active = true): string {
  const { label, hints } = keyBarHints(mode, handlers, active);
  const token = ({ key, label: hintLabel }: KeyHint) =>
    `#[bg=#24283b,fg=#c0caf5] ${key} #[bg=#16161e,fg=#565f89] ${hintLabel}`;
  const right = hints.length && hints[hints.length - 1]!.key === "?" ? hints.pop()! : null;
  const left = [`#[bg=#7aa2f7,fg=#16161e,bold] ${label} #[nobold]#[bg=#16161e]`, ...hints.map(token)].join("  ");
  return right ? `${left}#[align=right]${token(right)} ` : left;
}

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
  // Rebuilt on every paint. Values are indexes into the current filtered
  // result set, so section headers and variable-height banners remain safe.
  const listHitRows = new Map<number, number>();
  const formHitRows = new Map<number, number>();
  let renderedSidebarWidth = 0;
  const refreshActivity = () => {
    activity = handlers.activity?.() ?? null;
  };

  // Hub key bar on the tmux status line: pushed from render so it always
  // matches the visible mode, deduped because render runs every second.
  let lastKeyBar = "";
  const pushKeyBar = (barMode: Mode, active: boolean) => {
    if (!handlers.setKeyBar) return;
    const format = tmuxKeyBar(barMode, handlers, active);
    if (format === lastKeyBar) return;
    lastKeyBar = format;
    try {
      handlers.setKeyBar(format);
    } catch {
      /* a broken status line must not take the picker down */
    }
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

  // The zoomed create flow is a centered, borderless TUI dialog: a #16161e
  // block with full-width rules under the title and above the consequence
  // footer. The focused row gets a full-row selection fill plus the ▌ glyph,
  // and option chips are reverse-video cells.
  const renderForm = (cols: number, rows: number): string[] => {
    formHitRows.clear();
    const labels: Record<string, string> = {
      name: "name",
      task: "task",
      dir: "dir",
      provider: "provider",
      model: "model",
      effort: "effort",
      where: "where",
    };
    const cardWidth = Math.max(1, Math.min(76, cols - 4));
    // Rows: 1-cell marker column, 11-cell label, value, 2-cell right pad.
    const labelW = 11;
    const innerWidth = Math.max(1, cardWidth - 3);
    interface FormLine { text: string; field?: number }
    const card: FormLine[] = [];
    const content = (value: string, base = THEME.form): string => `${base}${padAnsi(value, cardWidth)}`;
    const rule = () => card.push({ text: `${THEME.form}${THEME.border}${"─".repeat(cardWidth)}` });
    const optionStrip = (options: string[], selected: number, rowBase: string, kind: string): string =>
      options
        .map((o, oi) => {
          if (oi !== selected) return `${THEME.muted}${o}${rowBase}`;
          // Reverse-video cells: the provider chip is a solid identity-color
          // block (claude purple, codex blue); where/effort use the selection
          // fill, flipping to the cursor blue when their own row is focused
          // (the selection fill would vanish against the focused row's bg).
          const selectedStyle = kind === "provider"
            ? `${o === "claude" ? bg("bb9af7") : bg("7aa2f7")}${fg("16161e")}${BOLD}`
            : rowBase === THEME.selected
              ? bg("7aa2f7") + fg("16161e")
              : bg("283457") + THEME.bright;
          return `${selectedStyle} ${o} ${NORMAL_WEIGHT}${rowBase}`;
        })
        .join("  ");

    const fieldRow = (field: string, i: number): FormLine => {
      const focused = i === formIdx;
      const rowBase = focused ? THEME.selected : THEME.form;
      const marker = focused ? `${THEME.blue}▌${rowBase}` : " ";
      const label = `${focused ? THEME.blue : THEME.muted}${labels[field]!.padEnd(labelW)}${rowBase}`;
      const cursor = focused ? `${bg("7aa2f7")}${fg("16161e")} ${rowBase}` : "";
      let value: string;
      let hint = "";
      if (field === "name") {
        value = newName + cursor;
        hint = `${THEME.faint}branch am/${newName || "…"}${rowBase}`;
      } else if (field === "task") {
        value = newTask
          ? newTask + cursor
          : `${THEME.faint}describe the task… (optional)${rowBase}${cursor}`;
      } else if (field === "dir") {
        value = newDir + cursor;
        hint = `${THEME.faint}tab complete${rowBase}`;
      } else if (field === "model") {
        value = newModel ? newModel + cursor : `${THEME.muted}default${rowBase}${cursor}`;
      } else if (field === "provider") {
        value = optionStrip(PROVIDER_OPTIONS, newProviderIdx, rowBase, field);
      } else if (field === "effort") {
        value = optionStrip(EFFORT_OPTIONS, newEffortIdx, rowBase, field);
      } else {
        value = optionStrip(hostOptions, newHostIdx, rowBase, field);
      }
      const left = marker + label + value;
      const body = hint ? alignAnsi(left, hint + " ".repeat(2), cardWidth) : left;
      return { text: content(body, rowBase), field: i };
    };

    card.push({ text: content("") });
    card.push({
      text: content(alignAnsi(
        `  ${THEME.green}${BOLD}Create agent${NORMAL_WEIGHT}${THEME.form}`,
        `${THEME.faint}esc cancel  ${THEME.form}`,
        cardWidth,
      )),
    });
    rule();
    fields.forEach((field, i) => {
      card.push(fieldRow(field, i));
      if (field === "dir" && formCandidates.length) {
        for (const candidate of formCandidates.slice(0, 3)) {
          card.push({
            text: content(` ${" ".repeat(labelW)}${THEME.cyan}${candidate}${THEME.form}`),
          });
        }
        if (formCandidates.length > 3) {
          card.push({ text: content(` ${" ".repeat(labelW)}${THEME.muted}… ${formCandidates.length - 3} more${THEME.form}`) });
        }
      }
    });

    const active: FeedbackResult | null = creating
      ? { text: `creating "${newName}"…`, level: "info" }
      : feedback;
    if (active) {
      rule();
      for (const cell of feedbackBanner(active, innerWidth).slice(0, 3)) {
        card.push({ text: content(`  ${cell.style ?? ""}${cell.text}${THEME.form}`) });
      }
    }
    if (dirQuerying) {
      card.push({ text: content(`  ${THEME.muted}querying ${hostOptions[newHostIdx]}…${THEME.form}`) });
    }
    rule();
    const provider = PROVIDER_OPTIONS[newProviderIdx]!;
    const providerColor = provider === "claude" ? THEME.purple : THEME.blue;
    const where = hostOptions[newHostIdx] === "local" ? "locally" : `on ${hostOptions[newHostIdx]}`;
    const worktree = handlers.worktreeByDefault ? " in a worktree of" : " in";
    const summary = `${THEME.muted}  will run ${providerColor}${provider}${THEME.muted} ${where}${worktree} ${THEME.blue}${newDir || "the current directory"}${THEME.form}`;
    const create = `${bg("9ece6a")}${fg("16161e")}${BOLD} ⏎ create ${NORMAL_WEIGHT}${THEME.form}`;
    card.push({ text: content(alignAnsi(summary, create, cardWidth)) });
    card.push({ text: content("") });

    const footer = handlers.setKeyBar ? [] : keyBar("new-form", handlers, cols, true);
    pushKeyBar("new-form", true);
    const available = Math.max(0, rows - footer.length);
    const top = Math.max(0, Math.floor((available - card.length) / 2));
    const screen: string[] = Array.from({ length: top }, () => THEME.app + " ".repeat(cols) + RESET);
    const left = Math.max(0, Math.floor((cols - cardWidth) / 2));
    for (const line of card) {
      const screenRow = screen.length + 1;
      if (line.field !== undefined) formHitRows.set(screenRow, line.field);
      screen.push(THEME.app + " ".repeat(left) + line.text + THEME.app + " ".repeat(Math.max(0, cols - left - cardWidth)) + RESET);
    }
    while (screen.length < available) screen.push(THEME.app + " ".repeat(cols) + RESET);
    screen.push(...footer.map((cell) => `${cell.style ?? THEME.sidebar}${padAnsi(cell.text, cols)}${RESET}`));
    return screen.slice(0, rows);
  };

  const render = () => {
    const cols = process.stdout.columns ?? 80;
    const rows = process.stdout.rows ?? 24;
    listHitRows.clear();
    renderedSidebarWidth = cols;

    if (mode === "new-form") {
      out("\x1b[H" + renderForm(cols, rows).map((l) => CLEAR_LINE + l).join("\r\n"));
      return;
    }

    const showPreview = !!handlers.preview && cols >= 28 + MIN_PREVIEW_WIDTH + 2;
    const sidebarWidth = sidebarWidthFor(cols, showPreview);
    renderedSidebarWidth = sidebarWidth;
    const previewWidth = cols - sidebarWidth - 2; // "│ " separator

    // The active message renders under the two-line fleet summary, near the
    // cursor. The footer is a contextual key bar rather than a prose manual.
    const active: FeedbackResult | null = creating
      ? { text: `creating "${newName}"…`, level: "info" }
      : confirmRemove
        ? { text: `remove "${confirmRemove}"? d again to confirm`, level: "warn" }
        : feedback;
    const footerCells = handlers.setKeyBar ? [] : keyBar(mode, handlers, sidebarWidth, activity?.active ?? true);
    pushKeyBar(mode, activity?.active ?? true);
    const bodyRows = Math.max(1, rows - footerCells.length);
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
    }

    const current = items.filter((item) => item.status !== "exited" && item.status !== "dead");
    const running = current.filter((item) => ["working", "starting", "waiting"].includes(item.status ?? "")).length;
    const needs = current.filter((item) => item.status === "needs-attention").length;
    const idle = current.filter((item) => item.status === "idle").length;
    const exited = items.filter((item) => item.secondary).length;
    const titleLeft = `${THEME.bright}${BOLD}agent motel${NORMAL_WEIGHT}${THEME.sidebar}`;
    const titleRight = `${THEME.green}●${running}${THEME.sidebar} ${THEME.yellow}✱${needs}${THEME.sidebar} ${THEME.muted}◌${idle}${THEME.sidebar}`;
    const headerBlock: Cell[] = [
      { text: alignAnsi(titleLeft, titleRight, sidebarWidth), style: THEME.sidebar },
      {
        text: exited > 0
          ? `${THEME.faint}${exited} exited · ${THEME.muted}a${THEME.faint} ${showAll ? "hide" : "all"} · ${THEME.muted}f${THEME.faint} filter${THEME.sidebar}`
          : `${THEME.faint}${current.length === 0 ? "no active agents" : "f filter · / search chats"}${THEME.sidebar}`,
        style: THEME.sidebar,
      },
      { text: `${THEME.border}${"─".repeat(sidebarWidth)}${THEME.sidebar}`, style: THEME.sidebar },
    ];
    const prompt: Cell | null =
      mode === "cd-dir"
        ? { text: `${THEME.blue}cd to${THEME.sidebar}  ${cdDir}${THEME.blue}▌${THEME.sidebar}`, style: THEME.sidebar }
        : mode === "search"
          ? { text: `${THEME.blue}search chats${THEME.sidebar}  ${chatQuery}${THEME.blue}▌${THEME.sidebar}`, style: THEME.sidebar }
          : mode === "filter"
            ? { text: `${THEME.blue}filter${THEME.sidebar}  ${filter}${THEME.blue}▌${THEME.sidebar}`, style: THEME.sidebar }
            : chatMatch
              ? { text: `${THEME.muted}search: ${chatQuery} · ${matches.length} matches · esc clears${THEME.sidebar}`, style: THEME.sidebar }
              : filter
                ? { text: `${THEME.muted}filter: ${filter} · ⌫ clears${THEME.sidebar}`, style: THEME.sidebar }
                : mode === "edit"
                  ? { text: `${THEME.orange}edit${THEME.sidebar}  ${selected?.label ?? ""}`, style: THEME.sidebar }
                  : mode === "help"
                    ? { text: `${THEME.blue}${BOLD}keyboard shortcuts${NORMAL_WEIGHT}${THEME.sidebar}`, style: THEME.sidebar }
                    : null;
    if (prompt) headerBlock.push(prompt);

    // Keep the details panel a stable height while moving the cursor. Per the
    // TUI design it's a borderless lighter-bg block with a one-cell margin —
    // no box-drawing frame.
    const metaHeight = Math.max(0, ...items.map((i) => i.meta?.length ?? 0)) + (chatMatch ? 1 : 0);
    const detailWidth = Math.max(8, sidebarWidth - 2);
    const detailInner = Math.max(1, detailWidth - 2);
    const detailRow = (value: string): Cell => ({
      text: ` ${THEME.card} ${padAnsi(value, detailInner)} ${THEME.sidebar}`,
      style: THEME.sidebar,
    });
    const metaBlock: Cell[] = metaHeight && selected
      ? (() => {
          const status = `${selected.iconStyle ?? THEME.muted}${selected.icon ?? ""} ${selected.statusLabel ?? selected.status ?? ""}${THEME.card}`;
          const title = alignAnsi(
            `${THEME.bright}${BOLD}${selected.label}${NORMAL_WEIGHT}${THEME.card}`,
            status,
            detailInner,
          );
          const rows = Array.from({ length: metaHeight }, (_, i) => {
            const raw = selected.meta?.[i] ?? "";
            const match = /^(\S+)(\s+)(.*)$/.exec(raw);
            if (!match) return detailRow(raw);
            const label = `${THEME.muted}${match[1]!.padEnd(9)}${THEME.card}`;
            return detailRow(label + match[3]);
          });
          return [{ text: "", style: THEME.sidebar }, detailRow(title), ...rows];
        })()
      : [];
    const visibleMetaBlock = mode === "help" ? [] : metaBlock;

    // Section headers are rendered only when the matches span more than one
    // section (a lone "local" header is noise); they consume list rows, so
    // capacity shrinks by the section count.
    const sections = [...new Set(matches.map((i) => i.section ?? ""))];
    const showSections = sections.length > 1;
    const headerRows = showSections ? sections.length : 0;

    // Window the list around the cursor so long agent lists stay navigable.
    // Reserve rows for overflow hints when the fleet is taller than its pane.
    const availableListRows = Math.max(
      1,
      bodyRows - headerBlock.length - bannerBlock.length - visibleMetaBlock.length - headerRows,
    );
    const overflowRows = matches.length > availableListRows ? 2 : 0;
    const listCapacity = Math.max(1, availableListRows - overflowRows);
    let start = 0;
    if (matches.length > listCapacity) {
      start = Math.min(Math.max(0, cursor - Math.floor(listCapacity / 2)), matches.length - listCapacity);
    }

    const side: Cell[] = [...headerBlock, ...bannerBlock];
    if (mode === "help") {
      const key = (value: string) => `${THEME.keycap} ${value.padEnd(7)} ${THEME.sidebar}`;
      const helpRows = [
        `${THEME.muted}NAVIGATION${THEME.sidebar}`,
        `${key("↑ ↓ / j k")} preview agent`,
        `${key("enter / →")} ${handlers.select ? "lock into session" : "jump to agent"}`,
        ...(handlers.select ? [`${key("ctrl-q")} return to sidebar`] : []),
        "",
        `${THEME.muted}FLEET${THEME.sidebar}`,
        ...(handlers.create ? [`${key("n")} create agent`] : []),
        `${key("f")} filter names/tasks`,
        `${key("/")} search conversations`,
        ...(handlers.regroup ? [`${key("g")} group host/project`] : []),
        `${key("a")} show exited agents`,
        ...(hasEditActions(handlers) ? [`${key("e")} edit selected agent`] : []),
        `${key("q / esc")} ${handlers.quit ? "detach" : "quit"}`,
      ];
      side.push(...helpRows.map((text) => ({ text, style: THEME.sidebar })));
    } else {
      if (start > 0) {
        side.push({ text: `${THEME.muted}↑ ${start} more${THEME.sidebar}`, style: THEME.sidebar });
      }
      let lastSection: string | null = null;
      matches.slice(start, start + listCapacity).forEach((item, i) => {
        const idx = start + i;
        if (showSections && (item.section ?? "") !== lastSection) {
          lastSection = item.section ?? "";
          const count = matches.filter((candidate) => (candidate.section ?? "") === lastSection).length;
          const title = ` ${lastSection || "local"} `;
          const countText = ` ${count} `;
          const dashes = "─".repeat(Math.max(1, sidebarWidth - 2 - title.length - countText.length));
          side.push({
            text: `${THEME.muted}──${title}${dashes}${countText}${THEME.sidebar}`,
            style: THEME.sidebar,
          });
        }
        listHitRows.set(side.length + 1, idx);
        const selectedRow = idx === cursor;
        const isAttention = item.status === "needs-attention";
        // Selection and attention read as full-row background fills, per the
        // TUI design — no borders. `restore` returns each colored segment to
        // the row's own bg+fg.
        const rowStyle = selectedRow ? THEME.selected : isAttention ? THEME.text + THEME.attention : THEME.sidebar;
        const restore = rowStyle;
        const prefix = selectedRow ? `${THEME.blue}▌${restore} ` : "  ";
        const icon = item.icon ?? "";
        const iconWidth = icon ? visibleWidth(icon) + 1 : 0;
        const right = item.right ?? "";
        const queue = (item.queueDepth ?? 0) > 0 ? `▸${item.queueDepth}` : "";
        const badge = item.badge ?? "";
        // Provider tag is plain colored text with a one-cell right inset.
        const suffixWidth =
          (right ? visibleWidth(right) + 1 : 0) +
          (queue ? visibleWidth(queue) + 1 : 0) +
          (badge ? visibleWidth(badge) + 2 : 0);
        const labelWidth = Math.max(1, sidebarWidth - 2 - iconWidth - suffixWidth);
        const label = clipLine(item.label, labelWidth).padEnd(labelWidth);
        const iconSeg = icon ? `${item.iconStyle ?? THEME.muted}${icon}${restore} ` : "";
        const labelSeg = selectedRow
          ? `${THEME.bright}${BOLD}${label}${NORMAL_WEIGHT}${restore}`
          : `${item.labelStyle ?? THEME.text}${label}${restore}`;
        const rightSeg = right ? ` ${selectedRow ? THEME.muted : (item.rightStyle ?? THEME.muted)}${right}${restore}` : "";
        const queueSeg = queue ? ` ${THEME.yellow}${queue}${restore}` : "";
        const badgeStyle = (selectedRow ? item.badgeSelectedStyle : undefined) ?? item.badgeStyle ?? THEME.muted;
        const badgeSeg = badge ? ` ${badgeStyle}${badge}${restore} ` : "";
        side.push({ text: prefix + iconSeg + labelSeg + rightSeg + queueSeg + badgeSeg, style: rowStyle });
      });
      const end = Math.min(matches.length, start + listCapacity);
      if (end < matches.length) {
        side.push({ text: `${THEME.muted}↓ ${matches.length - end} more${THEME.sidebar}`, style: THEME.sidebar });
      }
      if (matches.length === 0) {
        side.push({
          text: items.length === 0 ? "  no agents — n creates one" : "  no matches",
          style: THEME.muted,
        });
      }
      side.push(...visibleMetaBlock);
    }

    const previewLines =
      showPreview && selected && handlers.preview ? handlers.preview(selected.name).slice(-bodyRows) : [];

    const lines: string[] = [];
    for (let r = 0; r < bodyRows; r++) {
      const cell = side[r] ?? { text: "" };
      // Cells may carry embedded SGR (colored status glyph): clip and pad by
      // VISIBLE width so escape codes don't throw off the column math.
      const clipped = visibleWidth(cell.text) > sidebarWidth ? clipAnsi(cell.text, sidebarWidth) : cell.text;
      const padded = clipped + " ".repeat(Math.max(0, sidebarWidth - visibleWidth(clipped)));
      let line = THEME.sidebar + (cell.style ?? "") + padded + RESET;
      if (showPreview) {
        // Preview lines keep their own colors; RESET stops any unclosed
        // attribute from bleeding into the next row.
        const preview = clipAnsi(previewLines[r] ?? "", previewWidth);
        line += THEME.app + THEME.border + "│ " + THEME.app + padAnsi(preview, previewWidth) + RESET;
      }
      lines.push(line);
    }

    for (const cell of footerCells) {
      let line = THEME.sidebar + (cell.style ?? "") + padAnsi(cell.text, sidebarWidth) + RESET;
      if (showPreview) line += THEME.app + " ".repeat(previewWidth + 2) + RESET;
      lines.push(line);
    }

    // No trailing newline: the footer sits on the last row and writing past
    // it would scroll the alternate screen.
    out("\x1b[H" + lines.map((l) => CLEAR_LINE + l).join("\r\n"));
  };

  process.stdin.setRawMode(true);
  process.stdin.resume();
  out("\x1b]0;am\x07"); // tab title; agent sessions set their own via tmux set-titles
  out(ALT_SCREEN_ON + HIDE_CURSOR + WRAP_OFF + MOUSE_ON);
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
      out(MOUSE_OFF + WRAP_ON + ALT_SCREEN_OFF + SHOW_CURSOR);
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
          // Follow the newly created agent before reloading. The cursor is
          // name-tracked, so leaving the previous name here would make render
          // snap back to the old row even though select() opened the new one.
          cursorName = created;
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

    const activateSelection = () => {
      const match = filtered()[cursor];
      if (!match) return;
      if (!handlers.select) return finish(match.name);
      feedback = asFeedback(handlers.select(match.name));
      items = load();
      // Focus just moved to the agent pane — reflect it without waiting a tick.
      refreshActivity();
    };

    const handleKey = (key: string) => {
      if (key === "\x03") return finish(null); // ctrl-c

      // Mouse wheel follows the list. A left click activates an agent row or,
      // in the create form, moves the focus ring to the clicked field.
      // Releases and clicks outside known rows are deliberately ignored.
      const mouse = parseMouseEvent(key);
      if (mouse) {
        if (mouse.pressed && (mouse.button === 64 || mouse.button === 65)) {
          moveCursor(mouse.button === 64 ? -1 : 1);
          render();
        } else if (mouse.pressed && mouse.button === 0) {
          if (mode === "new-form") {
            const clickedField = formHitRows.get(mouse.y);
            if (clickedField !== undefined) {
              formIdx = clickedField;
              formCandidates = [];
              dirQueryGen++;
              render();
            }
          } else if ((mode === "list" || mode === "filter" || mode === "search") && mouse.x <= renderedSidebarWidth) {
            const clickedIndex = listHitRows.get(mouse.y);
            if (clickedIndex !== undefined) {
              cursor = clickedIndex;
              cursorName = filtered()[cursor]?.name ?? null;
              activateSelection();
              if (!finished) render();
            }
          }
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

      if (mode === "help") {
        if (key === "?" || key === "\x1b" || key === "q") mode = "list";
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
          if (field === "name") {
            newName = newName.slice(0, -1);
            feedback = null;
          }
          else if (field === "task") newTask = newTask.slice(0, -1);
          else if (field === "model") newModel = newModel.slice(0, -1);
          else if (field === "dir") {
            newDir = newDir.slice(0, -1);
            formCandidates = [];
            dirQueryGen++; // input changed: discard any in-flight completion
          }
        } else if (key >= " " && !key.startsWith("\x1b")) {
          if (field === "name") {
            if (/^[a-zA-Z0-9_-]$/.test(key)) {
              newName += key;
              feedback = null;
            } else {
              feedback = { text: "use letters, numbers, dashes, or underscores", level: "warn" };
            }
          }
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
        activateSelection();
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
      } else if (key === "?") {
        mode = "help";
        feedback = null;
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
