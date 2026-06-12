import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ensureDirs, handoffsDir } from "../paths";
import { agentProvider, readAgent, resolveAgent, type Provider } from "../state";
import { locateTranscript, parseTranscript, renderTranscript } from "../transcript";
import { newCommand } from "./new";

function targetProvider(source: Provider, to?: string): Provider {
  if (to === undefined) return source === "claude" ? "codex" : "claude";
  if (to !== "claude" && to !== "codex") throw new Error(`--to must be "claude" or "codex", got "${to}"`);
  return to;
}

function uniqueName(base: string): string {
  if (!readAgent(base)) return base;
  for (let i = 2; i < 100; i++) {
    if (!readAgent(`${base}${i}`)) return `${base}${i}`;
  }
  throw new Error(`could not find a free name for ${base}`);
}

// Cross-provider "resume": neither CLI can adopt the other's session, so the
// handoff renders the source conversation to markdown (the native JSONL stays
// the source of truth) and briefs a fresh agent on the target provider with
// it. The source agent keeps running — stop it yourself if it shouldn't.
export async function handoffAgent(
  prefix: string,
  opts: { newName?: string; to?: string; full?: boolean; jump?: boolean; quiet?: boolean },
): Promise<{ name: string; target: Provider; file: string }> {
  const agent = resolveAgent(prefix);
  const source = agentProvider(agent);
  const target = targetProvider(source, opts.to);

  const file = locateTranscript(agent);
  const transcript = parseTranscript(source, readFileSync(file, "utf8"));
  if (transcript.turns.length === 0) {
    throw new Error(`agent "${agent.name}" has an empty transcript — nothing to hand off`);
  }
  const markdown = renderTranscript(transcript, { full: opts.full, agentName: agent.name });

  ensureDirs();
  const stamp = new Date().toISOString().replaceAll(/[:.]/g, "-");
  const handoffFile = join(handoffsDir(), `${agent.name}-to-${target}-${stamp}.md`);
  writeFileSync(handoffFile, markdown);

  const name = uniqueName(opts.newName ?? `${agent.name}-${target}`);
  const message = [
    `You are taking over work from the agent "${agent.name}" (running on ${source}). The full transcript of its conversation is at:`,
    "",
    `  ${handoffFile}`,
    "",
    "Read it first. Tool outputs in a transcript can be stale — re-verify the actual state of the files/repo before continuing the work.",
    ...(agent.task ? ["", `The original task was: ${agent.task}`] : []),
  ].join("\n");

  await newCommand({
    name,
    message,
    dir: agent.dir,
    provider: target,
    jump: opts.jump,
    quiet: opts.quiet,
  });
  return { name, target, file: handoffFile };
}

export async function handoffCommand(
  prefix: string,
  opts: { newName?: string; to?: string; full?: boolean; jump?: boolean },
): Promise<void> {
  const result = await handoffAgent(prefix, opts);
  console.log(`handoff transcript: ${result.file}`);
}
