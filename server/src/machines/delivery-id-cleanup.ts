import { Injectable, Logger, type OnApplicationBootstrap, type OnModuleDestroy } from "@nestjs/common";
import { PrismaService } from "../prisma.service.js";

/**
 * How long a recorded delivery id (`machine_event_deliveries`, see
 * `creditFirstDelivery`) is kept, counted from when the server recorded it.
 * Within it, a resend changes nothing. The plugin sends a delivery again on
 * its next welcomed connection, or after a reload from the deliveries its
 * outbox keeps in Decaid's plugin storage, so this is far longer than a
 * resend can plausibly come. One that comes later anyway, after the plugin
 * stayed unloaded or the server unreachable that long, is handled as a new
 * delivery. Its plugin sends it
 * ahead of anything newer, and an event is stored only if it differs from
 * the latest stored, so at worst it puts one stale event or collection value
 * after a newer one another tablet's mismatched session reported for the
 * same Machine.
 */
export const DELIVERY_ID_RETENTION_DAYS = 90;
/** How often each server instance deletes the delivery ids it no longer keeps. */
export const DELIVERY_ID_CLEANUP_INTERVAL_MS = 60 * 60_000;
/** The most delivery ids one statement deletes, so a large backlog never holds one long statement. */
export const DELIVERY_ID_CLEANUP_BATCH = 1_000;

/**
 * Deletes recorded delivery ids older than DELIVERY_ID_RETENTION_DAYS, by
 * PostgreSQL's clock (ADR-0016): once as the server starts, then every hour,
 * on every instance, with no operator action. It runs beside the server's
 * other work, never ahead of a `welcome` or a delivery. A run that fails is
 * logged, and the next tries again.
 */
@Injectable()
export class DeliveryIdCleanup implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger("DeliveryIdCleanup");
  private timer: NodeJS.Timeout | undefined;
  /** The run in progress, which shutdown waits for. */
  private running: Promise<void> | undefined;
  private stopped = false;

  constructor(private readonly prisma: PrismaService) {}

  onApplicationBootstrap(): void {
    this.schedule(0);
  }

  /** Runs before the database disconnects: stops the timer, and lets a run in progress finish its statement. */
  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.timer);
    await this.running;
  }

  private schedule(delayMs: number): void {
    this.timer = setTimeout(() => {
      this.running = this.run().finally(() => {
        this.running = undefined;
        if (!this.stopped) this.schedule(DELIVERY_ID_CLEANUP_INTERVAL_MS);
      });
    }, delayMs);
  }

  private async run(): Promise<void> {
    let deleted = 0;
    try {
      // Until a batch finds fewer than it may delete, or the server shuts down.
      while (!this.stopped) {
        const count = await this.deleteBatch();
        deleted += count;
        if (count < DELIVERY_ID_CLEANUP_BATCH) break;
      }
    } catch (error) {
      this.logger.error(`Could not delete delivery ids recorded more than ${DELIVERY_ID_RETENTION_DAYS} days ago; trying again in an hour: ${String(error)}`);
    }
    if (deleted > 0) this.logger.log(`Deleted ${deleted} delivery ids recorded more than ${DELIVERY_ID_RETENTION_DAYS} days ago`);
  }

  /**
   * Deletes a batch, oldest first, in a statement of its own. It skips rows
   * another transaction has locked, so it waits for no one, and runs on
   * other instances at the same time delete other rows. A delivery waits for
   * it only if it resends an id this statement is deleting, and then
   * records that id again.
   *
   * The rows are deleted by their ctid, which cannot change while this
   * statement holds their locks, so it reads only those rows. Matched by
   * key instead, each batch scanned the whole table of 10,000 or 100,000
   * ids.
   */
  private deleteBatch(): Promise<number> {
    return this.prisma.$executeRaw`
      DELETE FROM machine_event_deliveries WHERE ctid = ANY(ARRAY(
        SELECT ctid FROM machine_event_deliveries
        WHERE received_at < now() - make_interval(days => ${DELIVERY_ID_RETENTION_DAYS}::integer)
        ORDER BY received_at
        LIMIT ${DELIVERY_ID_CLEANUP_BATCH}::integer
        FOR UPDATE SKIP LOCKED
      ))`;
  }
}
