import { loadConfig } from "../config";
import { splitFleetKey } from "../fleet";
import { sshAm } from "../remote";
import { defaultMoveTarget, moveAgent } from "./move";
import { handoffAgent } from "./handoff";

// The sidebar/picker `m` and `h` actions, shared by both UIs. These can take
// seconds (ssh, scp, spawning agents); the picker paints "moving …" first
// and shows the returned string in the footer when done.

export function moveHandler(key: string): string | Promise<string> {
  const target = defaultMoveTarget(key, loadConfig().remotes ?? []);
  if ("error" in target) return target.error;
  return moveAgent(target.first, target.second, { copy: false, force: false, start: true });
}

export function handoffHandler(key: string): string | Promise<string> {
  const { host, name } = splitFleetKey(key);
  if (host) {
    if (!name) return "host unreachable";
    // Remote agent: the handoff runs on its machine, sibling included.
    const result = sshAm(host, ["handoff", name], { timeoutMs: 90000 });
    return result.exitCode === 0
      ? `handed off ${name} on ${host}`
      : `handoff failed: ${(result.stderr || result.stdout).trim()}`;
  }
  return handoffAgent(name, { jump: false, quiet: true }).then(
    (r) => `handed off → ${r.name} (${r.target})`,
  );
}
