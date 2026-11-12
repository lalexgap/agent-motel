// Read requests to an am server, through the bridge.
import { call } from "./bridge";
import { state } from "./state";

export class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

export async function apiGet<T>(id: string, path: string): Promise<T> {
  const conn = state.conns.get(id);
  const response = await call("api.get", { connection: id, path });
  if (response.status === 401) {
    if (conn) conn.tokenRejected = true;
    throw new ApiError("Token rejected (401)", 401);
  }
  if (response.status < 200 || response.status >= 300) {
    const body = response.body as { error?: unknown } | null;
    throw new ApiError(typeof body?.error === "string" ? body.error : `HTTP ${response.status}`, response.status);
  }
  if (conn) conn.tokenRejected = false;
  return response.body as T;
}
