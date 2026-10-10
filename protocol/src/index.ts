// The wire contract between the plugin and the server. Both ends import it from
// here so they cannot drift apart. The plugin bundles it into an ES2020 script,
// so this package must not depend on Node or browser APIs.
//
// Every message is one JSON object, told apart by its `type`, in a WebSocket
// text frame of its own or, if too large for one, in chunks (chunking.ts).
// Validators accept fields they do not know, so either end can add one
// without breaking the other, and never echo field values in the problems
// they report, apart from a Decaid version's release numbers: a `hello`
// carries the Machine's token.

import type { Chunk } from "./chunking.js";

export * from "./chunking.js";

/** The protocol version this build of the plugin and server speaks. */
export const PROTOCOL_VERSION = 1;

/**
 * The oldest protocol version the server accepts. Before v1 both stay 1: a
 * wire change needs only the plugin and server of the same commit, so it
 * raises neither, and a plugin from before it fails validation. From v1 a
 * change the previous release's plugin can't follow raises PROTOCOL_VERSION,
 * and this is the version that plugin speaks (ADR-0017).
 */
export const OLDEST_SUPPORTED_PROTOCOL_VERSION = 1;

/**
 * The oldest Decaid release the server accepts, always a release rather than
 * a pre-release. Before v1 it is 0.8.7. From v1, each release sets it to the
 * second Decaid release tag before the newest, so tablets may run the newest
 * or either of the two before it (ADR-0017).
 */
export const OLDEST_SUPPORTED_DECAID = "0.8.7";

/** The path of the server's sync endpoint, under its public URL's host. */
export const SYNC_PATH = "/sync";

/**
 * Either end closes a connection it has heard nothing on for this many
 * heartbeat intervals, so neither waits on a dead one until TCP gives up.
 */
export const MISSED_HEARTBEATS = 3;

/**
 * The longest id a delivery or chunk may have, in UTF-16 code units. The
 * plugin's are about 30 (`Outbox.nextId`). The server keeps the ids of
 * recent deliveries for each connection, and of Workflow, machine state and
 * collection deliveries for 90 days, so a longer one is refused.
 */
export const MAX_ID_LENGTH = 128;

/**
 * The longest machine model, serial or connection id a `hello` may report, in
 * UTF-16 code units, which is also the longest serial an Admin may enter.
 * Decaid's are far shorter: a model such as DE1Pro, a serial number, and a
 * Bluetooth address or a USB id made of the device's vendor, product and
 * serial (`computeUsbStableId` in decaid:lib/src/services/serial/utils.dart).
 * The server keeps them in unique indexes, which refuse an entry over about
 * 2.7 KB every time it is tried, so a longer one is refused in `hello`, and a
 * Shot recording one counts as recording no hardware.
 */
export const MAX_HARDWARE_LENGTH = 100;

/**
 * The longest Shot or Steam Record id the server stores, in UTF-16 code
 * units. Decaid's are UUIDs. A longer one could not be indexed by
 * PostgreSQL, so a record whose id fails `isRecordId` is never sent,
 * requested or stored.
 */
export const MAX_RECORD_ID_LENGTH = 128;

/**
 * Whether a value is a Shot or Steam Record id the server stores: a string
 * of 1 to MAX_RECORD_ID_LENGTH code units without NUL, which PostgreSQL's
 * text cannot hold. The plugin leaves other records and index entries out;
 * the server acknowledges a record with another id without storing it, and
 * never requests one.
 */
export function isRecordId(value: unknown): value is string {
  return typeof value === "string" && value !== "" && value.length <= MAX_RECORD_ID_LENGTH && !value.includes("\u0000");
}

/** Why the server refused or ended a connection, sent in an `error` before it closes. */
export type ErrorCode =
  | "protocol_error"
  | "bad_token"
  | "plugin_too_old"
  | "replaced"
  | "hardware_dismissed"
  | "decaid_too_old"
  | "machine_held"
  | "superseded";

/** The WebSocket close code that goes with each error. */
export const CLOSE_CODES: Readonly<Record<ErrorCode, number>> = {
  /** A frame that is not a valid message here, including no `hello` in time. */
  protocol_error: 4000,
  /** The token is unknown or has been revoked. */
  bad_token: 4001,
  /** The plugin speaks a protocol version older than the server supports. */
  plugin_too_old: 4002,
  /**
   * A connection from another tablet took over with the same token. The
   * plugin waits, then connects only with a `yielding` hello.
   */
  replaced: 4003,
  /**
   * An Admin dismissed the hardware this tablet reports for this token: its
   * machine is not the one the token was issued for.
   */
  hardware_dismissed: 4004,
  /** The tablet runs a Decaid older than the server supports. */
  decaid_too_old: 4005,
  /**
   * A `yielding` hello was refused because a live connection from another
   * tablet holds the Machine. The plugin waits, then tries again the same way.
   */
  machine_held: 4006,
  /**
   * This connection no longer holds its Machine, but no other tablet's does:
   * another connection from this tablet does, as when it reconnected while
   * the server still held this one, or none does. The plugin reconnects.
   */
  superseded: 4007,
};

/** The hardware a machine reports while it is connected to its tablet. */
export interface MachineHardware {
  /** Decaid's model name, such as DE1Pro. */
  model: string;
  /** The serial number; older DE1s report "0". */
  serial: string;
  firmware?: string | null;
}

/**
 * A machine's identity: its model and serial together, so the same serial on
 * another model is other hardware. Both ends compare reports with the helpers
 * below, so they agree on what is the same hardware.
 */
export interface Hardware {
  model: string;
  serial: string;
}

/** Whether a serial identifies hardware: not empty, and not the "0" older DE1s report. */
export function isRealSerial(serial: string): boolean {
  const trimmed = serial.trim();
  return trimmed !== "" && trimmed !== "0";
}

/** The reported model and serial, trimmed, if they name real hardware. */
export function realHardware(reported: MachineHardware | null | undefined): Hardware | null {
  if (!reported) return null;
  const model = reported.model.trim();
  const serial = reported.serial.trim();
  if (model === "" || !isRealSerial(serial)) return null;
  return { model, serial };
}

/** Whether two reports name the same hardware: model and serial, trimmed, whatever the firmware. Two absent reports are the same. */
export function sameHardware(a: Hardware | null, b: Hardware | null): boolean {
  if (a === null || b === null) return a === b;
  return a.model.trim() === b.model.trim() && a.serial.trim() === b.serial.trim();
}

/** Whether a value is a UUID, such as 0f8e5d34-6c1b-4f0a-9d2e-7b3c4a5f6e81, in either case. */
function isUuid(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

/** Whether a value is a tablet id as the plugin makes one: a UUID, in either case. */
export function isTabletId(value: unknown): value is string {
  return isUuid(value);
}

/**
 * Whether a value is a Library item's global id as the server gives one
 * (ADR-0006): a UUID, in either case. The plugin writes it into the item's
 * record on each tablet, in `extras` under GLOBAL_ID_KEY.
 */
export function isGlobalId(value: unknown): value is string {
  return isUuid(value);
}

/**
 * The key in a Library record's `extras` that holds its global id. Decaid
 * replaces `extras` whole when a record is updated, so the plugin keeps the
 * other keys there, which other plugins write, whenever it writes this one.
 */
export const GLOBAL_ID_KEY = "decentSyncId";

/**
 * The key two Beans with the same roaster and name share, ignoring case and
 * white space at either end: how a bean new to the Library is matched to a
 * Library Bean (ADR-0018). The server matches a tablet's new beans by it, and
 * the plugin a bean it is asked to create to one its tablet already holds.
 */
export function beanMatchKey(roaster: string, name: string): string {
  return JSON.stringify([roaster.trim().toLowerCase(), name.trim().toLowerCase()]);
}

/**
 * Whether two values a Library record holds are the same, as JSON: objects
 * compared key by key whatever their order, arrays element by element. A
 * field a record does not hold is the same as one holding null, since Decaid
 * leaves out a field it holds no value for. The server compares a tablet's
 * records by it to find what an edit changed (ADR-0020), and the plugin a
 * record with what the server expects it to hold before it writes a field.
 */
export function sameValue(a: unknown, b: unknown): boolean {
  if (a === undefined) a = null;
  if (b === undefined) b = null;
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((value, index) => sameValue(value, b[index]));
  }
  if (!isObject(a) || !isObject(b)) return false;
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  return [...keys].every((key) => sameValue(a[key], b[key]));
}

/** The global id a tablet's Library record carries in its `extras`, or null if it carries none. */
export function globalIdOf(record: unknown): string | null {
  const extras = isObject(record) ? record.extras : undefined;
  const id = isObject(extras) ? extras[GLOBAL_ID_KEY] : undefined;
  return isGlobalId(id) ? id.toLowerCase() : null;
}

/** The plugin's first message on every connection. */
export interface Hello {
  type: "hello";
  protocolVersion: number;
  token: string;
  pluginVersion: string;
  /** Decaid's full version, such as 0.8.7+2847. */
  decaidVersion: string;
  /**
   * The tablet's id (ADR-0006): a random UUID the plugin made on its first
   * run and keeps in Decaid's plugin storage. Resetting the tablet's Decaid
   * data makes a new one, and restoring a Decaid backup that holds it brings
   * it back.
   */
  tabletId: string;
  /** The connection id of Decaid's preferred machine: a Bluetooth address or USB id. */
  connectionId?: string | null;
  /** Absent or null while no machine is connected to the tablet. */
  machine?: MachineHardware | null;
  /**
   * Asks not to replace a live connection from another tablet: the server
   * refuses the hello with `machine_held` while one holds the Machine, and
   * otherwise accepts it as any other. Sent by a plugin whose connection
   * another tablet replaced, so two tablets with one token never take turns.
   */
  yielding?: boolean;
}

/**
 * Sent by the plugin every `heartbeatIntervalMs` from `welcome`, and by the
 * server in reply to each, so each end hears from the other every interval.
 */
export interface Heartbeat {
  type: "heartbeat";
}

/** The server's reply to an accepted `hello`. */
export interface Welcome {
  type: "welcome";
  protocolVersion: number;
  /** How often the plugin sends `heartbeat`; either end closes a connection silent for `MISSED_HEARTBEATS` intervals. */
  heartbeatIntervalMs: number;
}

/** Sent by the server just before it closes the connection with `CLOSE_CODES[code]`. */
export interface ErrorMessage {
  type: "error";
  code: ErrorCode;
  /** Says what went wrong, for the plugin's log. */
  message: string;
}

/**
 * Decaid data stays opaque; only the delivery envelope is validated. A `shot`
 * is the full record; a `shotUpdated` is the edited Shot's complete metadata,
 * as Decaid's event supplies it, without curves.
 */
export interface ShotDelivery {
  type: "shot" | "shotUpdated";
  /** An id for this logical delivery, retained until acknowledged. */
  id: string;
  shotId: string;
  shot: Record<string, unknown>;
}

/** One bounded page of the tablet's history. Reloads include edit times; reconnects omit them. */
export interface ShotIndex {
  type: "shotIndex";
  id: string;
  shots: { id: string; updatedAt?: string | null }[];
}

export interface RequestShots {
  type: "requestShots";
  shotIds: string[];
}

/**
 * A Steam Record, as Decaid serves it, beside its time in UTC. Decaid writes
 * a Steam Record's `timestamp` in the tablet's local time without an offset,
 * so the plugin, which runs in the tablet's time zone, places it.
 */
export interface SteamDelivery {
  type: "steam";
  /** An id for this logical delivery, retained until acknowledged. */
  id: string;
  steamId: string;
  /** The record's `timestamp`, read as the tablet's local time, as a UTC instant such as 2026-10-05T14:07:03.341Z. */
  steamedAt: string;
  steam: Record<string, unknown>;
}

/**
 * One bounded page of the tablet's Steam Record ids. Steam Records have no
 * edit time, so an entry is only an id.
 */
export interface SteamIndex {
  type: "steamIndex";
  id: string;
  steams: { id: string }[];
}

export interface RequestSteams {
  type: "requestSteams";
  steamIds: string[];
}

/**
 * Asks the plugin to send its latest Workflow again, then read every
 * collection again and send each in full, as it does on every `welcome`.
 * The server sends it when the Machine's Location changes, so the tablet's
 * Workflow and Library are taken in at its new Location before anything is
 * written to it there (ADR-0008).
 */
export interface RequestCollections {
  type: "requestCollections";
}

/**
 * The tablet's Workflow, as Decaid's `workflowUpdated` event gave it, sent on
 * every change and again on every `welcome`. The Workflow stays opaque.
 */
export interface WorkflowDelivery {
  type: "workflow";
  /**
   * An id for this logical delivery, retained until acknowledged and kept
   * when it is sent again: the server records every one it has handled, so a
   * resend changes nothing.
   */
  id: string;
  /**
   * When the plugin observed it, by the tablet's clock, in UTC, such as
   * 2026-10-05T14:05:43.648Z. Delivery may come much later.
   */
  observedAt: string;
  workflow: Record<string, unknown>;
}

/** A change of the machine's state or substate, from Decaid's `stateUpdate` event. */
export interface MachineStateDelivery {
  type: "machineState";
  /** As for a Workflow: kept when it is sent again. */
  id: string;
  /** When the plugin observed it, as for a Workflow. */
  observedAt: string;
  /** Decaid's name for the state, such as espresso. */
  state: string;
  /** Decaid's name for the substate, such as preinfusion. */
  substate: string;
}

/**
 * The collections a tablet reports, each read from Decaid's local API (or
 * DYE2's storage in it) and stored by the server as the latest value for its
 * Machine:
 *
 * - `beans`, `beanBatches` and `grinders`, archived ones included;
 * - `profiles`, hidden ones included;
 * - `dye2Recipes`, `dye2Equipment` and `dye2Baskets`, DYE2's keys, read only;
 * - `appSettings`, `machineSettings` and `advancedSettings`;
 * - `pairedDevices`, the device inventory without devices only discovered nearby;
 * - `scaleInfo`, the connected scale's firmware and battery level;
 * - `sensors`.
 */
export const COLLECTION_NAMES = [
  "beans",
  "beanBatches",
  "grinders",
  "profiles",
  "dye2Recipes",
  "dye2Equipment",
  "dye2Baskets",
  "appSettings",
  "machineSettings",
  "advancedSettings",
  "pairedDevices",
  "scaleInfo",
  "sensors",
] as const;

export type CollectionName = (typeof COLLECTION_NAMES)[number];

export function isCollectionName(name: string): name is CollectionName {
  return (COLLECTION_NAMES as readonly string[]).includes(name);
}

/**
 * The collections that are the tablet's Library lists. Decaid writes each of
 * their records' `updatedAt` in the tablet's local time without an offset,
 * so the plugin sends each placed in UTC beside the list.
 */
export const LIBRARY_LISTS = ["beans", "beanBatches", "grinders", "profiles"] as const satisfies readonly CollectionName[];

export function isLibraryList(name: string): name is (typeof LIBRARY_LISTS)[number] {
  return (LIBRARY_LISTS as readonly string[]).includes(name);
}

/**
 * One collection, as Decaid's API answered it, sent when it changed and in
 * full on every `welcome`. A read that failed or had nothing to report (no
 * machine or scale connected, a DYE2 key never written) is sent as
 * unavailable, without a value, so it never replaces what the server knows.
 */
export interface CollectionDelivery {
  type: "collection";
  /** An id for this logical delivery, retained until acknowledged and kept when it is sent again, as for a Workflow. */
  id: string;
  /** One of COLLECTION_NAMES. A server ignores a name it does not know. */
  name: string;
  available: boolean;
  /** Decaid's response, as sent, while available: anything but null. Absent while unavailable. */
  value?: unknown;
  /**
   * For one of the LIBRARY_LISTS, each record's `updatedAt`, read as the
   * tablet's local time and placed in UTC, such as
   * 2026-10-05T14:07:03.341Z, in the order of `value`: null for a record
   * whose time cannot be read. Only with a list `value`, and as long as it.
   */
  updatedAt?: (string | null)[];
}

/** The kinds of Library item the server writes to tablets: Beans, Bean Batches, Grinders and Profiles. */
export const LIBRARY_KINDS = ["bean", "beanBatch", "grinder", "profile"] as const;

export type LibraryKind = (typeof LIBRARY_KINDS)[number];

export function isLibraryKind(kind: string): kind is LibraryKind {
  return (LIBRARY_KINDS as readonly string[]).includes(kind);
}

/**
 * What the server writes to tablets besides Library items: the steam, hot
 * water and rinse settings of the tablet's Machine's Location (ADR-0014),
 * which a `write` of this kind carries.
 */
export const SETTINGS_KIND = "settings";

/**
 * What the server writes to a tablet as its Machine joins a Location that
 * does not offer the grinder or batch its Workflow names: that Workflow's
 * grinder and batch, cleared (ADR-0008). A `write` of this kind carries them.
 */
export const WORKFLOW_KIND = "workflow";

/**
 * The fields of a Workflow's `context` naming its grinder, and its batch,
 * which a write of WORKFLOW_KIND clears together, as Decaid's
 * `WorkflowContext.clearGrinder` and `clearBeanBatch` do
 * (decaid:lib/src/models/data/workflow_context.dart), and as DYE2 sets them:
 * the grinder's setting stays, and so do the profile, dose and yield.
 */
export const WORKFLOW_GRINDER = ["context.grinderId", "context.grinderModel"] as const;
export const WORKFLOW_BATCH = ["context.beanBatchId", "context.coffeeName", "context.coffeeRoaster"] as const;

/** What has versions and Conflicts (ADR-0020): a Library item of one of LIBRARY_KINDS, or a Location's shared settings. */
export type VersionedKind = LibraryKind | typeof SETTINGS_KIND;

/** What a `write` writes: a Library item of one of LIBRARY_KINDS, the shared settings, or a Workflow's grinder and batch, cleared. */
export type WrittenKind = LibraryKind | typeof SETTINGS_KIND | typeof WORKFLOW_KIND;

export function isWrittenKind(kind: string): kind is WrittenKind {
  return kind === SETTINGS_KIND || kind === WORKFLOW_KIND || isLibraryKind(kind);
}

/**
 * Whether a value is the id of a Library item of that kind: a Profile's is
 * Decaid's own (`isRecordId`), a hash of what the machine executes that is
 * the same on every tablet (ADR-0006); every other kind's is its global id,
 * the shared settings' is the id the server gives a Location's settings, and
 * a Workflow's is the tablet's id.
 */
export function isItemId(kind: string, value: unknown): value is string {
  return kind === "profile" ? isRecordId(value) : isGlobalId(value);
}

/**
 * The parts of Decaid's Workflow that a Location shares between its
 * Machines, whatever their model (ADR-0014): the steam, hot water and rinse
 * settings. The rest
 * of a Workflow (its profile, dose, yield, batch and grinder) stays each
 * Machine's own.
 */
export const SETTINGS_PARTS = ["steamSettings", "hotWaterData", "rinseData"] as const;

/**
 * The shared settings, each a field of its own (ADR-0020), named by its part
 * and Decaid's name for it in that part (`Workflow.toJson` in
 * decaid:lib/src/models/data/workflow.dart). Decaid sends each of them in
 * every Workflow. A field it may add to a part later is not shared.
 */
export const SHARED_SETTINGS = [
  "steamSettings.targetTemperature",
  "steamSettings.duration",
  "steamSettings.flow",
  "steamSettings.stopAtTemperature",
  "hotWaterData.targetTemperature",
  "hotWaterData.duration",
  "hotWaterData.volume",
  "hotWaterData.flow",
  "rinseData.targetTemperature",
  "rinseData.duration",
  "rinseData.flow",
] as const;

export type SharedSetting = (typeof SHARED_SETTINGS)[number];

/** The steam settings, which a Machine whose steam is off neither shares nor takes (ADR-0014). */
export const STEAM_SETTINGS: readonly SharedSetting[] = SHARED_SETTINGS.filter((field) => field.startsWith("steamSettings."));

/**
 * Decaid has no steam on/off flag: a steam target temperature below this, in
 * °C, means steam is off (`De1Controller.updateWorkflowSettings`).
 */
export const STEAM_ON_FROM = 135;

/** The shared settings, by field name. */
export type SharedSettings = Readonly<Record<SharedSetting, number>>;

/**
 * The shared settings a Workflow, or an object holding its steam, hot water
 * and rinse parts, holds, by field name; null if it lacks any of them, or
 * holds one that is not a number, which no supported Decaid sends.
 */
export function sharedSettingsOf(workflow: unknown): SharedSettings | null {
  if (!isObject(workflow)) return null;
  const settings: Partial<Record<SharedSetting, number>> = {};
  for (const field of SHARED_SETTINGS) {
    const [part, name] = field.split(".") as [string, string];
    const values = workflow[part];
    const value = isObject(values) ? values[name] : undefined;
    if (typeof value !== "number" || !Number.isFinite(value)) return null;
    settings[field] = value;
  }
  return settings as SharedSettings;
}

/** Whether settings keep steam on: a steam target temperature of STEAM_ON_FROM or more. */
export function steamIsOn(settings: Readonly<Partial<Record<string, unknown>>>): boolean {
  const target = settings["steamSettings.targetTemperature"];
  return typeof target === "number" && target >= STEAM_ON_FROM;
}

/** Fields of a Workflow's parts by name, as the parts hold them: `{ steamSettings: { flow: 1.5 } }` for `steamSettings.flow`. */
export function settingsParts(fields: Readonly<Record<string, unknown>>): Record<string, Record<string, unknown>> {
  const parts: Record<string, Record<string, unknown>> = {};
  for (const [field, value] of Object.entries(fields)) {
    const [part, name] = field.split(".");
    if (part === undefined || name === undefined) continue;
    (parts[part] ??= {})[name] = value;
  }
  return parts;
}

/**
 * Asks the plugin to write one Library item to its tablet through Decaid's
 * API (ADR-0006). The server sends one at a time, and the next once this one
 * is answered with `written` or `writeRefused`. A write too large for one
 * frame comes in chunks, which the plugin puts back together.
 *
 * With no `localId`, the plugin creates the record, unless the tablet already
 * holds one carrying this global id, as when the answer to an earlier write
 * was lost: it answers with that one instead. Nor does it create one when an
 * unarchived record without a global id is the same item, such as a bean with
 * the same roaster and name (`beanMatchKey`) entered before the tablet
 * reported it: it writes only the global id to that record. Bean Batches and
 * Grinders are never the same item (ADR-0018). With a `localId`, it updates
 * that record.
 * Either way it sets only `fields`, and writes the global id into the
 * record's `extras`, keeping the other keys there. An update sets a field
 * only while the record holds the value `expected` names for it, as the
 * tablet last reported it: a field changed on the tablet since, such as a
 * barista's edit of a Bean's notes not yet reported, is kept, and reaches the
 * server in the answer, which leaves it out of `writtenFields`.
 *
 * A Bean Batch is created under its Bean: `fields.beanId` is the tablet's id
 * for the Bean's record, which the server writes first. Decaid's create
 * takes neither `archived` nor `weightRemaining`, setting the remaining
 * weight to `weight`, so the plugin writes those it is given in a second
 * request when they differ from what Decaid made. A Grinder's create takes no
 * `archived` either.
 *
 * A Profile keeps Decaid's id, which is its `globalId` and, on every tablet,
 * its `localId` (ADR-0006), and its record carries no global id. To create
 * one, the plugin posts `fields.profile`, with `fields.metadata` and with
 * `fields.parentId` if the tablet holds that Profile, as Decaid refuses a
 * parent it lacks. Decaid derives the record's id from the profile, and
 * answers with the record it holds already if it has one with that id,
 * hidden or deleted as it may be. So the plugin then sets
 * `fields.visibility` where the record has another (`PUT
 * /profiles/{id}/visibility`). To update one, it sets `fields.visibility`
 * alone, and its title, author and notes, where `fields` holds them, in
 * the record's `profile`, which Decaid's `PUT /profiles/{id}` takes whole:
 * they are outside the hash, so the record keeps its id (ADR-0006).
 *
 * A write of SETTINGS_KIND carries the steam, hot water and rinse settings
 * of the Machine's Location (ADR-0014): `globalId` is the server's id
 * for them, `localId` null, and `fields` and `expected` are named as
 * SHARED_SETTINGS names them. The plugin reads the tablet's Workflow and
 * sets, through `PUT /workflow`, which Decaid merges into the Workflow, the
 * fields it still holds as expected, the steam settings only while the
 * Workflow keeps steam on (`steamIsOn`). Its answer's `record` is the Workflow's
 * steam, hot water and rinse parts as Decaid returned them, and its
 * `updatedAt` when the plugin had Decaid's answer, by its own clock, as a
 * Workflow carries no time. Decaid refuses to change them while no machine
 * is connected. The plugin's own write is not sent back as a change of the
 * tablet's Workflow ahead of its answer, so the server never reads it as one.
 *
 * A write of WORKFLOW_KIND clears the grinder and batch of the tablet's
 * Workflow, as its Machine joins a Location that does not offer them
 * (ADR-0008): `globalId` is the tablet's id, `localId` null, and `fields`
 * names WORKFLOW_GRINDER, WORKFLOW_BATCH or both, each null, with `expected`
 * the values the Workflow held for them as the tablet last reported it. The
 * plugin reads the tablet's Workflow and clears, through `PUT /workflow`,
 * the grinder, and the batch, each whole, only while it still names it by
 * the id expected (`context.grinderId`, `context.beanBatchId`): a barista
 * who picked another grinder or batch since keeps it.
 * Decaid needs no machine for this. Its answer's `record` is the Workflow's
 * `context` as Decaid returned it, timed as a settings write's is, and the
 * Workflow change it causes is sent after the answer, as a settings write's
 * is.
 */
export interface LibraryWrite {
  type: "write";
  /** Names this write, which its answer repeats. */
  id: string;
  /** One of LIBRARY_KINDS, SETTINGS_KIND or WORKFLOW_KIND. A plugin answers a kind it does not know with `writeRefused`. */
  kind: string;
  /** The item's global id, a Profile's id, the settings' id, or the tablet's id for a Workflow (`isItemId`). */
  globalId: string;
  /** The tablet's record to update, or null to create one. */
  localId: string | null;
  /** The record's fields to set, as Decaid names them: on creating, its content. */
  fields: Record<string, unknown>;
  /**
   * On updating, the value the record held for each of `fields` as the
   * tablet last reported it, null for none: the plugin sets a field only
   * while the record still holds it.
   */
  expected?: Record<string, unknown>;
  /**
   * When the latest edit of the item's content the write carries was
   * decided, by the server's database clock: a UTC time the plugin repeats
   * in its answer, so the server knows what the record it answers with has
   * seen even when the answer comes after the server stopped awaiting it.
   */
  contentDecidedAt?: string;
}

/**
 * The plugin's answer to a `write` Decaid carried out: the record as Decaid
 * returned it, which the server records as the tablet's version of the item.
 * The server acknowledges it with `ack` once recorded.
 *
 * The plugin reads the tablet's lists of the kinds it writes and carries
 * out writes one at a time, and sends answers through its outbox, behind
 * every report it read before the write. So the server takes in a report
 * read before a write before that write's answer, and never reads an item it
 * wrote as deleted from a report that predates it. An answer the
 * connection's drop held back is sent on the next connection, ahead of every
 * report read after the write, and the server records it there too, as it
 * does one arriving after its write timed out, though not as the answer to
 * a write that connection asked for.
 */
export interface ItemWritten {
  type: "written";
  /** The write's id. */
  id: string;
  kind: string;
  /** The write's `globalId`. */
  globalId: string;
  /** The record as Decaid returned it, its global id in `extras` but for a Profile's. */
  record: Record<string, unknown>;
  /** The record's `updatedAt`, read as the tablet's local time and placed in UTC; null if it cannot be read. */
  updatedAt: string | null;
  /**
   * The names of the fields the write set, as it named them. The plugin reads
   * a record before it updates it, and Decaid keeps the fields it is not sent,
   * so every other field the record holds is as the tablet had it, a change
   * made there since its last report included. The server reads such changes
   * from the answer, whether or not it still awaits it.
   */
  writtenFields: string[];
  /**
   * Set when the write was to create a Bean, and the plugin found the tablet
   * holding the same coffee without a global id, entered there before it was
   * reported, and wrote only the global id to it: the record is linked to the
   * Bean, and so takes the Bean's content, each field it held otherwise kept
   * as a Conflict (ADR-0018).
   */
  linked?: boolean;
  /** The write's `contentDecidedAt`, repeated. */
  contentDecidedAt?: string;
}

/**
 * The plugin's answer to a `write` Decaid refused, or could not be asked to
 * carry out, sent as `written` is. The server acknowledges it with `ack` and
 * goes on to its next write.
 */
export interface WriteRefused {
  type: "writeRefused";
  /** The write's id. */
  id: string;
  kind: string;
  globalId: string;
  /** Decaid's HTTP status, such as 400 or 404, or null if Decaid did not answer. */
  status: number | null;
  /** What Decaid answered, or why it could not be asked, cut to MAX_REFUSAL_LENGTH. */
  error: string;
}

/**
 * Asks the plugin to delete a tablet's record of a Library item an Admin
 * hard-deleted (ADR-0003): a Bean, Bean Batch, Grinder or Profile no Shot
 * names. The server sends it as it sends a `write`, one at a time with them,
 * and it is answered with `deleted` or `writeRefused`. The plugin deletes the
 * record unless it carries another item's global id (ANOTHER_ITEMS_RECORD),
 * as one the server mapped may not carry one yet, or a Shot the plugin queued
 * since it loaded, or has yet to send, names it, or one of a bean's batches;
 * and a bean only once its batches are deleted, as Decaid refuses to delete a
 * bean that has any: so it deletes the bean's batches first, as DYE2 does. A
 * Profile's record carries no global id, its id being Decaid's, the same on
 * every tablet, and is purged, as Decaid's delete only marks it deleted. A
 * record already gone is deleted.
 */
export interface LibraryDelete {
  type: "delete";
  /** Names this delete, which its answer repeats. */
  id: string;
  /** One of DELETED_KINDS. A plugin answers a kind it does not know with `writeRefused`. */
  kind: string;
  /** The deleted item's global id, which the record carries; a Profile's is Decaid's id, as its record's is. */
  globalId: string;
  /** The tablet's record to delete. */
  localId: string;
}

/**
 * The error of a `writeRefused` answering a `delete` whose record carries
 * another item's global id: it is not the deleted item's, so the server takes
 * it in again rather than asking for its delete.
 */
export const ANOTHER_ITEMS_RECORD = "The record carries another item's global id";

/**
 * The error of a `writeRefused` answering a `delete` the plugin cannot judge
 * yet: more Shots are still to be read and sent than it reads to see whether
 * one names the record, as during a backfill. The server asks again on the
 * same connection a little later, rather than skipping it until the next.
 */
export const SHOTS_STILL_TO_READ = "More Shots are still to be sent than a delete reads; ask again once they are";

/** The kinds of Library item an Admin hard-deletes from tablets. A tablet's own delete of a Profile only hides it at its Location (ADR-0019). */
export const DELETED_KINDS = ["bean", "beanBatch", "grinder", "profile"] as const;

export type DeletedKind = (typeof DELETED_KINDS)[number];

export function isDeletedKind(kind: string): kind is DeletedKind {
  return (DELETED_KINDS as readonly string[]).includes(kind);
}

/**
 * The plugin's answer to a `delete` Decaid carried out, or that found the
 * record gone: the tablet holds the record no more. Sent as `written` is,
 * through the outbox, behind every report read before it.
 */
export interface ItemDeleted {
  type: "deleted";
  /** The delete's id. */
  id: string;
  kind: string;
  globalId: string;
  localId: string;
}

/**
 * Asks the plugin to set aside a tablet's record the Library leaves out, as
 * its Machine joined a Location that offers items of that kind already
 * (ADR-0018): to archive a bean, bean batch or grinder, or hide a profile,
 * so the tablet offers only what its Location does. The record carries no
 * global id, and is never deleted, so the tablet's Shots still find it. The
 * server sends it as it sends a `write`, one at a time with them, and it is
 * answered with `leftOut`. The plugin sets aside only a record without a
 * global id, and changes nothing else of it.
 */
export interface LeaveOut {
  type: "leaveOut";
  /** Names this request, which its answer repeats. */
  id: string;
  /** One of DELETED_KINDS, the kinds a tablet holds records of. A plugin answers a kind it does not know as `refused`. */
  kind: string;
  /** The tablet's record to set aside. */
  localId: string;
}

/**
 * What became of a `leaveOut`: the record is archived or hidden now, as it
 * was or as the plugin set it (`setAside`); the tablet holds no such record
 * (`gone`); it carries a global id now, as one a write made a Library
 * item's record (`taken`); or Decaid refused, or could not be asked
 * (`refused`).
 */
export const LEFT_OUT_OUTCOMES = ["setAside", "gone", "taken", "refused"] as const;

export type LeftOutOutcome = (typeof LEFT_OUT_OUTCOMES)[number];

/** The plugin's answer to a `leaveOut`, sent as `written` is, through the outbox, behind every report read before it. */
export interface ItemLeftOut {
  type: "leftOut";
  /** The request's id. */
  id: string;
  kind: string;
  localId: string;
  outcome: LeftOutOutcome;
  /** For `refused`: Decaid's HTTP status, or null if Decaid did not answer. */
  status?: number | null;
  /** For `refused`: what Decaid answered, or why it could not be asked, cut to MAX_REFUSAL_LENGTH. */
  error?: string;
}

/** The most of Decaid's answer a `writeRefused` repeats, in UTF-16 code units. */
export const MAX_REFUSAL_LENGTH = 1000;

/** The most field names a `written` may list; a Library record has a few dozen fields. */
export const MAX_WRITTEN_FIELDS = 1000;

/** A logical delivery acknowledged only after its transaction commits. */
export interface Ack {
  type: "ack";
  id: string;
}

/**
 * Sent by the server for every chunk it receives, so the plugin knows the
 * chunk has left the tablet and can send more. It says nothing about
 * storage: a chunked delivery is acknowledged once, by its `ack`.
 */
export interface ChunkReceived {
  type: "chunkReceived";
  /** The chunk's `id`. */
  id: string;
  /** The chunk's `index`. */
  index: number;
}

/** Messages the plugin sends, each in a frame of its own or in chunks. */
export type PluginMessage =
  | Hello
  | Heartbeat
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
/** Messages the server sends, each in a frame of its own or, a `write` too large for one, in chunks. */
export type ServerMessage =
  | Welcome
  | Heartbeat
  | ErrorMessage
  | RequestShots
  | RequestSteams
  | RequestCollections
  | Ack
  | ChunkReceived
  | LibraryWrite
  | LibraryDelete
  | LeaveOut;

export type Decoded<T> =
  | { ok: true; message: T }
  | {
      ok: false;
      error: Extract<ErrorCode, "protocol_error" | "plugin_too_old" | "decaid_too_old">;
      problem: string;
      /**
       * The token of a `hello` refused for its protocol or Decaid version, so
       * the server can show the reason on that token's Machine. Never log it.
       */
      token?: string;
    };

export function encode(message: PluginMessage | ServerMessage): string {
  return JSON.stringify(message);
}

/** Reads a frame the plugin sent: a whole message, or a chunk of one too large for a frame. */
export function decodePluginFrame(frame: string): Decoded<PluginMessage | Chunk> {
  const object = parseObject(frame);
  if (typeof object === "string") return invalid(object);
  if (object.type !== "chunk") return decodeMessage(object);
  return check<Chunk>(object, "chunk", (fields) => {
    fields.id();
    fields.integer("index", { nonNegative: true });
    fields.integer("count", { positive: true });
    fields.string("data");
  });
}

/**
 * Reads a whole message from the plugin: a frame that is not a chunk, or the
 * encoding a message's chunks were put back together into.
 */
export function decodePluginMessage(text: string): Decoded<PluginMessage> {
  const object = parseObject(text);
  if (typeof object === "string") return invalid(object);
  if (object.type === "chunk") return invalid("A chunked message must not be a chunk itself");
  return decodeMessage(object);
}

/**
 * Reads a Workflow or machine state delivery as `decodePluginMessage` does,
 * for the plugin, which keeps them in Decaid's plugin storage across unloads
 * and sends only those the server would take.
 */
export function decodeMachineEvent(text: string): Decoded<WorkflowDelivery | MachineStateDelivery> {
  const object = parseObject(text);
  if (typeof object === "string") return invalid(object);
  if (object.type !== "workflow" && object.type !== "machineState") return invalid("Not a Workflow or machine state delivery");
  return checkMachineEvent(object);
}

/** Checks a Workflow or machine state delivery, by its `type`. */
function checkMachineEvent(object: Fields & { type: string }): Decoded<WorkflowDelivery | MachineStateDelivery> {
  if (object.type === "workflow") {
    return check<WorkflowDelivery>(object, "workflow", (fields) => {
      fields.id();
      fields.instant("observedAt");
      fields.objectField("workflow");
    });
  }
  return check<MachineStateDelivery>(object, "machineState", (fields) => {
    fields.id();
    fields.instant("observedAt");
    fields.string("state", { nonEmpty: true });
    fields.string("substate", { nonEmpty: true });
  });
}

/**
 * A `hello` is checked for its protocol version before anything else, so a
 * plugin too old to send today's `hello` is told it is too old rather than
 * that its message is invalid. A valid `hello` is then checked for its Decaid
 * version.
 */
function decodeMessage(object: Fields & { type: string }): Decoded<PluginMessage> {
  switch (object.type) {
    case "hello": {
      const version = object.protocolVersion;
      if (typeof version !== "number" || !Number.isInteger(version)) {
        return invalid("hello.protocolVersion must be a whole number");
      }
      // A hello of another version need not have today's fields, but a string token is kept.
      const token = typeof object.token === "string" && object.token !== "" ? { token: object.token } : {};
      if (version < OLDEST_SUPPORTED_PROTOCOL_VERSION) {
        return {
          ok: false,
          error: "plugin_too_old",
          problem: `The plugin speaks protocol version ${version}, but this server needs ${OLDEST_SUPPORTED_PROTOCOL_VERSION} or newer: update the plugin`,
          ...token,
        };
      }
      if (version > PROTOCOL_VERSION) {
        return {
          ...invalid(`The plugin speaks protocol version ${version}, newer than this server's ${PROTOCOL_VERSION}: update the server`),
          ...token,
        };
      }
      const hello = check<Hello>(object, "hello", (fields) => {
        fields.string("token", { nonEmpty: true });
        fields.string("pluginVersion");
        fields.string("decaidVersion", { nonEmpty: true });
        fields.uuid("tabletId");
        fields.optionalString("connectionId", { maxLength: MAX_HARDWARE_LENGTH });
        fields.optionalObject("machine", (machine) => {
          machine.string("model", { maxLength: MAX_HARDWARE_LENGTH });
          machine.string("serial", { maxLength: MAX_HARDWARE_LENGTH });
          machine.optionalString("firmware");
        });
        fields.optionalBoolean("yielding");
      });
      if (!hello.ok) return hello;
      const decaid = decaidRelease(hello.message.decaidVersion);
      if (decaid && supportedDecaid(decaid)) return hello;
      // Only the release numbers are repeated: they cannot hold a token.
      const runs = decaid
        ? `This tablet runs ${decaid.preRelease ? "a pre-release of " : ""}Decaid ${decaid.numbers.join(".")}`
        : "This tablet's Decaid reports no release version";
      return {
        ok: false,
        error: "decaid_too_old",
        problem: `${runs}, but this server needs ${OLDEST_SUPPORTED_DECAID} or newer: update Decaid`,
        token: hello.message.token,
      };
    }
    case "shot":
    case "shotUpdated":
      return check<ShotDelivery>(object, object.type, (fields) => {
        fields.id();
        fields.string("shotId", { nonEmpty: true });
        fields.objectField("shot");
      });
    case "shotIndex":
      return check<ShotIndex>(object, "shotIndex", (fields) => {
        fields.id();
        fields.array("shots", (value) => isObject(value) && typeof value.id === "string" && value.id !== "" &&
          (value.updatedAt === undefined || typeof value.updatedAt === "string"), 100);
      });
    case "steam":
      return check<SteamDelivery>(object, "steam", (fields) => {
        fields.id();
        fields.string("steamId", { nonEmpty: true });
        fields.instant("steamedAt");
        fields.objectField("steam");
      });
    case "steamIndex":
      return check<SteamIndex>(object, "steamIndex", (fields) => {
        fields.id();
        fields.array("steams", (value) => isObject(value) && typeof value.id === "string" && value.id !== "", 100);
      });
    case "workflow":
    case "machineState":
      return checkMachineEvent(object);
    case "collection":
      return check<CollectionDelivery>(object, "collection", (fields) => {
        fields.id();
        fields.string("name", { nonEmpty: true });
        fields.boolean("available");
        if (object.available === true) fields.present("value");
        else if (object.available === false) fields.absent("value");
        if (object.updatedAt !== undefined) {
          const length = Array.isArray(object.value) ? object.value.length : -1;
          fields.instants("updatedAt", length);
        }
      });
    case "written":
      return check<ItemWritten>(object, "written", (fields) => {
        fields.id();
        fields.string("kind", { nonEmpty: true });
        fields.itemId("globalId", object.kind);
        fields.objectField("record");
        if (object.updatedAt !== null) fields.instant("updatedAt");
        fields.array("writtenFields", (value) => typeof value === "string", MAX_WRITTEN_FIELDS);
        fields.optionalBoolean("linked");
        if (object.contentDecidedAt !== undefined) fields.instant("contentDecidedAt");
      });
    case "deleted":
      return check<ItemDeleted>(object, "deleted", (fields) => {
        fields.id();
        fields.string("kind", { nonEmpty: true });
        fields.itemId("globalId", object.kind);
        fields.string("localId", { nonEmpty: true, maxLength: MAX_RECORD_ID_LENGTH });
      });
    case "leftOut":
      return check<ItemLeftOut>(object, "leftOut", (fields) => {
        fields.id();
        fields.string("kind", { nonEmpty: true });
        fields.string("localId", { nonEmpty: true, maxLength: MAX_RECORD_ID_LENGTH });
        fields.oneOf("outcome", LEFT_OUT_OUTCOMES);
        if (object.status !== undefined && object.status !== null) fields.integer("status", { nonNegative: true });
        if (object.error !== undefined) fields.string("error", { maxLength: MAX_REFUSAL_LENGTH });
      });
    case "writeRefused":
      return check<WriteRefused>(object, "writeRefused", (fields) => {
        fields.id();
        fields.string("kind", { nonEmpty: true });
        fields.itemId("globalId", object.kind);
        if (object.status !== null) fields.integer("status", { nonNegative: true });
        fields.string("error", { maxLength: MAX_REFUSAL_LENGTH });
      });
    case "heartbeat":
      return check<Heartbeat>(object, "heartbeat", () => {});
    default:
      return invalid("Unknown message type");
  }
}

/** Reads a frame the server sent: a whole message, or a chunk of one too large for a frame. */
export function decodeServerFrame(frame: string): Decoded<ServerMessage | Chunk> {
  const object = parseObject(frame);
  if (typeof object === "string") return invalid(object);
  if (object.type !== "chunk") return decodeServerObject(object);
  return check<Chunk>(object, "chunk", (fields) => {
    fields.id();
    fields.integer("index", { nonNegative: true });
    fields.integer("count", { positive: true });
    fields.string("data");
  });
}

/**
 * Reads a whole message from the server: a frame that is not a chunk, or the
 * encoding a message's chunks were put back together into.
 */
export function decodeServerMessage(text: string): Decoded<ServerMessage> {
  const object = parseObject(text);
  if (typeof object === "string") return invalid(object);
  if (object.type === "chunk") return invalid("A chunked message must not be a chunk itself");
  return decodeServerObject(object);
}

function decodeServerObject(object: Fields & { type: string }): Decoded<ServerMessage> {
  switch (object.type) {
    case "welcome":
      return check<Welcome>(object, "welcome", (fields) => {
        fields.integer("protocolVersion");
        fields.integer("heartbeatIntervalMs", { positive: true });
      });
    case "ack":
      return check<Ack>(object, "ack", (fields) => fields.string("id", { nonEmpty: true }));
    case "chunkReceived":
      return check<ChunkReceived>(object, "chunkReceived", (fields) => {
        fields.string("id", { nonEmpty: true });
        fields.integer("index", { nonNegative: true });
      });
    case "requestShots":
      return check<RequestShots>(object, "requestShots", (fields) => {
        fields.array("shotIds", (value) => typeof value === "string" && value !== "", 100);
      });
    case "requestSteams":
      return check<RequestSteams>(object, "requestSteams", (fields) => {
        fields.array("steamIds", (value) => typeof value === "string" && value !== "", 100);
      });
    case "requestCollections":
      return check<RequestCollections>(object, "requestCollections", () => {});
    case "heartbeat":
      return check<Heartbeat>(object, "heartbeat", () => {});
    case "error":
      return check<ErrorMessage>(object, "error", (fields) => {
        fields.string("code");
        fields.string("message");
      });
    case "write":
      return check<LibraryWrite>(object, "write", (fields) => {
        fields.id();
        fields.string("kind", { nonEmpty: true });
        fields.itemId("globalId", object.kind);
        if (object.localId !== null) fields.string("localId", { nonEmpty: true, maxLength: MAX_RECORD_ID_LENGTH });
        fields.objectField("fields");
        if (object.expected !== undefined) fields.objectField("expected");
        if (object.contentDecidedAt !== undefined) fields.instant("contentDecidedAt");
      });
    case "delete":
      return check<LibraryDelete>(object, "delete", (fields) => {
        fields.id();
        fields.string("kind", { nonEmpty: true });
        fields.itemId("globalId", object.kind);
        fields.string("localId", { nonEmpty: true, maxLength: MAX_RECORD_ID_LENGTH });
      });
    case "leaveOut":
      return check<LeaveOut>(object, "leaveOut", (fields) => {
        fields.id();
        fields.string("kind", { nonEmpty: true });
        fields.string("localId", { nonEmpty: true, maxLength: MAX_RECORD_ID_LENGTH });
      });
    default:
      return invalid("Unknown message type");
  }
}

interface DecaidRelease {
  numbers: [number, number, number];
  preRelease: boolean;
}

/**
 * The release a Decaid `fullVersion` names: the tag it was built from, then
 * `+` and a build number, such as 0.8.7+2847 or 0.8.8-beta.2+2860.
 */
function decaidRelease(version: string): DecaidRelease | null {
  const match = /^(\d+)\.(\d+)\.(\d+)(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/.exec(version);
  if (!match) return null;
  return { numbers: [Number(match[1]), Number(match[2]), Number(match[3])], preRelease: match[4] !== undefined };
}

/** Whether a release is OLDEST_SUPPORTED_DECAID or newer. A pre-release comes before its release. */
function supportedDecaid(release: DecaidRelease): boolean {
  const oldest = decaidRelease(OLDEST_SUPPORTED_DECAID)!.numbers;
  for (const [index, number] of release.numbers.entries()) {
    if (number !== oldest[index]) return number > oldest[index]!;
  }
  return !release.preRelease;
}

type Fields = Record<string, unknown>;

/** Records what is wrong with an object's fields, by name and never by value. */
class FieldChecker {
  constructor(
    private readonly object: Fields,
    private readonly path: string,
    readonly problems: string[],
  ) {}

  string(key: string, options: { nonEmpty?: boolean; maxLength?: number } = {}): void {
    const value = this.object[key];
    if (typeof value !== "string") this.problem(key, "must be a string");
    else if (options.nonEmpty && value === "") this.problem(key, "must not be empty");
    else if (options.maxLength !== undefined && value.length > options.maxLength) {
      this.problem(key, `must be at most ${options.maxLength} characters`);
    }
  }

  /** The id of a delivery or a chunk. */
  id(): void {
    this.string("id", { nonEmpty: true, maxLength: MAX_ID_LENGTH });
  }

  /** A UUID, in either case, as a tablet id is. */
  uuid(key: string): void {
    if (!isTabletId(this.object[key])) this.problem(key, "must be a UUID");
  }

  /** The id of a Library item of the kind given (`isItemId`): a Profile's id, or another kind's global id, a UUID. */
  itemId(key: string, kind: unknown): void {
    if (!isItemId(String(kind), this.object[key])) {
      this.problem(key, kind === "profile" ? `must be a Profile's id of 1 to ${MAX_RECORD_ID_LENGTH} characters without NUL` : "must be a UUID");
    }
  }

  optionalString(key: string, options: { maxLength?: number } = {}): void {
    const value = this.object[key];
    if (value === undefined || value === null) return;
    if (typeof value !== "string") this.problem(key, "must be a string or null");
    else if (options.maxLength !== undefined && value.length > options.maxLength) {
      this.problem(key, `must be at most ${options.maxLength} characters`);
    }
  }

  integer(key: string, options: { positive?: boolean; nonNegative?: boolean } = {}): void {
    const value = this.object[key];
    if (typeof value !== "number" || !Number.isInteger(value)) this.problem(key, "must be a whole number");
    else if (options.positive && value <= 0) this.problem(key, "must be positive");
    else if (options.nonNegative && value < 0) this.problem(key, "must not be negative");
  }

  /** One of `values`. */
  oneOf(key: string, values: readonly string[]): void {
    if (!values.includes(this.object[key] as string)) this.problem(key, `must be one of ${values.join(", ")}`);
  }

  boolean(key: string): void {
    if (typeof this.object[key] !== "boolean") this.problem(key, "must be true or false");
  }

  optionalBoolean(key: string): void {
    const value = this.object[key];
    if (value !== undefined && typeof value !== "boolean") this.problem(key, "must be true or false");
  }

  objectField(key: string): void {
    if (!isObject(this.object[key])) this.problem(key, "must be an object");
  }

  /** Any JSON value but null. */
  present(key: string): void {
    const value = this.object[key];
    if (value === undefined || value === null) this.problem(key, "must be present and not null");
  }

  absent(key: string): void {
    if (this.object[key] !== undefined) this.problem(key, "must be absent");
  }

  /** A UTC instant as `Date.prototype.toISOString` writes it. Read back, it must be written the same, so times that do not exist, which Date rolls over, are refused. */
  instant(key: string): void {
    if (!isInstant(this.object[key])) this.problem(key, "must be a UTC time such as 2026-10-05T14:07:03.341Z");
  }

  /**
   * An array of `length` UTC instants, as `instant` reads one, or nulls. A
   * `length` below zero says there is nothing for it to go beside.
   */
  instants(key: string, length: number): void {
    const value = this.object[key];
    if (length < 0) this.problem(key, "must be absent unless value is a list");
    else if (!Array.isArray(value) || value.length !== length || !value.every((entry) => entry === null || isInstant(entry))) {
      this.problem(key, "must be an array as long as value, of UTC times such as 2026-10-05T14:07:03.341Z or nulls");
    }
  }

  array(key: string, valid: (value: unknown) => boolean, max: number): void {
    const value = this.object[key];
    if (!Array.isArray(value) || value.length > max || !value.every(valid)) {
      this.problem(key, `must be an array of at most ${max} valid entries`);
    }
  }

  optionalObject(key: string, checkFields: (fields: FieldChecker) => void): void {
    const value = this.object[key];
    if (value === undefined || value === null) return;
    if (!isObject(value)) {
      this.problem(key, "must be an object or null");
      return;
    }
    checkFields(new FieldChecker(value, `${this.path}.${key}`, this.problems));
  }

  private problem(key: string, what: string): void {
    this.problems.push(`${this.path}.${key} ${what}`);
  }
}

function check<T>(object: Fields, type: string, checkFields: (fields: FieldChecker) => void): Decoded<T> {
  const fields = new FieldChecker(object, type, []);
  checkFields(fields);
  if (fields.problems.length > 0) return invalid(fields.problems.join("; "));
  return { ok: true, message: object as T };
}

/** The frame as an object with a string `type`, or what is wrong with it. */
function parseObject(frame: string): (Fields & { type: string }) | string {
  let value: unknown;
  try {
    value = JSON.parse(frame);
  } catch {
    return "The frame is not JSON";
  }
  if (!isObject(value)) return "A message must be a JSON object";
  if (typeof value.type !== "string") return "A message must have a string type";
  return value as Fields & { type: string };
}

function isObject(value: unknown): value is Fields {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Whether a value is a UTC instant as `Date.prototype.toISOString` writes it, naming a time that exists. */
function isInstant(value: unknown): boolean {
  const ms = typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(ms) && new Date(ms).toISOString() === value;
}

function invalid(problem: string): { ok: false; error: "protocol_error"; problem: string } {
  return { ok: false, error: "protocol_error", problem };
}
