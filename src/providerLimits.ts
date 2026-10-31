import type { Provider } from "./state";

export const ANTIGRAVITY_MAX_MESSAGE_BYTES = 64 * 1024;

export function providerMessageError(provider: Provider, message: string): string | null {
  return provider === "antigravity" && Buffer.byteLength(message, "utf8") > ANTIGRAVITY_MAX_MESSAGE_BYTES
    ? "Antigravity messages must be at most 64 KiB after attribution; use a file attachment for larger text"
    : null;
}
