import { describe, expect, test } from "bun:test";
import {
  checkSelection,
  effortsForModel,
  parseCatalogs,
  parseClaudeEfforts,
  parseClaudeModels,
  parseCodexCatalog,
  providerCatalog,
  validateSelection,
  type ProviderCatalog,
} from "../src/catalog";
import { catalogsForHost } from "../src/commands/models";

const CODEX_JSON = JSON.stringify({
  models: [
    {
      slug: "gpt-5.6-sol",
      display_name: "GPT-5.6-Sol",
      description: "Latest frontier agentic coding model.",
      default_reasoning_level: "low",
      supported_reasoning_levels: [
        { effort: "low", description: "Fast" },
        { effort: "medium", description: "Balanced" },
        { effort: "high", description: "Deep" },
        { effort: "ultra", description: "Delegating" },
      ],
      visibility: "list",
      priority: 1,
    },
    {
      slug: "gpt-5.5",
      display_name: "GPT-5.5",
      default_reasoning_level: "medium",
      supported_reasoning_levels: [{ effort: "low" }, { effort: "medium" }, { effort: "high" }],
      visibility: "list",
      priority: 3,
    },
    {
      slug: "internal-preview",
      display_name: "Internal",
      supported_reasoning_levels: [{ effort: "low" }],
      visibility: "hide",
      priority: 2,
    },
  ],
});

const CLAUDE_HELP = `Usage: claude [options] [command] [prompt]

Options:
  --model <model>                       Model for the current session. Provide an
                                        alias for the latest model (e.g. 'sonnet'
                                        or 'opus') or a model's full name.
  --effort <level>                      Effort level for the current session
                                        (low, medium, high, xhigh, max)
  --environment <environment_id>        Create a new cloud session
`;

describe("codex catalog", () => {
  const catalog = parseCodexCatalog(CODEX_JSON)!;

  test("keeps listed models in priority order and drops hidden ones", () => {
    expect(catalog.models.map((m) => m.id)).toEqual(["gpt-5.6-sol", "gpt-5.5"]);
    expect(catalog.modelsExhaustive).toBe(true);
  });

  test("carries per-model reasoning levels and defaults", () => {
    expect(catalog.models[0]!.efforts).toEqual(["low", "medium", "high", "ultra"]);
    expect(catalog.models[0]!.defaultEffort).toBe("low");
    expect(catalog.models[1]!.efforts).toEqual(["low", "medium", "high"]);
  });

  test("provider-wide efforts union every listed model's levels", () => {
    expect(catalog.efforts).toEqual(["low", "medium", "high", "ultra"]);
  });

  test("effort options narrow to the selected model", () => {
    expect(effortsForModel(catalog, "gpt-5.5")).toEqual(["low", "medium", "high"]);
    expect(effortsForModel(catalog, "gpt-5.6-sol")).toContain("ultra");
    // Unknown model: fall back to everything the provider offers.
    expect(effortsForModel(catalog, "made-up")).toEqual(catalog.efforts);
  });

  test("garbage in, null out", () => {
    expect(parseCodexCatalog("not json")).toBeNull();
    expect(parseCodexCatalog(JSON.stringify({ models: [] }))).toBeNull();
  });
});

describe("claude catalog", () => {
  test("effort levels come from the installed CLI's help text", () => {
    expect(parseClaudeEfforts(CLAUDE_HELP)).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(parseClaudeEfforts("no flags here")).toEqual([]);
  });

  test("models merge documented aliases with the CLI's cached options", () => {
    const models = parseClaudeModels(CLAUDE_HELP, [
      { value: "claude-fable-5[1m]", label: "Fable", description: "Fable 5 · 1M context" },
      { value: "claude-fable-5[1m]", label: "duplicate" },
      { nonsense: true },
    ]);
    expect(models.map((m) => m.id)).toEqual(["fable", "opus", "sonnet", "haiku", "claude-fable-5[1m]"]);
    expect(models.at(-1)!.description).toBe("Fable 5 · 1M context");
  });
});

describe("providerCatalog", () => {
  test("probes codex through the injected runner", () => {
    const catalog = providerCatalog("codex", {
      run: (command) => {
        expect(command).toEqual(["codex", "debug", "models"]);
        return { exitCode: 0, stdout: CODEX_JSON };
      },
    });
    expect(catalog?.models[0]!.id).toBe("gpt-5.6-sol");
  });

  test("a failing probe yields no catalog rather than a guess", () => {
    expect(providerCatalog("codex", { run: () => ({ exitCode: 1, stdout: "" }) })).toBeNull();
  });
});

describe("validateSelection", () => {
  const codex = parseCodexCatalog(CODEX_JSON)!;
  const claude: ProviderCatalog = {
    provider: "claude",
    models: [{ id: "opus", efforts: [] }],
    efforts: ["low", "medium", "high", "xhigh", "max"],
    modelsExhaustive: false,
    effortsExhaustive: true,
  };

  test("accepts a valid pair", () => {
    expect(validateSelection(codex, { model: "gpt-5.5", effort: "high" })).toEqual([]);
  });

  test("an unknown model is fatal where the catalog is complete", () => {
    const [complaint] = validateSelection(codex, { model: "gpt-9" });
    expect(complaint?.fatal).toBe(true);
    expect(complaint?.message).toContain("gpt-5.6-sol");
  });

  test("suggests a unique installed suffix without accepting it as an alias", () => {
    const catalog = { ...codex, models: [{ id: "gpt-6-astra", efforts: [] }] };
    const [complaint] = validateSelection(catalog, { model: "astra" });
    expect(complaint?.message).toContain('did you mean "gpt-6-astra"?');
    expect(complaint?.fatal).toBe(true);
    expect(() => checkSelection(catalog, { model: "astra" })).toThrow(/did you mean/);
    expect(validateSelection(catalog, { model: "gpt-6-astra" })).toEqual([]);
  });

  test("does not guess ambiguous suffixes, partial words, or absent models", () => {
    const catalog = { ...codex, models: [
      { id: "gpt-6-astra", efforts: [] },
      { id: "gpt-7-astra", efforts: [] },
    ] };
    for (const model of ["astra", "stra", "gpt", "unknown"]) {
      const [complaint] = validateSelection(catalog, { model });
      expect(complaint?.fatal).toBe(true);
      expect(complaint?.message).not.toContain("did you mean");
    }
    expect(validateSelection(codex, { model: "astra" })[0]?.message).not.toContain("did you mean");
    expect(validateSelection(null, { model: "astra" })).toEqual([]);
  });

  test("a suggestion preserves a non-exhaustive catalog's warning semantics", () => {
    const catalog = { ...claude, models: [{ id: "claude-example", efforts: [] }] };
    expect(validateSelection(catalog, { model: "example" })[0]).toMatchObject({ fatal: false });
    expect(() => checkSelection(catalog, { model: "example" })).not.toThrow();
  });

  test("an unknown claude model is only a warning", () => {
    const [complaint] = validateSelection(claude, { model: "claude-opus-5[1m]" });
    expect(complaint?.fatal).toBe(false);
  });

  test("an effort the selected model doesn't support is rejected", () => {
    const [complaint] = validateSelection(codex, { model: "gpt-5.5", effort: "ultra" });
    expect(complaint?.fatal).toBe(true);
    expect(complaint?.message).toContain("for gpt-5.5");
  });

  test("no catalog means no complaints", () => {
    expect(validateSelection(null, { model: "whatever", effort: "nonsense" })).toEqual([]);
  });

  test("a guessed effort list warns instead of blocking the spawn", () => {
    // claude --help changed shape: the levels are a fallback, not the truth.
    const guessed = providerCatalog("claude", {
      run: () => ({ exitCode: 0, stdout: "Options:\n  --model <model>  'opus'\n" }),
    })!;
    expect(guessed.effortsExhaustive).toBe(false);
    expect(guessed.efforts).toEqual(["low", "medium", "high"]);
    const [complaint] = validateSelection(guessed, { effort: "xhigh" });
    expect(complaint?.fatal).toBe(false);
  });
});

describe("catalogsForHost", () => {
  test("asks the remote machine what its own providers offer", async () => {
    let calledWith: string[] = [];
    const options = catalogsForHost("server", async (_host, args) => {
      calledWith = args;
      return { exitCode: 0, stdout: JSON.stringify([parseCodexCatalog(CODEX_JSON)]), stderr: "" };
    });
    expect(calledWith).toEqual(["models", "--json"]);
    expect(await options).toEqual([parseCodexCatalog(CODEX_JSON)!]);
  });

  test("a remote that can't answer reports which host failed", async () => {
    const options = catalogsForHost("server", async () => ({ exitCode: 1, stdout: "", stderr: "am: not found" }));
    expect(options).rejects.toThrow(/could not load models from server/);
  });
});

describe("parseCatalogs", () => {
  test("round-trips what `am models --json` prints", () => {
    const catalogs = parseCatalogs(JSON.stringify([parseCodexCatalog(CODEX_JSON)]));
    expect(catalogs).toEqual([parseCodexCatalog(CODEX_JSON)!]);
  });

  test("ignores junk from an old or broken remote", () => {
    expect(parseCatalogs("nope")).toEqual([]);
    expect(parseCatalogs(JSON.stringify([{ provider: "gemini" }, null]))).toEqual([]);
  });

  test("a catalog without efforts falls back rather than showing an empty cycle", () => {
    const [catalog] = parseCatalogs(JSON.stringify([{ provider: "claude", models: [], efforts: [] }]));
    expect(catalog?.efforts).toEqual(["low", "medium", "high"]);
    expect(catalog?.effortsExhaustive).toBe(false);
  });

  test("drops an empty model id (it would shadow the form's default entry)", () => {
    const [catalog] = parseCatalogs(JSON.stringify([
      { provider: "codex", models: [{ id: "", label: "bogus" }, { id: "gpt-5.5" }], efforts: ["low"] },
    ]));
    expect(catalog?.models.map((m) => m.id)).toEqual(["gpt-5.5"]);
  });
});
