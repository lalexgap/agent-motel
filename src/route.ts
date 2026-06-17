import { listAgents } from "./state";
import { loadConfig } from "./config";
import { fleetRows, splitFleetKey } from "./fleet";

// Where a target reference resolves to. Shared by the CLI (maybeForwardToFleet),
// the MCP server, and anything else routing a name across the fleet, so an
// address behaves identically everywhere:
//   local  → dispatch locally
//   remote → forward over ssh to that host
//   none   → not found / unreachable → store-and-forward outbox (by bare name)
export type Target =
  | { kind: "local"; name: string }
  | { kind: "remote"; host: string; name: string }
  | { kind: "none"; name: string };

// Resolve a target the same way the CLI does: explicit host:name (known host),
// else an exact/unique-prefix LOCAL agent, else an exact/unique-prefix agent
// across configured remotes, else "none" (the outbox handles it). Throws on an
// ambiguous prefix — same outcome as the CLI's resolvers.
export function resolveTarget(ref: string, opts: { timeoutMs?: number } = {}): Target {
  const { host: explicitHost, name: explicitName } = splitFleetKey(ref);
  if (explicitHost && explicitName) {
    const known = loadConfig().remotes ?? [];
    if (known.includes(explicitHost)) return { kind: "remote", host: explicitHost, name: explicitName };
    return { kind: "none", name: explicitName }; // colon but unknown host → outbox by bare name
  }

  const localNames = listAgents().map((a) => a.name);
  if (localNames.includes(ref)) return { kind: "local", name: ref };
  const localPrefix = localNames.filter((n) => n.startsWith(ref));
  if (localPrefix.length === 1) return { kind: "local", name: localPrefix[0]! };
  if (localPrefix.length > 1) throw new Error(`"${ref}" is ambiguous locally: ${localPrefix.join(", ")}`);

  const remoteRows = fleetRows({ timeoutMs: opts.timeoutMs ?? 4000 }).rows.filter((r) => r.host);
  const exact = remoteRows.filter((r) => r.name === ref);
  const prefix = remoteRows.filter((r) => r.name.startsWith(ref));
  const match = exact.length === 1 ? exact[0] : prefix.length === 1 ? prefix[0] : null;
  if (match?.host) return { kind: "remote", host: match.host, name: match.name };
  if (prefix.length > 1) {
    throw new Error(`"${ref}" is ambiguous across hosts: ${prefix.map((r) => `${r.host}:${r.name}`).join(", ")}`);
  }
  return { kind: "none", name: ref };
}
