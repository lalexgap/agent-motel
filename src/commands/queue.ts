import { resolveAgent } from "../state";
import { queueClearEntries, queueList } from "../queue";
import { cancelQueuedMessages } from "../messages";
import { relativeTime } from "./ls";

export function queueCommand(prefix: string, opts: { clear: boolean }): void {
  const agent = resolveAgent(prefix);

  if (opts.clear) {
    cancelQueuedMessages(agent.name);
    queueClearEntries(agent.name);
    console.log(`cleared queue for "${agent.name}"`);
    return;
  }

  const items = queueList(agent.name);
  if (items.length === 0) {
    console.log(`queue for "${agent.name}" is empty`);
    return;
  }
  items.forEach((item, i) => {
    console.log(`${i + 1}. [${relativeTime(item.queuedAt)}] ${item.message}`);
  });
}
