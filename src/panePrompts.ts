import { createHash } from "node:crypto";

export interface ClaudePromptOption {
  id: string;
  label: string;
  description?: string;
  other?: boolean;
}

export interface ClaudePrompt {
  id: string;
  kind: "question" | "permission";
  title: string;
  options: ClaudePromptOption[];
  selected: string;
  raw: string;
}

export type PromptKey = { key: string } | { text: string };
export interface ClaudePromptAnswer { optionId: string; text?: string }

// Grammar verified against the embedded W7, Qe/Fi and M4 UI source in the
// installed Claude Code 2.1.318 binary. Captures must be the visible pane,
// not scrollback. The transport owns freshness, identity and replay guards.
const rowPattern = /^( *)(❯)? *(\d+)\. +(.+)$/;
const rulePattern = /^\s*[─━\-]{5,}\s*$/;
const questionFooter = /^Enter to select\s*·\s*(?:↑\/↓ to navigate|Tab\/Arrow keys to navigate)(?:\s*·\s*Ctrl\+g to edit in [^·]+)?\s*·\s*Esc to cancel$/i;
const permissionFooter = /^Esc to cancel(?:\s*·\s*Tab to amend)?$/i;
const otherPattern = /^(?:Type something\.|Other)$/;

export function detectClaudePrompt(pane: string): ClaudePrompt | null {
  if (typeof pane !== "string" || pane.length > 200_000) return null;
  const clean = pane.replace(/\x1b\[[0-9;:]*m/g, "").replace(/\r\n/g, "\n");
  if (/[\x00-\x09\x0b-\x1f\x7f-\x9f]/.test(clean)) return null;
  const lines = clean.split("\n").map(line => line.trimEnd());
  while (lines.length && !lines.at(-1)) lines.pop();
  const footer = lines.at(-1)?.trim() ?? "";
  const kind = questionFooter.test(footer) ? "question" : permissionFooter.test(footer) ? "permission" : null;
  if (!kind) return null;

  const end = lines.length - 1;
  let selectedLine = -1;
  for (let i = end - 1; i >= 0; i--) {
    if (/^ *❯ *\d+\. /.test(lines[i]!)) { selectedLine = i; break; }
  }
  if (selectedLine < 0) return null;
  let first = selectedLine;
  while (first >= 0 && rowPattern.exec(lines[first]!)?.[3] !== "1") first--;
  if (first < 1) return null;

  let start = first - 1;
  if (kind === "permission") {
    const boundaries: number[] = [];
    for (let i = 0; i < first - 1; i++) {
      if (rulePattern.test(lines[i]!) && lines[i + 1]?.trim() === "Bash command") boundaries.push(i);
    }
    if (boundaries.length !== 1) return null;
    start = boundaries[0]!;
  } else {
    while (start > 0 && !rulePattern.test(lines[start]!)) start--;
  }
  const raw = lines.slice(start, end + 1).join("\n");
  // Checkbox rows, clipped menus, preview layouts and feedback editors have
  // different focus/submit semantics; leave them to the raw terminal.
  if (/^ *[❯↑↓]? *\d+\. *(?:\[[ xX]\]|[☐☑☒□■✓✔])/m.test(raw)
    || /(?:space to (?:select|toggle)|multi-select|-- (?:INSERT|NORMAL|VISUAL) --|terminal is too (?:short|small|narrow)|more (?:lines|options)|tell Claude what to do)/i.test(raw)
    || /^ *[↑↓] *\d+\./m.test(raw)) return null;

  const options: ClaudePromptOption[] = [];
  let selected: string | undefined;
  let chat = false;
  let separator = false;
  for (let i = first; i < end; i++) {
    const line = lines[i]!;
    if (!line.trim()) continue;
    if (rulePattern.test(line)) { separator = true; continue; }
    const match = rowPattern.exec(line);
    if (match) {
      const [, , pointer, id, label] = match;
      if (chat || id !== String(options.length + 1)) return null;
      if (pointer) {
        if (selected) return null;
        selected = id;
      }
      if (label === "Chat about this" && kind === "question") {
        if (pointer) return null;
        chat = true;
        continue;
      }
      if (separator || /[☐☑☒□■]|\[disabled\]|\(disabled\)/i.test(label!)) return null;
      const other = kind === "question" && otherPattern.test(label!);
      options.push({ id: id!, label: other ? "Other" : label!, ...(other ? { other: true } : {}) });
      continue;
    }
    const option = options.at(-1);
    if (!option || chat || separator || option.other || !/^ {4,}\S/.test(line)
      || /^\s*(?:❯|\d+\.|[↑↓]|[╭╰│])/u.test(line)) return null;
    option.description = option.description ? `${option.description}\n${line.trim()}` : line.trim();
  }
  if (!selected || options.length < 2 || options.length > 9 || !options.some(o => o.id === selected)) return null;
  const others = options.filter(o => o.other);
  if (others.length > 1 || (others.length && !options.at(-1)?.other)) return null;
  // In W7, the final input row precedes Chat. A populated input loses its
  // placeholder, so refusing that screen prevents treating text as an option.
  if (kind === "question" && chat && others.length !== 1) return null;
  if (kind === "permission" && (!options.some(o => /^Yes(?:$|[, .])/.test(o.label))
    || !options.some(o => /^No(?:$|[, .])/.test(o.label)))) return null;

  const heading: string[] = [];
  let headingStart = first;
  for (let i = first - 1; i >= start; i--) {
    const line = lines[i]!.trim();
    if (!line) { if (heading.length) break; continue; }
    if (rulePattern.test(line) || /[☐☑☒□■]|[←→].*Submit|^[❯>]/.test(line)) break;
    heading.unshift(line);
    headingStart = i;
  }
  const title = heading.join("\n");
  if (!title || title.length > 4000) return null;
  if (kind === "permission") {
    if (!/(?:Do you want to |Allow |trust (?:this|the) |Would you like to )[^\n]*\?/i.test(title)) return null;
    const command = lines.slice(start + 2, headingStart).map(line => line.trim()).filter(Boolean);
    if (!command.length) return null;
  }
  return { id: createHash("sha256").update(raw).digest("hex"), kind, title, options, selected, raw };
}

// Only build from a freshly detected server-side prompt. Execute steps in
// order with a render opportunity between them; never append another Enter.
export function buildPromptKeys(prompt: ClaudePrompt, answer: ClaudePromptAnswer): PromptKey[] {
  const parsed = detectClaudePrompt(prompt.raw);
  if (!parsed || JSON.stringify(parsed) !== JSON.stringify(prompt)) throw new Error("Invalid or changed Claude prompt");
  if (!answer || typeof answer.optionId !== "string") throw new Error("Invalid prompt option");
  const target = prompt.options.findIndex(option => option.id === answer.optionId);
  const current = prompt.options.findIndex(option => option.id === prompt.selected);
  if (target < 0 || current < 0) throw new Error("Invalid prompt option");
  const option = prompt.options[target]!;
  if (option.other) {
    if (typeof answer.text !== "string" || !answer.text.trim() || answer.text.length > 2000
      || /[\x00-\x1f\x7f-\x9f\u2028\u2029]/.test(answer.text)) throw new Error("Other requires a single line of text (maximum 2000 characters)");
  } else if (answer.text !== undefined) throw new Error("Text is only supported for Other");
  const steps: PromptKey[] = Array.from({ length: Math.abs(target - current) }, () => ({ key: target > current ? "Down" : "Up" }));
  if (option.other) steps.push({ text: answer.text! });
  steps.push({ key: "Enter" });
  return steps;
}
