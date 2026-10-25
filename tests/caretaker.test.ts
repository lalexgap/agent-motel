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
import * as deliver from "../src/deliver";
import { queueAppend, queueList } from "../src/queue";
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
    provider: "codex",
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
test("idle scan is admitted under delivery locks without steering", async () => {
  seed("idle");
  spies.push(spyOn(tmux, "hasSession").mockReturnValue(true));
  const delivered = spyOn(deliver, "deliverNext").mockResolvedValue({
    status: "empty",
  });
  spies.push(delivered);
  await caretakerCommand({ scan: true });
  expect(queueList("caretaker")[0]?.message).toBe(CARETAKER_SCAN);
  expect(delivered).toHaveBeenCalledWith("caretaker");
});
test("in-flight handoff suppresses a scan even while status is idle", async () => {
  seed("idle");
  const { readAgent } = await import("../src/state");
  writeAgent({
    ...readAgent("caretaker")!,
    statusChangedAt: new Date(Date.now() - 10000).toISOString(),
    lastHandoffAt: new Date().toISOString(),
  });
  spies.push(spyOn(tmux, "hasSession").mockReturnValue(true));
  await caretakerCommand({ scan: true });
  expect(queueList("caretaker")).toHaveLength(0);
});
test("revival refuses to select an unrelated last conversation", async () => {
  seed("idle");
  spies.push(spyOn(tmux, "hasSession").mockReturnValue(false));
  await expect(caretakerCommand({ scan: true })).rejects.toThrow(
    "no captured session ID",
  );
});
test("scheduled revival leaves queued operator work alone", async () => {
  seed("idle");
  spies.push(spyOn(tmux, "hasSession").mockReturnValue(false));
  queueAppend("caretaker", "operator request");
  await caretakerCommand({ scan: true });
  expect(queueList("caretaker")).toHaveLength(1);
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
