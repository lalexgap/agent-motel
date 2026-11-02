import { planFile } from "../paths";
import { planMtimeMs, readPlan } from "../plan";
import { resolveAgent } from "../state";

export interface PlanInfo {
  name: string;
  path: string;
  exists: boolean;
  updatedAt: string | null;
  content: string | null;
}

export function planInfo(prefix: string): PlanInfo {
  const { name } = resolveAgent(prefix);
  const content = readPlan(name);
  const mtime = planMtimeMs(name);
  return {
    name,
    path: planFile(name),
    exists: content !== null,
    updatedAt: mtime === null ? null : new Date(mtime).toISOString(),
    content,
  };
}

// `am plan <name>`: the agent's running plan, for the operator.
export function planCommand(prefix: string, opts: { path?: boolean; json?: boolean }): void {
  const info = planInfo(prefix);
  if (opts.json) {
    console.log(JSON.stringify(info, null, 2));
    return;
  }
  if (opts.path) {
    console.log(info.path);
    return;
  }
  if (info.content === null) throw new Error(`agent "${info.name}" has no plan file (${info.path})`);
  process.stdout.write(info.content.endsWith("\n") ? info.content : `${info.content}\n`);
}
