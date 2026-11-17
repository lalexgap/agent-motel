// Small element helpers shared by the views.
import { blockingDecisions, decisionsName, decisionsTitle, openDecisions } from "./decisions";
import { statusLabel } from "./fleet";
import type { AgentRow, TranscriptEntry } from "./types";

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

// Whether two rendered nodes look the same, ignoring the named attributes
// (ones the caller sets again after rendering) and a status dot's spin phase.
function sameNode(a: Node, b: Node, ignore: ReadonlySet<string>): boolean {
  if (a.nodeType !== b.nodeType) return false;
  if (!(a instanceof Element) || !(b instanceof Element)) return a.isEqualNode(b);
  if (a.tagName !== b.tagName) return false;
  const skip = (name: string) => ignore.has(name) || (name === "style" && a.classList.contains("dot"));
  const names = (node: Element) => node.getAttributeNames().filter((name) => !skip(name));
  const attributes = names(a);
  if (attributes.length !== names(b).length || attributes.some((name) => a.getAttribute(name) !== b.getAttribute(name))) return false;
  if (a.childNodes.length !== b.childNodes.length) return false;
  for (let index = 0; index < a.childNodes.length; index++) {
    if (!sameNode(a.childNodes[index]!, b.childNodes[index]!, ignore)) return false;
  }
  return true;
}

// Replaces `parent`'s children with `next` but keeps each current child that
// renders the same, matched by `key`, so a refresh that changes one row leaves
// the others' layout and running animations alone. Only for nodes without
// listeners of their own: a kept node keeps its old ones.
export function reconcileChildren(parent: Element, next: readonly Element[], key: (node: Element) => string | undefined,
                                  ignore: readonly string[] = []): void {
  const skip = new Set(ignore);
  const current = [...parent.children];
  const byKey = new Map<string, Element>();
  for (const node of current) {
    const id = key(node);
    if (id !== undefined && !byKey.has(id)) byKey.set(id, node);
  }
  const unkeyed = current.filter((node) => key(node) === undefined);
  const kept = new Set<Element>();
  const plan = next.map((node) => {
    const id = key(node);
    const match = id !== undefined ? byKey.get(id) : unkeyed.find((old) => !kept.has(old) && sameNode(old, node, skip));
    if (match && !kept.has(match) && sameNode(match, node, skip)) {
      kept.add(match);
      return match;
    }
    return node;
  });
  for (const node of current) if (!kept.has(node)) node.remove();
  let cursor = parent.firstElementChild;
  for (const node of plan) {
    if (node === cursor) cursor = cursor.nextElementSibling;
    else parent.insertBefore(node, cursor);
  }
  // Text nodes are not rendered children here; anything left after the plan goes.
  while (cursor) {
    const after = cursor.nextElementSibling;
    cursor.remove();
    cursor = after;
  }
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
export function decisionsBadge(row: AgentRow, now = Date.now()): HTMLElement | null {
  const open = openDecisions(row);
  if (!open) return null;
  const node = h("span", `am-decisions${blockingDecisions(row) ? " blocking" : ""}`, String(open));
  node.setAttribute("role", "img");
  node.setAttribute("aria-label", decisionsName(row));
  node.title = decisionsTitle(row, now);
  return node;
}
