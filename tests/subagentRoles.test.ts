import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addRole, removeRole } from "../src/roles";
import {
  SHIPPED_SUBAGENT_ROLES,
  claudeAgentsDir,
  codexAgentsDir,
  exportSubagentRoles,
  exportableRoles,
  formatExportReport,
  renderClaudeAgent,
  renderCodexAgent,
} from "../src/subagentRoles";

let home: string;
const saved = { HOME: process.env.HOME, CODEX_HOME: process.env.CODEX_HOME };

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "am-roles-export-"));
  // The export writes into the providers' real config dirs; point every
  // root at the sandbox.
  process.env.AGENTMGR_HOME = join(home, "am");
  process.env.HOME = home;
  process.env.CODEX_HOME = join(home, ".codex");
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  delete process.env.AGENTMGR_HOME;
  process.env.HOME = saved.HOME;
  if (saved.CODEX_HOME === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = saved.CODEX_HOME;
});

describe("shipped subagent roles", () => {
  test("engineer, reviewer and shepherd ship with strong-model defaults", () => {
    expect(SHIPPED_SUBAGENT_ROLES.map((r) => r.name)).toEqual(["engineer", "reviewer", "shepherd"]);
    const reviewer = SHIPPED_SUBAGENT_ROLES.find((r) => r.name === "reviewer")!;
    expect(reviewer.models).toEqual({ claude: "fable", codex: "gpt-6-astra" });
    // review-loop scans for line-initial severity tags and the Verdict line.
    const lines = reviewer.instructions.split("\n");
    expect(lines.filter((line) => /^\[(high|medium|low)\]/.test(line))).toHaveLength(1);
    expect(reviewer.instructions).toContain("starts `Verdict:`");
  });

  test("subagent prompts never point at am for delegation or reporting", () => {
    for (const role of SHIPPED_SUBAGENT_ROLES) {
      expect(role.instructions).not.toContain("am run");
      expect(role.instructions).not.toContain("am send");
      expect(role.instructions).not.toContain("am new");
    }
  });
});

describe("exportableRoles", () => {
  test("custom roles join the shipped ones, and a custom role of the same name wins", () => {
    addRole({ name: "auditor", description: "Audits auth", instructions: "Audit it." });
    addRole({ name: "shepherd", description: "Mine", instructions: "My own shepherd." });
    const roles = exportableRoles();
    expect(roles.map((r) => r.name)).toEqual(["engineer", "reviewer", "shepherd", "auditor"]);
    expect(roles.find((r) => r.name === "shepherd")!.instructions).toBe("My own shepherd.");
    expect(roles.find((r) => r.name === "auditor")!.description).toBe("Audits auth");
  });

  test("the concierge is fleet management, not a subagent", () => {
    expect(exportableRoles().some((r) => r.name === "concierge")).toBe(false);
  });
});

describe("rendering", () => {
  const role = {
    name: "reviewer",
    description: 'Reviews "carefully"',
    instructions: "Line one.\nLine two with a 'quote'.",
    models: { claude: "fable", codex: "gpt-6-astra" },
  };

  test("claude: frontmatter with the model, prompt as the body", () => {
    const md = renderClaudeAgent(role);
    expect(md.startsWith("---\nname: reviewer\ndescription: \"Reviews \\\"carefully\\\"\"\nmodel: fable\n---\n")).toBe(true);
    expect(md).toEndWith("Line one.\nLine two with a 'quote'.\n");
  });

  test("codex: a TOML table with developer_instructions as a literal block", () => {
    const toml = renderCodexAgent(role);
    expect(toml).toContain('name = "reviewer"');
    expect(toml).toContain('model = "gpt-6-astra"');
    expect(toml).toContain("developer_instructions = '''\nLine one.\nLine two with a 'quote'.\n'''");
  });

  test("codex: instructions containing the literal delimiter fall back to an escaped block", () => {
    const toml = renderCodexAgent({ ...role, instructions: "uses ''' inside" });
    expect(toml).toContain('developer_instructions = """\nuses \'\'\' inside\n"""');
  });

  test("no model pin means no model line", () => {
    expect(renderClaudeAgent({ ...role, models: undefined })).not.toContain("model:");
    expect(renderCodexAgent({ ...role, models: undefined })).not.toContain("model =");
  });
});

describe("exportSubagentRoles", () => {
  test("writes both providers' files and records them", () => {
    const report = exportSubagentRoles();
    expect(report.written).toHaveLength(6);
    expect(existsSync(join(claudeAgentsDir(), "reviewer.md"))).toBe(true);
    expect(existsSync(join(codexAgentsDir(), "engineer.toml"))).toBe(true);
    // A second run changes nothing.
    const again = exportSubagentRoles();
    expect(again.written).toEqual([]);
    expect(again.unchanged).toHaveLength(6);
  });

  test("a provider can be exported alone", () => {
    const report = exportSubagentRoles({ providers: ["codex"] });
    expect(report.written.every((p) => p.endsWith(".toml"))).toBe(true);
    expect(existsSync(claudeAgentsDir())).toBe(false);
  });

  test("a file the user wrote, or edited after us, is left alone", () => {
    mkdirSync(claudeAgentsDir(), { recursive: true });
    writeFileSync(join(claudeAgentsDir(), "reviewer.md"), "theirs");
    let report = exportSubagentRoles();
    expect(report.skipped).toEqual([join(claudeAgentsDir(), "reviewer.md")]);
    expect(readFileSync(join(claudeAgentsDir(), "reviewer.md"), "utf8")).toBe("theirs");

    // Ours, then hand-edited: also theirs from now on.
    writeFileSync(join(claudeAgentsDir(), "engineer.md"), "edited by hand");
    report = exportSubagentRoles();
    expect(report.skipped).toContain(join(claudeAgentsDir(), "engineer.md"));
    expect(readFileSync(join(claudeAgentsDir(), "engineer.md"), "utf8")).toBe("edited by hand");
  });

  test("a lost manifest re-adopts files that still match what am would write", () => {
    exportSubagentRoles();
    rmSync(join(home, "am", "exported-agents.json"));
    let report = exportSubagentRoles();
    expect(report.skipped).toEqual([]);
    expect(report.unchanged).toHaveLength(6);
    // Adopted for real: a later role change rewrites them again.
    addRole({ name: "auditor", instructions: "Audit it." });
    exportSubagentRoles();
    removeRole("auditor");
    report = exportSubagentRoles();
    expect(report.removed).toHaveLength(2);
    expect(report.unchanged).toHaveLength(6);
  });

  test("removing a role removes the files am wrote for it — and only those", () => {
    addRole({ name: "auditor", instructions: "Audit it." });
    exportSubagentRoles();
    expect(existsSync(join(codexAgentsDir(), "auditor.toml"))).toBe(true);
    removeRole("auditor");
    const report = exportSubagentRoles();
    expect(report.removed.sort()).toEqual([join(claudeAgentsDir(), "auditor.md"), join(codexAgentsDir(), "auditor.toml")].sort());
    expect(existsSync(join(codexAgentsDir(), "auditor.toml"))).toBe(false);
    // The shipped ones are untouched.
    expect(existsSync(join(codexAgentsDir(), "reviewer.toml"))).toBe(true);
  });

  test("a role edit re-renders its files", () => {
    addRole({ name: "auditor", instructions: "Audit it." });
    exportSubagentRoles();
    addRole({ name: "auditor", instructions: "Audit it harder.", force: true });
    const report = exportSubagentRoles();
    expect(report.written.sort()).toEqual([join(claudeAgentsDir(), "auditor.md"), join(codexAgentsDir(), "auditor.toml")].sort());
    expect(readFileSync(join(claudeAgentsDir(), "auditor.md"), "utf8")).toContain("Audit it harder.");
  });

  test("dry run reports without touching disk", () => {
    const report = exportSubagentRoles({ dryRun: true });
    expect(report.written).toHaveLength(6);
    expect(existsSync(claudeAgentsDir())).toBe(false);
    expect(formatExportReport(report, true)[0]).toStartWith("would write");
  });
});
