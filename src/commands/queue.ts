import { resolveAgent } from "../state";
import { queueList } from "../queue";
import { clearQueue } from "../deliver";
import { relativeTime } from "./ls";

export async function queueCommand(prefix: string, opts: { clear: boolean }): Promise<void> {
  const agent = resolveAgent(prefix);

  if (opts.clear) {
    await clearQueue(agent.name);
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
