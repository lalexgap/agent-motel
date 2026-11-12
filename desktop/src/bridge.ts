// The page's only way out: the native WKScriptMessageHandlerWithReply in the
// Mac app, or the dev server's /__bridge endpoints when running in a browser.
import { CONFIRM_OPEN, confirmMessage, isConfirmMethod } from "./policy";
import type { BridgeEventName, BridgeEvents, BridgeMethod, BridgeMethods, DevConfirmation } from "./types";

interface NativeHandler {
  postMessage(message: { method: string; params: unknown }): Promise<unknown>;
}
declare global {
  interface Window {
    webkit?: { messageHandlers?: { am?: NativeHandler } };
    __amNativeEvent?: (name: string, payload: unknown) => void;
  }
}

type Handler<N extends BridgeEventName> = (payload: BridgeEvents[N]) => void;
const handlers = new Map<string, Set<(payload: unknown) => void>>();

function dispatch(name: string, payload: unknown): void {
  for (const handler of handlers.get(name) || []) {
    try {
      handler(payload);
    } catch (error) {
      console.error(`bridge event ${name} handler failed`, error);
    }
  }
}

const native = (): NativeHandler | undefined => window.webkit?.messageHandlers?.am;
export const isNative = (): boolean => !!native();

export async function call<M extends BridgeMethod>(method: M, params: BridgeMethods[M]["params"]): Promise<BridgeMethods[M]["result"]> {
  const handler = native();
  if (handler) {
    // The native shell runs the pre-check and its own alert for confirmed methods.
    try {
      return (await handler.postMessage({ method, params })) as BridgeMethods[M]["result"];
    } catch (error) {
      throw error instanceof Error ? error : new Error(String(error));
    }
  }
  if (isConfirmMethod(method)) return (await devConfirmed(method, params)) as BridgeMethods[M]["result"];
  return (await devCall(method, params)) as BridgeMethods[M]["result"];
}

async function devCall(method: string, params: unknown): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch("/__bridge", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ method, params }),
    });
  } catch {
    throw new Error("Dev bridge unreachable");
  }
  const data = (await response.json().catch(() => null)) as { result?: unknown; error?: string } | null;
  if (!data || typeof data.error === "string" || !response.ok) throw new Error(data?.error || `Dev bridge returned ${response.status}`);
  return data.result;
}

// Browser dev mode stands in for the native alert: only `dev.confirm` with the one-time ticket sends the write.
// Same-origin page code could call it directly; a dev-only boundary (/__bridge is loopback, same-origin, fixture tokens only).
let confirmOwner: object | null = null;

async function devConfirmed(method: string, params: unknown): Promise<unknown> {
  if (confirmOwner) throw new Error(CONFIRM_OPEN);
  const owner = {};
  confirmOwner = owner;
  let accepted = false;
  let ticket: string;
  try {
    const pending = (await devCall(method, params)) as { confirm?: DevConfirmation } | null;
    const confirmation = pending?.confirm;
    if (!confirmation || typeof confirmation.ticket !== "string") throw new Error("Dev bridge did not return a confirmation");
    ticket = confirmation.ticket;
    accepted = window.confirm(confirmMessage(confirmation.title, confirmation.body, confirmation.server, confirmation.url));
  } finally {
    if (confirmOwner === owner) confirmOwner = null;
  }
  if (!accepted) {
    devCall("dev.confirm", { ticket, accept: false }).catch(() => {});
    return { cancelled: true };
  }
  return devCall("dev.confirm", { ticket, accept: true });
}

export function on<N extends BridgeEventName>(name: N, handler: Handler<N>): () => void {
  const set = handlers.get(name) || new Set();
  handlers.set(name, set);
  const wrapped = handler as (payload: unknown) => void;
  set.add(wrapped);
  return () => set.delete(wrapped);
}

let devEvents: EventSource | null = null;
// Native events arrive through a page global; the dev server pushes the same
// {name, payload} pairs over SSE.
export function startBridge(): void {
  window.__amNativeEvent = (name, payload) => dispatch(name, payload);
  if (native() || devEvents) return;
  devEvents = new EventSource("/__bridge/events");
  devEvents.onmessage = (message) => {
    try {
      const { name, payload } = JSON.parse(message.data) as { name: string; payload: unknown };
      dispatch(name, payload);
    } catch (error) {
      console.error("bad dev bridge event", error);
    }
  };
}
