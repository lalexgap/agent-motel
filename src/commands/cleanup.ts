import { cleanupAgent, planCleanup, type CleanupPlan } from "../cleanup";
import { readAgent, resolveAgent } from "../state";

export interface CleanupCommandOptions {
  dryRun?: boolean;
  force?: boolean;
  json?: boolean;
  exact?: boolean;
  createdAt?: string;
  planToken?: string;
}

function render(plan: CleanupPlan, dryRun: boolean): string {
  const lines = [`cleanup ${dryRun ? "plan" : plan.applied ? "complete" : "refused"} for ${plan.name}:`];
  lines.push("remove:", ...plan.remove.map((item) => `  ${item}`));
  lines.push("keep:", ...plan.keep.map((item) => `  ${item}`));
  lines.push("blockers:", ...(plan.blockers.length ? plan.blockers.map((item) => `  ${item.forceable ? "forceable: " : ""}${item.reason}`) : ["  none"]));
  return lines.join("\n");
}

export async function cleanupCommand(name: string, opts: CleanupCommandOptions = {}): Promise<CleanupPlan> {
  const agent = opts.exact ? readAgent(name) : resolveAgent(name);
  if (!agent) throw new Error(`no local agent "${name}"`);
  if (opts.createdAt && opts.createdAt !== agent.createdAt) throw new Error(`agent "${name}" changed — preview cleanup again`);
  const plan = opts.dryRun
    ? await planCleanup(agent)
    : await cleanupAgent(agent, { force: opts.force, expectedCreatedAt: opts.createdAt, expectedToken: opts.planToken });
  console.log(opts.json ? JSON.stringify(plan) : render(plan, !!opts.dryRun));
  return plan;
}
