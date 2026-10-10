import { isTabletId } from "@decent-sync/protocol";
import { keepStorageInBackups } from "./decaid.js";
import type { PluginStorage } from "./storage.js";

// This tablet's id (ADR-0006). Decaid gives plugins no installation id, so the
// plugin makes one, a random UUID, when its key in Decaid's plugin storage was
// never written, and keeps it there, where it survives plugin updates.
// Resetting the tablet's Decaid data loses it, and the next load makes a new
// one: the server then sees a new tablet, which can miss a delete but never
// invent one. A read Decaid fails or leaves unanswered (storage.ts) is
// retried by the caller, and never taken for a key never written. Decaid's
// backups hold the id only once its store API has read the plugin's storage
// since Decaid started, so the plugin has it read there on every load, asking
// again until it answers.

/** The id's key in this plugin's storage. */
const KEY = "tabletId";
/** How long to wait before asking Decaid's store API again to read the plugin's storage, after it failed to. */
const BACKUP_RETRY_MS = 30_000;

export class TabletId {
  /** Known once read or made, for as long as this load lasts. */
  private id: string | undefined;
  /** The read of the id under way, shared by callers meanwhile. */
  private reading: Promise<string> | undefined;
  /** The next attempt to have Decaid's backups include the id, while one is due. */
  private backupRetry: number | undefined;
  private stopped = false;

  constructor(
    private readonly storage: PluginStorage,
    private readonly log: (message: string) => void,
  ) {}

  /**
   * The tablet's id: the one in plugin storage, or, if that key was never
   * written, a new one, once Decaid has written it there, or, while Decaid
   * leaves writes unanswered (storage.ts), once it is sent: a Decaid that
   * cannot write it gives the tablet a new id each load. Rejects, saying why,
   * if Decaid refuses or does not answer in time; reading again later
   * retries.
   */
  read(): Promise<string> {
    if (this.id !== undefined) return Promise.resolve(this.id);
    this.reading ??= this.readOrMake().finally(() => {
      this.reading = undefined;
    });
    return this.reading;
  }

  stop(): void {
    this.stopped = true;
    if (this.backupRetry !== undefined) clearTimeout(this.backupRetry);
  }

  private async readOrMake(): Promise<string> {
    const stored = await this.storage.read(KEY, "a read of this tablet's id");
    if (isTabletId(stored)) return this.known(stored);

    const made = newTabletId();
    await this.storage.write(KEY, made, "the write of this tablet's new id");
    this.log(
      stored === null
        ? `This tablet had no id in Decaid's plugin storage, so it was given one: ${made}.`
        : `This tablet's id in Decaid's plugin storage was not a UUID, so it was given a new one: ${made}.`,
    );
    return this.known(made);
  }

  /** Keeps the id, once read or written, for this load, and has Decaid's backups include it. */
  private known(id: string): string {
    this.id = id;
    void this.keepInBackups();
    return id;
  }

  /** Has Decaid's store API read the plugin's storage, so backups hold the id, asking again until it answers. */
  private async keepInBackups(): Promise<void> {
    if ((await keepStorageInBackups()) || this.stopped) return;
    this.backupRetry = setTimeout(() => {
      this.backupRetry = undefined;
      void this.keepInBackups();
    }, BACKUP_RETRY_MS);
  }
}

/**
 * A random version 4 UUID. Math.random is the only randomness Decaid's
 * runtime offers, and enough: a tablet id need only differ from other
 * tablets', since the token, not the id, is what a tablet connects with.
 */
function newTabletId(): string {
  const hex = (digits: number) => {
    let text = "";
    for (let digit = 0; digit < digits; digit++) text += Math.floor(Math.random() * 16).toString(16);
    return text;
  };
  const variant = (8 + Math.floor(Math.random() * 4)).toString(16);
  return `${hex(8)}-${hex(4)}-4${hex(3)}-${variant}${hex(3)}-${hex(12)}`;
}
