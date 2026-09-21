import { completeDir, completeDirRemote } from "./dirComplete";
import { localAgentMatches, search } from "./search";
import { startUsagePolling, usageBadge } from "./usage";
import { effortsForModel, findModel, type ModelOption, type ProviderCatalog } from "./catalog";

export interface PickerItem {
  name: string;
  label: string;
  parent?: string;
  depth?: number;
  treePrefix?: string;
  // Leading status glyph, colored (iconStyle) independently of the label so
  // state reads at a glance. On the highlighted row the inverse bar owns the
  // colors, so the glyph there renders plain.
  icon?: string;
  iconStyle?: string;
  // Display status powers the header rollup and the selected item's detail
  // card. It stays a string so the picker remains independent of AgentState.
  status?: string;
  statusLabel?: string;
  role?: string;
  // False for synthetic fleet rows such as an unreachable-host marker. These
  // rows are visible fleet context, but are not unassigned agents.
  roleFilterable?: boolean;
  // Row styling is split into the activity column and compact provider chip.
  labelStyle?: string;
  badge?: string;
  badgeStyle?: string;
  // Tag color when the row is selected (the design brightens cdx to blue on
  // the selection fill); falls back to badgeStyle.
  badgeSelectedStyle?: string;
  queueDepth?: number;
  // Right-aligned role text, with an optional color on unselected rows.
  right?: string;
  rightStyle?: string;
  statusAge?: string;
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

export function pickerRoleFilterOptions(items: PickerItem[]): string[] {
  const agents = items.filter((item) => item.roleFilterable !== false);
  const roles = [...new Set(agents.map((item) => item.role).filter((role): role is string => !!role))].sort();
  return [...roles, ...(agents.some((item) => !item.role) ? ["unassigned"] : [])];
}

export function matchesPickerRole(item: PickerItem, role: string | null): boolean {
  if (!role) return true;
  if (item.roleFilterable === false) return false;
  return role === "unassigned" ? !item.role : item.role === role;
}

export function visibleItemsForRole(
  items: PickerItem[],
  filter: string,
  showAll: boolean,
  role: string | null,
  showHierarchy = true,
): PickerItem[] {
  // Choosing a role is an explicit search, just like typing a text filter, so
  // matching exited agents should not disappear behind the default view.
  const visible = visibleItems(items, filter, showAll || !!role)
    .filter((item) => matchesPickerRole(item, role));
  return showHierarchy ? nestPickerItems(visible) : visible;
}

export function nestPickerItems(items: PickerItem[]): PickerItem[] {
  const byName = new Map(items.map((item) => [item.name, item]));
  const children = new Map<string, PickerItem[]>();
  const hasVisibleParent = new Set<string>();

  for (const item of items) {
    const parent = item.parent ? byName.get(item.parent) : undefined;
    if (!parent || parent === item || parent.section !== item.section) continue;
    const siblings = children.get(parent.name) ?? [];
    siblings.push(item);
    children.set(parent.name, siblings);
    hasVisibleParent.add(item.name);
  }

  const nested: PickerItem[] = [];
  const emitted = new Set<string>();
  const append = (
    item: PickerItem,
    ancestorContinues: boolean[],
    branch: "middle" | "last" | null,
  ) => {
    if (emitted.has(item.name)) return;
    emitted.add(item.name);
    const { depth: _oldDepth, treePrefix: _oldTreePrefix, ...clean } = item;
    const treePrefix = branch
      ? ancestorContinues.map((continues) => continues ? "│  " : "   ").join("")
        + (branch === "middle" ? "├─ " : "└─ ")
      : undefined;
    nested.push(branch ? { ...clean, depth: ancestorContinues.length + 1, treePrefix } : clean);

    const childItems = children.get(item.name) ?? [];
    childItems.forEach((child, index) => {
      const childBranch = index === childItems.length - 1 ? "last" : "middle";
      append(child, branch ? [...ancestorContinues, branch === "middle"] : [], childBranch);
    });
  };

  for (const item of items) {
    if (!hasVisibleParent.has(item.name)) append(item, [], null);
  }
  // Keep parent cycles visible instead of dropping those rows.
  for (const item of items) append(item, [], null);
  return nested;
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
  create?: (spec: CreateSpec) => Promise<string>;
  // Configured remote hosts. When non-empty, the create flow adds a
  // "where" step (local vs a remote) after the dir prompt.
  remotes?: string[];
  // Prefill for the create flow's directory prompt, given the currently
  // highlighted agent (related work usually lives in the same project).
  defaultDir?: (highlighted: string | null) => string;
  // Ensure the fleet concierge exists (created or revived as needed) and
  // resolve with its picker key; the picker then selects it like any row.
  concierge?: () => string | Promise<string>;
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
  // Previous names remain exact routing aliases; live sessions are renamed
  // in place, so the handler may complete while the provider is still busy.
  rename?: (name: string, newName: string) => Feedback | Promise<Feedback>;
  // Toggle the list grouping (host ↔ directory); returns banner feedback.
  regroup?: () => Feedback;
  // Toggle status ordering ↔ most-recently-active ordering within each group.
  resort?: () => Feedback;
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
  roleOptions?: RoleOption[] | ((host?: string) => RoleOption[] | Promise<RoleOption[]>);
  // What the providers on the target machine actually offer, so the create
  // form's model / effort fields list real choices instead of a guess. Async
  // for remote hosts (`am models --json` over ssh); absent = fall back to the
  // built-in EFFORT_OPTIONS and a free-text model.
  catalogOptions?: (host?: string) => ProviderCatalog[] | Promise<ProviderCatalog[]>;
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
  // Push-driven reloads (the hub subscribes to daemon fleet events). Returns
  // an unsubscribe function. A periodic reload remains as a consistency
  // fallback for missed events and remote hosts.
  subscribe?: (onUpdate: () => void) => () => void;
  // Host the command palette as a floating overlay (tmux display-popup) so
  // what's underneath stays visible. Resolves with the picked action (null =
  // dismissed); the picker executes it. Unset = the in-picker fallback.
  palettePopup?: (spec: PaletteSpec) => Promise<PaletteResult | null>;
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

const RENDER_REFRESH_MS = 1000;
const EVENT_FALLBACK_REFRESH_MS = 5000;
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

type Mode = "list" | "filter" | "search" | "palette" | "new-form" | "cd-dir" | "rename-name" | "edit" | "help";

export interface PaletteCommand {
  id: string;
  label: string;
  keywords?: string;
  shortcut?: string;
}

export function filterPaletteCommands(commands: PaletteCommand[], query: string): PaletteCommand[] {
  const normalized = query.toLowerCase().trim();
  const terms = normalized.split(/\s+/).filter(Boolean);
  if (terms.length === 0) return commands;
  return commands
    .map((command, index) => {
      const label = command.label.toLowerCase();
      const shortcut = command.shortcut?.toLowerCase() ?? "";
      const haystack = `${label} ${command.keywords ?? ""} ${shortcut}`.toLowerCase();
      const tokens = haystack.split(/\s+/);
      if (!terms.every((term) => term.length === 1 ? tokens.includes(term) : haystack.includes(term))) return null;
      const score = label === normalized
        ? 0
        : label.startsWith(normalized)
          ? 1
          : label.split(/\s+/).some((word) => word.startsWith(normalized))
            ? 2
            : label.includes(normalized) || shortcut === normalized
              ? 3
              : terms.every((term) => label.includes(term))
                ? 4
                : 5;
      return { command, index, score };
    })
    .filter((match): match is { command: PaletteCommand; index: number; score: number } => match !== null)
    .sort((a, b) => a.score - b.score || a.index - b.index)
    .map((match) => match.command);
}

// The palette's agent group: the minimal row shape shared by the in-picker
// fallback (PickerItem satisfies it) and the popup process, which receives it
// as JSON.
export interface PaletteAgentEntry {
  name: string;
  label: string;
  search?: string;
  icon?: string;
  iconStyle?: string;
  badge?: string;
  badgeStyle?: string;
  role?: string;
}

export interface PaletteSpec {
  commands: PaletteCommand[];
  agents: PaletteAgentEntry[];
  // "lock in" on the hub (the right pane follows), "attach" elsewhere.
  attachLabel: string;
}

export type PaletteResult = { type: "command"; id: string } | { type: "agent"; name: string };

export function filterPaletteAgents<T extends { label: string; search?: string }>(agents: T[], query: string): T[] {
  const terms = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
  if (!terms.length) return agents;
  return agents.filter((agent) => {
    const haystack = `${agent.label} ${agent.search ?? ""}`.toLowerCase();
    return terms.every((term) => haystack.includes(term));
  });
}

export interface PaletteRowOut {
  text: string;
  entry?: number;
}

// Build the palette panel — query row, rules, grouped results windowed around
// the cursor, footer — as styled lines of `width` cells. Shared by the popup
// (which IS the panel) and the in-picker fallback (which centers it on the
// app background). Returns the clamped cursor so callers stay in bounds.
export function paletteScreenRows(opts: {
  commands: PaletteCommand[];
  agents: PaletteAgentEntry[];
  attachLabel: string;
  query: string;
  cursor: number;
  width: number;
  capacity: number;
}): { rows: PaletteRowOut[]; total: number; cursor: number } {
  const { commands, agents, attachLabel, query, width } = opts;
  const total = commands.length + agents.length;
  const cursor = Math.min(opts.cursor, Math.max(0, total - 1));

  const content = (value: string, base = THEME.form): string => `${base}${padAnsi(value, width)}`;
  const ruleText = `${THEME.form}${THEME.border}${"─".repeat(width)}`;

  // Color the query's matched characters in place (first occurrence of each
  // term), restoring the row's own style afterwards.
  const terms = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
  const highlightTerms = (text: string, base: string): string => {
    if (!terms.length) return base + text;
    const lower = text.toLowerCase();
    const marked = new Array<boolean>(text.length).fill(false);
    for (const term of terms) {
      const at = lower.indexOf(term);
      for (let i = at; at >= 0 && i < at + term.length; i++) marked[i] = true;
    }
    let out = base;
    let inMatch = false;
    for (let i = 0; i < text.length; i++) {
      if (marked[i] && !inMatch) {
        out += THEME.cyan;
        inMatch = true;
      } else if (!marked[i] && inMatch) {
        out += base;
        inMatch = false;
      }
      out += text[i];
    }
    return inMatch ? out + base : out;
  };

  const body: PaletteRowOut[] = [];
  commands.forEach((command, i) => {
    if (i === 0) body.push({ text: content(` ${THEME.muted}commands${THEME.form}`) });
    const selectedRow = i === cursor;
    const rowBase = selectedRow ? THEME.selected : THEME.form;
    const marker = selectedRow ? `${THEME.blue}▌${rowBase} ` : "  ";
    const shortcut = command.shortcut ? `${THEME.keycap} ${command.shortcut} ${rowBase} ` : " ";
    body.push({
      text: content(alignAnsi(marker + highlightTerms(command.label, rowBase), shortcut, width), rowBase),
      entry: i,
    });
  });
  agents.forEach((item, i) => {
    if (i === 0) body.push({ text: content(` ${THEME.muted}agents${THEME.form}`) });
    const entry = commands.length + i;
    const selectedRow = entry === cursor;
    const rowBase = selectedRow ? THEME.selected : THEME.form;
    const marker = selectedRow ? `${THEME.blue}▌${rowBase} ` : "  ";
    const icon = `${item.iconStyle ?? THEME.muted}${item.icon ?? "●"}${rowBase}`;
    const action = `${THEME.muted} — ${item.role ? `${item.role} · ` : ""}${attachLabel}${rowBase}`;
    const tag = item.badge ? `${item.badgeStyle ?? THEME.muted}${item.badge}${rowBase} ` : " ";
    body.push({
      text: content(alignAnsi(marker + icon + " " + highlightTerms(item.label, rowBase) + action, tag, width), rowBase),
      entry,
    });
  });
  if (total === 0) body.push({ text: content(` ${THEME.muted}no matches${THEME.form}`) });

  let start = 0;
  if (body.length > opts.capacity) {
    const cursorRow = Math.max(0, body.findIndex((row) => row.entry === cursor));
    start = Math.min(Math.max(0, cursorRow - Math.floor(opts.capacity / 2)), body.length - opts.capacity);
  }

  const rows: PaletteRowOut[] = [];
  rows.push({ text: content("") });
  rows.push({
    text: content(alignAnsi(
      ` ${THEME.blue}› ${THEME.bright}${query}${bg("7aa2f7")}${fg("16161e")} ${THEME.form}`,
      `${THEME.faint}esc close ${THEME.form}`,
      width,
    )),
  });
  rows.push({ text: ruleText });
  rows.push(...body.slice(start, start + opts.capacity));
  rows.push({ text: ruleText });
  const keys = ` ${THEME.keycap} ↑↓ ${THEME.form} ${THEME.muted}select${THEME.form}  ${THEME.keycap} ⏎ ${THEME.form} ${THEME.muted}run${THEME.form}`;
  const count = `${THEME.faint}${total} ${total === 1 ? "match" : "matches"} ${THEME.form}`;
  rows.push({ text: content(alignAnsi(keys, count, width)) });
  rows.push({ text: content("") });
  return { rows, total, cursor };
}

// The interactive UI inside a `tmux display-popup` (`am __palette`): the
// popup window is exactly the panel, floating over the hub, so what's
// underneath stays visible. Purely presentational — it resolves with the
// picked action and the caller (the picker that spawned it) executes it.
export async function palettePopupUi(spec: PaletteSpec): Promise<PaletteResult | null> {
  let query = "";
  let cursor = 0;
  const out = (s: string) => process.stdout.write(s);
  const render = () => {
    const width = process.stdout.columns ?? 74;
    const rows = process.stdout.rows ?? 20;
    const panel = paletteScreenRows({
      commands: filterPaletteCommands(spec.commands, query),
      agents: filterPaletteAgents(spec.agents, query),
      attachLabel: spec.attachLabel,
      query,
      cursor,
      width,
      capacity: Math.max(1, rows - 6),
    });
    cursor = panel.cursor;
    const lines = panel.rows.map((row) => row.text + RESET);
    while (lines.length < rows) lines.push(THEME.form + " ".repeat(width) + RESET);
    out("\x1b[H" + lines.slice(0, rows).map((l) => CLEAR_LINE + l).join("\r\n"));
  };

  process.stdin.setRawMode(true);
  process.stdin.resume();
  out(HIDE_CURSOR + WRAP_OFF);
  render();

  return await new Promise<PaletteResult | null>((resolve) => {
    const finishPopup = (value: PaletteResult | null) => {
      process.stdin.off("data", onData);
      process.stdout.off("resize", render);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      out(WRAP_ON + SHOW_CURSOR);
      resolve(value);
    };
    const onData = (data: Buffer) => {
      for (const key of splitKeys(data.toString("utf8"))) {
        const commands = filterPaletteCommands(spec.commands, query);
        const agents = filterPaletteAgents(spec.agents, query);
        const total = commands.length + agents.length;
        if (key === "\x03" || key === "\x1b" || key === "\x0b" || key === "\x10") return finishPopup(null);
        if (key === "\r" || key === "\n") {
          if (cursor < commands.length) {
            const command = commands[cursor];
            return finishPopup(command ? { type: "command", id: command.id } : null);
          }
          const agent = agents[cursor - commands.length];
          return finishPopup(agent ? { type: "agent", name: agent.name } : null);
        }
        if (key === "\x1b[A") cursor = Math.max(0, cursor - 1);
        else if (key === "\x1b[B") cursor = Math.min(Math.max(0, total - 1), cursor + 1);
        else if (key === "\x7f" || key === "\b") {
          query = query.slice(0, -1);
          cursor = 0;
        } else if (key >= " " && !key.startsWith("\x1b")) {
          query += key;
          cursor = 0;
        }
      }
      render();
    };
    process.stdin.on("data", onData);
    process.stdout.on("resize", render);
  });
}

interface KeyHint {
  key: string;
  label: string;
}

function keyBarHints(mode: Mode, handlers: PickerHandlers, active: boolean): { label: string; hints: KeyHint[] } {
  let label = mode === "new-form" ? "CREATE" : mode === "rename-name" ? "RENAME" : mode.toUpperCase().replace("-DIR", "");
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
      ...(handlers.rename ? [{ key: "n", label: "rename" }] : []),
      ...(handlers.cd ? [{ key: "r", label: "cd" }] : []),
      ...(handlers.stop ? [{ key: "x", label: "stop" }] : []),
      ...(handlers.remove ? [{ key: "d", label: "remove" }] : []),
      { key: "esc", label: "back" },
    ];
  } else if (mode === "palette") {
    hints = [
      { key: "↑↓", label: "select" },
      { key: "⏎", label: "run" },
      { key: "esc", label: "close" },
    ];
  } else if (mode === "filter" || mode === "search" || mode === "cd-dir" || mode === "rename-name") {
    hints = [
      { key: "⏎", label: mode === "cd-dir" ? "move" : mode === "rename-name" ? "rename" : "apply" },
      ...(mode === "cd-dir" || mode === "rename-name" ? [] : [{ key: "↑↓", label: "preview" }]),
      { key: "esc", label: "cancel" },
    ];
  } else if (mode === "help") {
    hints = [{ key: "? / esc", label: "close" }];
  } else {
    hints = [
      { key: "↑↓", label: "preview" },
      { key: "⏎", label: handlers.select ? "lock in" : "jump" },
      ...(handlers.create ? [{ key: "n", label: "new" }] : []),
      ...(handlers.concierge ? [{ key: "c", label: "concierge" }] : []),
      { key: "f", label: "filter" },
      { key: "r", label: "role" },
      { key: "t", label: "tree/flat" },
      ...(handlers.regroup ? [{ key: "g", label: "group" }] : []),
      ...(handlers.resort ? [{ key: "s", label: "sort" }] : []),
      ...(hasEditActions(handlers) ? [{ key: "e", label: "edit" }] : []),
      { key: "ctrl-p", label: "commands" },
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
  // Quota headroom rides the right edge of the last bar line when there's
  // room — key hints always win the space — and takes a line of its own when
  // there isn't, rather than being silently dropped in a narrow sidebar.
  const badge = usageBadge();
  if (badge) {
    const painted = `${THEME.faint}${badge}${THEME.sidebar}`;
    const last = lines[lines.length - 1];
    if (last !== undefined && visibleWidth(last) + visibleWidth(painted) + 2 <= width) {
      lines[lines.length - 1] = alignAnsi(last, painted, width);
    } else if (visibleWidth(painted) + 1 <= width) {
      // Indented to sit under the key hints, which start inside the label chip.
      lines.push(` ${painted}`);
    }
  }
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
  // The hub's status line spans the whole window, so the badge gets a home on
  // the right without competing with the hints. `#` is doubled: tmux would
  // otherwise read it as the start of a format substitution.
  const badge = usageBadge();
  const trailing = [
    ...(badge ? [`#[bg=#16161e,fg=#414868] ${badge.replaceAll("#", "##")} `] : []),
    ...(right ? [token(right)] : []),
  ].join("");
  return trailing ? `${left}#[align=right]${trailing} ` : left;
}

export function hasEditActions(handlers: PickerHandlers): boolean {
  return !!(handlers.move || handlers.clone || handlers.handoff || handlers.rename || handlers.cd || handlers.stop || handlers.remove);
}

// The edit menu's footer line, built from whichever actions are wired.
export function editMenuHelp(handlers: PickerHandlers): string {
  const keys = [
    handlers.move && "m move",
    handlers.clone && "c clone",
    handlers.handoff && "h handoff",
    handlers.rename && "n rename",
    handlers.cd && "r cd",
    handlers.stop && "x stop",
    handlers.remove && "d remove",
  ].filter(Boolean);
  return [...keys, "esc back"].join(" · ");
}

// What the create form collects. An object rather than a positional list:
// eight same-typed `string | undefined` arguments in a row is an ordering
// accident waiting to happen every time a field is added.
export interface CreateSpec {
  name: string;
  task?: string;
  dir?: string;
  host?: string;
  provider?: string;
  model?: string;
  effort?: string;
  role?: string;
}

export function renamedPickerKey(key: string, newName: string): string {
  const colon = key.indexOf(":");
  return colon >= 0 ? `${key.slice(0, colon + 1)}${newName}` : newName;
}

// The create form's fields. "where" (local vs a configured remote) only
// appears when remotes exist, mirroring the old stepped flow. Provider/model/
// effort are always shown — they apply equally to local and remote spawns.
export function formFields(hasRemotes: boolean, hasRoles = false): string[] {
  // "where" (location) sits just before "dir" so you pick the host first — the
  // dir field then completes against that host on the first Tab.
  const fields = hasRemotes
    ? ["name", "task", "where", "dir", "provider", "model", "effort"]
    : ["name", "task", "dir", "provider", "model", "effort"];
  if (hasRoles) fields.splice(fields.indexOf("provider"), 0, "role");
  return fields;
}

export function preservedFieldIndex(previous: string[], index: number, next: string[]): number {
  const focused = previous[index];
  const matching = focused === undefined ? -1 : next.indexOf(focused);
  if (matching >= 0) return matching;
  return Math.min(Math.max(0, index), Math.max(0, next.length - 1));
}

// Provider cycle (mirrors the Where field). The first entry is the default.
export const PROVIDER_OPTIONS = ["claude", "codex"];

// A role offered by the create form. `provider` is the role's pin: selecting
// the role moves the form's provider strip to it, the way a CLI spawn without
// --claude/--codex would land there.
export interface RoleOption {
  name: string;
  description?: string;
  provider?: string;
}
// Effort cycle; "default" means omit the flag and let the provider decide.
// Only a fallback now — the real levels come from the target machine's
// provider catalog (see catalogOptions / `am models`).
export const EFFORT_OPTIONS = ["default", "low", "medium", "high"];
// The model cycle's first entry: no --model, the provider's own default.
export const DEFAULT_MODEL_OPTION: ModelOption = { id: "", label: "default", efforts: [] };

export function catalogFor(catalogs: ProviderCatalog[], provider: string | undefined): ProviderCatalog | null {
  return catalogs.find((catalog) => catalog.provider === provider) ?? null;
}

// Model cycle for the selected provider. Without a catalog it's just
// "default" — the field stays typeable, so an unlisted model is still
// reachable (Claude's list is not exhaustive).
export function modelOptionsFor(catalogs: ProviderCatalog[], provider: string | undefined): ModelOption[] {
  return [DEFAULT_MODEL_OPTION, ...(catalogFor(catalogs, provider)?.models ?? [])];
}

// Effort cycle for the selected provider AND model: codex varies per model
// (`ultra` only exists on the newest), so the list narrows as you pick.
export function effortOptionsFor(catalogs: ProviderCatalog[], provider: string | undefined, model: string): string[] {
  const catalog = catalogFor(catalogs, provider);
  if (!catalog) return EFFORT_OPTIONS;
  return ["default", ...effortsForModel(catalog, model || undefined)];
}

// What the effort strip actually shows. A selected level the current list
// doesn't contain (its catalog hasn't arrived yet) is appended rather than
// hidden — the form must never display "default" while holding something else.
export function effortStripOptions(
  catalogs: ProviderCatalog[],
  provider: string | undefined,
  model: string,
  effort: string,
): string[] {
  const options = effortOptionsFor(catalogs, provider, model);
  return effort && !options.includes(effort) ? [...options, effort] : options;
}

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
  let paletteQuery = "";
  let paletteCursor = 0;
  let paletteReturnMode: Mode = "list";
  let newName = "";
  let newTask = "";
  let newDir = "";
  // Where to spawn: index into hostOptions ("local" + configured remotes).
  // The "where" step is only shown when at least one remote is configured.
  const hostOptions = ["local", ...(handlers.remotes ?? [])];
  let newHostIdx = 0;
  // Provider (Claude/Codex), model and reasoning effort all cycle like Where.
  // Model and effort options come from the target machine's provider catalog
  // (blank model = the provider's default); model stays typeable for names the
  // catalog doesn't list. The initial selection follows config's
  // defaultProvider so the form opens on the user's default.
  const defaultProviderIdx = Math.max(0, PROVIDER_OPTIONS.indexOf(handlers.defaultProvider ?? PROVIDER_OPTIONS[0]!));
  let newProviderIdx = defaultProviderIdx;
  let newModel = "";
  let newEffort = "";
  let catalogs: ProviderCatalog[] = [];
  let catalogQueryGen = 0;
  const currentModelOptions = () => modelOptionsFor(catalogs, PROVIDER_OPTIONS[newProviderIdx]);
  const currentEffortOptions = () =>
    effortStripOptions(catalogs, PROVIDER_OPTIONS[newProviderIdx], newModel, newEffort);
  const configuredRoles = (host?: string) => typeof handlers.roleOptions === "function" ? handlers.roleOptions(host) : (handlers.roleOptions ?? []);
  let roleOptions: RoleOption[] = [
    { name: "", description: "No custom role" },
  ];
  let newRoleIdx = 0;
  // Full-screen create form: which field has the focus ring, and the dir
  // autocomplete candidates to display (when the last Tab was ambiguous).
  let fields = formFields(hostOptions.length > 1, roleOptions.length > 1);
  let formIdx = 0;
  let formCandidates: string[] = [];
  // Remote Dir completion runs over ssh: dirQuerying drives the "(querying …)"
  // line, and dirQueryGen is bumped on every dir edit / focus move / new query
  // so a slow round-trip that lands after the input changed is discarded.
  let dirQuerying = false;
  let dirQueryGen = 0;
  let roleQueryGen = 0;
  let cdDir = "";
  let cdTarget: string | null = null;
  let renameName = "";
  let renameTarget: string | null = null;
  let creating = false;
  let lastHighlighted: string | null = null;
  // Hub focus indicator: which pane is driving the keyboard. Refreshed on the
  // load tick and right after a lock-in (cheap tmux poll); null off the hub.
  let activity = handlers.activity?.() ?? null;
  // Rebuilt on every paint. Values are indexes into the current filtered
  // result set, so section headers and variable-height banners remain safe.
  const listHitRows = new Map<number, number>();
  const paletteHitRows = new Map<number, number>();
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
  let showHierarchy = true;
  let roleFilter: string | null = null;
  const matchesRole = (item: PickerItem) => matchesPickerRole(item, roleFilter);
  const filtered = () => {
    if (chatMatch) {
      // Chat-search owns the list: show every agent whose conversation matched
      // (exited included), in search-rank order, with the snippet surfaced as
      // the first meta line for the highlighted row.
      const byName = new Map(items.map((i) => [i.name, i]));
      return chatOrder
        .map((name) => byName.get(name))
        .filter((i): i is PickerItem => !!i)
        .filter(matchesRole)
        .map((i) => ({ ...i, meta: [`match    ${chatMatch!.get(i.name) ?? ""}`, ...(i.meta ?? [])] }));
    }
    return visibleItemsForRole(items, filter, showAll, roleFilter, showHierarchy);
  };

  const paletteCommands = (): PaletteCommand[] => {
    const target = filtered()[cursor];
    const name = target?.label ?? target?.name;
    const filterRoles = pickerRoleFilterOptions(items);
    const commands: (PaletteCommand | undefined)[] = [
      target && {
        id: "open",
        label: `${handlers.select ? "Lock into" : "Open"} ${name}`,
        keywords: "select jump attach session",
        shortcut: "enter",
      },
      handlers.create && { id: "create", label: "Create agent", keywords: "new spawn", shortcut: "n" },
      handlers.concierge && { id: "concierge", label: "Ask the concierge", keywords: "assistant fleet manage status find which agent question", shortcut: "c" },
      { id: "filter", label: "Filter agents", keywords: "find name task", shortcut: "f" },
      { id: "search", label: "Search conversations", keywords: "chat transcript history", shortcut: "/" },
      {
        id: "toggle-all",
        label: showAll ? "Hide exited agents" : "Show exited agents",
        keywords: "all dead stopped",
        shortcut: "a",
      },
      {
        id: "toggle-hierarchy",
        label: showHierarchy ? "Flatten agent hierarchy" : "Show agent hierarchy",
        keywords: "tree flat parent child nesting indentation",
        shortcut: "t",
      },
      handlers.regroup && { id: "regroup", label: "Toggle host/project grouping", keywords: "group directory", shortcut: "g" },
      handlers.resort && { id: "resort", label: "Cycle status/recent/role sort", keywords: "sort recent newest latest updated role", shortcut: "s" },
      roleFilter ? { id: "role:all", label: "Show all roles", keywords: "role filter clear", shortcut: "r" } : undefined,
      ...filterRoles.filter((role) => role !== "unassigned")
        .map((role) => ({ id: `role:${role}`, label: `Filter role: ${role}`, keywords: "role filter", shortcut: "r" })),
      filterRoles.includes("unassigned")
        ? { id: "role:unassigned", label: "Filter role: unassigned", keywords: "role filter none", shortcut: "r" }
        : undefined,
      target && handlers.move && { id: "move", label: `Move ${name}`, keywords: "remote host relocate", shortcut: "e m" },
      target && handlers.clone && { id: "clone", label: `Clone ${name}`, keywords: "copy fork remote", shortcut: "e c" },
      target && handlers.handoff && { id: "handoff", label: `Handoff ${name}`, keywords: "provider transcript", shortcut: "e h" },
      target && handlers.rename && { id: "rename", label: `Rename ${name}`, keywords: "name identity alias", shortcut: "e n" },
      target && handlers.cd && { id: "cd", label: `Change directory for ${name}`, keywords: "relocate path", shortcut: "e r" },
      target && handlers.stop && { id: "stop", label: `Stop ${name}`, keywords: "exit kill", shortcut: "e x" },
      target && handlers.remove && { id: "remove", label: `Remove ${name}…`, keywords: "delete destroy", shortcut: "e d" },
      { id: "help", label: "Show keyboard shortcuts", keywords: "help keys", shortcut: "?" },
      {
        id: "quit",
        label: handlers.quit ? "Detach from Agent Motel" : "Quit picker",
        keywords: "exit close",
        shortcut: "q",
      },
    ];
    return commands.filter((command): command is PaletteCommand => command !== undefined);
  };

  const paletteMatches = () => filterPaletteCommands(paletteCommands(), paletteQuery);

  // The palette's second group: every visible agent, fuzzily matched on name
  // plus the same haystack the sidebar filter uses (task, dir, provider, host).
  // Ignores any active sidebar filter — the palette searches the whole fleet.
  const paletteAgentMatches = (): PickerItem[] =>
    filterPaletteAgents(visibleItems(items, "", showAll), paletteQuery);

  const paletteTotal = () => paletteMatches().length + paletteAgentMatches().length;

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
      role: "role",
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
        const options = currentModelOptions();
        const selected = options.find((option) => option.id === newModel);
        value = newModel ? newModel + cursor : `${THEME.muted}default${rowBase}${cursor}`;
        const note = selected
          ? (selected.description ?? "")
          : (newModel ? "not in this machine's list" : "");
        const detail = note || (options.length > 1 ? "← → choose · or type" : "");
        const short = detail.length > 34 ? `${detail.slice(0, 33)}…` : detail;
        hint = short ? `${THEME.faint}${short}${rowBase}` : "";
      } else if (field === "provider") {
        value = optionStrip(PROVIDER_OPTIONS, newProviderIdx, rowBase, field);
      } else if (field === "role") {
        const selectedRole = roleOptions[newRoleIdx]!;
        value = `${THEME.muted}‹${rowBase} ${THEME.cyan}${selectedRole.name || "none"}${rowBase} ${THEME.muted}›${rowBase}`;
        hint = selectedRole.description ? `${THEME.faint}${selectedRole.description}${rowBase}` : "";
      } else if (field === "effort") {
        const options = currentEffortOptions();
        const selected = Math.max(0, options.indexOf(newEffort || "default"));
        value = optionStrip(options, selected, rowBase, field);
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
    const selectedRole = roleOptions[newRoleIdx]?.name;
    const roleSummary = selectedRole ? ` as ${THEME.cyan}${selectedRole}${THEME.muted}` : "";
    const summary = `${THEME.muted}  will run ${providerColor}${provider}${THEME.muted}${roleSummary} ${where}${worktree} ${THEME.blue}${newDir || "the current directory"}${THEME.form}`;
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

  // Fallback palette when no popup host is wired (outside tmux): a centered
  // overlay panel near the top of the screen, same borderless #16161e
  // vocabulary as the create dialog, rendered over the app background.
  const PALETTE_TOP = 4;
  const renderPalette = (cols: number, rows: number): string[] => {
    const panelWidth = Math.max(20, Math.min(72, cols - 4));
    const footerCells = handlers.setKeyBar ? [] : keyBar("palette", handlers, cols, true);
    pushKeyBar("palette", true);
    const available = Math.max(0, rows - footerCells.length);
    const panel = paletteScreenRows({
      commands: paletteMatches(),
      agents: paletteAgentMatches(),
      attachLabel: handlers.select ? "lock in" : "attach",
      query: paletteQuery,
      cursor: paletteCursor,
      width: panelWidth,
      // Fixed chrome: pad, query, rule above — rule, footer, pad below.
      capacity: Math.max(1, available - PALETTE_TOP - 6),
    });
    paletteCursor = panel.cursor;

    const top = Math.min(PALETTE_TOP, Math.max(0, available - panel.rows.length));
    const left = Math.max(0, Math.floor((cols - panelWidth) / 2));
    const screen: string[] = Array.from({ length: top }, () => THEME.app + " ".repeat(cols) + RESET);
    for (const row of panel.rows) {
      const screenRow = screen.length + 1;
      if (row.entry !== undefined) paletteHitRows.set(screenRow, row.entry);
      screen.push(THEME.app + " ".repeat(left) + row.text + THEME.app + " ".repeat(Math.max(0, cols - left - panelWidth)) + RESET);
    }
    while (screen.length < available) screen.push(THEME.app + " ".repeat(cols) + RESET);
    screen.push(...footerCells.map((cell) => `${cell.style ?? THEME.sidebar}${padAnsi(cell.text, cols)}${RESET}`));
    return screen.slice(0, rows);
  };

  const render = () => {
    const cols = process.stdout.columns ?? 80;
    const rows = process.stdout.rows ?? 24;
    listHitRows.clear();
    paletteHitRows.clear();
    renderedSidebarWidth = cols;

    if (mode === "new-form") {
      out("\x1b[H" + renderForm(cols, rows).map((l) => CLEAR_LINE + l).join("\r\n"));
      return;
    }

    if (mode === "palette") {
      out("\x1b[H" + renderPalette(cols, rows).map((l) => CLEAR_LINE + l).join("\r\n"));
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
        text: roleFilter
          ? `${THEME.cyan}role: ${roleFilter}${THEME.faint} · r next · f filter${THEME.sidebar}`
          : exited > 0
          ? `${THEME.faint}${exited} exited · ${THEME.muted}a${THEME.faint} ${showAll ? "hide" : "all"} · ${THEME.muted}f${THEME.faint} filter${THEME.sidebar}`
          : `${THEME.faint}${current.length === 0 ? "no active agents" : "f filter · / search chats"}${THEME.sidebar}`,
        style: THEME.sidebar,
      },
      { text: `${THEME.border}${"─".repeat(sidebarWidth)}${THEME.sidebar}`, style: THEME.sidebar },
    ];
    const prompt: Cell | null =
      mode === "cd-dir"
        ? { text: `${THEME.blue}cd to${THEME.sidebar}  ${cdDir}${THEME.blue}▌${THEME.sidebar}`, style: THEME.sidebar }
        : mode === "rename-name"
          ? { text: `${THEME.blue}rename to${THEME.sidebar}  ${renameName}${THEME.blue}▌${THEME.sidebar}`, style: THEME.sidebar }
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
        ...(handlers.concierge ? [`${key("c")} ask the concierge`] : []),
        `${key("f")} filter names/tasks`,
        `${key("r")} filter by role`,
        `${key("t")} toggle tree/flat list`,
        `${key("/")} search conversations`,
        `${key("ctrl-k")} command palette`,
        ...(handlers.regroup ? [`${key("g")} group host/project`] : []),
        ...(handlers.resort ? [`${key("s")} cycle status/recent/role sort`] : []),
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
        const treePrefix = item.treePrefix ?? "";
        const treePrefixWidth = visibleWidth(treePrefix);
        const icon = item.icon ?? "";
        const iconWidth = icon ? visibleWidth(icon) + 1 : 0;
        const requestedRight = item.right ?? "";
        const statusAge = item.statusAge ?? "";
        const queue = (item.queueDepth ?? 0) > 0 ? `▸${item.queueDepth}` : "";
        const badge = item.badge ?? "";
        const fixedSuffixWidth =
          (statusAge ? visibleWidth(statusAge) + 1 : 0) +
          (queue ? visibleWidth(queue) + 1 : 0) +
          (badge ? visibleWidth(badge) + 2 : 0);
        const rightWidth = requestedRight ? visibleWidth(requestedRight) + 1 : 0;
        const minLabelWidth = Math.min(8, visibleWidth(item.label));
        const right = sidebarWidth - 2 - treePrefixWidth - iconWidth - fixedSuffixWidth - rightWidth >= minLabelWidth
          ? requestedRight
          : "";
        // Provider tag is plain colored text with a one-cell right inset.
        const suffixWidth = fixedSuffixWidth + (right ? rightWidth : 0);
        const labelWidth = Math.max(1, sidebarWidth - 2 - treePrefixWidth - iconWidth - suffixWidth);
        const label = clipLine(item.label, labelWidth).padEnd(labelWidth);
        const treeSeg = treePrefix ? `${THEME.muted}${treePrefix}${restore}` : "";
        const iconSeg = icon ? `${item.iconStyle ?? THEME.muted}${icon}${restore} ` : "";
        const labelSeg = selectedRow
          ? `${THEME.bright}${BOLD}${label}${NORMAL_WEIGHT}${restore}`
          : `${item.labelStyle ?? THEME.text}${label}${restore}`;
        const rightSeg = right ? ` ${selectedRow ? THEME.muted : (item.rightStyle ?? THEME.muted)}${right}${restore}` : "";
        const statusAgeSeg = statusAge ? ` ${THEME.muted}${statusAge}${restore}` : "";
        const queueSeg = queue ? ` ${THEME.yellow}${queue}${restore}` : "";
        const badgeStyle = (selectedRow ? item.badgeSelectedStyle : undefined) ?? item.badgeStyle ?? THEME.muted;
        const badgeSeg = badge ? ` ${badgeStyle}${badge}${restore} ` : "";
        side.push({ text: prefix + treeSeg + iconSeg + labelSeg + rightSeg + statusAgeSeg + queueSeg + badgeSeg, style: rowStyle });
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

  let pickerActive = true;
  const reload = () => {
    if (!pickerActive) return;
    items = load();
    refreshActivity();
    render();
  };
  let unsubscribe = () => {};
  try {
    unsubscribe = handlers.subscribe?.(reload) ?? unsubscribe;
  } catch {
    // The periodic reload below is the fallback when subscription setup fails.
  }
  // Preview/activity still repaint once a second. Fleet data reloads at the
  // old cadence without events, or every five seconds as a consistency check
  // when the daemon stream is active.
  const renderRefresh = setInterval(() => {
    refreshActivity();
    render();
  }, RENDER_REFRESH_MS);
  const loadRefresh = setInterval(reload, handlers.subscribe ? EVENT_FALLBACK_REFRESH_MS : RENDER_REFRESH_MS);
  // Provider quota for the key bar. Polled only while the UI is up; the
  // one-second repaint picks up each new reading.
  const stopUsagePolling = startUsagePolling();
  const onResize = () => render();
  process.stdout.on("resize", onResize);

  const result = await new Promise<string | null>((resolve) => {
    let finished = false;
    // True while the palette popup is up; guards against double-spawning.
    let paletteOpen = false;
    const finish = (value: string | null) => {
      finished = true;
      pickerActive = false;
      if (mode === "new-form" || mode === "palette") setForm(false); // un-zoom if we exit mid-overlay
      unsubscribe();
      clearInterval(renderRefresh);
      clearInterval(loadRefresh);
      stopUsagePolling();
      process.stdout.off("resize", onResize);
      process.stdin.off("data", onData);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      out(MOUSE_OFF + WRAP_ON + ALT_SCREEN_OFF + SHOW_CURSOR);
      resolve(value);
    };

    const beginCreate = () => {
      if (!handlers.create) return;
      mode = "new-form";
      newName = "";
      newTask = "";
      newDir = handlers.defaultDir?.(cursorName) ?? "";
      newHostIdx = 0;
      newProviderIdx = defaultProviderIdx;
      newModel = "";
      newEffort = "";
      newRoleIdx = 0;
      formIdx = 0;
      formCandidates = [];
      dirQuerying = false;
      dirQueryGen++;
      feedback = null;
      refreshRoleOptions();
      refreshCatalogs();
      setForm(true); // zoom the sidebar pane to full screen
    };

    const refreshRoleOptions = () => {
      const selected = roleOptions[newRoleIdx]?.name;
      const host = hostOptions[newHostIdx] === "local" ? undefined : hostOptions[newHostIdx];
      const gen = ++roleQueryGen;
      const applyRoles = (roles: RoleOption[]) => {
        const previousFields = fields;
        const previousFormIdx = formIdx;
        roleOptions = [{ name: "", description: "No custom role" }, ...roles];
        newRoleIdx = selected ? Math.max(0, roleOptions.findIndex((role) => role.name === selected)) : 0;
        fields = formFields(hostOptions.length > 1, roleOptions.length > 1);
        formIdx = preservedFieldIndex(previousFields, previousFormIdx, fields);
      };
      try {
        const roles = configuredRoles(host);
        if (Array.isArray(roles)) {
          applyRoles(roles);
          return;
        }
        applyRoles([]);
        feedback = { text: `loading roles from ${host}…`, level: "info" };
        roles.then(
          (loaded) => {
            if (finished || gen !== roleQueryGen) return;
            applyRoles(loaded);
            feedback = null;
            render();
          },
          (error: Error) => {
            if (finished || gen !== roleQueryGen) return;
            applyRoles([]);
            feedback = { text: error.message, level: "warn" };
            render();
          },
        );
      } catch (error) {
        applyRoles([]);
        feedback = { text: (error as Error).message, level: "warn" };
      }
    };

    // Model / effort options for whichever machine the agent will land on.
    // Remote catalogs arrive over ssh, so a stale reply (host changed while it
    // was in flight) is dropped by the generation counter; until one lands the
    // fields simply show the fallbacks.
    const refreshCatalogs = () => {
      if (!handlers.catalogOptions) return;
      const host = hostOptions[newHostIdx] === "local" ? undefined : hostOptions[newHostIdx];
      const gen = ++catalogQueryGen;
      const apply = (loaded: ProviderCatalog[]) => {
        catalogs = loaded;
        reconcileModelEffort();
      };
      try {
        const loaded = handlers.catalogOptions(host);
        if (Array.isArray(loaded)) {
          apply(loaded);
          return;
        }
        // Nothing is known about the new host until the round-trip lands —
        // clear the lists but keep the selection, which its reply may support.
        catalogs = [];
        loaded.then(
          (result) => {
            if (finished || gen !== catalogQueryGen) return;
            apply(result);
            render();
          },
          () => {
            // A host that can't answer `am models` isn't worth a banner — the
            // form keeps working with the fallback lists.
            if (finished || gen !== catalogQueryGen) return;
            apply([]);
            render();
          },
        );
      } catch {
        apply([]);
      }
    };

    // Keep the selection legal after the provider or catalog changes: a model
    // the new provider doesn't list falls back to the provider default rather
    // than being sent as-is.
    const reconcileModelEffort = () => {
      const catalog = catalogFor(catalogs, PROVIDER_OPTIONS[newProviderIdx]);
      if (newModel && catalog?.modelsExhaustive && !findModel(catalog, newModel)) newModel = "";
      reconcileEffort();
    };

    // Selecting a role that pins a provider moves the strip with it — the form
    // then shows what the spawn would actually do (and its model/effort
    // options follow that provider's catalog). Moving off that role puts the
    // strip back where the user had it, so a pin never leaks onto a role that
    // doesn't have one.
    let providerBeforePin: number | null = null;
    const applyRolePin = () => {
      const pinned = roleOptions[newRoleIdx]?.provider;
      const idx = pinned ? PROVIDER_OPTIONS.indexOf(pinned) : -1;
      const next = idx >= 0 ? idx : providerBeforePin;
      if (idx >= 0) providerBeforePin ??= newProviderIdx;
      else providerBeforePin = null;
      if (next !== null && next !== newProviderIdx) {
        newProviderIdx = next;
        reconcileModelEffort();
      }
    };

    // Editing the model narrows the effort list (codex levels are per model),
    // so drop a level the new model doesn't support — leaving it selected but
    // undisplayable is how you get an error about a value you never saw.
    const reconcileEffort = () => {
      if (!newEffort) return;
      const catalog = catalogFor(catalogs, PROVIDER_OPTIONS[newProviderIdx]);
      if (!catalog) return; // catalog unknown: keep what the user picked
      if (!effortOptionsFor(catalogs, PROVIDER_OPTIONS[newProviderIdx], newModel).includes(newEffort)) newEffort = "";
    };

    const submitCreate = () => {
      if (creating || !handlers.create) return;
      creating = true;
      render();
      const host = hostOptions[newHostIdx] === "local" ? undefined : hostOptions[newHostIdx];
      const provider = PROVIDER_OPTIONS[newProviderIdx];
      const effort = newEffort || undefined;
      const role = roleOptions[newRoleIdx]?.name || undefined;
      handlers.create({
        name: newName,
        task: newTask || undefined,
        dir: newDir.trim() || undefined,
        host,
        provider,
        model: newModel.trim() || undefined,
        effort,
        role,
      }).then(
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
          newEffort = "";
          newRoleIdx = 0;
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

    // Jump to a palette-picked agent, bypassing any active sidebar filter.
    const jumpToPaletteAgent = (name: string) => {
      mode = "list";
      filter = "";
      cursorName = name;
      const idx = filtered().findIndex((i) => i.name === name);
      if (idx >= 0) cursor = idx;
      activateSelection();
    };

    // Ensure-then-select the fleet concierge. Ensuring (create or revive,
    // possibly over ssh) can take a moment, so it runs deferred with a banner,
    // like move/handoff. Selection goes by KEY, not by row: a concierge just
    // created on a remote host isn't in the cached fleet rows yet, so waiting
    // for (or worse, cursor-guessing) its row would select the wrong agent.
    let conciergeOpening = false;
    const openConcierge = () => {
      if (!handlers.concierge || conciergeOpening) return;
      conciergeOpening = true;
      feedback = { text: "opening the concierge…", level: "info" };
      render();
      Promise.resolve()
        .then(handlers.concierge)
        .then(
          (key) => {
            conciergeOpening = false;
            if (finished) return;
            feedback = null;
            // Clear filters so the concierge row is visible once it loads.
            mode = "list";
            filter = "";
            roleFilter = null;
            chatQuery = "";
            chatMatch = null;
            chatOrder = [];
            items = load();
            cursorName = key;
            const idx = filtered().findIndex((i) => i.name === key);
            if (idx >= 0) cursor = idx;
            if (!handlers.select) return finish(key);
            feedback = asFeedback(handlers.select(key));
            refreshActivity();
            render();
          },
          (error: Error) => {
            conciergeOpening = false;
            if (finished) return;
            feedback = { text: error.message, level: "error" };
            render();
          },
        );
    };

    // Execute a palette command by id — shared by the popup overlay (result
    // arrives from the `am __palette` process) and the in-picker fallback.
    const runPaletteCommand = (id: string) => {
      const target = filtered()[cursor];
      if (id.startsWith("role:")) {
        roleFilter = id.slice(5) === "all" ? null : id.slice(5);
        mode = "list";
        cursor = 0;
        cursorName = filtered()[0]?.name ?? null;
        feedback = { text: roleFilter ? `showing role: ${roleFilter}` : "showing all roles", level: "info" };
        return;
      }
      switch (id) {
        case "open":
          mode = "list";
          activateSelection();
          break;
        case "create":
          beginCreate();
          break;
        case "concierge":
          mode = "list";
          openConcierge();
          break;
        case "filter":
          mode = "filter";
          break;
        case "search":
          mode = "search";
          break;
        case "toggle-all":
          mode = "list";
          showAll = !showAll;
          break;
        case "toggle-hierarchy":
          mode = "list";
          showHierarchy = !showHierarchy;
          feedback = { text: showHierarchy ? "showing parent tree" : "showing flat list", level: "info" };
          break;
        case "regroup":
          mode = "list";
          if (handlers.regroup) feedback = asFeedback(handlers.regroup());
          items = load();
          break;
        case "resort":
          mode = "list";
          if (handlers.resort) feedback = asFeedback(handlers.resort());
          items = load();
          break;
        case "move":
          mode = "list";
          if (handlers.move) runDeferred("moving", handlers.move);
          break;
        case "clone":
          mode = "list";
          if (handlers.clone) runDeferred("cloning", handlers.clone);
          break;
        case "handoff":
          mode = "list";
          if (handlers.handoff) runDeferred("handing off", handlers.handoff);
          break;
        case "rename":
          if (target && handlers.rename) {
            mode = "rename-name";
            renameTarget = target.name;
            renameName = "";
          }
          break;
        case "cd":
          if (target && handlers.cd) {
            mode = "cd-dir";
            cdTarget = target.name;
            cdDir = handlers.cdPrefill?.(target.name) ?? "";
          }
          break;
        case "stop":
          mode = "list";
          if (handlers.stop) runAction(handlers.stop);
          break;
        case "remove":
          if (target && handlers.remove) {
            mode = "edit";
            confirmRemove = target.name;
          }
          break;
        case "help":
          mode = "help";
          break;
        case "quit":
          if (handlers.quit) handlers.quit();
          else return finish(null);
          mode = "list";
          break;
      }
    };

    // Enter in the fallback (in-picker) palette: entries past the command
    // group are agents.
    const executePaletteCommand = () => {
      const commands = paletteMatches();
      const agent = paletteCursor >= commands.length
        ? paletteAgentMatches()[paletteCursor - commands.length]
        : undefined;
      const command = paletteCursor < commands.length ? commands[paletteCursor] : undefined;
      if (!command && !agent) return;
      paletteQuery = "";
      paletteCursor = 0;
      feedback = null;
      // Un-zoom the palette overlay — except into the create form, which is
      // itself zoomed (beginCreate re-asserts it; skipping the toggle avoids
      // a flicker through the split view).
      if (command?.id !== "create") setForm(false);
      if (agent) jumpToPaletteAgent(agent.name);
      else runPaletteCommand(command!.id);
    };

    // Popup palette: hand the current commands + fleet to the overlay host
    // and execute whatever it resolves with. The picker keeps refreshing
    // underneath — the popup floats above it.
    const openPalettePopup = () => {
      if (paletteOpen || !handlers.palettePopup) return;
      paletteOpen = true;
      pushKeyBar("palette", true);
      const spec: PaletteSpec = {
        commands: paletteCommands(),
        agents: visibleItems(items, "", showAll).map((i) => ({
          name: i.name,
          label: i.label,
          search: i.search,
          icon: i.icon,
          iconStyle: i.iconStyle,
          badge: i.badge,
          badgeStyle: i.badgeStyle,
          role: i.role,
        })),
        attachLabel: handlers.select ? "lock in" : "attach",
      };
      handlers.palettePopup(spec).then(
        (result) => {
          paletteOpen = false;
          if (finished) return;
          if (result) {
            feedback = null;
            if (result.type === "agent") jumpToPaletteAgent(result.name);
            else runPaletteCommand(result.id);
          }
          if (!finished) render();
        },
        () => {
          paletteOpen = false;
          if (!finished) render();
        },
      );
    };

    const handleKey = (key: string) => {
      if (key === "\x03") return finish(null); // ctrl-c

      if ((key === "\x0b" || key === "\x10") && mode !== "new-form") { // ctrl-k (and legacy ctrl-p)
        if (handlers.palettePopup) {
          openPalettePopup();
          return;
        }
        if (mode === "palette") {
          mode = paletteReturnMode === "palette" ? "list" : paletteReturnMode;
          paletteQuery = "";
          paletteCursor = 0;
          setForm(false);
        } else {
          paletteReturnMode = mode;
          mode = "palette";
          paletteQuery = "";
          paletteCursor = 0;
          feedback = null;
          setForm(true); // the overlay is full-screen, like the create form
        }
        return render();
      }

      // Mouse wheel follows the list. A left click activates an agent row or,
      // in the create form, moves the focus ring to the clicked field.
      // Releases and clicks outside known rows are deliberately ignored.
      const mouse = parseMouseEvent(key);
      if (mouse) {
        if (mouse.pressed && (mouse.button === 64 || mouse.button === 65)) {
          if (mode === "palette") {
            paletteCursor = Math.min(
              Math.max(0, paletteCursor + (mouse.button === 64 ? -1 : 1)),
              Math.max(0, paletteTotal() - 1),
            );
          } else {
            moveCursor(mouse.button === 64 ? -1 : 1);
          }
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
          } else if (mode === "palette" && mouse.x <= renderedSidebarWidth) {
            const clickedIndex = paletteHitRows.get(mouse.y);
            if (clickedIndex !== undefined) {
              paletteCursor = clickedIndex;
              executePaletteCommand();
              if (!finished) render();
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

      if (mode === "palette") {
        if (key === "\x1b") {
          mode = paletteReturnMode === "palette" ? "list" : paletteReturnMode;
          paletteQuery = "";
          paletteCursor = 0;
          setForm(false);
        } else if (key === "\r" || key === "\n") {
          executePaletteCommand();
        } else if (key === "\x1b[A") {
          paletteCursor = Math.max(0, paletteCursor - 1);
        } else if (key === "\x1b[B") {
          paletteCursor = Math.min(Math.max(0, paletteTotal() - 1), paletteCursor + 1);
        } else if (key === "\x7f" || key === "\b") {
          paletteQuery = paletteQuery.slice(0, -1);
          paletteCursor = 0;
        } else if (key >= " " && !key.startsWith("\x1b")) {
          paletteQuery += key;
          paletteCursor = 0;
        }
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
        } else if (key === "n" && handlers.rename) {
          mode = "rename-name";
          renameTarget = target.name;
          renameName = "";
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
          newEffort = "";
          newRoleIdx = 0;
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
          if (field === "provider") {
            newProviderIdx = cycleField(newProviderIdx, PROVIDER_OPTIONS.length, dir);
            providerBeforePin = null; // an explicit choice outranks the role's pin
            reconcileModelEffort();
          } else if (field === "model") {
            const options = currentModelOptions();
            const current = options.findIndex((option) => option.id === newModel);
            // A typed-in model isn't in the list: cycling starts from "default".
            newModel = options[cycleField(current < 0 ? 0 : current, options.length, dir)]!.id;
            reconcileEffort();
          } else if (field === "effort") {
            const options = currentEffortOptions();
            const current = Math.max(0, options.indexOf(newEffort || "default"));
            const next = options[cycleField(current, options.length, dir)]!;
            newEffort = next === "default" ? "" : next;
          } else if (field === "role") {
            newRoleIdx = cycleField(newRoleIdx, roleOptions.length, dir);
            applyRolePin();
          } else if (field === "where") {
            newHostIdx = cycleField(newHostIdx, hostOptions.length, dir);
            refreshRoleOptions();
            refreshCatalogs();
          }
        } else if (key === "\x7f" || key === "\b") {
          if (field === "name") {
            newName = newName.slice(0, -1);
            feedback = null;
          }
          else if (field === "task") newTask = newTask.slice(0, -1);
          else if (field === "model") {
            newModel = newModel.slice(0, -1);
            reconcileEffort();
          }
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
          else if (field === "model") {
            newModel += key;
            reconcileEffort();
          }
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

      if (mode === "rename-name") {
        if (key === "\x1b") {
          mode = "list";
          renameName = "";
          renameTarget = null;
          feedback = null;
        } else if (key === "\r" || key === "\n") {
          const target = renameTarget;
          const next = renameName.trim();
          if (!next) {
            feedback = { text: "new agent name is required", level: "warn" };
            return render();
          }
          mode = "list";
          renameName = "";
          renameTarget = null;
          if (target && handlers.rename) {
            feedback = { text: `renaming ${target} to ${next}…`, level: "info" };
            Promise.resolve()
              .then(() => handlers.rename!(target, next))
              .then(
                (message) => {
                  const result = asFeedback(message);
                  feedback = result;
                  if (result?.level !== "error") cursorName = renamedPickerKey(target, next);
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
          renameName = renameName.slice(0, -1);
        } else if (key >= " " && !key.startsWith("\x1b")) {
          if (/^[a-zA-Z0-9_-]$/.test(key)) {
            renameName += key;
            feedback = null;
          } else {
            feedback = { text: "use letters, numbers, dashes, or underscores", level: "warn" };
          }
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
        beginCreate();
      } else if (key === "c" && handlers.concierge) {
        openConcierge();
      } else if (key === "a") {
        showAll = !showAll;
        feedback = null;
      } else if (key === "t") {
        showHierarchy = !showHierarchy;
        feedback = { text: showHierarchy ? "showing parent tree" : "showing flat list", level: "info" };
      } else if (key === "r") {
        const options = pickerRoleFilterOptions(items);
        const current = roleFilter ? options.indexOf(roleFilter) : -1;
        roleFilter = current + 1 < options.length ? options[current + 1]! : null;
        cursor = 0;
        cursorName = filtered()[0]?.name ?? null;
        feedback = { text: roleFilter ? `showing role: ${roleFilter}` : "showing all roles", level: "info" };
      } else if (key === "g" && handlers.regroup) {
        feedback = asFeedback(handlers.regroup());
        items = load();
      } else if (key === "s" && handlers.resort) {
        feedback = asFeedback(handlers.resort());
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
