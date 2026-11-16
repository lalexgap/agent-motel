// A click on a native notification: open the agent it is about.
import { selectAgent } from "./chat";
import { reloadAll } from "./data";
import { notificationAgentKey } from "./fleet";
import { fleets } from "./state";
import type { BridgeEvents } from "./types";

export async function openFromNotification(payload: BridgeEvents["notification.open"]): Promise<void> {
  let key = notificationAgentKey(fleets(), payload.host, payload.agent);
  if (!key) {
    // The app may have been idle in the background: refresh once, then give up quietly.
    await reloadAll();
    key = notificationAgentKey(fleets(), payload.host, payload.agent);
  }
  if (key) selectAgent(key, false, "chat");
}
