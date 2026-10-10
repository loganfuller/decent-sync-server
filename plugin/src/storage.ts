import type { PluginHost, StorageCommand } from "./host.js";

// Decaid's plugin storage (`pluginStorage`), shared by everything the plugin
// keeps there: the tablet's id (tablet-id.ts) and the deliveries its outbox
// keeps across unloads (kept-deliveries.ts). Decaid answers a read with a
// `storageRead` event of `{ key, value }` and a write with a `storageWrite`
// event of only the data written, and leaves a command that fails
// unanswered, so commands go one at a time, each answered by the event that
// matches it or given up on after STORAGE_TIMEOUT_MS. A write waiting its
// turn takes the data of a later write to the same key, which then waits
// with it, so however slow Decaid is, no more writes wait than there are
// keys. A write Decaid leaves unanswered has the writes after it sent without
// waiting for answers, until Decaid answers anything again, so a Decaid that
// fails every write does not hold up each delivery waiting to be kept.
// Decaid stores a value only if it is not null, so no command deletes a
// key: a key once written stays until written again. A write sent as the
// plugin unloads still lands, as Decaid finishes a retiring generation's
// writes before the next one loads, so `stop` sends the writes still waiting
// their turn.

/** How long Decaid may take to answer a storage command before it counts as failed. */
export const STORAGE_TIMEOUT_MS = 10_000;

interface Command {
  command: StorageCommand;
  /** What the command does, for messages. */
  what: string;
  /** The event that answers it. */
  event: "storageRead" | "storageWrite";
  /** Whether that event's payload answers it. */
  answers(payload: unknown): boolean;
  /** Those waiting for it: more than one for a write that took the data of later ones. */
  waiting: { resolve(payload: unknown): void; reject(error: Error): void }[];
}

export class PluginStorage {
  /** Commands waiting their turn, in order. */
  private readonly queue: Command[] = [];
  /** The writes among them, by key. */
  private readonly queuedWrites = new Map<string, Command>();
  /** The command sent and awaiting Decaid's answer. */
  private waiting: { command: Command; timer: number } | undefined;
  /**
   * Set once Decaid leaves a write unanswered, until it answers anything:
   * meanwhile writes are sent without waiting for answers, as with a Decaid
   * failing every write each would otherwise hold up what waits on it for
   * STORAGE_TIMEOUT_MS.
   */
  private unanswered = false;
  private stopped = false;

  constructor(private readonly host: PluginHost) {}

  /** The value at `key`, null if it was never written. Rejects, saying why, if Decaid refuses or does not answer in time. */
  async read(key: string, what: string): Promise<unknown> {
    const answer = await this.run({ type: "read", key }, what, "storageRead", (payload) => {
      return typeof payload === "object" && payload !== null && (payload as { key?: unknown }).key === key;
    });
    return (answer as { value?: unknown }).value ?? null;
  }

  /**
   * Writes `data` at `key`, or a later write's data to the same key, made
   * while this one waited its turn. Rejects, saying why, if Decaid refuses or
   * does not answer in time; it may still have written it. While Decaid
   * leaves writes unanswered, it resolves once the write is sent.
   */
  async write(key: string, data: string, what: string): Promise<void> {
    // A read of the key queued between the two would read the later data. Nothing reads a key it is writing.
    const queued = this.queuedWrites.get(key);
    if (!queued || this.stopped) {
      await this.run({ type: "write", key, data }, what, "storageWrite", (payload) => payload === data);
      return;
    }
    queued.command = { type: "write", key, data };
    queued.what = what;
    queued.answers = (payload) => payload === data;
    await new Promise((resolve, reject) => queued.waiting.push({ resolve, reject }));
  }

  /** A Decaid event, which may answer the command awaiting one. */
  answered(name: string, payload: unknown): void {
    // Decaid answers again.
    this.unanswered = false;
    const waiting = this.waiting;
    if (!waiting || name !== waiting.command.event || !waiting.command.answers(payload)) return;
    this.settle();
    for (const waiter of waiting.command.waiting) waiter.resolve(payload);
    this.next();
  }

  /**
   * Sends the writes still waiting their turn, without waiting for Decaid's
   * answers, which it no longer sends once the plugin has unloaded, and
   * gives up on the reads. The write awaiting an answer is sent again first:
   * Decaid drops one it received just before the unload if it handles the
   * unload first, and writing the same data twice changes nothing.
   */
  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    const unloading = new Error("the plugin is unloading");
    const sent = this.settle();
    const unsent = [...(sent ? [sent.command] : []), ...this.queue.splice(0)];
    this.queuedWrites.clear();
    for (const command of unsent) {
      if (command.command.type === "write") {
        try {
          this.host.storage(command.command);
        } catch {
          // Refused as it would have been in its turn.
        }
      }
      fail(command, unloading);
    }
  }

  private run(command: StorageCommand, what: string, event: Command["event"], answers: Command["answers"]): Promise<unknown> {
    if (this.stopped) return Promise.reject(new Error("the plugin is unloading"));
    return new Promise((resolve, reject) => {
      const queued: Command = { command, what, event, answers, waiting: [{ resolve, reject }] };
      this.queue.push(queued);
      if (command.type === "write") this.queuedWrites.set(command.key, queued);
      if (!this.waiting) this.next();
    });
  }

  /** Sends the commands waiting their turn: the next one, or, while Decaid leaves writes unanswered, every write up to a read. */
  private next(): void {
    for (;;) {
      const command = this.queue.shift();
      if (!command) return;
      if (command.command.type === "write") this.queuedWrites.delete(command.command.key);
      if (this.unanswered && command.command.type === "write") {
        try {
          this.host.storage(command.command);
          for (const waiter of command.waiting) waiter.resolve(undefined);
        } catch (error) {
          fail(command, new Error(`Decaid refused ${command.what}: ${error instanceof Error ? error.message : String(error)}`));
        }
        continue;
      }
      const timer = setTimeout(() => {
        this.settle();
        if (command.command.type === "write") this.unanswered = true;
        fail(command, new Error(`Decaid's plugin storage did not answer ${command.what} within ${STORAGE_TIMEOUT_MS / 1000} s`));
        this.next();
      }, STORAGE_TIMEOUT_MS);
      this.waiting = { command, timer };
      try {
        this.host.storage(command.command);
        return;
      } catch (error) {
        // Such as Decaid refusing a plugin whose manifest lacks the permission.
        this.settle();
        fail(command, new Error(`Decaid refused ${command.what}: ${error instanceof Error ? error.message : String(error)}`));
      }
    }
  }

  /** Stops waiting for the answer to the command sent, returning what waited. */
  private settle(): { command: Command; timer: number } | undefined {
    const waiting = this.waiting;
    if (waiting) clearTimeout(waiting.timer);
    this.waiting = undefined;
    return waiting;
  }
}

function fail(command: Command, error: Error): void {
  for (const waiter of command.waiting) waiter.reject(error);
}
