import { expect, test } from "bun:test";
import { parseRuntimeSettings, agentRuntimeSettings } from "../src/runtimeSettings";

test("Codex uses the newest turn context, tolerating partial writes and unrelated events", () => {
  const lines = [
    { type: "turn_context", payload: { model: "old-model", effort: "low" } },
    { type: "turn_context", payload: { model: "actual-model", effort: "high" } },
    { type: "response_item", payload: { model: "ignored" } },
  ].map(JSON.stringify).join("\n") + '\n{"type":';
  expect(parseRuntimeSettings(lines, "codex")).toEqual({ model: "actual-model", effort: "high" });
  expect(parseRuntimeSettings(lines + '\n{"type":"turn_context","payload":{"model":"new-model"}}', "codex")).toEqual({ model: "new-model", effort: null });
});

test("Claude ignores sidechains and synthetic messages and does not invent reasoning effort", () => {
  const lines = [
    { type: "assistant", message: { model: "claude-model" } },
    { type: "assistant", isSidechain: true, message: { model: "subagent-model" } },
    { type: "assistant", message: { model: "<synthetic>" } },
  ].map(JSON.stringify).join("\n");
  expect(parseRuntimeSettings(lines, "claude")).toEqual({ model: "claude-model", effort: null });
});

test("unknown settings and explicit configuration are distinguished without guessing provider defaults", () => {
  const agent = { name: "runtime-test", provider: "codex" as const, status: "idle" as const, dir: "/no/such/workspace", tmuxSession: "none", createdAt: "now", updatedAt: "now" };
  expect(agentRuntimeSettings(agent)).toEqual({ model: null, effort: null, modelSource: "unknown", effortSource: "unknown" });
  expect(agentRuntimeSettings({ ...agent, model: "chosen", effort: "medium" })).toEqual({ model: "chosen", effort: "medium", modelSource: "configured", effortSource: "configured" });
});
