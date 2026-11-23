import type { NotificationSettings, NotificationSettingsPatch } from "./types";

export interface SettingsView {
  settings?: NotificationSettings;
  canSave: boolean;
  message: string;
  tone: "" | "ok" | "error";
}

export class NotificationSettingsController {
  private epoch = 0;
  private connection: string | null = null;
  private ready = false;
  private saving: Promise<void> | null = null;
  private loads = new Map<string, Promise<NotificationSettings>>();
  private revisions = new Map<string, number>();

  constructor(
    private readonly read: (connection: string) => Promise<NotificationSettings>,
    private readonly write: (connection: string, patch: NotificationSettingsPatch) => Promise<NotificationSettings>,
    private readonly cache: (connection: string, settings: NotificationSettings) => void,
    private readonly render: (view: SettingsView) => void,
  ) {}

  load(connection: string): Promise<NotificationSettings> {
    const existing = this.loads.get(connection);
    if (existing) return existing;
    const revision = this.revisions.get(connection) ?? 0;
    const pending = Promise.resolve(this.saving).then(() => this.read(connection)).then((settings) => {
      if (revision === (this.revisions.get(connection) ?? 0)) this.cache(connection, settings);
      return settings;
    }).finally(() => {
      if (this.loads.get(connection) === pending) this.loads.delete(connection);
    });
    this.loads.set(connection, pending);
    return pending;
  }

  async select(connection: string): Promise<void> {
    const epoch = ++this.epoch;
    this.connection = connection;
    this.ready = false;
    this.render({ canSave: false, message: "Loading…", tone: "" });
    try {
      if (this.saving) await this.saving;
      if (epoch !== this.epoch) return;
      const settings = await this.load(connection);
      if (epoch !== this.epoch) return;
      this.ready = true;
      this.render({ settings, canSave: true, message: "", tone: "" });
    } catch (error) {
      if (epoch === this.epoch) this.failure(error);
    }
  }

  close(): void {
    this.epoch++;
    this.connection = null;
    this.ready = false;
    this.render({ canSave: false, message: "", tone: "" });
  }

  async save(snapshot: () => NotificationSettingsPatch): Promise<void> {
    if (!this.connection || !this.ready || this.saving) return;
    const connection = this.connection;
    const epoch = this.epoch;
    let patch: NotificationSettingsPatch;
    try { patch = snapshot(); }
    catch (error) { this.failure(error); return; }
    this.ready = false;
    this.revisions.set(connection, (this.revisions.get(connection) ?? 0) + 1);
    this.loads.delete(connection);
    this.render({ canSave: false, message: "Saving…", tone: "" });
    const pending = this.write(connection, patch).then((settings) => {
      this.cache(connection, settings);
      if (epoch === this.epoch) {
        this.ready = true;
        this.render({ settings, canSave: true, message: "Saved on this server", tone: "ok" });
      }
    }).catch((error: unknown) => {
      if (epoch === this.epoch) this.failure(error);
    });
    this.saving = pending;
    await pending;
    if (this.saving === pending) this.saving = null;
  }

  private failure(error: unknown): void {
    this.ready = false;
    this.render({ canSave: false, message: error instanceof Error ? error.message : String(error), tone: "error" });
  }
}
