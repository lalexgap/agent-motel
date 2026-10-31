import { homedir } from "node:os";
import { join } from "node:path";
import { readJsonOrNull } from "./fsutil";
import { isProvider, providerBinary, type Provider } from "./state";

// What models and reasoning-effort levels each provider actually offers on
// THIS machine, asked of the CLIs themselves rather than hardcoded:
//   codex   `codex debug models` — a real catalog (slug, display name, the
//           reasoning levels each model supports, the model's default level)
//   claude  no catalog command, so: effort levels come from the `--effort`
//           line of `claude --help` (authoritative for the installed version)
//           and the model list is the documented aliases plus whatever extra
//           options the CLI has cached from the API in ~/.claude.json.
//   agy     `agy models` — a plain slug/display-label catalog.

export interface ModelOption {
  // What goes on the command line (--model); "" is the provider's default.
  id: string;
  label?: string;
  description?: string;
  // Reasoning levels this model supports; empty = fall back to the
  // provider-wide list.
  efforts: string[];
  defaultEffort?: string;
}

export interface ProviderCatalog {
  provider: Provider;
  models: ModelOption[];
  // Provider-wide effort levels, for models that don't declare their own.
  efforts: string[];
  // Claude's model list is best-effort (no catalog command), so an id that
  // isn't in it may still be valid — callers warn instead of rejecting.
  modelsExhaustive: boolean;
  // False when the effort list is a fallback guess rather than something the
  // CLI told us (e.g. claude --help changed shape). Guesses must not reject a
  // level that would have worked.
  effortsExhaustive: boolean;
}

// Used when a provider is installed but its probe fails (old CLI, broken
// install): better a plausible list than an empty form.
export const FALLBACK_EFFORTS = ["low", "medium", "high"];

// Claude Code's model aliases. The --help text names some of them, but not
// exhaustively, so the parsed set is merged with this one.
const CLAUDE_ALIASES = ["fable", "opus", "sonnet", "haiku"];

export type ProbeRunner = (command: string[]) => { exitCode: number; stdout: string };

const runProbe: ProbeRunner = (command) => {
  try {
    // The create form probes synchronously on open, so a wedged CLI would
    // freeze the whole picker — cap it and fall back to the built-in lists.
    const result = Bun.spawnSync(command, { stdout: "pipe", stderr: "pipe", timeout: 5000, maxBuffer: 1024 * 1024 });
    return { exitCode: result.exitCode, stdout: result.stdout.toString() };
  } catch {
    return { exitCode: 1, stdout: "" };
  }
};

interface CodexModel {
  slug?: unknown;
  display_name?: unknown;
  description?: unknown;
  visibility?: unknown;
  priority?: unknown;
  default_reasoning_level?: unknown;
  supported_reasoning_levels?: unknown;
}

// `codex debug models` prints the raw catalog: every model, including the
// internal ones (visibility "hide") and a priority that defines the order the
// TUI lists them in.
export function parseCodexCatalog(json: string): ProviderCatalog | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  const raw = (parsed as { models?: unknown })?.models;
  if (!Array.isArray(raw)) return null;
  const models = raw
    .filter((m): m is CodexModel => !!m && typeof m === "object")
    .filter((m) => typeof m.slug === "string" && m.slug && m.visibility !== "hide")
    .sort((a, b) => (typeof a.priority === "number" ? a.priority : 999) - (typeof b.priority === "number" ? b.priority : 999))
    .map((m): ModelOption => {
      const levels = Array.isArray(m.supported_reasoning_levels) ? m.supported_reasoning_levels : [];
      return {
        id: m.slug as string,
        ...(typeof m.display_name === "string" && m.display_name ? { label: m.display_name } : {}),
        ...(typeof m.description === "string" && m.description ? { description: m.description } : {}),
        efforts: levels
          .map((l) => (typeof l === "string" ? l : (l as { effort?: unknown })?.effort))
          .filter((e): e is string => typeof e === "string" && !!e),
        ...(typeof m.default_reasoning_level === "string" ? { defaultEffort: m.default_reasoning_level } : {}),
      };
    });
  if (!models.length) return null;
  // Provider-wide list: every level any listed model supports, in the order
  // the catalog introduces them (low → … → ultra).
  const efforts: string[] = [];
  for (const model of models) for (const effort of model.efforts) if (!efforts.includes(effort)) efforts.push(effort);
  return {
    provider: "codex",
    models,
    efforts: efforts.length ? efforts : FALLBACK_EFFORTS,
    modelsExhaustive: true,
    effortsExhaustive: efforts.length > 0,
  };
}

// `claude --help` documents the flag's own vocabulary:
//   --effort <level>   Effort level for the current session (low, medium,
//                      high, xhigh, max)
// which tracks the installed version — no need to guess when `max` lands.
export function parseClaudeEfforts(help: string): string[] {
  const match = help.match(/--effort <level>([\s\S]*?)\n\s*--/);
  const levels = match?.[1]?.match(/\(([^)]*)\)/)?.[1];
  if (!levels) return [];
  return levels
    .split(",")
    .map((level) => level.trim())
    .filter((level) => /^[a-z]+$/.test(level));
}

// The --model help text names a few aliases by example ('fable', 'opus', …);
// take those, keep the documented set as the floor, and append anything the
// CLI has cached from the API (e.g. the 1M-context variants) so per-account
// options show up too.
export function parseClaudeModels(help: string, additional: unknown): ModelOption[] {
  const modelHelp = help.match(/--model <model>([\s\S]*?)\n\s*-/)?.[1] ?? "";
  const quoted = [...modelHelp.matchAll(/'([^']+)'/g)].map((m) => m[1]!);
  const aliases = [...CLAUDE_ALIASES, ...quoted.filter((name) => /^[a-z]+$/.test(name))];
  const models: ModelOption[] = [];
  const push = (option: ModelOption) => {
    if (!models.some((m) => m.id === option.id)) models.push(option);
  };
  for (const alias of aliases) push({ id: alias, efforts: [] });
  if (Array.isArray(additional)) {
    for (const entry of additional) {
      const value = (entry as { value?: unknown })?.value;
      if (typeof value !== "string" || !value) continue;
      const label = (entry as { label?: unknown }).label;
      const description = (entry as { description?: unknown }).description;
      push({
        id: value,
        ...(typeof label === "string" && label ? { label } : {}),
        ...(typeof description === "string" && description ? { description } : {}),
        efforts: [],
      });
    }
  }
  return models;
}

function claudeAdditionalModels(): unknown {
  const config = readJsonOrNull<Record<string, unknown>>(join(homedir(), ".claude.json"));
  return config?.additionalModelOptionsCache;
}

// `agy models` prints slug + display label. Require complete, bounded rows;
// auth prompts and errors must never become an exhaustive model catalog.
export function parseAntigravityCatalog(output: string): ProviderCatalog | null {
  if (output.length > 1024 * 1024) return null;
  const rows = output.trim().split(/\r?\n/);
  if (!output.trim() || rows.length > 1000) return null;
  const models: ModelOption[] = [];
  for (const row of rows) {
    const match = row.match(/^([a-z][a-z0-9]*(?:[.-][a-z0-9]+)+)[ \t]{2,}([A-Z][^\x00-\x1f\x7f]*)$/);
    if (!match || !/\d/.test(match[1]!)) return null;
    const [, id, label] = match;
    if (label!.split(/[ \t]/)[0]!.toLowerCase() !== id!.split(/[.-]/)[0]) return null;
    if (!models.some(model => model.id === id)) models.push({ id: id!, label: label!.trim(), efforts: [] });
  }
  return {
    provider: "antigravity", models, modelsExhaustive: true,
    efforts: [...FALLBACK_EFFORTS], effortsExhaustive: false,
  };
}

function probeCatalog(provider: Provider, run: ProbeRunner): ProviderCatalog | null {
  if (provider === "antigravity") {
    const result = run([providerBinary(provider), "models"]);
    return result.exitCode === 0 ? parseAntigravityCatalog(result.stdout) : null;
  }
  if (provider === "codex") {
    const result = run(["codex", "debug", "models"]);
    if (result.exitCode !== 0) return null;
    return parseCodexCatalog(result.stdout);
  }
  const result = run(["claude", "--help"]);
  if (result.exitCode !== 0) return null;
  const efforts = parseClaudeEfforts(result.stdout);
  const models = parseClaudeModels(result.stdout, claudeAdditionalModels());
  if (!efforts.length && !models.length) return null;
  return {
    provider: "claude",
    models,
    efforts: efforts.length ? efforts : FALLBACK_EFFORTS,
    modelsExhaustive: false,
    effortsExhaustive: efforts.length > 0,
  };
}

// Probes are cheap (codex ~40ms, claude ~200ms) but the create form asks on
// every keystroke-free repaint, so memoize per process.
const cache = new Map<Provider, ProviderCatalog | null>();

export function providerCatalog(
  provider: Provider,
  opts: { run?: ProbeRunner; refresh?: boolean } = {},
): ProviderCatalog | null {
  if (!isProvider(provider)) throw new Error("unknown catalog provider");
  if (!opts.refresh && !opts.run && cache.has(provider)) return cache.get(provider)!;
  // An injected runner stands in for the CLI (tests), so only gate the real one.
  if (!opts.run && !Bun.which(providerBinary(provider))) {
    cache.set(provider, null);
    return null;
  }
  const catalog = probeCatalog(provider, opts.run ?? runProbe);
  if (!opts.run) cache.set(provider, catalog);
  return catalog;
}

// Which effort levels apply to a model: its own when the catalog knows them
// (codex varies per model — `ultra` only exists on the newest), else the
// provider-wide list.
export function effortsForModel(catalog: ProviderCatalog | null, modelId: string | undefined): string[] {
  if (!catalog) return FALLBACK_EFFORTS;
  const model = modelId ? catalog.models.find((m) => m.id === modelId) : undefined;
  return model?.efforts.length ? model.efforts : catalog.efforts;
}

export function findModel(catalog: ProviderCatalog | null, modelId: string): ModelOption | undefined {
  return catalog?.models.find((m) => m.id === modelId);
}

// Reverse of what `am models --json` prints — used to read a remote host's
// catalog over ssh. Unknown/damaged entries are dropped rather than throwing:
// a half-understood catalog still beats none.
export function parseCatalogs(json: string): ProviderCatalog[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed
    .filter((entry): entry is Record<string, unknown> => !!entry && typeof entry === "object")
    .filter((entry) => isProvider(entry.provider))
    .map((entry) => ({
      provider: entry.provider as Provider,
      models: (Array.isArray(entry.models) ? entry.models : [])
        .filter((model): model is Record<string, unknown> => !!model && typeof model === "object")
        // An empty id is the picker's "provider default" entry, never a model.
        .filter((model) => typeof model.id === "string" && model.id)
        .map((model): ModelOption => ({
          id: model.id as string,
          ...(typeof model.label === "string" ? { label: model.label } : {}),
          ...(typeof model.description === "string" ? { description: model.description } : {}),
          efforts: (Array.isArray(model.efforts) ? model.efforts : []).filter((e): e is string => typeof e === "string"),
          ...(typeof model.defaultEffort === "string" ? { defaultEffort: model.defaultEffort } : {}),
        })),
      efforts: (Array.isArray(entry.efforts) ? entry.efforts : []).filter((e): e is string => typeof e === "string"),
      modelsExhaustive: entry.modelsExhaustive === true,
      effortsExhaustive: entry.effortsExhaustive === true,
    }))
    .map((catalog) => (catalog.efforts.length
      ? catalog
      : { ...catalog, efforts: FALLBACK_EFFORTS, effortsExhaustive: false }));
}

export interface CatalogComplaint {
  message: string;
  // Hard errors reject the spawn; warnings let it through (the catalog may
  // simply be behind the provider).
  fatal: boolean;
}

// Validate --model / --effort before a spawn: a bogus value otherwise produces
// an agent that dies on startup (or silently ignores the flag).
export function validateSelection(
  catalog: ProviderCatalog | null,
  selection: { model?: string; effort?: string },
): CatalogComplaint[] {
  if (!catalog) return [];
  const complaints: CatalogComplaint[] = [];
  const known = selection.model ? findModel(catalog, selection.model) : undefined;
  if (selection.model && !known && catalog.models.length) {
    const names = catalog.models.map((m) => m.id).join(", ");
    complaints.push({
      message: `unknown ${catalog.provider} model "${selection.model}" — known models: ${names}`,
      fatal: catalog.modelsExhaustive,
    });
  }
  if (selection.effort) {
    const efforts = effortsForModel(catalog, known ? selection.model : undefined);
    if (efforts.length && !efforts.includes(selection.effort)) {
      const where = known?.efforts.length ? ` for ${known.id}` : "";
      complaints.push({
        message: `unknown ${catalog.provider} effort "${selection.effort}"${where} — supported: ${efforts.join(", ")}`,
        // Only reject when the levels came from the CLI itself; a fallback
        // list must not block a level the provider would have accepted.
        fatal: catalog.effortsExhaustive,
      });
    }
  }
  return complaints;
}

// A rejected --model / --effort: the API answers 400 rather than 409.
export class SelectionError extends Error {}

// Throws on a fatal complaint; a warning goes to `warn` (unset = dropped).
export function checkSelection(
  catalog: ProviderCatalog | null,
  selection: { model?: string; effort?: string },
  warn?: (message: string) => void,
): void {
  for (const complaint of validateSelection(catalog, selection)) {
    if (complaint.fatal) throw new SelectionError(`${complaint.message} (see \`am models\`)`);
    warn?.(`warning: ${complaint.message}`);
  }
}
