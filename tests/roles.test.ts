import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CONCIERGE_ROLE,
  ENGINEER_ROLE,
  REVIEWER_ROLE,
  addRole,
  getRole,
  listRoles,
  removeRole,
  requireRole,
  roleForAgent,
  modelForRole,
  providerForRole,
  setRoleModel,
  setRoleProvider,
} from "../src/roles";
import { roleOptionsForHost } from "../src/commands/ui";

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "am-test-"));
  process.env.AGENTMGR_HOME = home;
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  delete process.env.AGENTMGR_HOME;
});

describe("role registry", () => {
  test("includes the protected concierge role", () => {
    const concierge = requireRole(CONCIERGE_ROLE);
    expect(concierge.builtIn).toBe(true);
    expect(concierge.instructions).toContain("am role add");
    expect(() => removeRole(CONCIERGE_ROLE)).toThrow(/built in/);
    expect(() => addRole({ name: CONCIERGE_ROLE, instructions: "replace it" })).toThrow(/built in/);
  });

  test("ships a protected engineer role defaulting to the strong coding models", () => {
    const engineer = requireRole(ENGINEER_ROLE);
    expect(engineer.builtIn).toBe(true);
    // It lands the work end to end rather than handing back a dirty tree.
    expect(engineer.instructions).toContain("DRAFT");
    expect(engineer.instructions).toContain("Commit on the branch you were started on");
    expect(engineer.models).toEqual({ claude: "opus", codex: "gpt-5.6-sol" });
    expect(engineer.provider).toBe("claude");
    expect(providerForRole(ENGINEER_ROLE, "codex")).toBe("claude");
    expect(providerForRole(ENGINEER_ROLE, "codex", "codex")).toBe("codex");
    expect(modelForRole(ENGINEER_ROLE, "claude")).toBe("opus");
    expect(modelForRole(ENGINEER_ROLE, "codex")).toBe("gpt-5.6-sol");
    expect(() => removeRole(ENGINEER_ROLE)).toThrow(/built in/);
  });

  test("a user's own role of the same name shadows a later built-in", () => {
    // Written before `engineer` shipped as a built-in (a fresh `am role add`
    // over a built-in name is still refused): theirs must survive the upgrade,
    // stay listed once, and stay replaceable and removable.
    mkdirSync(join(home, "roles"), { recursive: true });
    writeFileSync(
      join(home, "roles", `${ENGINEER_ROLE}.json`),
      JSON.stringify({ description: "Mine", instructions: "My own engineer." }),
    );
    expect(requireRole(ENGINEER_ROLE)).toMatchObject({ description: "Mine", instructions: "My own engineer." });
    expect(requireRole(ENGINEER_ROLE).builtIn).toBeUndefined();
    expect(listRoles().filter((role) => role.name === ENGINEER_ROLE)).toHaveLength(1);
    addRole({ name: ENGINEER_ROLE, instructions: "Still mine.", force: true });
    expect(requireRole(ENGINEER_ROLE).instructions).toBe("Still mine.");
    removeRole(ENGINEER_ROLE);
    // Removing it uncovers the built-in again, pin and models intact.
    expect(requireRole(ENGINEER_ROLE)).toMatchObject({ builtIn: true, provider: "claude" });
  });

  test("a provider pin can be repointed, cleared, and survives a model change", () => {
    setRoleProvider(ENGINEER_ROLE, "codex");
    expect(requireRole(ENGINEER_ROLE).provider).toBe("codex");
    expect(modelForRole(ENGINEER_ROLE, "codex")).toBe("gpt-5.6-sol");
    setRoleModel(ENGINEER_ROLE, "codex", "gpt-5.6-luna");
    expect(requireRole(ENGINEER_ROLE).provider).toBe("codex");
    setRoleProvider(ENGINEER_ROLE, undefined);
    expect(requireRole(ENGINEER_ROLE).provider).toBeUndefined();
    expect(providerForRole(ENGINEER_ROLE, "codex")).toBe("codex");
    expect(modelForRole(ENGINEER_ROLE, "codex")).toBe("gpt-5.6-luna");
  });

  test("custom roles pin providers too, and replacing instructions keeps the pin", () => {
    addRole({ name: "auditor", instructions: "Audit it." });
    expect(providerForRole("auditor", "codex")).toBe("codex");
    setRoleProvider("auditor", "claude");
    addRole({ name: "auditor", instructions: "Audit it harder.", force: true });
    expect(requireRole("auditor")).toMatchObject({ provider: "claude", instructions: "Audit it harder." });
    expect(providerForRole(undefined, "codex")).toBe("codex");
  });

  test("an engineer model default can be overridden and cleared per provider", () => {
    setRoleModel(ENGINEER_ROLE, "claude", "sonnet");
    expect(requireRole(ENGINEER_ROLE).models).toEqual({ claude: "sonnet", codex: "gpt-5.6-sol" });
    setRoleModel(ENGINEER_ROLE, "claude", undefined);
    expect(modelForRole(ENGINEER_ROLE, "claude")).toBeUndefined();
    expect(modelForRole(ENGINEER_ROLE, "codex")).toBe("gpt-5.6-sol");
  });

  test("ships a reviewer role on the strong reasoning models that never edits", () => {
    const reviewer = requireRole(REVIEWER_ROLE);
    expect(reviewer.builtIn).toBe(true);
    expect(reviewer.provider).toBe("claude");
    expect(reviewer.models).toEqual({ claude: "fable", codex: "gpt-6-astra" });
    // review-loop and shepherd-pr parse these tags out of its report.
    expect(reviewer.instructions).toContain("[high]");
    expect(reviewer.instructions).toContain("[medium]");
    expect(reviewer.instructions).toContain("you don't fix");
    expect(() => removeRole(REVIEWER_ROLE)).toThrow(/built in/);
  });

  test("adds, lists, reads, replaces, and removes a custom role", () => {
    addRole({ name: "security-reviewer", description: "Reviews auth", instructions: "Inspect trust boundaries." });
    expect(getRole("security-reviewer")).toMatchObject({
      name: "security-reviewer",
      description: "Reviews auth",
      instructions: "Inspect trust boundaries.",
    });
    expect(listRoles().map((role) => role.name)).toEqual(["concierge", "engineer", "reviewer", "security-reviewer"]);
    expect(() => addRole({ name: "security-reviewer", instructions: "new" })).toThrow(/--force/);
    addRole({ name: "security-reviewer", instructions: "New instructions", force: true });
    expect(requireRole("security-reviewer").instructions).toBe("New instructions");
    removeRole("security-reviewer");
    expect(getRole("security-reviewer")).toBeNull();
  });

  test("rejects unsafe names and empty instructions", () => {
    expect(() => addRole({ name: "../escape", instructions: "no" })).toThrow(/role name/);
    expect(() => addRole({ name: "Reviewer", instructions: "no" })).toThrow(/role name/);
    expect(() => addRole({ name: "auditor", instructions: "  " })).toThrow(/empty/);
    // The built-in names are taken; a pre-existing file still shadows them.
    expect(() => addRole({ name: "reviewer", instructions: "mine" })).toThrow(/built in/);
    expect(() => addRole({ name: "none", instructions: "no" })).toThrow(/reserved/);
    expect(() => addRole({ name: "unassigned", instructions: "no" })).toThrow(/reserved/);
    expect(getRole("../config")).toBeNull();
  });

  test("valid names inherited from Object.prototype remain custom roles", () => {
    addRole({ name: "constructor", instructions: "Construct a review." });
    expect(requireRole("constructor")).toMatchObject({ name: "constructor", instructions: "Construct a review." });
    removeRole("constructor");
  });

  test("loads create-form role options asynchronously from the selected remote host", async () => {
    let calledWith: string[] = [];
    let resolveRun!: (value: { exitCode: number; stdout: string; stderr: string }) => void;
    const pending = new Promise<{ exitCode: number; stdout: string; stderr: string }>((resolve) => {
      resolveRun = resolve;
    });
    const options = roleOptionsForHost("server", async (_host, args) => {
      calledWith = args;
      return pending;
    });
    expect(calledWith).toEqual(["role", "list", "--json"]);
    expect(options).toBeInstanceOf(Promise);
    resolveRun({
      exitCode: 0,
      stdout: JSON.stringify([
        { name: "concierge", builtIn: true, instructions: "built in" },
        { name: "remote-reviewer", description: "Remote only", instructions: "review" },
      ]),
      stderr: "",
    });
    expect(await options).toEqual([{ name: "remote-reviewer", description: "Remote only" }]);
  });

  test("legacy concierge state infers the built-in role", () => {
    expect(roleForAgent({ name: "concierge" })).toBe("concierge");
    expect(roleForAgent({ name: "worker" })).toBeUndefined();
    expect(roleForAgent({ name: "worker", role: "reviewer" })).toBe("reviewer");
  });
});

describe("role model defaults", () => {
  beforeEach(() => {
    addRole({ name: "shepherd", instructions: "Shepherd the PR." });
  });

  test("persists independent provider defaults and honors explicit overrides", () => {
    setRoleModel("shepherd", "claude", "opus");
    setRoleModel("shepherd", "codex", "gpt-5.6-luna");
    expect(requireRole("shepherd").models).toEqual({ claude: "opus", codex: "gpt-5.6-luna" });
    expect(modelForRole("shepherd", "claude")).toBe("opus");
    expect(modelForRole("shepherd", "codex")).toBe("gpt-5.6-luna");
    expect(modelForRole("shepherd", "codex", "gpt-5.6-sol")).toBe("gpt-5.6-sol");
    expect(modelForRole("shepherd", "codex", "")).toBe("gpt-5.6-luna");
    expect(listRoles().find((role) => role.name === "shepherd")?.models?.claude).toBe("opus");
  });

  test("falls back to provider defaults and clears only the selected provider", () => {
    expect(modelForRole("shepherd", "codex")).toBeUndefined();
    expect(modelForRole(undefined, "codex")).toBeUndefined();
    expect(modelForRole("removed-role", "codex")).toBeUndefined();
    setRoleModel("shepherd", "claude", "opus");
    setRoleModel("shepherd", "codex", "gpt-5.6-luna");
    setRoleModel("shepherd", "codex", undefined);
    expect(modelForRole("shepherd", "codex")).toBeUndefined();
    expect(modelForRole("shepherd", "claude")).toBe("opus");
  });

  test("preserves instructions and defaults when updating the other", () => {
    setRoleModel("shepherd", "claude", "opus");
    expect(requireRole("shepherd").instructions).toBe("Shepherd the PR.");
    addRole({ name: "shepherd", instructions: "Updated instructions", force: true });
    expect(requireRole("shepherd").models?.claude).toBe("opus");
    expect(() => setRoleModel("missing", "claude", "opus")).toThrow(/unknown role/);
    expect(() => setRoleModel("shepherd", "claude", "  ")).toThrow(/empty/);
  });

  test("built-in model defaults are configurable while instructions remain protected", () => {
    const instructions = requireRole(CONCIERGE_ROLE).instructions;
    setRoleModel(CONCIERGE_ROLE, "codex", "gpt-5.6-luna");
    expect(requireRole(CONCIERGE_ROLE)).toMatchObject({ builtIn: true, instructions, models: { codex: "gpt-5.6-luna" } });
    expect(listRoles()[0]?.models?.codex).toBe("gpt-5.6-luna");
    expect(() => removeRole(CONCIERGE_ROLE)).toThrow(/built in/);
  });
});
