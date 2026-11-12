// What the agent actions and their dialogs share: the agents with an action in
// flight, the activation keys still held down, failures shown near the header,
// and calling the bridge for an outcome.
import { keyToRelease, rejectionOutcome, resultOutcome, type ActionOutcome } from "./actions";
import { call } from "./bridge";
import { refreshConnection } from "./data";
import { parseAgentKey } from "./fleet";
import { flashStatus } from "./statusbar";
import { changed, state } from "./state";
import type { BridgeMethod, BridgeMethods } from "./types";

// One action per agent at a time: a second activation while one is in flight does nothing.
const pending = new Map<string, string>();
export const isPending = (key: string): boolean => pending.has(key);
export const pendingAction = (key: string): string | undefined => pending.get(key);
export function setPending(key: string, on: boolean, action = ""): void {
  if (on) pending.set(key, action);
  else pending.delete(key);
  changed("agent");
}

// Enter and Space while down. A confirmed action activated by one of them waits
// for its release, so a held key cannot answer the native sheet unread.
const held = new Set<string>();
const waiters = new Map<string, ((released: boolean) => void)[]>();
function settle(key: string, released: boolean): void {
  for (const resolve of waiters.get(key) ?? []) resolve(released);
  waiters.delete(key);
}
function giveUp(): void {
  for (const key of [...held]) settle(key, false);
  held.clear();
}
export function trackActivationKeys(): void {
  // macOS sends no keyup for a key released while ⌘ is down (⌘Enter sends a message).
  window.addEventListener("keydown", (event) => {
    if ((event.key === "Enter" || event.key === " ") && !event.metaKey) held.add(event.key);
  }, true);
  window.addEventListener("keyup", (event) => {
    if (event.key === "Meta") return giveUp();
    if (!held.delete(event.key)) return;
    settle(event.key, true);
  }, true);
  // The release can't be seen any more: give up rather than risk the sheet.
  window.addEventListener("blur", giveUp);
}
// False when the key's release was lost: nothing is sent.
export async function activationReleased(method: BridgeMethod): Promise<boolean> {
  const key = keyToRelease(method, held);
  if (!key) return true;
  const released = await new Promise<boolean>((resolve) => waiters.set(key, [...(waiters.get(key) ?? []), resolve]));
  if (!released) flashStatus("Nothing was sent: the key's release was not seen. Try again.", 8000, "error");
  return released;
}

export async function callOutcome<M extends BridgeMethod>(method: M, params: BridgeMethods[M]["params"]): Promise<ActionOutcome> {
  try {
    return resultOutcome((await call(method, params)) as BridgeMethods["agents.stop"]["result"], method);
  } catch (error) {
    return rejectionOutcome(error);
  }
}

// The side effects every failure has: a rejected token flags the connection,
// a missing agent refreshes the fleet.
export function noteFailure(key: string, outcome: Extract<ActionOutcome, { kind: "failed" }>): void {
  const connection = parseAgentKey(key)?.connection ?? "";
  if (outcome.tokenRejected) {
    const conn = state.conns.get(connection);
    if (conn) conn.tokenRejected = true;
    changed("status");
  }
  if (outcome.gone) void refreshConnection(connection);
}

// Failures of actions run outside a dialog: the status bar, and a line under the
// header while that agent is open.
export const failures = new Map<string, string>();
export function reportFailure(key: string, message: string): void {
  failures.set(key, message);
  flashStatus(`${parseAgentKey(key)?.id ?? key}: ${message}`, 8000, "error");
  changed("agent");
}
export function clearFailure(key: string): void {
  if (failures.delete(key)) changed("agent");
}
