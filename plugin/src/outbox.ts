import type {
  CollectionDelivery,
  ItemDeleted,
  ItemLeftOut,
  ItemWritten,
  MachineStateDelivery,
  PluginMessage,
  ShotDelivery,
  ShotIndex,
  SteamDelivery,
  SteamIndex,
  WorkflowDelivery,
  WriteRefused,
} from "@decent-sync/protocol";
import { type KeptDeliveries, type KeptDelivery, MAX_KEPT, MAX_KEPT_CHARACTERS, isKept } from "./kept-deliveries.js";

/**
 * A logical delivery, acknowledged once the server has stored it: a record,
 * a page of an index, a Workflow or machine state event, a collection, or
 * the answer to one of the server's Library writes.
 */
export type Delivery =
  | ShotDelivery
  | ShotIndex
  | SteamDelivery
  | SteamIndex
  | WorkflowDelivery
  | MachineStateDelivery
  | CollectionDelivery
  | ItemWritten
  | ItemDeleted
  | ItemLeftOut
  | WriteRefused;

/** The kinds of record the server can request by their ids. */
export type RecordKind = "shot" | "steam";

const RECORD_NAMES: Readonly<Record<RecordKind, string>> = { shot: "Shot", steam: "Steam Record" };

/**
 * Reads a requested record from Decaid's API as a delivery with the given id:
 * null if the tablet no longer has it, or it is not a record Decent Sync
 * sends. Throws if it cannot be read now, so it is tried again later.
 */
export type RecordReader = (id: string, deliveryId: string) => Promise<Delivery | null>;

/** Index pages wait while this many deliveries are queued. */
const SHORT_OUTBOX = 4;
/** How long to wait before reading the deliveries kept again after Decaid first fails to answer, doubling each time to at most RESTORE_RETRY_MAX_MS. */
const RESTORE_RETRY_MS = 5_000;
const RESTORE_RETRY_MAX_MS = 5 * 60_000;

/**
 * The plugin's one at-least-once outbox, for Shots, Steam Records and their
 * indices, Workflow and machine state events, collections, and the answers
 * to the server's Library writes. Workflow and machine state events are also
 * kept in Decaid's plugin storage (kept-deliveries.ts), each written there
 * before it is first sent, and after a reload they are sent first, with
 * their delivery ids, as a reconnect's are: nothing is sent until they are
 * read back. Everything else is held in memory for one runtime: a reload
 * loses it, and the indices and collections sent after the reload recover
 * what it held. A delivery stays until the server acknowledges it.
 * One logical delivery awaits acknowledgment at a time; the connection's
 * Sender keeps it, chunked or not, within Decaid's pending limit. Requested
 * records, those new on the tablet first, are read from Decaid's API one at
 * a time, when a connection is sending and nothing else is queued, so while
 * the server is unreachable only their ids are held.
 */
export class Outbox {
  private readonly queued = new Map<string, Delivery>();
  private readonly watchers: ((delivery: Delivery) => void)[] = [];
  private readonly requested = new Map<string, { kind: RecordKind; id: string }>();
  private readonly runtimeId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  private sequence = 0;
  private sendMessage?: (message: PluginMessage) => Promise<void>;
  /** Bumped by every welcome and disconnect, so a send prepared for one connection is not made on the next. */
  private connections = 0;
  /** The delivery awaiting acknowledgment. */
  private sent?: string;
  /** Deliveries handed to a connection at least once and not yet acknowledged. */
  private readonly handed = new Set<string>();
  private working = false;
  private stopped = false;
  private retryTimer?: number;
  /** Set until the deliveries kept by earlier loads are read back, and nothing is sent meanwhile. */
  private restoring = true;
  private restoreTimer?: number;
  private restoreDelayMs = RESTORE_RETRY_MS;
  /** The Workflow and machine state deliveries queued while restoring, oldest first, with the length of their JSON. */
  private readonly whileRestoring = new Map<string, number>();
  private whileRestoringCharacters = 0;
  /** Deliveries kept whose writes to Decaid's plugin storage are not yet answered; each waits for them before it is sent. */
  private readonly unwritten = new Set<string>();
  /** Whether dropping the oldest deliveries kept was logged since the last welcome. */
  private droppedLogged = false;

  constructor(
    private readonly log: (message: string) => void,
    private readonly readers: Readonly<Record<RecordKind, RecordReader>>,
    private readonly kept: KeptDeliveries,
  ) {}

  /**
   * Reads back the deliveries earlier loads kept, and queues them ahead of
   * everything queued since, which is kept after them. It sends nothing
   * meanwhile, so none is sent after a newer one, trying again, with
   * backoff, until Decaid answers. Decaid reads the plugin's storage from
   * memory, so its reads fail all together, and one that cannot read it as
   * the plugin loads cannot read the tablet's id either, without which the
   * plugin does not connect. The Workflow and
   * machine state deliveries queued meanwhile are held to the limits on
   * those kept (`holdWhileRestoring`).
   */
  async restore(): Promise<void> {
    let restored: Delivery[];
    try {
      restored = await this.kept.load();
    } catch (error) {
      if (this.stopped) return;
      const delay = this.restoreDelayMs;
      this.restoreDelayMs = Math.min(delay * 2, RESTORE_RETRY_MAX_MS);
      this.log(`Could not read the deliveries kept in Decaid's plugin storage, trying again in ${delay / 1000} s: ${error instanceof Error ? error.message : String(error)}.`);
      this.restoreTimer = setTimeout(() => {
        this.restoreTimer = undefined;
        void this.restore();
      }, delay);
      return;
    }
    if (this.stopped) return;
    this.whileRestoring.clear();
    this.whileRestoringCharacters = 0;
    const since = [...this.queued.values()];
    this.queued.clear();
    for (const delivery of [...restored, ...since]) this.queued.set(delivery.id, delivery);
    this.restoring = false;
    for (const delivery of since) if (isKept(delivery)) this.keep(delivery);
    // Keeping those queued since may have dropped the oldest.
    const sending = restored.filter((delivery) => this.queued.has(delivery.id)).length;
    if (sending > 0) this.log(`Sending ${sending} Workflow and machine state ${sending === 1 ? "event" : "events"} kept from before the plugin last unloaded.`);
    this.pump();
  }

  /** Whether a welcomed connection is sending. */
  get connected(): boolean { return this.sendMessage !== undefined; }

  welcome(send: (message: PluginMessage) => Promise<void>): void {
    this.sendMessage = send;
    this.connections++;
    this.sent = undefined;
    this.droppedLogged = false;
    this.pump();
  }

  disconnected(): void {
    this.sendMessage = undefined;
    this.connections++;
    this.sent = undefined;
  }

  stop(): void {
    this.stopped = true;
    this.disconnected();
    this.kept.stop();
    if (this.retryTimer !== undefined) clearTimeout(this.retryTimer);
    if (this.restoreTimer !== undefined) clearTimeout(this.restoreTimer);
  }

  enqueue(delivery: Delivery): void {
    this.queued.set(delivery.id, delivery);
    for (const watcher of this.watchers) watcher(delivery);
    // One queued while restoring is kept once those kept earlier are read back, after them.
    if (isKept(delivery)) {
      if (this.restoring) this.holdWhileRestoring(delivery);
      else this.keep(delivery);
    }
    this.pump();
  }

  acknowledge(id: string): void {
    this.forget(id);
    if (this.sent === id) this.sent = undefined;
    this.pump();
  }

  /** The ids of the records of that kind still to be read and sent. */
  requestedIds(kind: RecordKind): string[] {
    return [...this.requested.values()].filter((record) => record.kind === kind).map((record) => record.id);
  }

  /** Calls `watcher` with every delivery queued from now on, those read for the server's requests included. */
  watch(watcher: (delivery: Delivery) => void): void {
    this.watchers.push(watcher);
  }

  /** Drops a queued delivery that a newer one makes unnecessary; one being sent now stays, to be acknowledged. */
  discard(id: string): void {
    if (this.sent !== id) this.forget(id);
  }

  /**
   * Drops a queued delivery that a newer one makes unnecessary, unless it
   * was ever handed to a connection. One sent before a reconnect may still
   * be being stored by the server instance that received it; sent again,
   * ahead of the newer one, it is found already handled, or waited for, so
   * it can never be stored after the newer one.
   */
  supersede(id: string): void {
    if (!this.handed.has(id)) this.forget(id);
  }

  /**
   * Records to read and send: requested by the server, after those already
   * requested, where a record requested again keeps its place, or, with
   * `first`, ahead of them all, as for records new on the tablet.
   */
  request(kind: RecordKind, ids: string[], options: { first?: boolean } = {}): void {
    const records = ids.map((id) => [`${kind}:${id}`, { kind, id }] as const);
    if (options.first) {
      const keys = new Set<string>(records.map(([key]) => key));
      const others = [...this.requested].filter(([key]) => !keys.has(key));
      this.requested.clear();
      for (const [key, record] of [...records, ...others]) this.requested.set(key, record);
    } else {
      for (const [key, record] of records) this.requested.set(key, record);
    }
    this.pump();
  }

  /** Resolves once few enough deliveries are queued for an index to add a page. */
  async waitForRoom(): Promise<void> {
    while (!this.stopped && this.queued.size >= SHORT_OUTBOX) await new Promise<void>((resolve) => setTimeout(resolve, 50));
  }

  nextId(): string { return `${this.runtimeId}-${++this.sequence}`; }

  private pump(): void {
    if (this.restoring || this.retryTimer !== undefined || this.working || this.stopped || !this.sendMessage || this.sent !== undefined || (this.queued.size === 0 && this.requested.size === 0)) return;
    // The next delivery waits until kept in plugin storage, which pumps again.
    const next = this.queued.keys().next();
    if (!next.done && this.unwritten.has(next.value)) return;
    this.working = true;
    void this.work().catch(() => {
      // Only a send fails here: SyncConnection drops a transport whose send failed; the outbox stays for its replacement.
      this.log("Delivery interrupted; unacknowledged data remains queued.");
      this.retry();
    }).finally(() => {
      this.working = false;
      if (!this.stopped && this.sendMessage && this.sent === undefined) this.pump();
    });
  }

  private async work(): Promise<void> {
    const generation = this.connections;
    if (this.queued.size === 0 && this.requested.size > 0) {
      const [key, record] = this.requested.entries().next().value!;
      let delivery: Delivery | null;
      try { delivery = await this.readers[record.kind](record.id, this.nextId()); }
      catch {
        // Retry it after the others, so one unreadable record cannot hold up the rest.
        this.requested.delete(key);
        this.requested.set(key, record);
        this.log(`Could not read ${RECORD_NAMES[record.kind]} ${record.id} from Decaid; retrying it after the other requested records.`);
        this.retry();
        return;
      }
      if (this.stopped) return;
      this.requested.delete(key);
      // A record deleted on the tablet is absent; nothing deletes its server copy.
      if (delivery) {
        this.queued.set(delivery.id, delivery);
        for (const watcher of this.watchers) watcher(delivery);
      }
    }
    if (generation !== this.connections || !this.sendMessage) return;
    const next = this.queued.entries().next().value;
    if (!next) return;
    const [id, message] = next;
    if (this.unwritten.has(id)) return;
    this.sent = id;
    this.handed.add(id);
    await this.sendMessage(message);
  }

  /**
   * Keeps a Workflow or machine state delivery in Decaid's plugin storage,
   * sending it once written there, and drops the oldest kept, unless handed
   * to a connection already, if that takes them past the limits.
   */
  private keep(delivery: KeptDelivery): void {
    this.unwritten.add(delivery.id);
    const { written, dropped } = this.kept.keep(delivery);
    for (const id of dropped) {
      if (this.handed.has(id)) continue;
      this.queued.delete(id);
      this.unwritten.delete(id);
    }
    if (dropped.length > 0) this.logDropping();
    void written.then(() => {
      this.unwritten.delete(delivery.id);
      this.pump();
    });
  }

  /**
   * Holds a Workflow or machine state delivery queued while restoring, to be
   * kept once those kept earlier are read back, dropping the oldest held if
   * that takes them past the limits on those kept.
   */
  private holdWhileRestoring(delivery: KeptDelivery): void {
    const characters = JSON.stringify(delivery).length;
    this.whileRestoring.set(delivery.id, characters);
    this.whileRestoringCharacters += characters;
    while (this.whileRestoring.size > 1 && (this.whileRestoring.size > MAX_KEPT || this.whileRestoringCharacters > MAX_KEPT_CHARACTERS)) {
      const [oldest, size] = this.whileRestoring.entries().next().value!;
      this.whileRestoring.delete(oldest);
      this.whileRestoringCharacters -= size;
      this.queued.delete(oldest);
      this.logDropping();
    }
  }

  private logDropping(): void {
    if (this.droppedLogged) return;
    this.droppedLogged = true;
    this.log(`Dropping the oldest Workflow and machine state events not yet sent: at most ${MAX_KEPT} are kept, of at most ${MAX_KEPT_CHARACTERS / (1024 * 1024)} Mi characters.`);
  }

  /** Forgets a delivery, in memory and in Decaid's plugin storage. */
  private forget(id: string): void {
    const held = this.whileRestoring.get(id);
    if (held !== undefined) {
      this.whileRestoring.delete(id);
      this.whileRestoringCharacters -= held;
    }
    this.queued.delete(id);
    this.handed.delete(id);
    this.unwritten.delete(id);
    this.kept.remove(id);
  }

  private retry(): void {
    if (this.stopped || this.retryTimer !== undefined) return;
    this.retryTimer = setTimeout(() => { this.retryTimer = undefined; this.pump(); }, 5_000);
  }
}
