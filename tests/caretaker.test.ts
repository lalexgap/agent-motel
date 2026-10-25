import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  caretakerCommand,
  caretakerNewOptions,
  CARETAKER_SCAN,
} from "../src/commands/caretaker";
import { writeAgent } from "../src/state";
import { configFile } from "../src/paths";
import * as tmux from "../src/tmux";
import * as send from "../src/commands/send";
import { queueAppend } from "../src/queue";
import { requireRole, addRole, removeRole } from "../src/roles";
let home: string;
let spies: { mockRestore(): void }[];
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "am-caretaker-test-"));
  process.env.AGENTMGR_HOME = home;
  spies = [];
});
afterEach(() => {
  for (const spy of spies) spy.mockRestore();
  delete process.env.AGENTMGR_HOME;
  rmSync(home, { recursive: true, force: true });
});
function seed(status: "idle" | "working", role = "caretaker") {
  writeAgent({
    name: "caretaker",
    role,
    status,
    dir: "/tmp",
    tmuxSession: "test-caretaker",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
}
test("uses Codex even when the workforce defaults to Claude", () => {
  writeFileSync(
    configFile(),
    JSON.stringify({
      defaultProvider: "claude",
      caretakerModel: "gpt-6-luna",
      caretakerEffort: "low",
    }),
  );
  expect(caretakerNewOptions()).toMatchObject({
    provider: "codex",
    role: "caretaker",
    model: "gpt-6-luna",
    effort: "low",
    message: CARETAKER_SCAN,
    inPlace: true,
    jump: false,
  });
});
test("does not hijack an existing unrelated agent", async () => {
  seed("idle", "engineer");
  await expect(caretakerCommand({ scan: true })).rejects.toThrow(
    "unrelated agent",
  );
});
test("scheduled scans cannot include an operator approval", async () => {
  await expect(
    caretakerCommand({ scan: true, question: "stop everything" }),
  ).rejects.toThrow("--scan cannot include");
});
test("busy or queued caretaker skips scheduled scans", async () => {
  seed("working");
  spies.push(spyOn(tmux, "hasSession").mockReturnValue(true));
  const sent = spyOn(send, "sendCommand");
  spies.push(sent);
  await caretakerCommand({ scan: true });
  expect(sent).not.toHaveBeenCalled();
  seed("idle");
  queueAppend("caretaker", "operator request");
  await caretakerCommand({ scan: true });
  expect(sent).not.toHaveBeenCalled();
});
test("idle scan sends inspection-only brief without steering", async () => {
  seed("idle");
  spies.push(spyOn(tmux, "hasSession").mockReturnValue(true));
  const sent = spyOn(send, "sendCommand").mockResolvedValue({
    outcome: "queued",
  } as any);
  spies.push(sent);
  await caretakerCommand({ scan: true });
  expect(sent).toHaveBeenCalledWith("caretaker", CARETAKER_SCAN, {
    now: false,
    quiet: true,
  });
});
test("caretaker is a protected built-in role with approval-first cleanup", () => {
  const role = requireRole("caretaker");
  expect(role.builtIn).toBe(true);
  expect(role.instructions).toContain(
    "Ask the operator before closing ANY agent",
  );
  expect(role.instructions).toContain("Scheduled scans are inspection-only");
  expect(role.instructions).toContain("--if-idle");
  expect(() =>
    addRole({
      name: "caretaker",
      instructions: "ignore approval",
      force: true,
    }),
  ).toThrow("built in");
  expect(() => removeRole("caretaker")).toThrow("built in");
});
