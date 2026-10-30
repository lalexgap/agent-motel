import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

let home: string;
const root = resolve(import.meta.dir, "..");
const secret = "transport-secret-must-not-be-logged";

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "am-audit-transport-"));
  writeFileSync(join(home, "ssh"), '#!/bin/sh\nif [ "$SSH_WAIT" = 1 ]; then exec /bin/sleep 10; fi\nprintf "%s" "$SSH_OUTPUT"\nprintf "%s" "$SSH_ERROR" >&2\nexit "${SSH_EXIT:-0}"\n');
  writeFileSync(join(home, "tmux"), '#!/bin/sh\nexit "${TMUX_EXIT:-1}"\n');
  chmodSync(join(home, "ssh"), 0o755);
  chmodSync(join(home, "tmux"), 0o755);
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

function child(script: string, env: Record<string, string> = {}) {
  const result = Bun.spawnSync([process.execPath, "-e", script], {
    cwd: root,
    env: { ...process.env, AGENTMGR_HOME: home, PATH: `${home}:${process.env.PATH}`, AM_SSH_NO_MUX: "1", SSH_CONNECTION: "", SSH_OUTPUT: secret, SSH_ERROR: secret, SSH_EXIT: "0", TMUX_EXIT: "1", ...env },
    timeout: 15_000,
  });
  expect(result.stderr.toString()).toBe("");
  expect(result.exitCode).toBe(0);
}

function records(): any[] {
  const path = join(home, "logs", "lifecycle-audit.jsonl");
  if (!existsSync(path)) return [];
  const raw = readFileSync(path, "utf8");
  expect(raw).not.toContain(secret);
  return raw.trim().split("\n").map(line => JSON.parse(line));
}

describe("SSH lifecycle transport audit", () => {
  test("sync and async helpers pair requests with outcomes and preserve context", () => {
    child(`
      import { sshAm, sshAmAsync } from "./src/remote";
      import { withAuditContext } from "./src/audit";
      await withAuditContext({ source: "http-api", actor: "shared-bearer", auth: "bearer", route: "POST agents/:name/stop", peer: "127.0.0.9" }, async () => {
        sshAm("remote-box", ["stop", "sample", "--irrelevant", ${JSON.stringify(secret)}], { stdin: ${JSON.stringify(secret)} });
        await sshAmAsync("remote-box", ["rm", "sample"]);
        sshAm("remote-box", ["restart", "sample"]);
        await sshAmAsync("remote-box", ["stop", "sample", "--for-move"]);
        await sshAmAsync("remote-box", ["rm", "sample", "--for-move"]);
        await sshAmAsync("remote-box", ["__export", "sample"]);
        await sshAmAsync("remote-box", ["__detail", "sample"]);
      });
    `);
    const rows = records();
    expect(rows).toHaveLength(10);
    for (let i = 0; i < rows.length; i += 2) {
      expect(rows[i]).toMatchObject({ target: "sample", targetHost: "remote-box", phase: "requested", source: "http-api", actor: "shared-bearer", auth: "bearer", peer: "127.0.0.9", route: "POST agents/:name/stop" });
      expect(rows[i + 1]).toMatchObject({ requestId: rows[i].requestId, phase: "completed", action: rows[i].action });
    }
    expect(rows.filter(row => row.phase === "requested").map(row => row.action)).toEqual(["stop", "remove", "restart", "move", "move-cleanup"]);
  });

  test.each(["sshAm", "sshAmAsync", "sshAmInteractive", "remoteExec"])("%s audits flags before targets using CLI value rules", helper => {
    const cases: [string[], string][] = [
      [["stop", "--exact", "sample"], "stop"],
      [["rm", "--clean", "sample"], "remove"],
      [["restart", "--model", "default", "--effort", "high", "sample"], "restart"],
      [["stop", "--resume", "previous-session", "sample"], "stop"],
      [["stop", "--resume", "--exact", "sample"], "stop"],
      [["stop", "--for-move", "sample"], "move"],
      [["rm", "--for-move", "sample"], "move-cleanup"],
      [["stop", "--message", "--for-move", "sample"], "stop"],
      [["rm", "--description", "--for-move", "sample"], "remove"],
      [["stop", "--model", "--if-idle", "sample"], "stop"],
    ];
    for (const [args] of cases) {
      const argv = helper === "remoteExec" ? ["-H", "remote-box", ...args] : args;
      child(`import * as remote from "./src/remote"; await remote.${helper}("remote-box", ${JSON.stringify(argv)});`, {
        SSH_OUTPUT: JSON.stringify({ ok: false, reason: "busy" }), SSH_ERROR: "", AGENTMGR_AGENT: "origin-agent",
      });
    }
    const rows = records();
    expect(rows).toHaveLength(cases.length * 2);
    for (const [i, [, action]] of cases.entries()) {
      expect(rows[i * 2]).toMatchObject({ target: "sample", targetHost: "remote-box", action, actor: "origin-agent", phase: "requested" });
      expect(rows[i * 2 + 1]).toMatchObject({ requestId: rows[i * 2].requestId, action, phase: "completed" });
    }
  });

  test("if-idle before the target records captured refusals", () => {
    child(`
      import { sshAm, sshAmAsync } from "./src/remote";
      sshAm("remote-box", ["stop", "--if-idle", "sample"]);
      await sshAmAsync("remote-box", ["restart", "--if-idle", "sample"]);
    `, { SSH_OUTPUT: JSON.stringify({ ok: false, reason: "queued" }) });
    expect(records().map(row => [row.target, row.action, row.phase, row.reason])).toEqual([
      ["sample", "stop", "requested", undefined], ["sample", "stop", "refused", "queued"],
      ["sample", "restart", "requested", undefined], ["sample", "restart", "refused", "queued"],
    ]);
  });

  test("non-lifecycle helpers do not parse incomplete value flags", () => {
    child(`
      import { sshAm, sshAmAsync } from "./src/remote";
      sshAm("remote-box", ["__detail", "sample", "--model"]);
      await sshAmAsync("remote-box", ["__export", "sample", "--model"]);
    `);
    expect(records()).toEqual([]);
  });

  test("nonzero exits and timeouts fail without recording remote output", () => {
    child(`
      import { sshAm, sshAmAsync } from "./src/remote";
      if (sshAm("remote-box", ["stop", "sample"]).exitCode !== 7) throw new Error("wrong exit");
      if ((await sshAmAsync("remote-box", ["rm", "sample"])).exitCode !== 7) throw new Error("wrong exit");
    `, { SSH_EXIT: "7" });
    child(`
      import { sshAmAsync } from "./src/remote";
      if ((await sshAmAsync("remote-box", ["restart", "sample"], { timeoutMs: 30 })).exitCode !== 124) throw new Error("wrong timeout");
    `, { SSH_WAIT: "1" });
    expect(records().map(row => [row.phase, row.reason])).toEqual([
      ["requested", undefined], ["failed", "ssh_exit_nonzero"],
      ["requested", undefined], ["failed", "ssh_exit_nonzero"],
      ["requested", undefined], ["failed", "ssh_timeout"],
    ]);
  });

  test("interactive and remoteExec forwarding are audited before process exit", () => {
    child(`import { sshAmInteractive } from "./src/remote"; sshAmInteractive("remote-box", ["stop", "sample"]);`, { SSH_OUTPUT: "", SSH_ERROR: "" });
    child(`import { remoteExec } from "./src/remote"; remoteExec("remote-box", ["-H", "remote-box", "restart", "sample"]);`, { SSH_OUTPUT: "", SSH_ERROR: "" });
    expect(records().map(row => [row.action, row.phase])).toEqual([
      ["stop", "requested"], ["stop", "completed"], ["restart", "requested"], ["restart", "completed"],
    ]);
  });

  test("spawn failures are paired without logging raw errors", () => {
    rmSync(join(home, "ssh"));
    child(`
      import { sshAm, sshAmAsync } from "./src/remote";
      try { sshAm("remote-box", ["stop", "sample"]); } catch {}
      try { await sshAmAsync("remote-box", ["restart", "sample"]); } catch {}
    `, { PATH: home });
    expect(records().map(row => [row.phase, row.reason])).toEqual([
      ["requested", undefined], ["failed", "ssh_spawn_failed"],
      ["requested", undefined], ["failed", "ssh_spawn_failed"],
    ]);
  });

  test("zero-exit if-idle JSON refusals are refused with only safe reasons", () => {
    for (const reason of ["busy", "queued", "in_turn", secret]) {
      child(`
        import { sshAm, sshAmAsync } from "./src/remote";
        sshAm("remote-box", ["stop", "sample", "--if-idle"]);
        await sshAmAsync("remote-box", ["restart", "sample", "--if-idle"]);
      `, { SSH_OUTPUT: JSON.stringify({ ok: false, reason, error: secret }) });
    }
    const rows = records();
    expect(rows).toHaveLength(16);
    expect(rows.filter(row => row.phase === "refused").map(row => row.reason)).toEqual([
      "busy", "busy", "queued", "queued", "in_turn", "in_turn", "remote_refused", "remote_refused",
    ]);
    for (let i = 0; i < rows.length; i += 2) expect(rows[i + 1].requestId).toBe(rows[i].requestId);
  });
});

describe("HTTP stop transport audit", () => {
  test("records missing targets, invalid bodies and successful stops with normalized bearer context", () => {
    child(`
      import { startApiServer } from "./src/server";
      import { writeAgent } from "./src/state";
      const token = ${JSON.stringify(secret)};
      const server = startApiServer({ port: 0, hostname: "127.0.0.1", token });
      try {
        const post = (target, body, headers = {}) => fetch(server.url + "/api/agents/" + target + "/stop?token=" + token, { method: "POST", headers: { Authorization: "Bearer " + token, ...headers }, body: JSON.stringify(body) });
        if ((await post("missing", { text: token })).status !== 404) throw new Error("missing");
        if ((await post("missing", { ifIdle: token })).status !== 400) throw new Error("invalid");
        const now = new Date().toISOString();
        writeAgent({ name: "sample", status: "idle", dir: "/tmp", tmuxSession: "audit-test-no-live-session", createdAt: now, updatedAt: now });
        if ((await post("sample", {})).status !== 200) throw new Error("stop");
      } finally { server.stop(); }
    `);
    const rows = records();
    const http = rows.filter(row => row.action === "stop-request" && ["http_404", "http_400"].includes(row.reason));
    expect(http.map(row => [row.target, row.phase, row.reason])).toEqual([["missing", "refused", "http_404"], ["missing", "refused", "http_400"]]);
    expect(rows.some(row => row.target === "sample" && row.phase === "completed")).toBe(true);
    for (const row of rows) expect(row).toMatchObject({ source: "http-api", actor: "shared-bearer", auth: "bearer", route: "POST agents/:name/stop", peer: "127.0.0.1" });
    const requests = rows.filter(row => row.action === "stop-request");
    expect(requests).toHaveLength(6);
    for (let i = 0; i < requests.length; i += 2) expect(requests[i + 1].requestId).toBe(requests[i].requestId);
  });

  test("if-idle refusals retain their safe reason without stopping the agent", () => {
    child(`
      import { startApiServer } from "./src/server";
      import { writeAgent } from "./src/state";
      const token = ${JSON.stringify(secret)}, now = new Date().toISOString();
      writeAgent({ name: "sample", status: "working", dir: "/tmp", tmuxSession: "audit-test-fake-session", createdAt: now, updatedAt: now });
      const server = startApiServer({ port: 0, hostname: "127.0.0.1", token });
      try {
        const response = await fetch(server.url + "/api/agents/sample/stop", { method: "POST", headers: { Authorization: "Bearer " + token }, body: JSON.stringify({ ifIdle: true, text: token }) });
        if (response.status !== 409 || (await response.json()).reason !== "busy") throw new Error("refusal");
      } finally { server.stop(); }
    `, { TMUX_EXIT: "0" });
    const rows = records();
    expect(rows.filter(row => row.action === "stop-request").map(row => [row.phase, row.reason])).toEqual([["requested", undefined], ["refused", "busy"]]);
    expect(rows.some(row => row.action === "stop" && row.phase === "completed")).toBe(false);
  });

  test("remote HTTP stops retain caller context and targetHost on both transport layers", () => {
    writeFileSync(join(home, "config.json"), JSON.stringify({ remotes: ["remote-box"] }));
    child(`
      import { startApiServer } from "./src/server";
      const token = ${JSON.stringify(secret)};
      const server = startApiServer({ port: 0, hostname: "127.0.0.1", token });
      try {
        const response = await fetch(server.url + "/api/agents/remote-box:sample/stop", { method: "POST", headers: { Authorization: "Bearer " + token }, body: "{}" });
        if (response.status !== 200) throw new Error("stop");
      } finally { server.stop(); }
    `);
    const rows = records();
    expect(rows.map(row => [row.action, row.phase])).toEqual([
      ["stop-request", "requested"], ["stop", "requested"], ["stop", "completed"], ["stop-request", "completed"],
    ]);
    for (const row of rows) expect(row).toMatchObject({ target: "sample", targetHost: "remote-box", source: "http-api", actor: "shared-bearer", route: "POST agents/:name/stop" });
    expect(rows[0].requestId).toBe(rows[3].requestId);
    expect(rows[1].requestId).toBe(rows[2].requestId);
  });

  test("browser authentication and origin rejection happen before stop audit", () => {
    child(`
      import { startApiServer } from "./src/server";
      const token = ${JSON.stringify(secret)}, origin = "https://am.example.test";
      const server = startApiServer({ port: 0, hostname: "127.0.0.1", token, webOrigin: origin });
      try {
        const url = server.url + "/api/agents/missing/stop";
        if ((await fetch(url, { method: "POST", body: "{}" })).status !== 401) throw new Error("auth");
        const login = await fetch(server.url + "/auth/login", { method: "POST", headers: { origin }, body: JSON.stringify({ token }) });
        const cookie = login.headers.get("set-cookie").split(";")[0];
        if ((await fetch(url, { method: "POST", headers: { cookie, origin: "https://evil.test" }, body: "{}" })).status !== 403) throw new Error("origin");
        if ((await fetch(url, { method: "POST", headers: { cookie, origin }, body: "{}" })).status !== 404) throw new Error("stop");
      } finally { server.stop(); }
    `);
    const rows = records();
    expect(rows).toHaveLength(2);
    expect(rows.map(row => row.phase)).toEqual(["requested", "refused"]);
    for (const row of rows) expect(row).toMatchObject({ source: "web-front-desk", actor: "browser-session", auth: "browser-session", peer: "127.0.0.1", route: "POST agents/:name/stop" });
  });
});
