import { loadConfig } from "../config";
import { splitFleetKey } from "../fleet";
import { sshAm, sshAmAsync } from "../remote";
import type { Feedback } from "../picker";
import { cdAgent, defaultMoveTarget, moveAgent } from "./move";
import { handoffAgent } from "./handoff";

// The sidebar/picker `m` and `h` actions, shared by both UIs. These can take
// seconds (ssh, scp, spawning agents); the picker paints "moving …" first
// and shows the returned string in the footer when done.

export function moveHandler(key: string): Feedback | Promise<Feedback> {
  const target = defaultMoveTarget(key, loadConfig().remotes ?? []);
  if ("error" in target) return { text: target.error, level: "warn" };
  return moveAgent(target.first, target.second, { copy: false, start: true });
}

export function cloneHandler(key: string): Feedback | Promise<Feedback> {
  const target = defaultMoveTarget(key, loadConfig().remotes ?? []);
  if ("error" in target) return { text: target.error, level: "warn" };
  return moveAgent(target.first, target.second, { copy: false, start: true, clone: true });
}

// `r` in the sidebar: relocate the highlighted agent to a new directory.
export function cdHandler(key: string, dir: string): Feedback | Promise<Feedback> {
  if (!dir) return { text: "no directory given", level: "warn" };
  const { host, name } = splitFleetKey(key);
  if (host) {
    if (!name) return { text: "host unreachable", level: "error" };
    return sshAmAsync(host, ["cd", name, dir], { timeoutMs: 120000 }).then(
      (r): Feedback =>
        r.exitCode === 0
          ? { text: `moved ${name} to ${dir} on ${host}`, level: "ok" }
          : { text: `cd failed: ${(r.stderr || r.stdout).trim()}`, level: "error" },
    );
  }
  return cdAgent(name, dir, { inPlace: false, start: true });
}

export function handoffHandler(key: string): Feedback | Promise<Feedback> {
  const { host, name } = splitFleetKey(key);
  if (host) {
    if (!name) return { text: "host unreachable", level: "error" };
    // Remote agent: the handoff runs on its machine, sibling included.
    const result = sshAm(host, ["handoff", name], { timeoutMs: 90000 });
    return result.exitCode === 0
      ? `handed off ${name} on ${host}`
      : { text: `handoff failed: ${(result.stderr || result.stdout).trim()}`, level: "error" };
  }
  return handoffAgent(name, { jump: false, quiet: true }).then(
    (r) => `handed off → ${r.name} (${r.target})`,
  );
}
