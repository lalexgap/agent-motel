import { expect, test } from "bun:test";
import { startDecisionEvents } from "../src/decisionEvents";

test("decision events cover creation, same-count edits, chat resolution and removal without leaking content", () => {
  let stores: Map<string, string> | null = new Map();
  const events: unknown[][] = [];
  const watcher = startDecisionEvents((...event) => events.push(event), () => stores, 60_000);
  try {
    stores = new Map([["am-test-decisions", '{"status":"open","question":"private question"}']]);
    watcher.scan();
    watcher.scan();
    stores = new Map([["am-test-decisions", '{"status":"open","question":"edited question"}']]);
    watcher.scan();
    stores = null;
    watcher.scan();
    stores = new Map([["am-test-decisions", '{"status":"decided"}']]);
    watcher.scan();
    stores = new Map();
    watcher.scan();
    expect(events).toEqual(Array.from({ length: 4 }, () => ["decisions-changed", "am-test-decisions"]));
  } finally { watcher.stop(); }
});
