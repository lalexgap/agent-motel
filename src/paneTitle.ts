// tmux's byte-oriented regex ranges cannot span multibyte C1 characters.
const c1Controls = Array.from({ length: 32 }, (_, i) => String.fromCharCode(128 + i)).join("|");
export const HUB_TITLE_FORMAT = `#{s/[\x01-\x1f\x7f]|${c1Controls}//:pane_title}`;

export function safePaneTitle(title: string): string {
  return title.replace(/[\x00-\x1f\x7f-\x9f]/g, "") || "am";
}

export function paneTitleSequence(title: string): string {
  return `\x1b]2;${safePaneTitle(title)}\x07`;
}

export function tmuxPaneTitle(title: string): string {
  return safePaneTitle(title).replace(/#/g, "##");
}
