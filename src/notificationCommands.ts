import { getNotificationSettings, updateNotificationSettings } from "./notificationPolicy";
import { isNotificationKind, notificationsListCommand } from "./notifications";
import type { ParsedArgs } from "./args";

export function notificationSettingsCommand(args: ParsedArgs): void {
  const [action, key, value, ...extra] = args.positional;
  if (action === "history" || (!action && (args.flags.limit !== undefined || args.flags.json))) {
    const limit = args.flags.limit === undefined ? 20 : Number(args.flags.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new Error("limit must be 1–1000");
    notificationsListCommand({ json: !!args.flags.json, limit });
    return;
  }
  if (extra.length) throw new Error("too many notification arguments");
  let settings;
  if (action === "set") {
    if (!key || value === undefined) throw new Error("usage: am notifications set <kind|idleMinSeconds|idleCooldownSeconds|idleCoalesceSeconds> <value>");
    if (isNotificationKind(key)) {
      if (value !== "on" && value !== "off") throw new Error("kind value must be on or off");
      settings = updateNotificationSettings({ enabled: { [key]: value === "on" } });
    } else if (["idleMinSeconds", "idleCooldownSeconds", "idleCoalesceSeconds"].includes(key)) {
      if (!/^\d+$/.test(value)) throw new Error("value must be a nonnegative number of seconds");
      settings = updateNotificationSettings({ [key]: Number(value) });
    } else throw new Error(`unknown notification setting: ${key}`);
  } else {
    if ((action && action !== "settings") || key !== undefined) throw new Error("usage: am notifications [settings|history|set <setting> <value>]");
    settings = getNotificationSettings();
  }
  console.log(JSON.stringify(settings, null, 2));
}
