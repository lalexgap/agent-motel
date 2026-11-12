import { expect, test } from "bun:test";
import { DecisionOpenCoordinator } from "../desktop/src/decisionOpen";

test("decision opens share an exact in-flight target and allow a retry after settlement", async () => {
  const calls: unknown[] = [];
  let settle!: () => void;
  const coordinator = new DecisionOpenCoordinator((target) => {
    calls.push(target);
    return new Promise<void>((resolve) => { settle = resolve; });
  });
  const target = { connection: "a", agent: "api", decisionId: "d-1" };

  const first = coordinator.open(target);
  const duplicate = coordinator.open({ ...target });
  expect(duplicate).toBe(first);
  expect(calls).toEqual([target]);
  settle();
  await first;

  const retry = coordinator.open(target);
  expect(retry).not.toBe(first);
  expect(calls).toEqual([target, target]);
  settle();
  await retry;
});

test("decision opens do not combine different connection, agent, or decision targets", async () => {
  const calls: unknown[] = [];
  const coordinator = new DecisionOpenCoordinator(async (target) => { calls.push(target); });
  await Promise.all([
    coordinator.open({ connection: "a", agent: "api", decisionId: "d-1" }),
    coordinator.open({ connection: "b", agent: "api", decisionId: "d-1" }),
    coordinator.open({ connection: "a", agent: "worker", decisionId: "d-1" }),
    coordinator.open({ connection: "a", agent: "api", decisionId: "d-2" }),
  ]);
  expect(calls).toHaveLength(4);
});
