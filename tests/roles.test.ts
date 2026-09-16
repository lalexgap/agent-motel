import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CONCIERGE_ROLE,
  addRole,
  getRole,
  listRoles,
  removeRole,
  requireRole,
  roleForAgent,
  modelForRole,
  setRoleModel,
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

  test("adds, lists, reads, replaces, and removes a custom role", () => {
    addRole({ name: "security-reviewer", description: "Reviews auth", instructions: "Inspect trust boundaries." });
    expect(getRole("security-reviewer")).toMatchObject({
      name: "security-reviewer",
      description: "Reviews auth",
      instructions: "Inspect trust boundaries.",
    });
    expect(listRoles().map((role) => role.name)).toEqual(["concierge", "security-reviewer"]);
    expect(() => addRole({ name: "security-reviewer", instructions: "new" })).toThrow(/--force/);
    addRole({ name: "security-reviewer", instructions: "New instructions", force: true });
    expect(requireRole("security-reviewer").instructions).toBe("New instructions");
    removeRole("security-reviewer");
    expect(getRole("security-reviewer")).toBeNull();
  });

  test("rejects unsafe names and empty instructions", () => {
    expect(() => addRole({ name: "../escape", instructions: "no" })).toThrow(/role name/);
    expect(() => addRole({ name: "Reviewer", instructions: "no" })).toThrow(/role name/);
    expect(() => addRole({ name: "reviewer", instructions: "  " })).toThrow(/empty/);
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
