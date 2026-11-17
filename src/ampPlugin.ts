import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { cliEntrypoint } from "./settings";

// Amp has no settings-file hooks; am's hooks ride in a plugin instead. Amp
// loads system plugins from ~/.config/amp/plugins for every thread, so one
// file serves every agent — it stays inert in Amp processes am didn't launch
// as an agent (see ampAgentEnv). The source lives in src/amp/agent-motel.ts.
export const AMP_PLUGIN_SOURCE = join(import.meta.dir, "amp", "agent-motel.ts");

export function ampConfigDir(): string {
  // HOME read live, as claudeProjectsDir does: Bun caches homedir().
  return join(process.env.HOME ?? homedir(), ".config", "amp");
}

export function ampPluginFile(): string {
  return join(ampConfigDir(), "plugins", "agent-motel.ts");
}

// Install or refresh the plugin. Amp reads plugins at startup, so a changed
// file reaches agents launched after this.
export function ensureAmpPlugin(): { changed: boolean; file: string } {
  const file = ampPluginFile();
  const source = readFileSync(AMP_PLUGIN_SOURCE, "utf8");
  if (existsSync(file) && readFileSync(file, "utf8") === source) return { changed: false, file };
  mkdirSync(join(ampConfigDir(), "plugins"), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, source);
  renameSync(tmp, file);
  return { changed: true, file };
}

// Arms the plugin for this agent, and tells it which am to run its hooks
// with: this one, by absolute path, since Amp's PATH need not hold am.
export function ampAgentEnv(name: string): Record<string, string> {
  return { AGENTMGR_AMP_AGENT: name, AGENTMGR_AM_CMD: JSON.stringify([process.execPath, cliEntrypoint()]) };
}
