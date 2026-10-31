import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { parseArgs } from "../src/args";
import { parseCatalogs, providerCatalog, validateSelection } from "../src/catalog";
import { loadConfig } from "../src/config";
import { addRole, modelForRole, requireRole, setRoleModel, setRoleProvider } from "../src/roles";
import { roleCommand } from "../src/commands/role";
import { usageCommand } from "../src/commands/usage";
import { PROVIDER_OPTIONS } from "../src/picker";
import { setRemoteRunnersForTests } from "../src/remoteAgents";

let home: string;
let previous: Record<string, string | undefined>;
beforeEach(() => {
  previous = Object.fromEntries(["HOME", "AGENTMGR_HOME", "PATH", "AM_HOST"].map(k => [k, process.env[k]]));
  home = mkdtempSync(join(tmpdir(), "am-agy-surface-"));
  process.env.HOME = home;
  process.env.AGENTMGR_HOME = home;
  process.env.PATH = home;
  delete process.env.AM_HOST;
});
afterEach(() => {
  setRemoteRunnersForTests();
  for (const [k, v] of Object.entries(previous)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  rmSync(home, { recursive: true, force: true });
});
const listing = "gemini-4-argon-high       Gemini 4 Argon (High)\ngemini-4-argon-low        Gemini 4 Argon (Low)\n";

test("provider parsing accepts the exact id and rejects conflicts uniformly", () => {
  expect(parseArgs(["--antigravity"]).flags.antigravity).toBe(true);
  expect(parseArgs(["--provider", "antigravity"]).flags.provider).toBe("antigravity");
  for (const flags of [["--claude", "--codex"], ["--antigravity", "--codex"], ["--antigravity", "--claude"], ["--provider", "codex", "--antigravity"]]) {
    expect(() => parseArgs(flags)).toThrow(/select only one provider/);
  }
  for (const provider of ["agy", "Antigravity", "other", "--no-remote", ""]) expect(() => parseArgs(["--provider", provider])).toThrow(/provider/);
});

test("catalog probes agy models only and parses documented plain model rows", () => {
  const commands: string[][] = [];
  const catalog = providerCatalog("antigravity", { run: command => { commands.push(command); return { exitCode: 0, stdout: listing }; } });
  expect(commands).toEqual([["agy", "models"]]);
  expect(catalog).toMatchObject({ provider: "antigravity", modelsExhaustive: true, efforts: ["low", "medium", "high"], effortsExhaustive: false });
  expect(catalog?.models).toEqual([
    { id: "gemini-4-argon-high", label: "Gemini 4 Argon (High)", efforts: [] },
    { id: "gemini-4-argon-low", label: "Gemini 4 Argon (Low)", efforts: [] },
  ]);
  expect(validateSelection(catalog, { model: "invented" })[0]?.fatal).toBe(true);
  expect(validateSelection(catalog, { model: "gemini-4-argon-high", effort: "future" })[0]?.fatal).toBe(false);
});

test("catalog never turns errors, auth text, or empty output into models", () => {
  for (const stdout of ["", "Please authenticate", "error:       Auth required", "login       Please sign in", "gemini-4-argon-high", "gemini-4-argon-high;touch /tmp/x       Gemini", "gemini-4-argon-high       Gemini 4\nAuthentication required"]) {
    expect(providerCatalog("antigravity", { run: () => ({ exitCode: 0, stdout }) })).toBeNull();
  }
  expect(providerCatalog("antigravity", { run: () => ({ exitCode: 1, stdout: listing }) })).toBeNull();
});

test("installed discovery resolves the agy binary and keeps remote catalog shape", () => {
  writeFileSync(join(home, "agy"), `#!/bin/sh\nprintf '%s' '${listing}'\n`);
  chmodSync(join(home, "agy"), 0o755);
  const child = Bun.spawnSync([process.execPath, "-e", 'import {providerCatalog} from "./src/catalog"; console.log(JSON.stringify(providerCatalog("antigravity", {refresh:true})));'], { env: { ...process.env, PATH: home }, stdout: "pipe", stderr: "pipe" });
  expect(child.exitCode).toBe(0);
  const catalog = JSON.parse(child.stdout.toString());
  expect(catalog?.models[0]?.id).toBe("gemini-4-argon-high");
  expect(parseCatalogs(JSON.stringify([catalog, { provider: "agy" }]))).toEqual([catalog!]);
});

test("config defaults stay codex; exact antigravity pins persist and unknown ids fail", () => {
  expect(loadConfig().defaultProvider).toBe("codex");
  writeFileSync(join(home, "config.json"), JSON.stringify({ defaultProvider: "antigravity", conciergeProvider: "antigravity" }));
  expect(loadConfig().defaultProvider).toBe("antigravity");
  writeFileSync(join(home, "config.json"), JSON.stringify({ defaultProvider: "agy" }));
  expect(() => loadConfig()).toThrow(/provider/i);
});

test("role pins and models preserve all provider entries; export fails before writes", () => {
  addRole({ name: "auditor", instructions: "Review." });
  setRoleModel("auditor", "codex", "existing");
  setRoleModel("auditor", "antigravity", "gemini-4-argon-high");
  setRoleProvider("auditor", "antigravity");
  expect(requireRole("auditor").provider).toBe("antigravity");
  expect(modelForRole("auditor", "antigravity")).toBe("gemini-4-argon-high");
  expect(requireRole("auditor").models?.codex).toBe("existing");
  expect(() => setRoleProvider("auditor", "agy" as any)).toThrow(/provider/);
  expect(() => setRoleModel("auditor", "agy" as any, "bad")).toThrow(/provider/);
  expect(() => roleCommand("export", undefined, { provider: "antigravity", dryRun: true })).toThrow(/antigravity.*unsupported/i);
});

test("explicit antigravity usage fails without probes; picker includes third option", async () => {
  await expect(usageCommand({ provider: "antigravity" })).rejects.toThrow(/antigravity.*unsupported/i);
  expect(PROVIDER_OPTIONS).toEqual(["claude", "codex", "antigravity"]);
});

test("API validates provider and legacy selection before any remote forwarding", async () => {
  writeFileSync(join(home, "config.json"), JSON.stringify({ remotes: ["fixture"] }));
  const calls: string[][] = [];
  setRemoteRunnersForTests({ am: async (_host, args) => {
    calls.push(args);
    return { exitCode: 0, stdout: args[0] === "models" ? JSON.stringify([providerCatalog("antigravity", { run: () => ({ exitCode: 0, stdout: listing }) })]) : args[0] === "__detail" ? JSON.stringify({ provider: "antigravity" }) : "", stderr: "" };
  } });
  const { startApiServer } = await import("../src/server");
  const server = startApiServer({ port: 0, hostname: "127.0.0.1", token: "fixture-token" });
  try {
    const post = (body: object) => fetch(server.url + "/api/agents", { method: "POST", headers: { Authorization: "Bearer fixture-token" }, body: JSON.stringify({ name: "surface", host: "fixture", remoteDir: "/tmp/fixture", ...body }) });
    for (const body of [{ provider: "no-remote" }, { provider: "" }, { provider: null }, { provider: 5 }, { provider: "antigravity", codex: true }, { provider: "codex", codex: false }, { codex: "true" }]) {
      expect((await post(body)).status).toBe(400);
    }
    expect(calls).toEqual([]);
    expect((await post({ provider: "antigravity" })).status).toBe(201);
    expect(calls.find(args => args[0] === "new")).toContain("--antigravity");
  } finally { server.stop(); }
});

test("older remote cannot turn an Antigravity selection into its default provider", async () => {
  const { runRemoteAm } = await import("../src/remoteAgents");
  const calls: string[][] = [];
  setRemoteRunnersForTests({ am: async (_host, args) => {
    calls.push(args);
    return { exitCode: 0, stdout: JSON.stringify([{ provider: "codex", models: [{ id: "old-default", efforts: [] }], modelsExhaustive: true }]), stderr: "" };
  } });
  await expect(runRemoteAm("fixture", ["new", "blocked", "--antigravity"])).rejects.toThrow(/antigravity.*support/i);
  expect(calls).toHaveLength(1);
  expect(calls[0]?.[0]).toBe("models");
});

test("invalid provider fails before SSH, including TUI argument construction", async () => {
  const { runRemoteAm } = await import("../src/remoteAgents");
  const { remoteNewCommandArgs } = await import("../src/commands/ui");
  const calls: string[][] = [];
  setRemoteRunnersForTests({ am: async (_host, args) => { calls.push(args); return { exitCode: 0, stdout: "", stderr: "" }; } });
  await expect(runRemoteAm("fixture", ["new", "blocked", "--provider", "no-remote"])).rejects.toThrow(/provider/);
  expect(() => remoteNewCommandArgs({ name: "blocked", provider: "no-remote" as any })).toThrow(/provider/);
  expect(calls).toEqual([]);
});


test("all SSH launch paths reject older remotes before creation", () => {
  writeFileSync(join(home, "ssh"), `#!/bin/sh
printf '%s\\n' "$*" >> "$AGENTMGR_HOME/ssh-calls"
printf '%s' '[{"provider":"codex","models":[{"id":"old-default","efforts":[]}],"modelsExhaustive":true}]'
`);
  chmodSync(join(home, "ssh"), 0o755);
  for (const helper of ["sshAm", "sshAmAsync", "sshAmInteractive", "remoteExec"]) {
    const code = `import {${helper}} from "./src/remote"; try { await ${helper}("fixture", ["new", "blocked", "--antigravity"]); process.exit(2); } catch(e) { if (!String(e).includes("antigravity support")) throw e; }`;
    const child = Bun.spawnSync([process.execPath, "-e", code], { env: { ...process.env, PATH: home, AM_SSH_NO_MUX: "1" }, stdout: "pipe", stderr: "pipe" });
    expect(child.exitCode).toBe(0);
    const invalid = Bun.spawnSync([process.execPath, "-e", `import {${helper}} from "./src/remote"; try { await ${helper}("fixture", ["new", "invalid", "--provider", "other"]); process.exit(2); } catch(e) { if (!String(e).includes("unknown provider")) throw e; }`], { env: { ...process.env, PATH: home, AM_SSH_NO_MUX: "1" }, stdout: "pipe", stderr: "pipe" });
    expect(invalid.exitCode).toBe(0);
  }
  const cli = Bun.spawnSync([process.execPath, "src/index.ts", "-H", "fixture", "new", "invalid", "--provider", "other"], { env: { ...process.env, PATH: home }, stdout: "pipe", stderr: "pipe" });
  expect(cli.exitCode).not.toBe(0);
  expect(cli.stderr.toString()).toContain("unknown provider");
  const calls = readFileSync(join(home, "ssh-calls"), "utf8");
  expect(calls).toContain("models");
  expect(calls).not.toContain("blocked");
  expect(calls).not.toContain("invalid");
});

test("a remote reporting the wrong created provider fails verification", async () => {
  const { checkedRemoteAm } = await import("../src/remote");
  const catalog = providerCatalog("antigravity", { run: () => ({ exitCode: 0, stdout: listing }) });
  const calls: string[][] = [];
  await expect(checkedRemoteAm("fixture", ["new", "wrong", "--antigravity"], {}, async (_host, args) => {
    calls.push(args);
    return { exitCode: 0, stdout: args[0] === "models" ? JSON.stringify([catalog]) : JSON.stringify({ provider: "codex" }), stderr: "" };
  })).rejects.toThrow(/did not confirm provider antigravity/);
  expect(calls.map(args => args[0])).toEqual(["models", "new", "__detail"]);
});

test("Antigravity detail disables every unsupported control capability", async () => {
  const { writeAgent } = await import("../src/state");
  const { agentDetail } = await import("../src/server");
  const now = new Date().toISOString();
  writeAgent({ name: "capabilities", provider: "antigravity", status: "idle", dir: home, tmuxSession: "surface-test", createdAt: now, updatedAt: now });
  const detail = agentDetail("capabilities");
  expect(detail?.capabilities).toEqual({ remoteControl: false, quota: false, approvalRelay: false, interruptByReceipt: false, handoff: false, move: false, rename: false, subagents: false, attachments: false });
  expect(detail?.permissionRequests).toBe(false);
  expect(detail?.interruptByReceipt).toBe(false);
});


test("web actions honor provider limits and explicit server capabilities", () => {
  const source = readFileSync(new URL("../web/app.js", import.meta.url), "utf8");
  const functions = source.slice(source.indexOf("function capabilityAvailable("), source.indexOf("function updateAgentActions("));
  const { actionAvailable, capabilityAvailable } = runInNewContext(functions + "; ({ actionAvailable, capabilityAvailable });");
  const row = { provider: "antigravity", status: "working", name: "surface" };
  for (const action of ["handover", "move", "rename", "interrupt"]) expect(actionAvailable(row, action)).toBe(false);
  for (const action of ["stop", "restart", "terminal"]) expect(actionAvailable(row, action)).toBe(true);
  for (const capability of ["approvalRelay", "subagents", "attachments"]) expect(capabilityAvailable(row, capability)).toBe(false);
  expect(actionAvailable({ ...row, provider: "codex", capabilities: { rename: false } }, "rename")).toBe(false);
  expect(actionAvailable({ ...row, provider: "codex" }, "rename")).toBe(true);
});

test("unknown catalog providers never reach an injected runner", () => {
  let called = false;
  expect(() => providerCatalog("agy" as any, { run: () => { called = true; return { exitCode: 0, stdout: listing }; } })).toThrow(/provider/);
  expect(called).toBe(false);
});

test("attachment API refuses Antigravity before local writes or remote upload staging", async () => {
  const { startApiServer } = await import("../src/server");
  const { writeAgent } = await import("../src/state");
  const { existsSync } = await import("node:fs");
  const { inboxDir } = await import("../src/paths");
  const now = new Date().toISOString();
  writeAgent({ name: "no-images", provider: "antigravity", status: "idle", dir: home, tmuxSession: "surface-test", createdAt: now, updatedAt: now });
  writeFileSync(join(home, "config.json"), JSON.stringify({ remotes: ["fixture"] }));
  const calls: string[][] = [];
  let uploaded = false;
  setRemoteRunnersForTests({
    am: async (_host, args) => { calls.push(args); return { exitCode: 0, stdout: JSON.stringify({ provider: "antigravity", capabilities: { attachments: false } }), stderr: "" }; },
    sh: async () => { throw new Error("must not prepare remote upload"); },
    push: async () => { uploaded = true; throw new Error("must not upload"); },
  });
  const server = startApiServer({ port: 0, hostname: "127.0.0.1", token: "fixture-token" });
  try {
    const png = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);
    const post = (key: string) => fetch(server.url + "/api/agents/" + key + "/files", { method: "POST", headers: { Authorization: "Bearer fixture-token", "content-type": "image/png" }, body: png });
    expect((await post("no-images")).status).toBe(409);
    expect(existsSync(inboxDir("no-images"))).toBe(false);
    expect((await post("fixture:no-images")).status).toBe(409);
    expect(calls.map(args => args[0])).toEqual(["__detail"]);
    expect(uploaded).toBe(false);
  } finally { server.stop(); }
});
