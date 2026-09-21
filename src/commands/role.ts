import type { Provider } from "../state";
import { providerCatalog, validateSelection } from "../catalog";
import { addRole, getRole, listRoles, removeRole, setRoleModel, setRoleProvider } from "../roles";
import { ensureSubagentRoles, exportSubagentRoles, formatExportReport } from "../subagentRoles";

export interface RoleCommandOptions {
  json?: boolean;
  instructions?: string;
  description?: string;
  force?: boolean;
  provider?: Provider;
  model?: string;
  clear?: boolean;
  dryRun?: boolean;
}

export function roleCommand(action: string | undefined, name: string | undefined, opts: RoleCommandOptions = {}): void {
  if (!action || action === "list" || action === "ls") {
    const roles = listRoles();
    if (opts.json) console.log(JSON.stringify(roles, null, 2));
    else if (!roles.length) console.log("no roles defined");
    else for (const role of roles) {
      const pin = role.provider ? `  · ${role.provider}` : "";
      console.log(`${role.name}${role.builtIn ? "  [built-in]" : ""}${pin}${role.description ? `  · ${role.description}` : ""}`);
    }
    return;
  }

  if (action === "export") {
    const providers = opts.provider ? [opts.provider] : undefined;
    const report = exportSubagentRoles({ providers, dryRun: opts.dryRun });
    console.log(formatExportReport(report, opts.dryRun).join("\n"));
    return;
  }

  if (!name) throw new Error(`am role ${action} requires a role name`);
  if (action === "show") {
    const role = getRole(name);
    if (!role) throw new Error(`unknown role "${name}"`);
    if (opts.json) console.log(JSON.stringify(role, null, 2));
    else {
      console.log(`${role.name}${role.builtIn ? "  [built-in]" : ""}`);
      if (role.description) console.log(role.description);
      if (role.provider) console.log(`provider: ${role.provider}`);
      for (const [provider, model] of Object.entries(role.models ?? {})) console.log(`${provider} model: ${model}`);
      console.log("");
      console.log(role.instructions);
    }
    return;
  }
  if (action === "provider") {
    if (opts.clear ? !!opts.provider : !opts.provider) {
      throw new Error("pass either --claude/--codex or --clear");
    }
    const role = setRoleProvider(name, opts.clear ? undefined : opts.provider);
    console.log(role.provider ? `role "${name}" now launches on ${role.provider}` : `role "${name}" no longer pins a provider`);
    ensureSubagentRoles();
    return;
  }
  if (action === "model") {
    if (!opts.provider) throw new Error("select a provider with --claude or --codex");
    if (opts.clear ? opts.model !== undefined : !opts.model?.trim()) {
      throw new Error("pass either --model <name> or --clear");
    }
    if (opts.model) {
      for (const complaint of validateSelection(providerCatalog(opts.provider), { model: opts.model.trim() })) {
        if (complaint.fatal) throw new Error(`${complaint.message} (see \`am models\`)`);
        console.error(`warning: ${complaint.message}`);
      }
    }
    setRoleModel(name, opts.provider, opts.clear ? undefined : opts.model);
    console.log(`${opts.clear ? "cleared" : "saved"} ${opts.provider} model for role "${name}"`);
    ensureSubagentRoles();
    return;
  }
  if (action === "add") {
    if (!opts.instructions) throw new Error("role instructions required: pass -m <text>, -m -, or --file <path>");
    const role = addRole({ name, description: opts.description, instructions: opts.instructions, force: opts.force });
    console.log(`${opts.force ? "saved" : "added"} role "${role.name}"`);
    ensureSubagentRoles();
    return;
  }
  if (action === "rm" || action === "remove") {
    removeRole(name);
    console.log(`removed role "${name}"`);
    ensureSubagentRoles();
    return;
  }
  throw new Error(`unknown role action "${action}" — use list, show, add, model, provider, export, or rm`);
}
