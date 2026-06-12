import { resolveAgent, writeAgent } from "../state";
import { queueAppend } from "../queue";
import { deliverNext } from "../deliver";
import { hasSession } from "../tmux";

// Tell a running agent its reporting duty changed — its primer was fixed at
// launch, so a state change alone wouldn't reach it. Best-effort: queued,
// delivered when idle (or now if it already is).
function briefAgent(name: string, message: string): void {
  queueAppend(name, message);
  const agent = resolveAgent(name);
  if (agent.status === "idle" || agent.status === "starting") deliverNext(name);
}

export function reportCommand(prefix: string, opts: { to?: string; clear?: boolean }): void {
  const agent = resolveAgent(prefix);

  if (opts.clear) {
    if (!agent.reportTo) {
      console.log(`"${agent.name}" has no report relationship`);
      return;
    }
    const was = agent.reportTo;
    agent.reportTo = undefined;
    writeAgent(agent);
    console.log(`"${agent.name}" no longer reports to "${was}"`);
    if (hasSession(agent.tmuxSession)) {
      briefAgent(agent.name, `[am] You are no longer reporting to "${was}".`);
    }
    return;
  }

  if (opts.to) {
    // "spawner" resolves to whoever ran `am new` for this agent.
    const target = opts.to === "spawner" ? agent.spawnedBy : opts.to;
    if (!target) throw new Error(`"${agent.name}" has no spawning agent on record — name a target`);
    if (target === agent.name) throw new Error("an agent can't report to itself");
    agent.reportTo = target;
    writeAgent(agent);
    console.log(`"${agent.name}" now reports to "${target}"`);
    if (hasSession(agent.tmuxSession)) {
      briefAgent(
        agent.name,
        `[am] You are now reporting to "${target}". After finishing a chunk, post a short summary with \`am send ${target} "..."\`.`,
      );
    }
    return;
  }

  // No flags — show the current relationship.
  const lines = [`${agent.name} reports to: ${agent.reportTo ?? "(none)"}`];
  if (agent.spawnedBy) lines.push(`${agent.name} spawned by: ${agent.spawnedBy}`);
  console.log(lines.join("\n"));
}
