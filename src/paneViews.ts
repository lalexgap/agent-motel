import { stripSgr } from "./tmux";

// What a provider's pane shows where its composer goes. Kept free of the
// delivery code, which asks the same question before it types.

export type PaneView = "dialog" | "composer" | "unknown";

const RULE_RE = /─{8,}/;
const CLAUDE_SELECTED_RE = /^\s*❯\s*\d+\.\s+\S/;
const CLAUDE_FOOTER_RE = /^\s*(?:Esc to cancel|Enter to (?:select|confirm))\b/i;
// Rows under the composer: the mode line, plus one per background subagent.
const CLAUDE_STATUS_ROWS = 40;

export function plainLines(pane: string[]): string[] {
  const lines = pane.map((line) => stripSgr(line).trimEnd());
  while (lines.length && !lines.at(-1)) lines.pop();
  return lines;
}

// Claude draws a dialog in place of its composer, under the last rule. Only
// what is under that rule is read, so transcript text can't pass for either.
export function claudePaneView(pane: string[]): PaneView {
  const lines = plainLines(pane);
  const rules: number[] = [];
  for (let i = 0; i < lines.length; i++) if (RULE_RE.test(lines[i]!)) rules.push(i);
  const last = rules.at(-1) ?? -1;
  const below = lines.slice(last + 1);
  if (below.some((line) => CLAUDE_SELECTED_RE.test(line) || CLAUDE_FOOTER_RE.test(line))) return "dialog";
  if (rules.length < 2 || below.length > CLAUDE_STATUS_ROWS) return "unknown";
  const box = lines.slice(rules.at(-2)! + 1, last);
  return box.length > 0 && /^\s*❯/.test(box[0]!) ? "composer" : "unknown";
}
