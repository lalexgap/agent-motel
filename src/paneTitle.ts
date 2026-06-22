export function safePaneTitle(title: string): string {
  return title.replace(/[\x00-\x1f\x7f-\x9f]/g, "") || "am";
}

export function paneTitleSequence(title: string): string {
  return `\x1b]2;${safePaneTitle(title)}\x07`;
}
