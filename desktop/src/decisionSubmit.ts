import { call } from "./bridge";
import { decisionOpener } from "./decisionOpen";
import type { DecisionAction } from "./types";

export async function submitDecision(connection: string, agent: string, id: string, action: DecisionAction, text: string): Promise<void> {
  const response = await call("decisions.answer", { connection, agent, id, action, text });
  if (response.status >= 200 && response.status < 300) return;
  const body = response.body as { error?: unknown; reason?: unknown } | null;
  if (response.status === 404 && body?.reason !== "decision_not_found") {
    await decisionOpener.open({ connection, agent, decisionId: id });
    throw new Error("This server needs an update for inline answers. The external decisions page was opened instead.");
  }
  throw new Error(typeof body?.error === "string" ? body.error : `Could not submit the decision (HTTP ${response.status}).`);
}
