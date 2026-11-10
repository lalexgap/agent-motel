// The page's only way out: the native WKScriptMessageHandlerWithReply in the
// Mac app, or the dev server's /__bridge endpoints when running in a browser.
import type { BridgeEventName, BridgeEvents, BridgeMethod, BridgeMethods } from "./types";

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
    try {
      return (await handler.postMessage({ method, params })) as BridgeMethods[M]["result"];
    } catch (error) {
      throw error instanceof Error ? error : new Error(String(error));
    }
  }
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
  return data.result as BridgeMethods[M]["result"];
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
