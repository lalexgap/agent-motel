// Small element helpers shared by the views.
import { statusLabel } from "./fleet";
import type { TranscriptEntry } from "./types";

interface AgentTranscriptApi {
  icon(name: string, className?: string): SVGElement;
  renderEntries(view: HTMLElement, entries: TranscriptEntry[], options: { agentName: string; readBoundary?: number | null }): void;
  chatTurn(entry: { kind: "user"; text: string; index: string }, agentName: string): HTMLElement;
  preserveConversationScroll(view: HTMLElement, threshold: number): (follow?: boolean) => void;
}
declare global {
  interface Window {
    agentTranscript: AgentTranscriptApi;
  }
}

export const $ = <T extends HTMLElement = HTMLElement>(id: string): T => {
  const node = document.getElementById(id);
  if (!node) throw new Error(`missing #${id}`);
  return node as T;
};
export function h<K extends keyof HTMLElementTagNameMap>(tag: K, className = "", text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export const composerInput = () => $<HTMLTextAreaElement>("composer-input");

export const isTyping = (target: EventTarget | null): boolean =>
  target instanceof HTMLElement && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName));

// execCommand first: it only works synchronously inside the user's click.
export async function copyText(text: string): Promise<boolean> {
  const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const area = h("textarea", "am-copy-buffer");
  area.value = text;
  area.readOnly = true;
  area.setAttribute("aria-hidden", "true");
  area.tabIndex = -1;
  document.body.append(area);
  area.select();
  let ok = false;
  try {
    ok = document.execCommand("copy");
  } catch {
    ok = false;
  }
  area.remove();
  previous?.focus({ preventScroll: true });
  if (ok) return true;
  try {
    if (!navigator.clipboard?.writeText) return false;
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

export function dot(status: string): HTMLElement {
  const node = h("i", `dot ${["working", "idle", "needs-attention", "waiting", "dead", "exited", "starting"].includes(status) ? status : ""}`);
  node.setAttribute("aria-hidden", "true");
  // Re-renders replace the dot; phase the spin off a shared clock so it doesn't snap back.
  if (status === "working" || status === "waiting") node.style.animationDelay = `-${Math.round(performance.now() % 1600)}ms`;
  return node;
}
export function badge(status: string): HTMLElement {
  const node = h("span", "badge");
  node.append(dot(status), document.createTextNode(statusLabel(status)));
  return node;
}
