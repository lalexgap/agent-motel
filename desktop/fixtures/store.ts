// All mutable fixture state in one place, so POST /__fixture/reset can rebuild
// it from the seeds. Per-agent maps are keyed by the row object itself, so a
// rename or a move only has to change the row.
import type { TranscriptEntry } from "../src/types";
import { buildRows, buildTranscript, seedQueue, type FixtureRow } from "./data";
import { runningSummary, seedPermissions, seedPrompt, seedSubagents, type PanePrompt, type PermissionRecord, type Subagent, type Workspace } from "./extras";
import { historyFor, removedHistories, type History } from "./usage";

export interface Message {
  id: string;
  row: FixtureRow;
  text: string;
  mode: "queue" | "now";
  state: "queued" | "delivered" | "cancelled";
  queuedAt: string;
  // An inter-agent message: listed with this msgId, which has no record behind it.
  peerMsgId?: string;
}

export interface FixtureState {
  rows: FixtureRow[];
  transcripts: Map<FixtureRow, TranscriptEntry[]>;
  messages: Map<string, Message>;
  queues: Map<FixtureRow, Message[]>;
  // Agents in the middle of a fixture delivery; the drift-net flip leaves them alone.
  delivering: Set<FixtureRow>;
  // Bumped by every lifecycle action, so timers started before it do nothing.
  epochs: Map<FixtureRow, number>;
  permissions: PermissionRecord[];
  prompts: Map<FixtureRow, { prompt: PanePrompt; consumed: boolean }>;
  subagents: Map<FixtureRow, Subagent[]>;
  workspaces: Map<FixtureRow, Workspace>;
  histories: Map<FixtureRow, History>;
  // Usage ledger entries of agents no longer in the fleet.
  removed: History[];
  uploads: number;
}

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
export function ulid(now = Date.now()): string {
  let time = "";
  for (let rest = now, i = 0; i < 10; i++, rest = Math.floor(rest / 32)) time = CROCKFORD[rest % 32] + time;
  let random = "";
  for (const byte of crypto.getRandomValues(new Uint8Array(16))) random += CROCKFORD[byte % 32];
  return time + random;
}

// Fills `rows` in place: callers hold on to that array (FixtureServer.rows).
export function createState(rows: FixtureRow[], now = Date.now()): FixtureState {
  rows.splice(0, rows.length, ...buildRows(now));
  const state: FixtureState = {
    rows,
    transcripts: new Map(rows.map((row) => [row, buildTranscript(row)])),
    messages: new Map(),
    queues: new Map(),
    delivering: new Set(),
    epochs: new Map(),
    permissions: seedPermissions(rows, now),
    prompts: new Map(),
    subagents: new Map(),
    workspaces: new Map(),
    histories: new Map(rows.filter((row) => !row.host).map((row) => [row, historyFor(row, now)])),
    removed: removedHistories(),
    uploads: 0,
  };
  for (const row of rows) {
    const seeded = seedQueue(row, () => ulid(), now);
    if (seeded.length) {
      state.queues.set(row, seeded.map((item) => {
        const message: Message = {
          id: ulid(), row, text: item.message ?? "", mode: "queue", state: "queued", queuedAt: item.queuedAt ?? new Date(now).toISOString(),
          ...(item.msgId ? { peerMsgId: item.msgId } : {}),
        };
        if (!message.peerMsgId) state.messages.set(message.id, message);
        return message;
      }));
    }
    const subagents = seedSubagents(row, now);
    if (subagents.length) {
      state.subagents.set(row, subagents);
      const summary = runningSummary(subagents);
      if (summary) row.subagents = summary;
    }
    if (row.name === "origami-docs" && !row.host) state.prompts.set(row, { prompt: seedPrompt(), consumed: false });
  }
  return state;
}
