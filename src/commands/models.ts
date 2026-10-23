import { parseCatalogs, providerCatalog, type ProviderCatalog } from "../catalog";
import { sshAmAsync } from "../remote";
import type { Provider } from "../state";

const PROVIDERS: Provider[] = ["claude", "codex"];

export function localCatalogs(opts: { refresh?: boolean } = {}): ProviderCatalog[] {
  return PROVIDERS.map((provider) => providerCatalog(provider, opts)).filter((c): c is ProviderCatalog => !!c);
}

// The create form asks the machine the agent will actually run on — a remote
// host may have different providers, versions, and models than this one.
export function catalogsForHost(
  host: string | undefined,
  run: typeof sshAmAsync = sshAmAsync,
): ProviderCatalog[] | Promise<ProviderCatalog[]> {
  if (!host) return localCatalogs();
  return run(host, ["models", "--json"], { timeoutMs: 4000 }).then((result) => {
    if (result.exitCode !== 0) {
      throw new Error(`could not load models from ${host}: ${result.stderr.trim() || "remote command failed"}`);
    }
    return parseCatalogs(result.stdout);
  });
}

export interface ModelsCommandOptions {
  provider?: Provider;
  json?: boolean;
}

// `am models` shows what --model / --effort actually accept here, asked of the
// installed CLIs. The picker's create form uses the same data, and fetches a
// remote host's catalog by running `am models --json` there over ssh.
export function modelsCommand(opts: ModelsCommandOptions = {}): void {
  const catalogs = opts.provider
    ? [providerCatalog(opts.provider)].filter((catalog): catalog is ProviderCatalog => !!catalog)
    : localCatalogs();

  if (opts.json) {
    console.log(JSON.stringify(catalogs, null, 2));
    return;
  }
  if (!catalogs.length) {
    console.log("no model catalog available — is claude or codex installed?");
    return;
  }
  for (const catalog of catalogs) {
    console.log(`${catalog.provider}  (effort: ${catalog.efforts.join(", ")})`);
    for (const model of catalog.models) {
      const efforts = model.efforts.length ? model.efforts.join(", ") : catalog.efforts.join(", ");
      const marks = [
        model.label && model.label !== model.id ? model.label : "",
        `effort: ${efforts}`,
        model.defaultEffort ? `default ${model.defaultEffort}` : "",
      ].filter(Boolean);
      console.log(`  ${model.id.padEnd(22)} ${marks.join("  · ")}`);
    }
    if (!catalog.modelsExhaustive) {
      console.log(`  (${catalog.provider} has no catalog command — other model names may still work)`);
    }
  }
}
