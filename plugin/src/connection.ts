import {
  CHUNK_LIMITS,
  CLOSE_CODES,
  type ErrorCode,
  MISSED_HEARTBEATS,
  type MachineHardware,
  PROTOCOL_VERSION,
  type PluginMessage,
  Reassembly,
  type ServerMessage,
  decodeServerFrame,
  decodeServerMessage,
  sameHardware,
} from "@decent-sync/protocol";
import { CollectionCapture } from "./collections.js";
import { readMachineHardware, readTabletIdentity } from "./decaid.js";
import type { PluginHost, TransportEvent } from "./host.js";
import { KeptDeliveries } from "./kept-deliveries.js";
import { LibraryAccess, LibraryWrites } from "./library-writes.js";
import { MachineEvents } from "./machine-events.js";
import { Outbox } from "./outbox.js";
import { Sender } from "./sender.js";
import { ShotCapture } from "./shots.js";
import type { SyncSettings } from "./settings.js";
import { SteamCapture } from "./steams.js";
import { PluginStorage } from "./storage.js";
import { TabletId } from "./tablet-id.js";

const MIN_RECONNECT_MS = 1_000;
const MAX_RECONNECT_MS = 60_000;
/**
 * An attempt the server has not welcomed by then is abandoned and retried.
 * It covers opening the transport, which Decaid does not time out: a server
 * that accepts the TCP connection but never answers the WebSocket upgrade
 * would otherwise hold the attempt open for good. Reading Decaid's API comes
 * before it, since Decaid already times out its fetches (after 30 s).
 */
const CONNECT_TIMEOUT_MS = 15_000;
/**
 * Decaid's limit on transports per plugin generation, which counts opens
 * still in progress (plugin_transport_service.dart). An abandoned open cannot
 * be cancelled: it holds its slot until it ends, which for an upgrade the
 * server never answers may be never.
 */
const MAX_TRANSPORTS = 8;
/**
 * Machine state updates arrive many times a second while a machine is
 * connected; after one leads to a hardware check, the next waits this long.
 */
const HARDWARE_CHECK_COOLDOWN_MS = 5_000;
/**
 * How long a plugin another tablet replaced waits before each `yielding`
 * hello, which the server refuses while that tablet stays connected.
 */
const YIELD_MS = 5 * 60_000;
/**
 * How long a connection whose send failed waits for its transport's own
 * events before it is dropped. A send can fail as soon as its transport
 * ends, before the events received ahead of the end are handled, as the
 * simulated host delivers them, such as the server's error saying another
 * tablet took over; those then decide what follows.
 */
const SEND_FAILURE_GRACE_MS = 2_000;

/** Close codes after which retrying cannot help until someone changes something. */
const FINAL_CLOSES = new Map<number, string>([
  [CLOSE_CODES.bad_token, "The server refused the token. Enter the token shown when the machine entry was created, or a newly issued one."],
  [CLOSE_CODES.plugin_too_old, "The server needs a newer version of this plugin. Update the plugin."],
  [CLOSE_CODES.decaid_too_old, "The server needs a newer version of Decaid. Update Decaid on this tablet."],
]);

/** Close codes after which, or after their error message, the plugin waits, then connects with a `yielding` hello. */
const YIELDING_CLOSES = new Map<number, string>([
  [
    CLOSE_CODES.replaced,
    `Another tablet connected with this Machine's token and took over. Connecting again in ${YIELD_MS / 1000} s, unless that tablet is still connected then.`,
  ],
  [CLOSE_CODES.machine_held, `Another tablet is still connected with this Machine's token. Trying again in ${YIELD_MS / 1000} s.`],
]);

type TimerName = "restore" | "reconnect" | "heartbeat" | "silence" | "connect" | "hardwarePoll" | "hardwareCooldown" | "sendFailed";

/**
 * The plugin's one connection to the sync server: `hello` on every connect,
 * heartbeats once welcomed, and reconnecting with backoff after a drop.
 * Stops for good on a close that retrying cannot fix.
 *
 * A connection from another tablet with the same token replaces this one.
 * The plugin then keeps capturing, as while the server is unreachable, and
 * after `YIELD_MS` connects with a `yielding` hello, which the server refuses
 * while that tablet stays connected; it then waits and tries again the same
 * way until a hello is welcomed. So two tablets with one token never take
 * turns: the one connected last keeps the Machine until it goes away.
 *
 * The server answers every heartbeat, so a welcomed connection the server has
 * sent nothing on for `MISSED_HEARTBEATS` intervals is dropped. A server host
 * that vanished without resetting the connection would otherwise leave it
 * open, capturing nothing, until Android's TCP retransmissions give up.
 *
 * The server decides who the tablet is only at `hello` (ADR-0015), so when
 * the machine first reports its hardware, or reports different hardware,
 * the plugin reconnects to send a new one. It checks on machine state
 * updates and every poll interval. After the server refuses the reported
 * hardware for this token, it connects again only once the machine reports
 * other hardware.
 *
 * The server writes the Library items its Location shares to the tablet: it
 * asks for one write at a time, and the plugin carries each out through
 * Decaid's API, between its reads of the lists it writes to, and answers it
 * through the outbox (library-writes.ts).
 */
export class SyncConnection {
  /** The open handle, or undefined while disconnected. */
  private handle: string | undefined;
  /** Sends every message on the open handle. */
  private sender: Sender | undefined;
  /** Puts the open handle's chunked messages from the server back together. */
  private chunks = new Reassembly();
  /** Bumped by every attempt and drop, so late results of an older one are ignored. */
  private attempt = 0;
  private connecting = false;
  private stopped = false;
  private welcomed = false;
  /** How long a welcomed connection may go without hearing from the server, from its `welcome`. */
  private silenceMs = 0;
  private reconnectDelayMs = MIN_RECONNECT_MS;
  /** Transports opening, open or closing, as Decaid counts them against MAX_TRANSPORTS. */
  private transportsInUse = 0;
  private readonly timers = new Map<TimerName, number>();
  /** The hardware the latest `hello` reported, null while no machine was connected. */
  private sentHardware: MachineHardware | null = null;
  /**
   * Set once the machine this connection's `hello` reported is seen gone:
   * no hardware read, or Decaid refusing a write of the shared settings as
   * no machine is connected. Decaid refuses those while it is gone, and the
   * server skips such a write until it changes or the tablet reconnects, so
   * once the same machine is back the plugin reconnects, and is written it
   * again.
   */
  private machineAway = false;
  /** Hardware the server dismissed for this token; while set, the plugin does not connect. */
  private dismissedHardware: MachineHardware | null = null;
  /** Set once another tablet replaced this one, until a `yielding` hello is welcomed. */
  private yielding = false;
  /** Decaid's plugin storage, where the tablet's id and the outbox's Workflow and machine state events are kept. */
  private readonly storage: PluginStorage;
  /** Everything awaiting the server's acknowledgment, kept across reconnects, and its Workflow and machine state events across unloads. */
  private readonly outbox: Outbox;
  private readonly shots: ShotCapture;
  private readonly steams: SteamCapture;
  private readonly machineEvents: MachineEvents;
  private readonly collections: CollectionCapture;
  /** Carries out the Library writes the server asks for, one at a time, between reads of the lists it writes to. */
  private readonly writes: LibraryWrites;
  /** This tablet's id, read from Decaid's plugin storage before the first connection and sent in every `hello`. */
  private readonly tabletId: TabletId;
  private checkingHardware = false;
  private hardwareCooldown = false;

  constructor(
    private readonly host: PluginHost,
    private readonly settings: SyncSettings,
    private readonly log: (message: string) => void,
  ) {
    this.storage = new PluginStorage(host);
    this.outbox = new Outbox(
      log,
      {
        shot: (id, deliveryId) => this.shots.read(id, deliveryId),
        steam: (id, deliveryId) => this.steams.read(id, deliveryId),
      },
      new KeptDeliveries(this.storage, log, settings.token),
    );
    this.shots = new ShotCapture(this.outbox, log);
    this.steams = new SteamCapture(this.outbox, settings.pollSeconds * 1000, log);
    this.machineEvents = new MachineEvents(this.outbox);
    const library = new LibraryAccess();
    this.collections = new CollectionCapture(this.outbox, library, settings.pollSeconds * 1000);
    this.writes = new LibraryWrites(library, this.outbox, this.machineEvents, () => {
      if (this.sentHardware !== null) this.machineAway = true;
    });
    this.tabletId = new TabletId(this.storage, log);
  }

  /**
   * Reads back the outbox's deliveries kept by earlier loads, and connects,
   * from timers, so the caller (onLoad) returns at once.
   */
  start(): void {
    this.setTimer("restore", 0, () => void this.outbox.restore());
    this.setTimer("reconnect", 0, () => void this.connect());
    this.scheduleHardwarePoll();
    this.steams.start();
    this.collections.start();
  }

  /**
   * A machine state update, sent only while a machine is connected: a change
   * of state is recorded, and the machine may have just reported its hardware.
   */
  stateUpdate(payload: unknown): void {
    if (this.stopped) return;
    this.machineEvents.stateUpdate(payload);
    this.checkHardwareSoon();
  }

  workflowUpdated(payload: unknown): void {
    if (!this.stopped) this.machineEvents.workflowUpdated(payload);
  }

  shotEvent(type: "shot" | "shotUpdated", payload: unknown): void { this.shots.event(type, payload); }

  /** Decaid's answer to a command to its plugin storage. */
  storageEvent(name: string, payload: unknown): void { this.storage.answered(name, payload); }

  stop(): void {
    this.stopped = true;
    this.outbox.stop();
    this.shots.stop();
    this.steams.stop();
    this.collections.stop();
    this.tabletId.stop();
    // Sends the writes still waiting their turn, such as of a delivery just acknowledged.
    this.storage.stop();
    for (const id of this.timers.values()) clearTimeout(id);
    this.timers.clear();
    this.closeHandle();
  }

  /** Checks the machine's hardware, unless a check started within the cooldown. */
  private checkHardwareSoon(): void {
    if (this.hardwareCooldown) return;
    this.hardwareCooldown = true;
    this.setTimer("hardwareCooldown", HARDWARE_CHECK_COOLDOWN_MS, () => {
      this.hardwareCooldown = false;
    });
    void this.checkHardware();
  }

  private async connect(): Promise<void> {
    if (this.stopped || this.connecting || this.handle !== undefined) return;
    this.connecting = true;
    const attempt = ++this.attempt;
    try {
      let tabletId: string;
      try {
        tabletId = await this.tabletId.read();
      } catch (error) {
        // Retried after the backoff: a read that failed is never taken for an id never written.
        if (attempt === this.attempt) this.drop(describe(error));
        return;
      }
      if (this.stopped || attempt !== this.attempt) return;
      const identity = await readTabletIdentity();
      if (this.stopped || attempt !== this.attempt) return;
      // The server refuses a hello without it.
      if (identity.decaidVersion === null) {
        this.drop("could not read Decaid's version from its API");
        return;
      }
      if (this.transportsInUse >= MAX_TRANSPORTS) {
        this.drop(
          `${this.transportsInUse} earlier connection attempts are still waiting for the server to answer, and Decaid allows no more until one ends. Reloading the plugin releases them`,
        );
        return;
      }
      this.setTimer("connect", CONNECT_TIMEOUT_MS, () =>
        this.drop(`the server did not answer within ${CONNECT_TIMEOUT_MS / 1000} s`),
      );
      const handle = await this.openTransport();
      // Opened after the attempt was abandoned, by the deadline or by stop().
      if (this.stopped || attempt !== this.attempt) {
        this.closeTransport(handle);
        return;
      }
      this.handle = handle;
      this.sender = new Sender((frame) => this.host.transport.send(handle, { type: "text", data: frame }));
      this.chunks = new Reassembly();
      this.welcomed = false;
      this.sentHardware = identity.machine;
      this.machineAway = false;
      this.host.transport.onEvent(handle, (event) => this.onTransportEvent(handle, event));
      await this.send(handle, {
        type: "hello",
        protocolVersion: PROTOCOL_VERSION,
        token: this.settings.token,
        pluginVersion: __PLUGIN_VERSION__,
        decaidVersion: identity.decaidVersion,
        tabletId,
        connectionId: identity.connectionId,
        machine: identity.machine,
        ...(this.yielding ? { yielding: true } : {}),
      });
    } catch (error) {
      if (attempt === this.attempt) this.drop(`could not connect to ${this.settings.syncUrl}: ${describe(error)}`);
    } finally {
      // An abandoned attempt was released by drop(), and a newer one may be under way.
      if (attempt === this.attempt) this.connecting = false;
    }
  }

  private onTransportEvent(handle: string, event: TransportEvent): void {
    // Events for a handle already dropped, including its own close, are stale.
    if (handle !== this.handle) return;
    switch (event.type) {
      case "data":
        if (event.dataType === "text") this.onFrame(handle, event.data);
        // Anything the server sends shows it is there, even a message this plugin cannot read.
        if (handle === this.handle && this.welcomed) this.awaitServer(handle);
        break;
      case "error":
        this.drop(`connection error (${event.code}): ${event.message}`);
        break;
      case "close": {
        if (event.code === CLOSE_CODES.hardware_dismissed && this.sentHardware) {
          this.dismissedHardware = this.sentHardware;
          this.abandon();
          this.log(
            "The server refused this machine's hardware for this Machine's token. Not connecting until the machine reports other hardware, or another token is entered.",
          );
          break;
        }
        const final = event.code === undefined ? undefined : FINAL_CLOSES.get(event.code);
        const yielding = event.code === undefined ? undefined : YIELDING_CLOSES.get(event.code);
        if (final) {
          this.log(final);
          this.stop();
        } else if (yielding) {
          this.yieldToAnotherTablet(yielding);
        } else {
          this.drop(`the server closed the connection${event.code === undefined ? "" : ` (${event.code}${event.reason ? `: ${event.reason}` : ""})`}`);
        }
        break;
      }
    }
  }

  private onFrame(handle: string, frame: string): void {
    const decoded = decodeServerFrame(frame);
    if (!decoded.ok) {
      // A newer server may send messages this plugin does not know yet.
      this.log(`Ignoring a message from the server: ${decoded.problem}`);
      return;
    }
    if (decoded.message.type !== "chunk") return this.onMessage(handle, decoded.message);
    // A message too large for one frame, such as a large Library item to write.
    const added = this.chunks.add(decoded.message, CHUNK_LIMITS);
    if (added.status === "invalid") return this.drop(`the server sent chunks that do not fit together: ${added.problem}`);
    if (added.status === "incomplete") return;
    const whole = decodeServerMessage(added.text);
    if (!whole.ok) return this.log(`Ignoring a message from the server: ${whole.problem}`);
    this.onMessage(handle, whole.message);
  }

  private onMessage(handle: string, message: ServerMessage): void {
    switch (message.type) {
      case "welcome":
        if (this.welcomed) return;
        this.welcomed = true;
        this.yielding = false;
        this.reconnectDelayMs = MIN_RECONNECT_MS;
        this.clearTimer("connect");
        this.log(`Connected to ${this.settings.syncUrl}`);
        this.silenceMs = message.heartbeatIntervalMs * MISSED_HEARTBEATS;
        this.scheduleHeartbeat(handle, message.heartbeatIntervalMs);
        // What the last connection left unacknowledged goes first, then the
        // latest Workflow, queued before the outbox starts sending, then
        // every collection, read again, and, after the load's first welcome,
        // the Shot and Steam Record indices, which later welcomes resume
        // rather than send again. Steam Records are polled at once.
        this.machineEvents.welcome();
        this.outbox.welcome(async (delivery) => {
          try { await this.send(handle, delivery); }
          catch (error) {
            this.sendFailed(handle, "could not send a delivery");
            throw error;
          }
        });
        this.collections.sendAll();
        this.shots.welcome();
        this.steams.welcome();
        break;
      case "ack":
        this.sender?.acknowledged(message.id);
        this.outbox.acknowledge(message.id);
        break;
      case "chunkReceived":
        this.sender?.received(message.id, message.index);
        break;
      case "requestShots":
        this.outbox.request("shot", message.shotIds);
        break;
      case "requestSteams":
        this.outbox.request("steam", message.steamIds);
        break;
      case "requestCollections":
        // As when the Machine's Location changed: its Workflow and Library are taken in there before anything is written to it.
        this.machineEvents.resend();
        this.collections.sendAll();
        break;
      case "write":
        // The connection that asked waits for the answer, which the outbox sends behind the reports read before the
        // write. If that connection drops meanwhile, the next one records the answer, though not as one it awaits.
        void this.writes.apply(message);
        break;
      case "delete":
        // Answered as a write is, through the outbox.
        void this.writes.remove(message);
        break;
      case "leaveOut":
        // Answered as a write is, through the outbox.
        void this.writes.leaveOut(message);
        break;
      case "heartbeat":
        // Its arrival is what counts.
        break;
      case "error": {
        this.log(`The server reported ${describeError(message.code)}: ${message.message}`);
        // The close that follows decides what happens next, unless another tablet replaced this one or holds the
        // Machine: then the plugin gives way now, in case the connection fails before that close arrives.
        const yielding = YIELDING_CLOSES.get(CLOSE_CODES[message.code]);
        if (yielding) this.yieldToAnotherTablet(yielding);
        break;
      }
    }
  }

  private scheduleHeartbeat(handle: string, intervalMs: number): void {
    this.setTimer("heartbeat", intervalMs, () => {
      if (handle !== this.handle) return;
      this.send(handle, { type: "heartbeat" }).then(
        () => this.scheduleHeartbeat(handle, intervalMs),
        (error: unknown) => {
          this.sendFailed(handle, `could not send a heartbeat: ${describe(error)}`);
        },
      );
    });
  }

  /** Restarts the wait for the server's next message, dropping the connection if none comes in time. */
  private awaitServer(handle: string): void {
    this.setTimer("silence", this.silenceMs, () => {
      if (handle === this.handle) this.drop(`heard nothing from the server for ${this.silenceMs / 1000} s`);
    });
  }

  /**
   * A send on the handle failed. Its transport's events, the server's last
   * messages among them, are handled first, and decide what happens next; if
   * none ends the connection in time, it is dropped for `reason`.
   */
  private sendFailed(handle: string, reason: string): void {
    if (handle !== this.handle) return;
    this.setTimer("sendFailed", SEND_FAILURE_GRACE_MS, () => {
      if (handle === this.handle) this.drop(reason);
    });
  }

  /** Sends on the handle, in chunks if the message is too large for a frame, unless the handle was dropped. */
  private send(handle: string, message: PluginMessage): Promise<void> {
    if (handle !== this.handle || !this.sender) return Promise.reject(new Error("The connection closed"));
    return this.sender.send(message);
  }

  /**
   * Reads the machine's hardware and reconnects if the current connection
   * reported other hardware, or none, or if it differs from hardware the
   * server dismissed.
   */
  private async checkHardware(): Promise<void> {
    if (this.stopped || this.checkingHardware) return;
    this.checkingHardware = true;
    try {
      const hardware = await readMachineHardware();
      if (this.stopped) return;
      // While no machine is connected there is nothing new to tell the server, but the machine is away.
      if (hardware === null) {
        if (this.welcomed && this.sentHardware !== null) this.machineAway = true;
        return;
      }
      if (this.dismissedHardware) {
        if (sameHardware(hardware, this.dismissedHardware)) return;
        this.dismissedHardware = null;
        this.log("The machine reports other hardware than the server refused. Connecting.");
        this.reconnectNow();
        return;
      }
      if (!this.welcomed) return;
      if (sameHardware(hardware, this.sentHardware)) {
        if (!this.machineAway) return;
        this.log("The machine is connected again. Reconnecting, so the server writes what Decaid refused while it was away.");
        this.reconnectNow();
        return;
      }
      this.log(
        this.sentHardware === null
          ? "The machine reports its hardware now. Reconnecting to tell the server."
          : "The machine reports different hardware. Reconnecting to tell the server.",
      );
      this.reconnectNow();
    } finally {
      this.checkingHardware = false;
    }
  }

  private scheduleHardwarePoll(): void {
    this.setTimer("hardwarePoll", this.settings.pollSeconds * 1000, () => {
      void this.checkHardware().finally(() => {
        if (!this.stopped) this.scheduleHardwarePoll();
      });
    });
  }

  /**
   * Gives way to another tablet with this Machine's token: drops the
   * connection, keeps capturing, and after YIELD_MS connects with a
   * `yielding` hello.
   */
  private yieldToAnotherTablet(notice: string): void {
    this.yielding = true;
    this.abandon();
    this.log(notice);
    this.setTimer("reconnect", YIELD_MS, () => void this.connect());
  }

  /** Replaces the current connection, or ends a wait, with a new attempt at once. */
  private reconnectNow(): void {
    this.abandon();
    this.reconnectDelayMs = MIN_RECONNECT_MS;
    this.setTimer("reconnect", 0, () => void this.connect());
  }

  /** Abandons the current connection or attempt, if any, without trying again. */
  private abandon(): void {
    this.attempt++;
    this.connecting = false;
    this.clearTimer("reconnect");
    this.closeHandle();
  }

  /** Abandons the current connection or attempt, if any, and tries again after the backoff delay. */
  private drop(reason: string): void {
    this.abandon();
    if (this.stopped) return;
    const delay = this.reconnectDelayMs;
    this.reconnectDelayMs = Math.min(delay * 2, MAX_RECONNECT_MS);
    this.log(`Disconnected: ${reason}. Reconnecting in ${Math.round(delay / 1000)} s.`);
    this.setTimer("reconnect", delay, () => void this.connect());
  }

  private closeHandle(): void {
    const handle = this.handle;
    this.handle = undefined;
    this.welcomed = false;
    // A message cut off here is sent again whole, from its first chunk, on the next connection.
    this.sender?.close();
    this.sender = undefined;
    this.outbox.disconnected();
    this.clearTimer("heartbeat");
    this.clearTimer("silence");
    this.clearTimer("connect");
    this.clearTimer("sendFailed");
    if (handle !== undefined) this.closeTransport(handle);
  }

  private async openTransport(): Promise<string> {
    this.transportsInUse++;
    try {
      return (await this.host.transport.open({ kind: "websocket", url: this.settings.syncUrl })).handle;
    } catch (error) {
      this.transportsInUse--;
      throw error;
    }
  }

  /** Closes a transport, which counts against the limit until Decaid has closed it. */
  private closeTransport(handle: string): void {
    const release = () => {
      this.transportsInUse--;
    };
    this.host.transport.close(handle).then(release, release);
  }

  private setTimer(name: TimerName, delay: number, callback: () => void): void {
    this.clearTimer(name);
    this.timers.set(
      name,
      setTimeout(() => {
        this.timers.delete(name);
        callback();
      }, delay),
    );
  }

  private clearTimer(name: TimerName): void {
    const id = this.timers.get(name);
    if (id !== undefined) clearTimeout(id);
    this.timers.delete(name);
  }
}

function describeError(code: ErrorCode | string): string {
  return code.replace(/_/g, " ");
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
