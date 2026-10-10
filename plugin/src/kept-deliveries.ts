import { type MachineStateDelivery, type WorkflowDelivery, decodeMachineEvent } from "@decent-sync/protocol";
import type { PluginStorage } from "./storage.js";

// The outbox's Workflow and machine state deliveries, kept in Decaid's plugin
// storage until the server acknowledges them, so an unload loses none
// (ticket #93). Shots, Steam Records and collections are not kept: the
// indices and collections every load sends recover them.
//
// Decaid stores no null, so the plugin can delete no key it wrote, and it
// keeps a plugin's whole storage in memory (a Hive box). So the deliveries
// kept go in a ring of MAX_KEPT keys, `outbox.0` to `outbox.1999`, reused in
// turn, each holding one delivery and its sequence number, `{ seq, delivery }`.
// The key `outbox` holds the sequence numbers kept, `{ first, next, token }`:
// the deliveries numbered from `first` up to `next`, which is never more than
// MAX_KEPT apart, and a hash of the token they were made under. They belong
// to that token's Machine, so a load with another token, as after a barista
// enters another Machine's token, sends none of them: the server would
// credit them to that Machine. A delivery acknowledged, or dropped, is overwritten by its
// number alone, `{ seq }`, so storage holds no more than what is kept, and
// one at the head also moves `first` past it. A key holding another number
// than expected, as after a write that failed or one that landed before the
// sequence numbers did, is skipped. A delivery is sent only once Decaid has
// answered both the write of its key and that of the sequence numbers, in
// whichever order they land, or the plugin has given up waiting on them, or,
// while Decaid leaves writes unanswered, once they are sent (storage.ts).
//
// While the server is unreachable for long, at most MAX_KEPT deliveries,
// about a busy day of a Machine's state transitions, and MAX_KEPT_CHARACTERS
// of their JSON are kept, in memory and in storage: past either, the oldest
// are dropped, and the server's history then has a gap before the oldest it
// receives. The Workflow and machine state sent on every welcome still bring
// the current ones.

/** The most Workflow and machine state deliveries kept at once. */
export const MAX_KEPT = 2_000;
/** The most characters of their JSON kept at once, 2 Mi: some 4 MiB in Decaid's memory and storage. */
export const MAX_KEPT_CHARACTERS = 2 * 1024 * 1024;

/** The key holding the sequence numbers kept. */
const SEQUENCE_KEY = "outbox";

export type KeptDelivery = WorkflowDelivery | MachineStateDelivery;

/** Whether the outbox keeps a delivery of this type across unloads. */
export function isKept(delivery: { type: string }): delivery is KeptDelivery {
  return delivery.type === "workflow" || delivery.type === "machineState";
}

export class KeptDeliveries {
  /** The lowest sequence number kept, or `next` if none is. */
  private first = 0;
  /** The sequence number the next delivery kept is given. */
  private next = 0;
  /** The deliveries kept, by sequence number: their ids and the length of their JSON. */
  private readonly kept = new Map<number, { id: string; characters: number }>();
  /** Their sequence numbers, by delivery id. */
  private readonly numbers = new Map<string, number>();
  private characters = 0;
  private stopped = false;
  /** The hash of the token this load connects with, never the token itself. */
  private readonly token: string;

  constructor(
    private readonly storage: PluginStorage,
    private readonly log: (message: string) => void,
    token: string,
  ) {
    this.token = tokenHash(token);
  }

  /**
   * The deliveries kept, oldest first. Rejects, saying why, if Decaid
   * refuses or does not answer any read in time, so a read that failed is
   * never taken for nothing kept; loading again retries.
   */
  async load(): Promise<KeptDelivery[]> {
    this.kept.clear();
    this.numbers.clear();
    this.characters = 0;
    const sequence = parseSequence(await this.storage.read(SEQUENCE_KEY, "a read of the deliveries kept"));
    if (sequence.token !== undefined && sequence.token !== this.token && sequence.first < sequence.next) {
      this.log(`Not sending the Workflow and machine state events kept from before the plugin last unloaded, at most ${sequence.next - sequence.first}: they were made under another token.`);
      for (let seq = sequence.first; seq < sequence.next; seq++) this.writeRemoved(seq);
      this.first = this.next = sequence.next;
      this.writeSequence().catch((error: unknown) => this.failed("record the deliveries kept", error));
      return [];
    }
    const deliveries: KeptDelivery[] = [];
    for (let seq = sequence.first; seq < sequence.next; seq++) {
      const text = await this.storage.read(slotKey(seq), "a read of a delivery kept");
      const delivery = parseSlot(text, seq);
      if (!delivery) continue;
      this.add(seq, delivery.id, (text as string).length);
      deliveries.push(delivery);
    }
    this.first = sequence.first;
    this.next = sequence.next;
    this.skipRemoved();
    return deliveries;
  }

  /**
   * Keeps a delivery, after those `load` found, dropping the oldest kept if
   * that takes them past either limit. Returns the ids of those dropped,
   * and a promise that settles once Decaid has answered the writes, or
   * failed to: the delivery is then sent either way.
   */
  keep(delivery: KeptDelivery): { written: Promise<void>; dropped: string[] } {
    const seq = this.next++;
    const text = JSON.stringify({ seq, delivery });
    this.add(seq, delivery.id, text.length);
    const dropped: string[] = [];
    while (this.first < seq && (this.next - this.first > MAX_KEPT || this.characters > MAX_KEPT_CHARACTERS)) {
      const oldest = this.kept.get(this.first);
      if (oldest) {
        this.delete(this.first, oldest);
        dropped.push(oldest.id);
        // Unless the new delivery takes its key.
        if (slotKey(this.first) !== slotKey(seq)) this.writeRemoved(this.first);
      }
      this.first++;
    }
    this.skipRemoved();
    const written = Promise.all([
      this.storage.write(slotKey(seq), text, "the write of a delivery to keep"),
      this.writeSequence(),
    ]).then(
      () => undefined,
      (error: unknown) => this.failed("keep a delivery, so it is sent without being kept", error),
    );
    return { written, dropped };
  }

  /** Stops keeping a delivery, once acknowledged or no longer to be sent. Does nothing for one not kept. */
  remove(id: string): void {
    const seq = this.numbers.get(id);
    if (seq === undefined) return;
    this.delete(seq, this.kept.get(seq)!);
    this.writeRemoved(seq);
    if (seq !== this.first) return;
    this.skipRemoved();
    this.writeSequence().catch((error: unknown) => this.failed("record a delivery acknowledged", error));
  }

  stop(): void {
    this.stopped = true;
  }

  private add(seq: number, id: string, characters: number): void {
    this.kept.set(seq, { id, characters });
    this.numbers.set(id, seq);
    this.characters += characters;
  }

  private delete(seq: number, entry: { id: string; characters: number }): void {
    this.kept.delete(seq);
    this.numbers.delete(entry.id);
    this.characters -= entry.characters;
  }

  /** Moves `first` past the sequence numbers no longer kept. */
  private skipRemoved(): void {
    while (this.first < this.next && !this.kept.has(this.first)) this.first++;
  }

  /** Overwrites the key of a delivery no longer kept with its number alone, so storage no longer holds it. */
  private writeRemoved(seq: number): void {
    this.storage
      .write(slotKey(seq), JSON.stringify({ seq }), "the write of a delivery no longer kept")
      .catch((error: unknown) => this.failed("record a delivery no longer kept", error));
  }

  private writeSequence(): Promise<void> {
    return this.storage.write(SEQUENCE_KEY, JSON.stringify({ first: this.first, next: this.next, token: this.token }), "the write of the deliveries kept");
  }

  private failed(what: string, error: unknown): void {
    if (!this.stopped) this.log(`Could not ${what} in Decaid's plugin storage: ${error instanceof Error ? error.message : String(error)}.`);
  }
}

/** The key of the delivery with that sequence number. */
function slotKey(seq: number): string {
  return `${SEQUENCE_KEY}.${seq % MAX_KEPT}`;
}

/** The sequence numbers kept, and the hash of their token, as written at SEQUENCE_KEY: none if it was never written, or holds something else. */
function parseSequence(value: unknown): { first: number; next: number; token?: string } {
  const parsed = parse(value);
  const first = parsed?.first;
  const next = parsed?.next;
  if (!isCount(first) || !isCount(next) || first > next || next - first > MAX_KEPT) return { first: 0, next: 0 };
  return { first, next, token: typeof parsed?.token === "string" ? parsed.token : "" };
}

/**
 * A 32-bit FNV-1a hash of the token, in hex: enough to tell one Machine's
 * token from another's, and nothing that helps anyone guess a token of 32
 * random bytes.
 */
function tokenHash(token: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < token.length; index++) {
    hash ^= token.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/** The delivery a key holds, if it holds one numbered `seq` that the server would take. */
function parseSlot(value: unknown, seq: number): KeptDelivery | undefined {
  const parsed = parse(value);
  if (parsed?.seq !== seq || parsed.delivery === undefined) return undefined;
  const decoded = decodeMachineEvent(JSON.stringify(parsed.delivery));
  return decoded.ok ? decoded.message : undefined;
}

function parse(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
