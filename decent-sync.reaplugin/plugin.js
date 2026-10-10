// Decent Sync plugin for Decaid. Generated from plugin/ by `npm run build -w plugin`; do not edit.
"use strict";
var __decentSync = (() => {
  var __defProp = Object.defineProperty;
  var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
  var __getOwnPropNames = Object.getOwnPropertyNames;
  var __hasOwnProp = Object.prototype.hasOwnProperty;
  var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
  var __export = (target, all) => {
    for (var name in all)
      __defProp(target, name, { get: all[name], enumerable: true });
  };
  var __copyProps = (to, from, except, desc) => {
    if (from && typeof from === "object" || typeof from === "function") {
      for (let key of __getOwnPropNames(from))
        if (!__hasOwnProp.call(to, key) && key !== except)
          __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
    }
    return to;
  };
  var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
  var __publicField = (obj, key, value) => __defNormalProp(obj, typeof key !== "symbol" ? key + "" : key, value);

  // src/index.ts
  var index_exports = {};
  __export(index_exports, {
    createPlugin: () => createPlugin
  });

  // ../protocol/src/chunking.ts
  var MAX_FRAME_BYTES = 256 * 1024;
  var MAX_CHUNKED_LENGTH = 16 * 1024 * 1024;
  var MAX_CHUNKS = 1024;
  var ASCII_RUN = /[\x00-\x7f]*/y;
  var ASCII_STEPS = 32;
  function utf8Length(text) {
    const length = text.length;
    let bytes = length;
    for (let at = 0; at < length; ) {
      ASCII_RUN.lastIndex = at;
      ASCII_RUN.test(text);
      at = ASCII_RUN.lastIndex;
      for (let ascii = 0; at < length && ascii < ASCII_STEPS; at++) {
        const unit = text.charCodeAt(at);
        if (unit < 128) ascii++;
        else {
          ascii = 0;
          if (unit < 2048) bytes += 1;
          else {
            bytes += 2;
            if (unit >= 55296 && unit <= 56319) {
              const next = text.charCodeAt(at + 1);
              if (next >= 56320 && next <= 57343) at++;
            }
          }
        }
      }
    }
    return bytes;
  }
  function frames(text, id, maxFrameBytes = MAX_FRAME_BYTES) {
    if (text.length <= maxFrameBytes) {
      const bytes = utf8Length(text);
      if (bytes <= maxFrameBytes) return [{ text, bytes }];
    }
    const room = maxFrameBytes - utf8Length(chunkFrame(id, text.length, text.length, ""));
    if (room < 8) throw new Error("The frame size leaves no room for a chunk's data");
    const pieces = [];
    const aim = room * 0.99;
    let ratio = 1;
    for (let start = 0; start < text.length; ) {
      let length = Math.min(text.length - start, Math.max(1, Math.floor(aim / ratio)));
      for (; ; ) {
        length = withoutSplitPair(text, start, length);
        const piece = JSON.stringify(text.slice(start, start + length));
        const bytes = utf8Length(piece);
        if (bytes <= room) {
          pieces.push({ text: piece, bytes });
          ratio = bytes / length;
          start += length;
          break;
        }
        length = Math.max(1, length - (bytes - room), Math.floor(length * aim / bytes));
      }
    }
    return pieces.map((piece, index) => {
      const envelope = chunkFrame(id, index, pieces.length, "");
      return { text: chunkFrame(id, index, pieces.length, piece.text), bytes: utf8Length(envelope) + piece.bytes };
    });
  }
  function chunkFrame(id, index, count, encodedData) {
    return `{"type":"chunk","id":${JSON.stringify(id)},"index":${index},"count":${count},"data":${encodedData}}`;
  }
  function withoutSplitPair(text, start, length) {
    const end = start + length;
    const splitsPair = end < text.length && isHighSurrogate(text.charCodeAt(end - 1)) && isLowSurrogate(text.charCodeAt(end));
    if (!splitsPair) return length;
    return length > 1 ? length - 1 : 2;
  }
  function isHighSurrogate(unit) {
    return unit >= 55296 && unit <= 56319;
  }
  function isLowSurrogate(unit) {
    return unit >= 56320 && unit <= 57343;
  }
  var CHUNK_LIMITS = { maxLength: MAX_CHUNKED_LENGTH, maxChunks: MAX_CHUNKS };
  var Reassembly = class {
    constructor() {
      __publicField(this, "messages", /* @__PURE__ */ new Map());
      /** Code units held: the messages' ids and their chunks' data. */
      __publicField(this, "heldLength", 0);
      /** Chunks the messages have between them, counting those yet to arrive. */
      __publicField(this, "heldChunks", 0);
      __publicField(this, "problem");
    }
    add(chunk, limits) {
      if (this.problem === void 0) this.problem = this.problemWith(chunk, limits);
      if (this.problem !== void 0) {
        this.messages.clear();
        this.heldLength = 0;
        this.heldChunks = 0;
        return { status: "invalid", problem: this.problem };
      }
      let message = this.messages.get(chunk.id);
      if (message?.parts[chunk.index] !== void 0) return { status: "incomplete" };
      if (!message) {
        message = { count: chunk.count, parts: new Array(chunk.count), received: 0, length: chunk.id.length };
        this.messages.set(chunk.id, message);
        this.heldLength += chunk.id.length;
        this.heldChunks += chunk.count;
      }
      message.parts[chunk.index] = chunk.data;
      message.received++;
      message.length += chunk.data.length;
      this.heldLength += chunk.data.length;
      if (message.received < message.count) return { status: "incomplete" };
      this.messages.delete(chunk.id);
      this.heldLength -= message.length;
      this.heldChunks -= message.count;
      return { status: "complete", text: message.parts.join("") };
    }
    /** Why the chunk cannot be added, by field and never by value, or undefined if it can. */
    problemWith(chunk, limits) {
      const { index, count, data } = chunk;
      if (!Number.isInteger(count) || count < 1 || count > limits.maxChunks) {
        return `chunk.count must be a whole number from 1 to ${limits.maxChunks}`;
      }
      if (!Number.isInteger(index) || index < 0 || index >= count) return "chunk.index must be a whole number below chunk.count";
      const message = this.messages.get(chunk.id);
      if (message && message.count !== count) return "chunk.count differs from an earlier chunk of the same message";
      const held = message?.parts[index];
      if (held !== void 0) return held === data ? void 0 : "chunk.data differs from an earlier copy of the same chunk";
      const length = data.length + (message ? 0 : chunk.id.length);
      const chunks = message ? 0 : count;
      if (this.heldLength + length > limits.maxLength || this.heldChunks + chunks > limits.maxChunks) {
        return `Chunked messages still incomplete may hold at most ${limits.maxLength} characters, ids included, and ${limits.maxChunks} chunks between them`;
      }
      return void 0;
    }
  };

  // ../protocol/src/index.ts
  var PROTOCOL_VERSION = 1;
  var SYNC_PATH = "/sync";
  var MISSED_HEARTBEATS = 3;
  var MAX_ID_LENGTH = 128;
  var MAX_RECORD_ID_LENGTH = 128;
  function isRecordId(value) {
    return typeof value === "string" && value !== "" && value.length <= MAX_RECORD_ID_LENGTH && !value.includes("\0");
  }
  var CLOSE_CODES = {
    /** A frame that is not a valid message here, including no `hello` in time. */
    protocol_error: 4e3,
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
    superseded: 4007
  };
  function sameHardware(a, b) {
    if (a === null || b === null) return a === b;
    return a.model.trim() === b.model.trim() && a.serial.trim() === b.serial.trim();
  }
  function isUuid(value) {
    return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
  }
  function isTabletId(value) {
    return isUuid(value);
  }
  function isGlobalId(value) {
    return isUuid(value);
  }
  var GLOBAL_ID_KEY = "decentSyncId";
  function beanMatchKey(roaster, name) {
    return JSON.stringify([roaster.trim().toLowerCase(), name.trim().toLowerCase()]);
  }
  function sameValue(a, b) {
    if (a === void 0) a = null;
    if (b === void 0) b = null;
    if (a === b) return true;
    if (Array.isArray(a) || Array.isArray(b)) {
      return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((value, index) => sameValue(value, b[index]));
    }
    if (!isObject(a) || !isObject(b)) return false;
    const keys = /* @__PURE__ */ new Set([...Object.keys(a), ...Object.keys(b)]);
    return [...keys].every((key) => sameValue(a[key], b[key]));
  }
  function globalIdOf(record) {
    const extras = isObject(record) ? record.extras : void 0;
    const id = isObject(extras) ? extras[GLOBAL_ID_KEY] : void 0;
    return isGlobalId(id) ? id.toLowerCase() : null;
  }
  var LIBRARY_LISTS = ["beans", "beanBatches", "grinders", "profiles"];
  function isLibraryList(name) {
    return LIBRARY_LISTS.includes(name);
  }
  var SETTINGS_KIND = "settings";
  var WORKFLOW_KIND = "workflow";
  var WORKFLOW_GRINDER = ["context.grinderId", "context.grinderModel"];
  var WORKFLOW_BATCH = ["context.beanBatchId", "context.coffeeName", "context.coffeeRoaster"];
  function isItemId(kind, value) {
    return kind === "profile" ? isRecordId(value) : isGlobalId(value);
  }
  var SETTINGS_PARTS = ["steamSettings", "hotWaterData", "rinseData"];
  var SHARED_SETTINGS = [
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
    "rinseData.flow"
  ];
  var STEAM_SETTINGS = SHARED_SETTINGS.filter((field) => field.startsWith("steamSettings."));
  var STEAM_ON_FROM = 135;
  function steamIsOn(settings) {
    const target = settings["steamSettings.targetTemperature"];
    return typeof target === "number" && target >= STEAM_ON_FROM;
  }
  function settingsParts(fields) {
    const parts = {};
    for (const [field, value] of Object.entries(fields)) {
      const [part, name] = field.split(".");
      if (part === void 0 || name === void 0) continue;
      (parts[part] ?? (parts[part] = {}))[name] = value;
    }
    return parts;
  }
  var ANOTHER_ITEMS_RECORD = "The record carries another item's global id";
  var SHOTS_STILL_TO_READ = "More Shots are still to be sent than a delete reads; ask again once they are";
  var MAX_REFUSAL_LENGTH = 1e3;
  function encode(message) {
    return JSON.stringify(message);
  }
  function decodeMachineEvent(text) {
    const object3 = parseObject(text);
    if (typeof object3 === "string") return invalid(object3);
    if (object3.type !== "workflow" && object3.type !== "machineState") return invalid("Not a Workflow or machine state delivery");
    return checkMachineEvent(object3);
  }
  function checkMachineEvent(object3) {
    if (object3.type === "workflow") {
      return check(object3, "workflow", (fields) => {
        fields.id();
        fields.instant("observedAt");
        fields.objectField("workflow");
      });
    }
    return check(object3, "machineState", (fields) => {
      fields.id();
      fields.instant("observedAt");
      fields.string("state", { nonEmpty: true });
      fields.string("substate", { nonEmpty: true });
    });
  }
  function decodeServerFrame(frame) {
    const object3 = parseObject(frame);
    if (typeof object3 === "string") return invalid(object3);
    if (object3.type !== "chunk") return decodeServerObject(object3);
    return check(object3, "chunk", (fields) => {
      fields.id();
      fields.integer("index", { nonNegative: true });
      fields.integer("count", { positive: true });
      fields.string("data");
    });
  }
  function decodeServerMessage(text) {
    const object3 = parseObject(text);
    if (typeof object3 === "string") return invalid(object3);
    if (object3.type === "chunk") return invalid("A chunked message must not be a chunk itself");
    return decodeServerObject(object3);
  }
  function decodeServerObject(object3) {
    switch (object3.type) {
      case "welcome":
        return check(object3, "welcome", (fields) => {
          fields.integer("protocolVersion");
          fields.integer("heartbeatIntervalMs", { positive: true });
        });
      case "ack":
        return check(object3, "ack", (fields) => fields.string("id", { nonEmpty: true }));
      case "chunkReceived":
        return check(object3, "chunkReceived", (fields) => {
          fields.string("id", { nonEmpty: true });
          fields.integer("index", { nonNegative: true });
        });
      case "requestShots":
        return check(object3, "requestShots", (fields) => {
          fields.array("shotIds", (value) => typeof value === "string" && value !== "", 100);
        });
      case "requestSteams":
        return check(object3, "requestSteams", (fields) => {
          fields.array("steamIds", (value) => typeof value === "string" && value !== "", 100);
        });
      case "requestCollections":
        return check(object3, "requestCollections", () => {
        });
      case "heartbeat":
        return check(object3, "heartbeat", () => {
        });
      case "error":
        return check(object3, "error", (fields) => {
          fields.string("code");
          fields.string("message");
        });
      case "write":
        return check(object3, "write", (fields) => {
          fields.id();
          fields.string("kind", { nonEmpty: true });
          fields.itemId("globalId", object3.kind);
          if (object3.localId !== null) fields.string("localId", { nonEmpty: true, maxLength: MAX_RECORD_ID_LENGTH });
          fields.objectField("fields");
          if (object3.expected !== void 0) fields.objectField("expected");
          if (object3.contentDecidedAt !== void 0) fields.instant("contentDecidedAt");
        });
      case "delete":
        return check(object3, "delete", (fields) => {
          fields.id();
          fields.string("kind", { nonEmpty: true });
          fields.itemId("globalId", object3.kind);
          fields.string("localId", { nonEmpty: true, maxLength: MAX_RECORD_ID_LENGTH });
        });
      case "leaveOut":
        return check(object3, "leaveOut", (fields) => {
          fields.id();
          fields.string("kind", { nonEmpty: true });
          fields.string("localId", { nonEmpty: true, maxLength: MAX_RECORD_ID_LENGTH });
        });
      default:
        return invalid("Unknown message type");
    }
  }
  var FieldChecker = class _FieldChecker {
    constructor(object3, path, problems) {
      __publicField(this, "object", object3);
      __publicField(this, "path", path);
      __publicField(this, "problems", problems);
    }
    string(key, options = {}) {
      const value = this.object[key];
      if (typeof value !== "string") this.problem(key, "must be a string");
      else if (options.nonEmpty && value === "") this.problem(key, "must not be empty");
      else if (options.maxLength !== void 0 && value.length > options.maxLength) {
        this.problem(key, `must be at most ${options.maxLength} characters`);
      }
    }
    /** The id of a delivery or a chunk. */
    id() {
      this.string("id", { nonEmpty: true, maxLength: MAX_ID_LENGTH });
    }
    /** A UUID, in either case, as a tablet id is. */
    uuid(key) {
      if (!isTabletId(this.object[key])) this.problem(key, "must be a UUID");
    }
    /** The id of a Library item of the kind given (`isItemId`): a Profile's id, or another kind's global id, a UUID. */
    itemId(key, kind) {
      if (!isItemId(String(kind), this.object[key])) {
        this.problem(key, kind === "profile" ? `must be a Profile's id of 1 to ${MAX_RECORD_ID_LENGTH} characters without NUL` : "must be a UUID");
      }
    }
    optionalString(key, options = {}) {
      const value = this.object[key];
      if (value === void 0 || value === null) return;
      if (typeof value !== "string") this.problem(key, "must be a string or null");
      else if (options.maxLength !== void 0 && value.length > options.maxLength) {
        this.problem(key, `must be at most ${options.maxLength} characters`);
      }
    }
    integer(key, options = {}) {
      const value = this.object[key];
      if (typeof value !== "number" || !Number.isInteger(value)) this.problem(key, "must be a whole number");
      else if (options.positive && value <= 0) this.problem(key, "must be positive");
      else if (options.nonNegative && value < 0) this.problem(key, "must not be negative");
    }
    /** One of `values`. */
    oneOf(key, values) {
      if (!values.includes(this.object[key])) this.problem(key, `must be one of ${values.join(", ")}`);
    }
    boolean(key) {
      if (typeof this.object[key] !== "boolean") this.problem(key, "must be true or false");
    }
    optionalBoolean(key) {
      const value = this.object[key];
      if (value !== void 0 && typeof value !== "boolean") this.problem(key, "must be true or false");
    }
    objectField(key) {
      if (!isObject(this.object[key])) this.problem(key, "must be an object");
    }
    /** Any JSON value but null. */
    present(key) {
      const value = this.object[key];
      if (value === void 0 || value === null) this.problem(key, "must be present and not null");
    }
    absent(key) {
      if (this.object[key] !== void 0) this.problem(key, "must be absent");
    }
    /** A UTC instant as `Date.prototype.toISOString` writes it. Read back, it must be written the same, so times that do not exist, which Date rolls over, are refused. */
    instant(key) {
      if (!isInstant(this.object[key])) this.problem(key, "must be a UTC time such as 2026-10-05T14:07:03.341Z");
    }
    /**
     * An array of `length` UTC instants, as `instant` reads one, or nulls. A
     * `length` below zero says there is nothing for it to go beside.
     */
    instants(key, length) {
      const value = this.object[key];
      if (length < 0) this.problem(key, "must be absent unless value is a list");
      else if (!Array.isArray(value) || value.length !== length || !value.every((entry) => entry === null || isInstant(entry))) {
        this.problem(key, "must be an array as long as value, of UTC times such as 2026-10-05T14:07:03.341Z or nulls");
      }
    }
    array(key, valid, max) {
      const value = this.object[key];
      if (!Array.isArray(value) || value.length > max || !value.every(valid)) {
        this.problem(key, `must be an array of at most ${max} valid entries`);
      }
    }
    optionalObject(key, checkFields) {
      const value = this.object[key];
      if (value === void 0 || value === null) return;
      if (!isObject(value)) {
        this.problem(key, "must be an object or null");
        return;
      }
      checkFields(new _FieldChecker(value, `${this.path}.${key}`, this.problems));
    }
    problem(key, what) {
      this.problems.push(`${this.path}.${key} ${what}`);
    }
  };
  function check(object3, type, checkFields) {
    const fields = new FieldChecker(object3, type, []);
    checkFields(fields);
    if (fields.problems.length > 0) return invalid(fields.problems.join("; "));
    return { ok: true, message: object3 };
  }
  function parseObject(frame) {
    let value;
    try {
      value = JSON.parse(frame);
    } catch {
      return "The frame is not JSON";
    }
    if (!isObject(value)) return "A message must be a JSON object";
    if (typeof value.type !== "string") return "A message must have a string type";
    return value;
  }
  function isObject(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }
  function isInstant(value) {
    const ms = typeof value === "string" ? Date.parse(value) : NaN;
    return Number.isFinite(ms) && new Date(ms).toISOString() === value;
  }
  function invalid(problem) {
    return { ok: false, error: "protocol_error", problem };
  }

  // src/change-detection.ts
  function ifNoneMatch(last) {
    return last?.available ? last.etag : null;
  }
  function decide(last, reading, full) {
    switch (reading.kind) {
      case "notModified":
        return { send: false, next: last };
      case "unavailable":
        return { send: full || last?.available !== false, next: { available: false } };
      case "value": {
        const next = reading.etag !== null ? { available: true, etag: reading.etag, hash: null } : { available: true, etag: null, hash: contentHash(JSON.stringify(reading.value)) };
        return { send: full || !sameFingerprint(last, next), next };
      }
    }
  }
  function pairedDevices(inventory) {
    if (!Array.isArray(inventory)) return null;
    return inventory.filter((device) => !(typeof device === "object" && device !== null && device.state === "discovered"));
  }
  function contentHash(text) {
    let h1 = 3735928559;
    let h2 = 1103547991;
    for (let i = 0; i < text.length; i++) {
      const code = text.charCodeAt(i);
      h1 = Math.imul(h1 ^ code, 2654435761);
      h2 = Math.imul(h2 ^ code, 1597334677);
    }
    h1 = Math.imul(h1 ^ h1 >>> 16, 2246822507);
    h1 ^= Math.imul(h2 ^ h2 >>> 13, 3266489909);
    h2 = Math.imul(h2 ^ h2 >>> 16, 2246822507);
    h2 ^= Math.imul(h1 ^ h1 >>> 13, 3266489909);
    return `${text.length}:${hex(h2)}${hex(h1)}`;
  }
  function sameFingerprint(a, b) {
    if (!a?.available || !b.available) return a?.available === b.available;
    return a.etag === b.etag && a.hash === b.hash;
  }
  function hex(half) {
    return (half >>> 0).toString(16).padStart(8, "0");
  }

  // src/decaid.ts
  var API = "http://localhost:8080/api/v1";
  async function readTabletIdentity() {
    const [info, settings, machine] = await Promise.all([getObject("/info"), getObject("/settings"), readMachineHardware()]);
    return {
      decaidVersion: stringField(info, "fullVersion"),
      // Decaid keeps the preferred machine's id, so it is known before the machine connects.
      connectionId: stringField(settings, "preferredMachineId"),
      machine
    };
  }
  async function readMachineHardware() {
    return readHardware(await getObject("/machine/info"));
  }
  function readHardware(info) {
    const model = info?.model;
    const serial = info?.serialNumber;
    if (typeof model !== "string" || typeof serial !== "string") return null;
    return { model, serial, firmware: stringField(info, "version") };
  }
  async function getObject(path) {
    try {
      const response = await fetch(API + path);
      if (!response.ok) return null;
      const body = await response.json();
      return typeof body === "object" && body !== null && !Array.isArray(body) ? body : null;
    } catch {
      return null;
    }
  }
  function stringField(object3, key) {
    const value = object3?.[key];
    return typeof value === "string" && value !== "" ? value : null;
  }
  async function readShotPage(limit, offset) {
    const page = await getObject(`/shots?limit=${limit}&offset=${offset}&order=desc`);
    return Array.isArray(page?.items) && typeof page.total === "number" ? { items: page.items, total: page.total } : null;
  }
  function readShot(id) {
    return readRecord("shots", id);
  }
  function readSteam(id) {
    return readRecord("steams", id);
  }
  async function readSteamIds() {
    const response = await fetch(`${API}/steams/ids`);
    if (!response.ok) throw new Error(`Decaid answered ${response.status}`);
    const body = await response.json();
    if (!Array.isArray(body)) throw new Error("Decaid's answer is not a list");
    return body.filter(isRecordId);
  }
  async function readLatestSteamId() {
    const response = await fetch(`${API}/steams/latest`);
    if (!response.ok) throw new Error(`Decaid answered ${response.status}`);
    const body = await response.json();
    if (body === null) return null;
    if (typeof body !== "object" || Array.isArray(body)) throw new Error("Decaid's answer is not a Steam Record");
    const id = body.id;
    return isRecordId(id) ? id : null;
  }
  async function readRecord(collection, id) {
    const response = await fetch(`${API}/${collection}/${encodeURIComponent(id)}`);
    if (response.status === 404) return null;
    if (!response.ok) throw new Error("Record unavailable");
    const body = await response.json();
    if (body === null || typeof body !== "object" || Array.isArray(body)) throw new Error("Record response unavailable");
    return body;
  }
  async function keepStorageInBackups() {
    try {
      return (await fetch(`${API}/store/${encodeURIComponent("decent-sync.reaplugin")}`)).ok;
    } catch {
      return false;
    }
  }
  async function readCollection(path, etag) {
    try {
      const response = await fetch(API + path, etag === null ? void 0 : { headers: { "If-None-Match": etag } });
      if (response.status === 304) return { kind: "notModified" };
      if (!response.ok) return { kind: "unavailable" };
      const value = await response.json();
      return value === null ? { kind: "unavailable" } : { kind: "value", value, etag: response.headers.get("etag") };
    } catch {
      return { kind: "unavailable" };
    }
  }
  async function request(method, path, body) {
    const response = await fetch(
      API + path,
      body === void 0 ? { method } : { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }
    );
    return { status: response.status, ok: response.ok, text: await response.text() };
  }

  // src/local-time.ts
  var ISO_TIME = /^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d):(\d\d)(?:\.(\d+))?(Z|[+-]\d\d:\d\d)?$/;
  function utcTime(timestamp) {
    const match = typeof timestamp === "string" ? ISO_TIME.exec(timestamp) : null;
    if (!match) return null;
    const parts = match.slice(1, 7).map(Number);
    const [year, month, day, hour, minute, second] = parts;
    const ms = Number((match[7] ?? "").padEnd(3, "0").slice(0, 3));
    const offset = match[8];
    if (offset === void 0) {
      const local = new Date(year, month - 1, day, hour, minute, second, ms);
      const readBack2 = [local.getFullYear(), local.getMonth() + 1, local.getDate(), local.getHours(), local.getMinutes(), local.getSeconds()];
      return readBack2.every((part, index) => part === parts[index]) ? local.toISOString() : null;
    }
    const minutes = offsetMinutes(offset);
    const utc = new Date(Date.UTC(year, month - 1, day, hour, minute, second, ms));
    const readBack = [utc.getUTCFullYear(), utc.getUTCMonth() + 1, utc.getUTCDate(), utc.getUTCHours(), utc.getUTCMinutes(), utc.getUTCSeconds()];
    if (minutes === null || !readBack.every((part, index) => part === parts[index])) return null;
    return new Date(utc.getTime() - minutes * 6e4).toISOString();
  }
  function offsetMinutes(offset) {
    if (offset === "Z") return 0;
    const hours = Number(offset.slice(1, 3));
    const minutes = Number(offset.slice(4, 6));
    if (hours > 23 || minutes > 59) return null;
    return (offset.startsWith("-") ? -1 : 1) * (hours * 60 + minutes);
  }

  // src/collections.ts
  var SOURCES = [
    { name: "beans", path: "/beans?includeArchived=true" },
    { name: "beanBatches", path: "/bean-batches?includeArchived=true" },
    { name: "grinders", path: "/grinders?includeArchived=true" },
    { name: "profiles", path: "/profiles?includeHidden=true" },
    { name: "dye2Recipes", path: "/store/dye2.reaplugin/recipes" },
    { name: "dye2Equipment", path: "/store/dye2.reaplugin/equipment" },
    { name: "dye2Baskets", path: "/store/dye2.reaplugin/baskets" },
    { name: "appSettings", path: "/settings" },
    { name: "machineSettings", path: "/machine/settings" },
    { name: "advancedSettings", path: "/machine/settings/advanced" },
    { name: "pairedDevices", path: "/devices", select: pairedDevices },
    { name: "scaleInfo", path: "/scale/info" },
    { name: "sensors", path: "/sensors" }
  ];
  var WRITTEN_LISTS = /* @__PURE__ */ new Set(["beans", "beanBatches", "grinders", "profiles"]);
  var CollectionCapture = class {
    constructor(outbox, library, pollMs) {
      __publicField(this, "outbox", outbox);
      __publicField(this, "library", library);
      __publicField(this, "pollMs", pollMs);
      /** What was last queued for each collection. */
      __publicField(this, "last", /* @__PURE__ */ new Map());
      /** For each collection, the latest delivery queued, and the latest queued with a value. */
      __publicField(this, "queued", /* @__PURE__ */ new Map());
      __publicField(this, "wanted");
      __publicField(this, "reading", false);
      __publicField(this, "stopped", false);
      __publicField(this, "pollTimer");
    }
    start() {
      this.schedulePoll();
    }
    stop() {
      this.stopped = true;
      if (this.pollTimer !== void 0) clearTimeout(this.pollTimer);
    }
    /** Every collection, read again and sent in full, as on every welcome and whenever the server asks. */
    sendAll() {
      this.read("full");
    }
    schedulePoll() {
      this.pollTimer = setTimeout(() => {
        this.pollTimer = void 0;
        if (this.outbox.connected) this.read("changes");
        if (!this.stopped) this.schedulePoll();
      }, this.pollMs);
    }
    read(kind) {
      if (this.stopped) return;
      if (kind === "full" || this.wanted === void 0) this.wanted = kind;
      void this.run();
    }
    async run() {
      if (this.reading) return;
      this.reading = true;
      try {
        while (this.wanted !== void 0 && !this.stopped) {
          const full = this.wanted === "full";
          this.wanted = void 0;
          let beansSent = false;
          for (const source of SOURCES) {
            if (this.stopped) return;
            const sent = await (WRITTEN_LISTS.has(source.name) ? this.library.run(() => this.capture(source, full || source.name === "beanBatches" && beansSent)) : this.capture(source, full));
            if (source.name === "beans") beansSent = sent;
          }
        }
      } finally {
        this.reading = false;
      }
    }
    /** Reads a collection, and queues it if it is to be sent. Says whether a value was queued. */
    async capture(source, full) {
      const last = this.last.get(source.name);
      const reading = selected(source, await readCollection(source.path, full ? null : ifNoneMatch(last)));
      if (this.stopped) return false;
      const decision = decide(last, reading, full);
      if (decision.next) this.last.set(source.name, decision.next);
      if (!decision.send || reading.kind === "notModified") return false;
      const id = this.outbox.nextId();
      const delivery = reading.kind === "value" ? { type: "collection", id, name: source.name, available: true, value: reading.value, ...placedInTime(source.name, reading.value) } : { type: "collection", id, name: source.name, available: false };
      const earlier = this.queued.get(source.name);
      if (earlier) {
        if (delivery.available || earlier.latest !== earlier.value) this.outbox.supersede(earlier.latest);
        if (delivery.available && earlier.value !== void 0 && earlier.value !== earlier.latest) this.outbox.supersede(earlier.value);
      }
      this.queued.set(source.name, { latest: id, value: delivery.available ? id : earlier?.value });
      this.outbox.enqueue(delivery);
      return delivery.available;
    }
  };
  function placedInTime(name, value) {
    if (!isLibraryList(name) || !Array.isArray(value)) return {};
    return { updatedAt: value.map((record) => utcTime(record?.updatedAt)) };
  }
  function selected(source, reading) {
    if (reading.kind !== "value" || !source.select) return reading;
    const value = source.select(reading.value);
    return value === null ? { kind: "unavailable" } : { ...reading, value };
  }

  // src/kept-deliveries.ts
  var MAX_KEPT = 2e3;
  var MAX_KEPT_CHARACTERS = 2 * 1024 * 1024;
  var SEQUENCE_KEY = "outbox";
  function isKept(delivery) {
    return delivery.type === "workflow" || delivery.type === "machineState";
  }
  var KeptDeliveries = class {
    constructor(storage, log, token) {
      __publicField(this, "storage", storage);
      __publicField(this, "log", log);
      /** The lowest sequence number kept, or `next` if none is. */
      __publicField(this, "first", 0);
      /** The sequence number the next delivery kept is given. */
      __publicField(this, "next", 0);
      /** The deliveries kept, by sequence number: their ids and the length of their JSON. */
      __publicField(this, "kept", /* @__PURE__ */ new Map());
      /** Their sequence numbers, by delivery id. */
      __publicField(this, "numbers", /* @__PURE__ */ new Map());
      __publicField(this, "characters", 0);
      __publicField(this, "stopped", false);
      /** The hash of the token this load connects with, never the token itself. */
      __publicField(this, "token");
      this.token = tokenHash(token);
    }
    /**
     * The deliveries kept, oldest first. Rejects, saying why, if Decaid
     * refuses or does not answer any read in time, so a read that failed is
     * never taken for nothing kept; loading again retries.
     */
    async load() {
      this.kept.clear();
      this.numbers.clear();
      this.characters = 0;
      const sequence = parseSequence(await this.storage.read(SEQUENCE_KEY, "a read of the deliveries kept"));
      if (sequence.token !== void 0 && sequence.token !== this.token && sequence.first < sequence.next) {
        this.log(`Not sending the Workflow and machine state events kept from before the plugin last unloaded, at most ${sequence.next - sequence.first}: they were made under another token.`);
        for (let seq = sequence.first; seq < sequence.next; seq++) this.writeRemoved(seq);
        this.first = this.next = sequence.next;
        this.writeSequence().catch((error) => this.failed("record the deliveries kept", error));
        return [];
      }
      const deliveries = [];
      for (let seq = sequence.first; seq < sequence.next; seq++) {
        const text = await this.storage.read(slotKey(seq), "a read of a delivery kept");
        const delivery = parseSlot(text, seq);
        if (!delivery) continue;
        this.add(seq, delivery.id, text.length);
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
    keep(delivery) {
      const seq = this.next++;
      const text = JSON.stringify({ seq, delivery });
      this.add(seq, delivery.id, text.length);
      const dropped = [];
      while (this.first < seq && (this.next - this.first > MAX_KEPT || this.characters > MAX_KEPT_CHARACTERS)) {
        const oldest = this.kept.get(this.first);
        if (oldest) {
          this.delete(this.first, oldest);
          dropped.push(oldest.id);
          if (slotKey(this.first) !== slotKey(seq)) this.writeRemoved(this.first);
        }
        this.first++;
      }
      this.skipRemoved();
      const written2 = Promise.all([
        this.storage.write(slotKey(seq), text, "the write of a delivery to keep"),
        this.writeSequence()
      ]).then(
        () => void 0,
        (error) => this.failed("keep a delivery, so it is sent without being kept", error)
      );
      return { written: written2, dropped };
    }
    /** Stops keeping a delivery, once acknowledged or no longer to be sent. Does nothing for one not kept. */
    remove(id) {
      const seq = this.numbers.get(id);
      if (seq === void 0) return;
      this.delete(seq, this.kept.get(seq));
      this.writeRemoved(seq);
      if (seq !== this.first) return;
      this.skipRemoved();
      this.writeSequence().catch((error) => this.failed("record a delivery acknowledged", error));
    }
    stop() {
      this.stopped = true;
    }
    add(seq, id, characters) {
      this.kept.set(seq, { id, characters });
      this.numbers.set(id, seq);
      this.characters += characters;
    }
    delete(seq, entry) {
      this.kept.delete(seq);
      this.numbers.delete(entry.id);
      this.characters -= entry.characters;
    }
    /** Moves `first` past the sequence numbers no longer kept. */
    skipRemoved() {
      while (this.first < this.next && !this.kept.has(this.first)) this.first++;
    }
    /** Overwrites the key of a delivery no longer kept with its number alone, so storage no longer holds it. */
    writeRemoved(seq) {
      this.storage.write(slotKey(seq), JSON.stringify({ seq }), "the write of a delivery no longer kept").catch((error) => this.failed("record a delivery no longer kept", error));
    }
    writeSequence() {
      return this.storage.write(SEQUENCE_KEY, JSON.stringify({ first: this.first, next: this.next, token: this.token }), "the write of the deliveries kept");
    }
    failed(what, error) {
      if (!this.stopped) this.log(`Could not ${what} in Decaid's plugin storage: ${error instanceof Error ? error.message : String(error)}.`);
    }
  };
  function slotKey(seq) {
    return `${SEQUENCE_KEY}.${seq % MAX_KEPT}`;
  }
  function parseSequence(value) {
    const parsed2 = parse(value);
    const first = parsed2?.first;
    const next = parsed2?.next;
    if (!isCount(first) || !isCount(next) || first > next || next - first > MAX_KEPT) return { first: 0, next: 0 };
    return { first, next, token: typeof parsed2?.token === "string" ? parsed2.token : "" };
  }
  function tokenHash(token) {
    let hash = 2166136261;
    for (let index = 0; index < token.length; index++) {
      hash ^= token.charCodeAt(index);
      hash = Math.imul(hash, 16777619) >>> 0;
    }
    return hash.toString(16).padStart(8, "0");
  }
  function parseSlot(value, seq) {
    const parsed2 = parse(value);
    if (parsed2?.seq !== seq || parsed2.delivery === void 0) return void 0;
    const decoded = decodeMachineEvent(JSON.stringify(parsed2.delivery));
    return decoded.ok ? decoded.message : void 0;
  }
  function parse(value) {
    if (typeof value !== "string") return void 0;
    try {
      const parsed2 = JSON.parse(value);
      return typeof parsed2 === "object" && parsed2 !== null && !Array.isArray(parsed2) ? parsed2 : void 0;
    } catch {
      return void 0;
    }
  }
  function isCount(value) {
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
  }

  // src/library-writes.ts
  var ROUTES = {
    bean: {
      list: "/beans?includeArchived=true",
      records: "/beans",
      create: () => "/beans",
      deferred: ["archived"],
      sameItem: (record, fields) => typeof record.roaster === "string" && typeof record.name === "string" && typeof fields.roaster === "string" && typeof fields.name === "string" && beanMatchKey(record.roaster, record.name) === beanMatchKey(fields.roaster, fields.name)
    },
    beanBatch: {
      list: "/bean-batches?includeArchived=true",
      records: "/bean-batches",
      // Under the tablet's record of its bean, which `beanId` names; the path decides it, and Decaid ignores the field.
      create: (fields) => typeof fields.beanId === "string" && fields.beanId !== "" ? `/beans/${encodeURIComponent(fields.beanId)}/batches` : null,
      deferred: ["archived", "weightRemaining"],
      sameItem: () => false
    },
    grinder: {
      list: "/grinders?includeArchived=true",
      records: "/grinders",
      create: () => "/grinders",
      deferred: ["archived"],
      sameItem: () => false
    }
  };
  var LibraryAccess = class {
    constructor() {
      __publicField(this, "queue", Promise.resolve());
    }
    /** Runs `work` once everything asked for before it is done, and resolves or rejects as it does. */
    run(work) {
      const done = this.queue.then(work);
      this.queue = done.catch(() => {
      });
      return done;
    }
  };
  var LibraryWrites = class {
    constructor(library, outbox, workflow, machineMissing) {
      __publicField(this, "library", library);
      __publicField(this, "outbox", outbox);
      __publicField(this, "workflow", workflow);
      __publicField(this, "machineMissing", machineMissing);
      /**
       * The batch, Grinder and profile records the Shots this plugin queued since
       * it loaded name, as `kind:id`: a few per batch, Grinder and profile used.
       * A profile is named by its steps (`stepsKey`), as a skin sets the
       * Workflow's profile's targets for the Shot, and by the id a skin recorded,
       * if one did.
       */
      __publicField(this, "shotsName", /* @__PURE__ */ new Set());
      /** The Shots still to be sent that `namedByShot` read. */
      __publicField(this, "shotsRead", /* @__PURE__ */ new Set());
      outbox.watch((delivery) => {
        if (delivery.type === "shot" || delivery.type === "shotUpdated") this.noteShot(delivery.shot);
      });
    }
    /** Deletes a record of a hard-deleted item once the reads and writes before it are done, and queues its answer. It never rejects. */
    remove(remove) {
      return this.library.run(async () => this.outbox.enqueue(await carryOutDelete(remove, (kind, ids) => this.namedByShot(kind, ids))));
    }
    /**
     * Whether a Shot this plugin queued since it loaded, or has yet to read and
     * send, names one of the records, as one pulled while the tablet was
     * offline: the server may have planned the delete before it had the Shot,
     * and so could not keep the record for it. A Shot still to be read, as the
     * outbox reads a new Shot only as it sends it, is read here once.
     */
    async namedByShot(kind, ids) {
      const unread = this.outbox.requestedIds("shot").filter((id) => !this.shotsRead.has(id));
      if (unread.length > MAX_SHOTS_READ) return "tooMany";
      for (const id of unread) {
        const shot = await readShot(id);
        this.shotsRead.add(id);
        if (shot) this.noteShot(shot);
      }
      return [...ids].some((id) => this.shotsName.has(`${kind}:${id}`));
    }
    /** Notes the batch, Grinder and profile records a Shot names. */
    noteShot(shot) {
      const workflow = shot.workflow;
      if (!isObject2(workflow)) return;
      const steps = stepsKey(workflow.profile);
      if (steps !== null) this.shotsName.add(`profile:${steps}`);
      const context = workflow.context;
      if (!isObject2(context)) return;
      if (typeof context.beanBatchId === "string") this.shotsName.add(`beanBatch:${context.beanBatchId}`);
      if (typeof context.grinderId === "string") this.shotsName.add(`grinder:${context.grinderId}`);
      const skin = isObject2(context.extras) ? context.extras.workflowSkin : void 0;
      if (isObject2(skin) && typeof skin.selectedProfileId === "string") this.shotsName.add(`profile:${skin.selectedProfileId}`);
    }
    /** Sets aside a record the Library leaves out once the reads and writes before it are done, and queues its answer. It never rejects. */
    leaveOut(leave) {
      return this.library.run(async () => this.outbox.enqueue(await setAside(leave)));
    }
    /** Carries out a write once the reads and writes before it are done, and queues its answer. It never rejects. */
    apply(write) {
      if (write.kind !== SETTINGS_KIND && write.kind !== WORKFLOW_KIND) return this.library.run(async () => this.outbox.enqueue(await carryOut(write)));
      return this.library.run(async () => {
        this.workflow.hold();
        try {
          const answer = await carryOut(write);
          if (answer.type === "writeRefused" && answer.status === 500 && answer.error.includes("DeviceNotConnectedException")) this.machineMissing();
          this.outbox.enqueue(answer);
        } finally {
          this.workflow.release();
        }
      });
    }
  };
  async function carryOutDelete(remove, namedByShot) {
    if (remove.kind === "profile") return purgeProfile(remove, namedByShot);
    const route = Object.prototype.hasOwnProperty.call(ROUTES, remove.kind) ? ROUTES[remove.kind] : void 0;
    if (!route) return refused(remove, null, `This plugin cannot delete a ${remove.kind}`);
    try {
      const path = `${route.records}/${encodeURIComponent(remove.localId)}`;
      const current = await request("GET", path);
      if (current.status === 404) return deleted(remove);
      const record = current.ok ? parsed(current.text) : void 0;
      if (!isObject2(record)) return refused(remove, current.status, current.text);
      const carried = globalIdOf(record);
      if (carried !== null && carried !== remove.globalId.toLowerCase()) return refused(remove, null, ANOTHER_ITEMS_RECORD);
      if (remove.kind === "beanBatch" || remove.kind === "grinder") {
        const named = await namedByShot(remove.kind, /* @__PURE__ */ new Set([remove.localId]));
        if (named !== false) return refused(remove, null, named === "tooMany" ? SHOTS_STILL_TO_READ : SHOT_NOT_SENT);
      }
      if (remove.kind === "bean") {
        const listed = await request("GET", `${path}/batches?includeArchived=true`);
        const batches = listed.ok ? parsed(listed.text) : void 0;
        if (!Array.isArray(batches)) return refused(remove, listed.status, listed.text);
        const ids = new Set(batches.filter(isObject2).flatMap((batch) => typeof batch.id === "string" ? [batch.id] : []));
        const named = await namedByShot("beanBatch", ids);
        if (named !== false) return refused(remove, null, named === "tooMany" ? SHOTS_STILL_TO_READ : SHOT_NOT_SENT);
        for (const batch of batches.filter(isObject2)) {
          if (typeof batch.id !== "string") continue;
          const gone = await request("DELETE", `/bean-batches/${encodeURIComponent(batch.id)}`);
          if (!gone.ok && gone.status !== 404) return refused(remove, gone.status, gone.text);
        }
      }
      const answer = await request("DELETE", path);
      return answer.ok || answer.status === 404 ? deleted(remove) : refused(remove, answer.status, answer.text);
    } catch (error) {
      return refused(remove, null, `Decaid did not answer: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  async function purgeProfile(remove, namedByShot) {
    try {
      const path = `/profiles/${encodeURIComponent(remove.localId)}`;
      const current = await request("GET", path);
      if (current.status === 404) return deleted(remove);
      const record = current.ok ? parsed(current.text) : void 0;
      if (!isObject2(record)) return refused(remove, current.status, current.text);
      const steps = stepsKey(record.profile);
      const named = await namedByShot("profile", new Set(steps === null ? [remove.localId] : [remove.localId, steps]));
      if (named !== false) return refused(remove, null, named === "tooMany" ? SHOTS_STILL_TO_READ : SHOT_NOT_SENT);
      const answer = await request("DELETE", `${path}/purge`);
      return answer.ok || answer.status === 400 && answer.text.includes("Profile not found") ? deleted(remove) : refused(remove, answer.status, answer.text);
    } catch (error) {
      return refused(remove, null, `Decaid did not answer: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  function stepsKey(profile) {
    if (!isObject2(profile) || !Array.isArray(profile.steps)) return null;
    const steps = profile.steps.map((step) => {
      if (!isObject2(step)) return step;
      const { temperature: _, ...rest } = step;
      return isObject2(rest.limiter) && rest.limiter.value === 0 ? { ...rest, limiter: null } : rest;
    });
    return stableJson(steps);
  }
  function stableJson(value) {
    if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
    if (isObject2(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
    return JSON.stringify(value ?? null);
  }
  var SHOT_NOT_SENT = "A Shot this plugin has queued or has yet to send names the record or one of its batches";
  var MAX_SHOTS_READ = 20;
  async function setAside(leave) {
    const answer = (outcome, status, error) => ({
      type: "leftOut",
      id: leave.id,
      kind: leave.kind,
      localId: leave.localId,
      outcome,
      ...outcome === "refused" ? { status: status ?? null, error: (error ?? "").slice(0, MAX_REFUSAL_LENGTH) } : {}
    });
    const route = Object.prototype.hasOwnProperty.call(ROUTES, leave.kind) ? ROUTES[leave.kind] : void 0;
    if (!route && leave.kind !== "profile") return answer("refused", null, `This plugin cannot set aside a ${leave.kind}`);
    try {
      const path = `${route ? route.records : "/profiles"}/${encodeURIComponent(leave.localId)}`;
      const current = await request("GET", path);
      if (current.status === 404) return answer("gone");
      const record = current.ok ? parsed(current.text) : void 0;
      if (!isObject2(record)) return answer("refused", current.status, current.text);
      if (!route) {
        if (record.visibility !== "visible") return answer("setAside");
        const hidden = await setVisibility(leave.localId, "hidden");
        const updated2 = hidden.ok ? parsed(hidden.text) : void 0;
        return isObject2(updated2) && updated2.visibility !== "visible" ? answer("setAside") : answer("refused", hidden.status, hidden.text);
      }
      if (globalIdOf(record) !== null) return answer("taken");
      if (record.archived === true) return answer("setAside");
      const archived = await request("PUT", path, { archived: true, extras: isObject2(record.extras) ? record.extras : {} });
      const updated = archived.ok ? parsed(archived.text) : void 0;
      return isObject2(updated) && updated.archived === true ? answer("setAside") : answer("refused", archived.status, archived.text);
    } catch (error) {
      return answer("refused", null, `Decaid did not answer: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  function deleted(remove) {
    return { type: "deleted", id: remove.id, kind: remove.kind, globalId: remove.globalId, localId: remove.localId };
  }
  async function carryOut(write) {
    const route = Object.prototype.hasOwnProperty.call(ROUTES, write.kind) ? ROUTES[write.kind] : void 0;
    if (!route && write.kind !== "profile" && write.kind !== SETTINGS_KIND && write.kind !== WORKFLOW_KIND) {
      return refused(write, null, `This plugin cannot write a ${write.kind}`);
    }
    try {
      if (write.kind === SETTINGS_KIND) return await writeSettings(write);
      if (write.kind === WORKFLOW_KIND) return await clearWorkflow(write);
      if (!route) return await writeProfile(write);
      if (write.localId === null) return await create(route, write);
      const updated = await update(route, write, write.localId);
      return answerTo(write, updated.answer, updated.written);
    } catch (error) {
      return refused(write, null, `Decaid did not answer: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  async function writeProfile(write) {
    const visibility = write.fields.visibility;
    if (write.localId !== null) return await updateProfile(write, write.localId);
    const held = await heldProfile(write.globalId);
    if ("refused" in held) return refused(write, held.refused.status, held.refused.text);
    let record = held.record;
    const writtenFields = [];
    if (!record) {
      const { parentId, metadata } = write.fields;
      const parent = typeof parentId === "string" ? await heldProfile(parentId) : void 0;
      if (parent && "refused" in parent) return refused(write, parent.refused.status, parent.refused.text);
      const body = { profile: write.fields.profile, ...parent?.record ? { parentId } : {}, ...isObject2(metadata) ? { metadata } : {} };
      const made = await request("POST", "/profiles", body);
      const created = made.ok ? parsed(made.text) : void 0;
      if (!isObject2(created) || typeof created.id !== "string") return refused(write, made.status, made.text);
      record = created;
      writtenFields.push(...Object.keys(body));
    }
    if (record.id !== write.globalId || typeof visibility !== "string" || record.visibility === visibility) return written(write, record, writtenFields);
    const again = await setVisibility(write.globalId, visibility).catch(() => void 0);
    const updated = again?.ok ? parsed(again.text) : void 0;
    if (!isObject2(updated) || updated.id !== write.globalId) return written(write, record, writtenFields);
    return written(write, updated, [...writtenFields, "visibility"]);
  }
  async function writeSettings(write) {
    const current = await request("GET", "/workflow");
    const workflow = current.ok ? parsed(current.text) : void 0;
    if (!isObject2(workflow)) return refused(write, current.status, current.text);
    const held = (field) => {
      const [part, name] = field.split(".");
      const values = workflow[part];
      return isObject2(values) ? values[name] : void 0;
    };
    const steamOn = steamIsOn({ "steamSettings.targetTemperature": held("steamSettings.targetTemperature") });
    const fields = Object.fromEntries(
      Object.entries(settable(write, held)).filter(([field]) => steamOn || !STEAM_SETTINGS.includes(field))
    );
    if (Object.keys(fields).length === 0) return written(write, workflowSettings(workflow), [], (/* @__PURE__ */ new Date()).toISOString());
    const answer = await request("PUT", "/workflow", settingsParts(fields));
    const updated = answer.ok ? parsed(answer.text) : void 0;
    if (!isObject2(updated)) return refused(write, answer.status, answer.text);
    return written(write, workflowSettings(updated), Object.keys(fields), (/* @__PURE__ */ new Date()).toISOString());
  }
  async function clearWorkflow(write) {
    const current = await request("GET", "/workflow");
    const workflow = current.ok ? parsed(current.text) : void 0;
    if (!isObject2(workflow)) return refused(write, current.status, current.text);
    const context = isObject2(workflow.context) ? workflow.context : {};
    const fields = Object.fromEntries(
      [WORKFLOW_GRINDER, WORKFLOW_BATCH].flatMap((group) => {
        const [id] = group;
        const named = group.filter((field) => field in write.fields);
        const expected = write.expected?.[id];
        const holds = named.includes(id) && expected !== void 0 && expected !== null && sameValue(context[id.slice("context.".length)], expected);
        return holds ? named.map((field) => [field, null]) : [];
      })
    );
    if (Object.keys(fields).length === 0) return written(write, workflowContext(workflow), [], (/* @__PURE__ */ new Date()).toISOString());
    const answer = await request("PUT", "/workflow", settingsParts(fields));
    const updated = answer.ok ? parsed(answer.text) : void 0;
    if (!isObject2(updated)) return refused(write, answer.status, answer.text);
    return written(write, workflowContext(updated), Object.keys(fields), (/* @__PURE__ */ new Date()).toISOString());
  }
  function workflowContext(workflow) {
    return { context: isObject2(workflow.context) ? workflow.context : {} };
  }
  function workflowSettings(workflow) {
    return Object.fromEntries(SETTINGS_PARTS.flatMap((part) => part in workflow ? [[part, workflow[part]]] : []));
  }
  var PROFILE_TEXT = ["title", "author", "notes"];
  async function updateProfile(write, id) {
    const held = await heldProfile(id);
    if ("refused" in held) return refused(write, held.refused.status, held.refused.text);
    if (!held.record) return refused(write, 404, "Profile not found");
    let record = held.record;
    const fields = settable(write, (field) => field === "visibility" ? record.visibility : isObject2(record.profile) ? record.profile[field] : void 0);
    const writtenFields = [];
    const text = PROFILE_TEXT.filter((field) => field in fields);
    if (text.length > 0) {
      const profile = { ...isObject2(record.profile) ? record.profile : {} };
      for (const field of text) {
        if (fields[field] === null) delete profile[field];
        else profile[field] = fields[field];
      }
      const answer = await request("PUT", `/profiles/${encodeURIComponent(id)}`, { profile });
      const updated = answer.ok ? parsed(answer.text) : void 0;
      if (!isObject2(updated) || typeof updated.id !== "string") return refused(write, answer.status, answer.text);
      if (updated.id !== id) return written(write, updated, text);
      record = updated;
      writtenFields.push(...text);
    }
    if ("visibility" in fields) {
      if (record.visibility !== fields.visibility) {
        const answer = await setVisibility(id, fields.visibility).catch((error) => {
          if (writtenFields.length === 0) throw error;
          return void 0;
        });
        const updated = answer?.ok ? parsed(answer.text) : void 0;
        if (!isObject2(updated) || updated.id !== id) {
          return writtenFields.length === 0 ? refused(write, answer?.status ?? null, answer?.text ?? "") : written(write, record, writtenFields);
        }
        record = updated;
      }
      writtenFields.push("visibility");
    }
    return written(write, record, writtenFields);
  }
  function settable(write, current) {
    const expected = write.expected;
    return Object.fromEntries(
      Object.entries(write.fields).filter(([field]) => !expected || !(field in expected) || sameValue(current(field), expected[field]))
    );
  }
  async function heldProfile(id) {
    const answer = await request("GET", `/profiles/${encodeURIComponent(id)}`);
    if (answer.status === 404) return { record: void 0 };
    const record = answer.ok ? parsed(answer.text) : void 0;
    return isObject2(record) && record.id === id ? { record } : { refused: answer };
  }
  function setVisibility(id, visibility) {
    return request("PUT", `/profiles/${encodeURIComponent(id)}/visibility`, { visibility });
  }
  async function create(route, write) {
    const listed = await request("GET", route.list);
    if (!listed.ok) return refused(write, listed.status, listed.text);
    const parsedList = parsed(listed.text);
    const records = Array.isArray(parsedList) ? parsedList.filter(isObject2) : [];
    const held = records.find((record2) => globalIdOf(record2) === write.globalId.toLowerCase());
    if (held) return written(write, held, []);
    const same = records.find((record2) => globalIdOf(record2) === null && record2.archived !== true && route.sameItem(record2, write.fields));
    if (same && typeof same.id === "string") {
      const answer = answerTo(write, (await update(route, { ...write, fields: {} }, same.id)).answer, []);
      return answer.type === "written" ? { ...answer, linked: true } : answer;
    }
    const path = route.create(write.fields);
    if (path === null) return refused(write, null, `A ${write.kind} to create must name what it belongs to`);
    const body = { ...write.fields, extras: { [GLOBAL_ID_KEY]: write.globalId } };
    for (const field of route.deferred) delete body[field];
    const made = await request("POST", path, body);
    const record = made.ok ? parsed(made.text) : void 0;
    if (!isObject2(record) || typeof record.id !== "string") return refused(write, made.status, made.text);
    const later = Object.fromEntries(route.deferred.flatMap((field) => field in write.fields && write.fields[field] !== (record[field] ?? null) ? [[field, write.fields[field]]] : []));
    const writtenFields = Object.keys(write.fields);
    if (Object.keys(later).length === 0) return written(write, record, writtenFields);
    const again = await request("PUT", `${route.records}/${encodeURIComponent(record.id)}`, later).catch(() => void 0);
    const updated = again?.ok ? parsed(again.text) : void 0;
    return written(write, isObject2(updated) && typeof updated.id === "string" ? updated : record, writtenFields);
  }
  async function update(route, write, localId) {
    const path = `${route.records}/${encodeURIComponent(localId)}`;
    const current = await request("GET", path);
    if (!current.ok) return { answer: current, written: [] };
    const parsedRecord = parsed(current.text);
    const record = isObject2(parsedRecord) ? parsedRecord : {};
    const extras = isObject2(record.extras) ? record.extras : {};
    const fields = settable(write, (field) => record[field]);
    return { answer: await request("PUT", path, { ...fields, extras: { ...extras, [GLOBAL_ID_KEY]: write.globalId } }), written: Object.keys(fields) };
  }
  function answerTo(write, answer, writtenFields) {
    const record = answer.ok ? parsed(answer.text) : void 0;
    if (isObject2(record) && typeof record.id === "string") return written(write, record, writtenFields);
    return refused(write, answer.status, answer.text);
  }
  function written(write, record, writtenFields, at) {
    return {
      type: "written",
      id: write.id,
      kind: write.kind,
      globalId: write.globalId,
      record,
      updatedAt: at ?? utcTime(record.updatedAt),
      writtenFields,
      ...write.contentDecidedAt === void 0 ? {} : { contentDecidedAt: write.contentDecidedAt }
    };
  }
  function refused(write, status, error) {
    return { type: "writeRefused", id: write.id, kind: write.kind, globalId: write.globalId, status, error: error.slice(0, MAX_REFUSAL_LENGTH) };
  }
  function parsed(text) {
    try {
      return JSON.parse(text);
    } catch {
      return void 0;
    }
  }
  function isObject2(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }

  // src/machine-events.ts
  var MachineEvents = class {
    constructor(outbox) {
      __publicField(this, "outbox", outbox);
      /** The latest Workflow Decaid reported. */
      __publicField(this, "workflow");
      /**
       * Set while the plugin writes the shared settings into the Workflow
       * (`LibraryWrites`): a change Decaid reports meanwhile is sent once the
       * write's answer is queued, so the server reads the answer first.
       */
      __publicField(this, "held", false);
      /** A change reported while held, which `release` sends. */
      __publicField(this, "heldChange", false);
      /** The delivery that sent it again on the latest welcome, which the next welcome's replaces. */
      __publicField(this, "resent");
      /** The state and substate last queued, so repeated state updates send nothing. */
      __publicField(this, "state");
    }
    /** Decaid's `workflowUpdated`: the whole Workflow, sent on every load and every change. */
    workflowUpdated(payload) {
      const workflow = object(payload);
      if (!workflow) return;
      this.workflow = workflow;
      if (this.held) this.heldChange = true;
      else this.queueWorkflow(workflow);
    }
    /** Holds back the Workflow's changes, as a write of the shared settings begins. */
    hold() {
      this.held = true;
    }
    /**
     * Sends the latest Workflow, observed now, if it changed while held: that
     * holds the plugin's own write, and any change a barista made meanwhile.
     */
    release() {
      this.held = false;
      if (!this.heldChange || !this.workflow) return;
      this.heldChange = false;
      this.queueWorkflow(this.workflow);
    }
    /**
     * Decaid's `stateUpdate`, which arrives several times a second while a
     * machine is connected: only a change of state or substate is sent.
     */
    stateUpdate(payload) {
      const reported = object(object(payload)?.state);
      const state = reported?.state;
      const substate = reported?.substate;
      if (typeof state !== "string" || state === "" || typeof substate !== "string" || substate === "") return;
      if (this.state?.state === state && this.state.substate === substate) return;
      this.state = { state, substate };
      this.outbox.enqueue({ type: "machineState", id: this.outbox.nextId(), observedAt: now(), state, substate });
    }
    /**
     * On every welcome, before the outbox sends, the latest Workflow again,
     * observed now, behind whatever the last connection left unacknowledged.
     * The connection may stand for other hardware than the last one did,
     * after the tablet moved to another machine, and the server changes nothing
     * for a delivery it has handled, even one handled for the last hardware but
     * not acknowledged, so it is always a new delivery; the server records
     * nothing if it is unchanged. It replaces the one the last welcome queued,
     * if that is still queued. The next state update is sent whatever it is,
     * for the same reason.
     */
    welcome() {
      this.state = void 0;
      this.resend();
    }
    /**
     * Sends the latest Workflow again, observed now, as on a welcome: the
     * server asks for it with every collection when the Machine's Location
     * changes (`requestCollections`), so the tablet takes the new Location's
     * settings, or sets them, and its Workflow's grinder and batch are judged
     * there (ADR-0008).
     */
    resend() {
      if (!this.workflow) return;
      if (this.resent !== void 0) this.outbox.discard(this.resent);
      this.resent = void 0;
      if (this.held) this.heldChange = true;
      else this.resent = this.queueWorkflow(this.workflow);
    }
    /** Queues the Workflow as observed now, returning its delivery's id. */
    queueWorkflow(workflow) {
      const delivery = { type: "workflow", id: this.outbox.nextId(), observedAt: now(), workflow };
      this.outbox.enqueue(delivery);
      return delivery.id;
    }
  };
  function now() {
    return (/* @__PURE__ */ new Date()).toISOString();
  }
  function object(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value) ? value : void 0;
  }

  // src/outbox.ts
  var RECORD_NAMES = { shot: "Shot", steam: "Steam Record" };
  var SHORT_OUTBOX = 4;
  var RESTORE_RETRY_MS = 5e3;
  var RESTORE_RETRY_MAX_MS = 5 * 6e4;
  var Outbox = class {
    constructor(log, readers, kept) {
      __publicField(this, "log", log);
      __publicField(this, "readers", readers);
      __publicField(this, "kept", kept);
      __publicField(this, "queued", /* @__PURE__ */ new Map());
      __publicField(this, "watchers", []);
      __publicField(this, "requested", /* @__PURE__ */ new Map());
      __publicField(this, "runtimeId", `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`);
      __publicField(this, "sequence", 0);
      __publicField(this, "sendMessage");
      /** Bumped by every welcome and disconnect, so a send prepared for one connection is not made on the next. */
      __publicField(this, "connections", 0);
      /** The delivery awaiting acknowledgment. */
      __publicField(this, "sent");
      /** Deliveries handed to a connection at least once and not yet acknowledged. */
      __publicField(this, "handed", /* @__PURE__ */ new Set());
      __publicField(this, "working", false);
      __publicField(this, "stopped", false);
      __publicField(this, "retryTimer");
      /** Set until the deliveries kept by earlier loads are read back, and nothing is sent meanwhile. */
      __publicField(this, "restoring", true);
      __publicField(this, "restoreTimer");
      __publicField(this, "restoreDelayMs", RESTORE_RETRY_MS);
      /** The Workflow and machine state deliveries queued while restoring, oldest first, with the length of their JSON. */
      __publicField(this, "whileRestoring", /* @__PURE__ */ new Map());
      __publicField(this, "whileRestoringCharacters", 0);
      /** Deliveries kept whose writes to Decaid's plugin storage are not yet answered; each waits for them before it is sent. */
      __publicField(this, "unwritten", /* @__PURE__ */ new Set());
      /** Whether dropping the oldest deliveries kept was logged since the last welcome. */
      __publicField(this, "droppedLogged", false);
    }
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
    async restore() {
      let restored;
      try {
        restored = await this.kept.load();
      } catch (error) {
        if (this.stopped) return;
        const delay = this.restoreDelayMs;
        this.restoreDelayMs = Math.min(delay * 2, RESTORE_RETRY_MAX_MS);
        this.log(`Could not read the deliveries kept in Decaid's plugin storage, trying again in ${delay / 1e3} s: ${error instanceof Error ? error.message : String(error)}.`);
        this.restoreTimer = setTimeout(() => {
          this.restoreTimer = void 0;
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
      const sending = restored.filter((delivery) => this.queued.has(delivery.id)).length;
      if (sending > 0) this.log(`Sending ${sending} Workflow and machine state ${sending === 1 ? "event" : "events"} kept from before the plugin last unloaded.`);
      this.pump();
    }
    /** Whether a welcomed connection is sending. */
    get connected() {
      return this.sendMessage !== void 0;
    }
    welcome(send) {
      this.sendMessage = send;
      this.connections++;
      this.sent = void 0;
      this.droppedLogged = false;
      this.pump();
    }
    disconnected() {
      this.sendMessage = void 0;
      this.connections++;
      this.sent = void 0;
    }
    stop() {
      this.stopped = true;
      this.disconnected();
      this.kept.stop();
      if (this.retryTimer !== void 0) clearTimeout(this.retryTimer);
      if (this.restoreTimer !== void 0) clearTimeout(this.restoreTimer);
    }
    enqueue(delivery) {
      this.queued.set(delivery.id, delivery);
      for (const watcher of this.watchers) watcher(delivery);
      if (isKept(delivery)) {
        if (this.restoring) this.holdWhileRestoring(delivery);
        else this.keep(delivery);
      }
      this.pump();
    }
    acknowledge(id) {
      this.forget(id);
      if (this.sent === id) this.sent = void 0;
      this.pump();
    }
    /** The ids of the records of that kind still to be read and sent. */
    requestedIds(kind) {
      return [...this.requested.values()].filter((record) => record.kind === kind).map((record) => record.id);
    }
    /** Calls `watcher` with every delivery queued from now on, those read for the server's requests included. */
    watch(watcher) {
      this.watchers.push(watcher);
    }
    /** Drops a queued delivery that a newer one makes unnecessary; one being sent now stays, to be acknowledged. */
    discard(id) {
      if (this.sent !== id) this.forget(id);
    }
    /**
     * Drops a queued delivery that a newer one makes unnecessary, unless it
     * was ever handed to a connection. One sent before a reconnect may still
     * be being stored by the server instance that received it; sent again,
     * ahead of the newer one, it is found already handled, or waited for, so
     * it can never be stored after the newer one.
     */
    supersede(id) {
      if (!this.handed.has(id)) this.forget(id);
    }
    /**
     * Records to read and send: requested by the server, after those already
     * requested, where a record requested again keeps its place, or, with
     * `first`, ahead of them all, as for records new on the tablet.
     */
    request(kind, ids, options = {}) {
      const records = ids.map((id) => [`${kind}:${id}`, { kind, id }]);
      if (options.first) {
        const keys = new Set(records.map(([key]) => key));
        const others = [...this.requested].filter(([key]) => !keys.has(key));
        this.requested.clear();
        for (const [key, record] of [...records, ...others]) this.requested.set(key, record);
      } else {
        for (const [key, record] of records) this.requested.set(key, record);
      }
      this.pump();
    }
    /** Resolves once few enough deliveries are queued for an index to add a page. */
    async waitForRoom() {
      while (!this.stopped && this.queued.size >= SHORT_OUTBOX) await new Promise((resolve) => setTimeout(resolve, 50));
    }
    nextId() {
      return `${this.runtimeId}-${++this.sequence}`;
    }
    pump() {
      if (this.restoring || this.retryTimer !== void 0 || this.working || this.stopped || !this.sendMessage || this.sent !== void 0 || this.queued.size === 0 && this.requested.size === 0) return;
      const next = this.queued.keys().next();
      if (!next.done && this.unwritten.has(next.value)) return;
      this.working = true;
      void this.work().catch(() => {
        this.log("Delivery interrupted; unacknowledged data remains queued.");
        this.retry();
      }).finally(() => {
        this.working = false;
        if (!this.stopped && this.sendMessage && this.sent === void 0) this.pump();
      });
    }
    async work() {
      const generation = this.connections;
      if (this.queued.size === 0 && this.requested.size > 0) {
        const [key, record] = this.requested.entries().next().value;
        let delivery;
        try {
          delivery = await this.readers[record.kind](record.id, this.nextId());
        } catch {
          this.requested.delete(key);
          this.requested.set(key, record);
          this.log(`Could not read ${RECORD_NAMES[record.kind]} ${record.id} from Decaid; retrying it after the other requested records.`);
          this.retry();
          return;
        }
        if (this.stopped) return;
        this.requested.delete(key);
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
    keep(delivery) {
      this.unwritten.add(delivery.id);
      const { written: written2, dropped } = this.kept.keep(delivery);
      for (const id of dropped) {
        if (this.handed.has(id)) continue;
        this.queued.delete(id);
        this.unwritten.delete(id);
      }
      if (dropped.length > 0) this.logDropping();
      void written2.then(() => {
        this.unwritten.delete(delivery.id);
        this.pump();
      });
    }
    /**
     * Holds a Workflow or machine state delivery queued while restoring, to be
     * kept once those kept earlier are read back, dropping the oldest held if
     * that takes them past the limits on those kept.
     */
    holdWhileRestoring(delivery) {
      const characters = JSON.stringify(delivery).length;
      this.whileRestoring.set(delivery.id, characters);
      this.whileRestoringCharacters += characters;
      while (this.whileRestoring.size > 1 && (this.whileRestoring.size > MAX_KEPT || this.whileRestoringCharacters > MAX_KEPT_CHARACTERS)) {
        const [oldest, size] = this.whileRestoring.entries().next().value;
        this.whileRestoring.delete(oldest);
        this.whileRestoringCharacters -= size;
        this.queued.delete(oldest);
        this.logDropping();
      }
    }
    logDropping() {
      if (this.droppedLogged) return;
      this.droppedLogged = true;
      this.log(`Dropping the oldest Workflow and machine state events not yet sent: at most ${MAX_KEPT} are kept, of at most ${MAX_KEPT_CHARACTERS / (1024 * 1024)} Mi characters.`);
    }
    /** Forgets a delivery, in memory and in Decaid's plugin storage. */
    forget(id) {
      const held = this.whileRestoring.get(id);
      if (held !== void 0) {
        this.whileRestoring.delete(id);
        this.whileRestoringCharacters -= held;
      }
      this.queued.delete(id);
      this.handed.delete(id);
      this.unwritten.delete(id);
      this.kept.remove(id);
    }
    retry() {
      if (this.stopped || this.retryTimer !== void 0) return;
      this.retryTimer = setTimeout(() => {
        this.retryTimer = void 0;
        this.pump();
      }, 5e3);
    }
  };

  // src/sender.ts
  var MAX_UNCONFIRMED_BYTES = 512 * 1024;
  var Sender = class {
    constructor(sendFrame) {
      __publicField(this, "sendFrame", sendFrame);
      __publicField(this, "queue", []);
      __publicField(this, "unconfirmed", []);
      __publicField(this, "unconfirmedBytes", 0);
      __publicField(this, "sending", false);
      /** Set once the transport closed or refused a frame; nothing more is sent. */
      __publicField(this, "failure");
      /** Names chunked messages that have no id of their own. */
      __publicField(this, "unnamed", 0);
    }
    /** Resolves once every frame of the message has been handed to Decaid; rejects if the transport fails first. */
    async send(message) {
      if (this.failure) throw this.failure;
      const id = "id" in message ? message.id : void 0;
      const name = id ?? `message-${++this.unnamed}`;
      const encoded = frames(encode(message), name);
      if (encoded.length === 1 && id === void 0) return this.sendFrame(encoded[0].text);
      return new Promise((resolve, reject) => {
        this.queue.push({ id: name, frames: encoded, sent: 0, resolve, reject });
        void this.pump();
      });
    }
    /** The server received a chunk. */
    received(id, index) {
      this.confirm(id, index);
    }
    /** The server stored a delivery. */
    acknowledged(id) {
      this.confirm(id, void 0);
    }
    /** Fails every message not yet handed to Decaid in full, as the transport has closed. */
    close(error = new Error("The connection closed")) {
      if (this.failure) return;
      this.failure = error;
      for (const queued of this.queue.splice(0)) queued.reject(error);
      this.unconfirmed.length = 0;
      this.unconfirmedBytes = 0;
    }
    confirm(id, index) {
      const at = this.unconfirmed.findIndex((frame) => frame.id === id && frame.index === index);
      if (at < 0) return;
      for (const frame of this.unconfirmed.splice(0, at + 1)) this.unconfirmedBytes -= frame.bytes;
      void this.pump();
    }
    async pump() {
      if (this.sending) return;
      this.sending = true;
      try {
        while (!this.failure && this.queue.length > 0) {
          const next = this.queue[0];
          const frame = next.frames[next.sent];
          if (this.unconfirmedBytes + frame.bytes > MAX_UNCONFIRMED_BYTES) return;
          this.unconfirmed.push({ id: next.id, index: next.frames.length > 1 ? next.sent : void 0, bytes: frame.bytes });
          this.unconfirmedBytes += frame.bytes;
          next.sent++;
          await this.sendFrame(frame.text);
          if (this.failure) return;
          if (next.sent === next.frames.length) {
            this.queue.shift();
            next.resolve();
          }
        }
      } catch (error) {
        this.close(error instanceof Error ? error : new Error(String(error)));
      } finally {
        this.sending = false;
      }
    }
  };

  // src/shots.ts
  var PAGE_SIZE = 100;
  var OVERLAP = 10;
  var MAX_PASSES = 3;
  var ShotCapture = class {
    constructor(outbox, log) {
      __publicField(this, "outbox", outbox);
      __publicField(this, "log", log);
      __publicField(this, "scanning", false);
      __publicField(this, "scanned", false);
      __publicField(this, "stopped", false);
      __publicField(this, "timer");
      /** The Shots Decaid reported stored or edited while a summary pass runs. */
      __publicField(this, "reported");
    }
    welcome() {
      if (!this.scanned && !this.scanning && this.timer === void 0) void this.scan();
    }
    stop() {
      this.stopped = true;
      if (this.timer !== void 0) clearTimeout(this.timer);
    }
    event(type, payload) {
      const event = object2(payload);
      if (this.stopped || !event || !isCaptured(event.id)) return;
      const id = event.id;
      this.reported?.add(id);
      if (type === "shot") {
        this.outbox.request("shot", [id], { first: true });
        return;
      }
      const shot = object2(event.shot);
      if (!shot) return;
      this.outbox.enqueue({ type, id: this.outbox.nextId(), shotId: id, shot });
    }
    /** A Shot new on the tablet or requested by the server, as a delivery, or null if the tablet no longer has it. */
    async read(id, deliveryId) {
      const shot = await readShot(id);
      return shot && { type: "shot", id: deliveryId, shotId: id, shot };
    }
    /** Read bounded summaries once per load; never use the unbounded ids endpoint. */
    async scan() {
      this.scanning = true;
      try {
        for (let pass = 1; !await this.scanPass(); pass++) {
          if (pass === MAX_PASSES) {
            this.log("Shot history kept changing during reconciliation; the next load will reconcile the rest.");
            break;
          }
        }
        this.scanned = !this.stopped;
      } catch {
        this.log("Could not reconcile Shot history; retrying the summary scan.");
        if (!this.stopped) this.timer = setTimeout(() => {
          this.timer = void 0;
          void this.scan();
        }, 5e3);
      } finally {
        this.scanning = false;
        this.reported = void 0;
      }
    }
    /**
     * Pages through every summary once, newest first. Offsets count positions
     * in the list as it is when each page is read, so a deletion moves later
     * Shots up and an addition moves them down. Each page after the first
     * therefore starts OVERLAP Shots before the previous page ended and
     * resumes after the last Shot this pass has read and that has the edit
     * time it was read with: every unedited Shot older than that one sorts
     * after it, so none that existed throughout the pass is missed. Every
     * Decaid edit gives a Shot a new edit time, and an edit to its time can
     * move it anywhere. One moved from the part of the list not yet read into
     * the part already read is missed; Decaid's edit API reports it in
     * `shotUpdated`, but an import that overwrites it reports nothing. So a
     * pass that reaches the end checks it has read or been told of as many
     * Shots as the tablet holds; one deleted while another was moved that way
     * goes unnoticed. Returns true once the pass reaches the end with that
     * count, or the capture stops, and false if the count falls short, if no
     * Shot read with its current edit time reappears, as when more than the
     * overlap were deleted between two pages, or if the list grows past what
     * the first page's total allows: the pass may have missed Shots, so it is
     * repeated.
     */
    async scanPass() {
      const read = /* @__PURE__ */ new Map();
      const reported = this.reported = /* @__PURE__ */ new Set();
      let remaining = 1;
      for (let offset = 0; remaining > 0; remaining--) {
        await this.outbox.waitForRoom();
        if (this.stopped) return true;
        const page = await readShotPage(PAGE_SIZE, offset);
        if (!page) throw new Error("Shot summaries unavailable");
        const items = page.items.map(object2);
        let resume = 0;
        if (offset === 0) remaining = Math.ceil(page.total / (PAGE_SIZE - OVERLAP)) + 2;
        else {
          for (let index = items.length - 1; index >= 0 && resume === 0; index--) {
            const summary = items[index];
            if (typeof summary?.id === "string" && read.has(summary.id) && read.get(summary.id) === summary.updatedAt) resume = index + 1;
          }
          if (resume === 0) return false;
        }
        const shots = items.slice(resume).flatMap((summary) => {
          if (typeof summary?.id !== "string" || summary.id === "") return [];
          read.set(summary.id, summary.updatedAt);
          if (!isCaptured(summary.id) || typeof summary.updatedAt !== "string") return [];
          return [{ id: summary.id, updatedAt: summary.updatedAt }];
        });
        if (shots.length > 0) this.outbox.enqueue({ type: "shotIndex", id: this.outbox.nextId(), shots });
        if (page.items.length < PAGE_SIZE) {
          for (const id of read.keys()) reported.add(id);
          return reported.size >= page.total;
        }
        offset += page.items.length - OVERLAP;
      }
      return false;
    }
  };
  function isCaptured(id) {
    return isRecordId(id) && !id.startsWith("de1app-");
  }
  function object2(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value) ? value : void 0;
  }

  // src/steams.ts
  var PAGE_SIZE2 = 100;
  var FULL_READ_INTERVALS = 10;
  var MAX_RETRY_INTERVALS = 64;
  var SteamCapture = class {
    constructor(outbox, pollMs, log) {
      __publicField(this, "outbox", outbox);
      __publicField(this, "pollMs", pollMs);
      __publicField(this, "log", log);
      /** Every id this load has seen, in reads of every id and of the newest. */
      __publicField(this, "known", /* @__PURE__ */ new Set());
      /** Whether every id has been read for the index. */
      __publicField(this, "indexed", false);
      /** Whole poll intervals since the last read of every id began, or failed; one begun or failed between intervals counts from the next. */
      __publicField(this, "intervalsSinceFullRead", 0);
      /** Intervals that must begin after a read of every id before the next; none before the first. */
      __publicField(this, "fullReadWait", 0);
      /** Reads of every id that have failed in a row. */
      __publicField(this, "failures", 0);
      __publicField(this, "failureLogged", false);
      __publicField(this, "readingAll", false);
      __publicField(this, "readingLatest", false);
      __publicField(this, "stopped", false);
      __publicField(this, "pollTimer");
    }
    start() {
      this.schedulePoll();
    }
    stop() {
      this.stopped = true;
      if (this.pollTimer !== void 0) clearTimeout(this.pollTimer);
    }
    /**
     * Polls at once, between intervals, which go on as they were: the poll
     * finds what was recorded while disconnected, and starts the load's index.
     */
    welcome() {
      this.poll(false);
    }
    /** A Steam Record, as a delivery placed in time, or null if the tablet no longer has it or its time cannot be read. */
    async read(id, deliveryId) {
      const steam = await readSteam(id);
      if (!steam) return null;
      const steamedAt = utcTime(steam.timestamp);
      if (steamedAt === null) {
        this.log(`Not sending Steam Record ${id}: its time is not one Decaid writes.`);
        return null;
      }
      return { type: "steam", id: deliveryId, steamId: id, steamedAt, steam };
    }
    schedulePoll() {
      this.pollTimer = setTimeout(() => {
        this.pollTimer = void 0;
        this.intervalsSinceFullRead++;
        this.poll(true);
        if (!this.stopped) this.schedulePoll();
      }, this.pollMs);
    }
    /**
     * Requests the Steam Records new since the last poll, ahead of those the
     * server requested: the newest, and, when they are due, any that every id
     * shows. Each read is skipped while its last one still runs.
     */
    poll(atInterval) {
      if (this.stopped || !this.outbox.connected) return;
      if (!this.readingAll && this.intervalsSinceFullRead >= this.fullReadWait) void this.readAll(atInterval);
      if (!this.readingLatest) void this.readLatest();
    }
    async readLatest() {
      this.readingLatest = true;
      try {
        const latest = await readLatestSteamId();
        if (latest !== null && !this.stopped) this.request([latest]);
      } catch {
      } finally {
        this.readingLatest = false;
      }
    }
    /** Reads every id: the first time, to send them as the index; after that, to request those not seen. */
    async readAll(atInterval) {
      this.readingAll = true;
      this.intervalsSinceFullRead = atInterval ? 0 : -1;
      let ids;
      try {
        ids = await readSteamIds();
      } catch (error) {
        this.intervalsSinceFullRead = -1;
        this.fullReadWait = Math.min((this.indexed ? FULL_READ_INTERVALS : 1) * 2 ** this.failures, MAX_RETRY_INTERVALS);
        this.failures++;
        if (!this.failureLogged) {
          this.failureLogged = true;
          this.log(
            `Could not read the Steam Record ids: ${error instanceof Error ? error.message : String(error)}. New Steam Records are still sent; reading every id is tried again less and less often until it succeeds.`
          );
        }
        return;
      } finally {
        this.readingAll = false;
      }
      this.fullReadWait = FULL_READ_INTERVALS;
      this.failures = 0;
      if (this.stopped) return;
      if (this.indexed) {
        this.request(ids);
        return;
      }
      this.indexed = true;
      for (const id of ids) this.known.add(id);
      void this.sendIndex(ids);
    }
    /** Requests the Steam Records among these not seen before, ahead of those the server requested. */
    request(ids) {
      const fresh = ids.filter((id) => !this.known.has(id));
      for (const id of fresh) this.known.add(id);
      if (fresh.length > 0) this.outbox.request("steam", fresh, { first: true });
    }
    /**
     * Queues the index in pages, each once few deliveries are queued. While
     * disconnected the outbox sends nothing, so the pages wait, and the next
     * welcome sends those left, after any it had sent and not had acknowledged.
     */
    async sendIndex(ids) {
      for (let offset = 0; offset < ids.length; offset += PAGE_SIZE2) {
        await this.outbox.waitForRoom();
        if (this.stopped) return;
        this.outbox.enqueue({ type: "steamIndex", id: this.outbox.nextId(), steams: ids.slice(offset, offset + PAGE_SIZE2).map((id) => ({ id })) });
      }
    }
  };

  // src/storage.ts
  var STORAGE_TIMEOUT_MS = 1e4;
  var PluginStorage = class {
    constructor(host) {
      __publicField(this, "host", host);
      /** Commands waiting their turn, in order. */
      __publicField(this, "queue", []);
      /** The writes among them, by key. */
      __publicField(this, "queuedWrites", /* @__PURE__ */ new Map());
      /** The command sent and awaiting Decaid's answer. */
      __publicField(this, "waiting");
      /**
       * Set once Decaid leaves a write unanswered, until it answers anything:
       * meanwhile writes are sent without waiting for answers, as with a Decaid
       * failing every write each would otherwise hold up what waits on it for
       * STORAGE_TIMEOUT_MS.
       */
      __publicField(this, "unanswered", false);
      __publicField(this, "stopped", false);
    }
    /** The value at `key`, null if it was never written. Rejects, saying why, if Decaid refuses or does not answer in time. */
    async read(key, what) {
      const answer = await this.run({ type: "read", key }, what, "storageRead", (payload) => {
        return typeof payload === "object" && payload !== null && payload.key === key;
      });
      return answer.value ?? null;
    }
    /**
     * Writes `data` at `key`, or a later write's data to the same key, made
     * while this one waited its turn. Rejects, saying why, if Decaid refuses or
     * does not answer in time; it may still have written it. While Decaid
     * leaves writes unanswered, it resolves once the write is sent.
     */
    async write(key, data, what) {
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
    answered(name, payload) {
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
    stop() {
      if (this.stopped) return;
      this.stopped = true;
      const unloading = new Error("the plugin is unloading");
      const sent = this.settle();
      const unsent = [...sent ? [sent.command] : [], ...this.queue.splice(0)];
      this.queuedWrites.clear();
      for (const command of unsent) {
        if (command.command.type === "write") {
          try {
            this.host.storage(command.command);
          } catch {
          }
        }
        fail(command, unloading);
      }
    }
    run(command, what, event, answers) {
      if (this.stopped) return Promise.reject(new Error("the plugin is unloading"));
      return new Promise((resolve, reject) => {
        const queued = { command, what, event, answers, waiting: [{ resolve, reject }] };
        this.queue.push(queued);
        if (command.type === "write") this.queuedWrites.set(command.key, queued);
        if (!this.waiting) this.next();
      });
    }
    /** Sends the commands waiting their turn: the next one, or, while Decaid leaves writes unanswered, every write up to a read. */
    next() {
      for (; ; ) {
        const command = this.queue.shift();
        if (!command) return;
        if (command.command.type === "write") this.queuedWrites.delete(command.command.key);
        if (this.unanswered && command.command.type === "write") {
          try {
            this.host.storage(command.command);
            for (const waiter of command.waiting) waiter.resolve(void 0);
          } catch (error) {
            fail(command, new Error(`Decaid refused ${command.what}: ${error instanceof Error ? error.message : String(error)}`));
          }
          continue;
        }
        const timer = setTimeout(() => {
          this.settle();
          if (command.command.type === "write") this.unanswered = true;
          fail(command, new Error(`Decaid's plugin storage did not answer ${command.what} within ${STORAGE_TIMEOUT_MS / 1e3} s`));
          this.next();
        }, STORAGE_TIMEOUT_MS);
        this.waiting = { command, timer };
        try {
          this.host.storage(command.command);
          return;
        } catch (error) {
          this.settle();
          fail(command, new Error(`Decaid refused ${command.what}: ${error instanceof Error ? error.message : String(error)}`));
        }
      }
    }
    /** Stops waiting for the answer to the command sent, returning what waited. */
    settle() {
      const waiting = this.waiting;
      if (waiting) clearTimeout(waiting.timer);
      this.waiting = void 0;
      return waiting;
    }
  };
  function fail(command, error) {
    for (const waiter of command.waiting) waiter.reject(error);
  }

  // src/tablet-id.ts
  var KEY = "tabletId";
  var BACKUP_RETRY_MS = 3e4;
  var TabletId = class {
    constructor(storage, log) {
      __publicField(this, "storage", storage);
      __publicField(this, "log", log);
      /** Known once read or made, for as long as this load lasts. */
      __publicField(this, "id");
      /** The read of the id under way, shared by callers meanwhile. */
      __publicField(this, "reading");
      /** The next attempt to have Decaid's backups include the id, while one is due. */
      __publicField(this, "backupRetry");
      __publicField(this, "stopped", false);
    }
    /**
     * The tablet's id: the one in plugin storage, or, if that key was never
     * written, a new one, once Decaid has written it there, or, while Decaid
     * leaves writes unanswered (storage.ts), once it is sent: a Decaid that
     * cannot write it gives the tablet a new id each load. Rejects, saying why,
     * if Decaid refuses or does not answer in time; reading again later
     * retries.
     */
    read() {
      if (this.id !== void 0) return Promise.resolve(this.id);
      this.reading ?? (this.reading = this.readOrMake().finally(() => {
        this.reading = void 0;
      }));
      return this.reading;
    }
    stop() {
      this.stopped = true;
      if (this.backupRetry !== void 0) clearTimeout(this.backupRetry);
    }
    async readOrMake() {
      const stored = await this.storage.read(KEY, "a read of this tablet's id");
      if (isTabletId(stored)) return this.known(stored);
      const made = newTabletId();
      await this.storage.write(KEY, made, "the write of this tablet's new id");
      this.log(
        stored === null ? `This tablet had no id in Decaid's plugin storage, so it was given one: ${made}.` : `This tablet's id in Decaid's plugin storage was not a UUID, so it was given a new one: ${made}.`
      );
      return this.known(made);
    }
    /** Keeps the id, once read or written, for this load, and has Decaid's backups include it. */
    known(id) {
      this.id = id;
      void this.keepInBackups();
      return id;
    }
    /** Has Decaid's store API read the plugin's storage, so backups hold the id, asking again until it answers. */
    async keepInBackups() {
      if (await keepStorageInBackups() || this.stopped) return;
      this.backupRetry = setTimeout(() => {
        this.backupRetry = void 0;
        void this.keepInBackups();
      }, BACKUP_RETRY_MS);
    }
  };
  function newTabletId() {
    const hex2 = (digits) => {
      let text = "";
      for (let digit = 0; digit < digits; digit++) text += Math.floor(Math.random() * 16).toString(16);
      return text;
    };
    const variant = (8 + Math.floor(Math.random() * 4)).toString(16);
    return `${hex2(8)}-${hex2(4)}-4${hex2(3)}-${variant}${hex2(3)}-${hex2(12)}`;
  }

  // src/connection.ts
  var MIN_RECONNECT_MS = 1e3;
  var MAX_RECONNECT_MS = 6e4;
  var CONNECT_TIMEOUT_MS = 15e3;
  var MAX_TRANSPORTS = 8;
  var HARDWARE_CHECK_COOLDOWN_MS = 5e3;
  var YIELD_MS = 5 * 6e4;
  var SEND_FAILURE_GRACE_MS = 2e3;
  var FINAL_CLOSES = /* @__PURE__ */ new Map([
    [CLOSE_CODES.bad_token, "The server refused the token. Enter the token shown when the machine entry was created, or a newly issued one."],
    [CLOSE_CODES.plugin_too_old, "The server needs a newer version of this plugin. Update the plugin."],
    [CLOSE_CODES.decaid_too_old, "The server needs a newer version of Decaid. Update Decaid on this tablet."]
  ]);
  var YIELDING_CLOSES = /* @__PURE__ */ new Map([
    [
      CLOSE_CODES.replaced,
      `Another tablet connected with this Machine's token and took over. Connecting again in ${YIELD_MS / 1e3} s, unless that tablet is still connected then.`
    ],
    [CLOSE_CODES.machine_held, `Another tablet is still connected with this Machine's token. Trying again in ${YIELD_MS / 1e3} s.`]
  ]);
  var SyncConnection = class {
    constructor(host, settings, log) {
      __publicField(this, "host", host);
      __publicField(this, "settings", settings);
      __publicField(this, "log", log);
      /** The open handle, or undefined while disconnected. */
      __publicField(this, "handle");
      /** Sends every message on the open handle. */
      __publicField(this, "sender");
      /** Puts the open handle's chunked messages from the server back together. */
      __publicField(this, "chunks", new Reassembly());
      /** Bumped by every attempt and drop, so late results of an older one are ignored. */
      __publicField(this, "attempt", 0);
      __publicField(this, "connecting", false);
      __publicField(this, "stopped", false);
      __publicField(this, "welcomed", false);
      /** How long a welcomed connection may go without hearing from the server, from its `welcome`. */
      __publicField(this, "silenceMs", 0);
      __publicField(this, "reconnectDelayMs", MIN_RECONNECT_MS);
      /** Transports opening, open or closing, as Decaid counts them against MAX_TRANSPORTS. */
      __publicField(this, "transportsInUse", 0);
      __publicField(this, "timers", /* @__PURE__ */ new Map());
      /** The hardware the latest `hello` reported, null while no machine was connected. */
      __publicField(this, "sentHardware", null);
      /**
       * Set once the machine this connection's `hello` reported is seen gone:
       * no hardware read, or Decaid refusing a write of the shared settings as
       * no machine is connected. Decaid refuses those while it is gone, and the
       * server skips such a write until it changes or the tablet reconnects, so
       * once the same machine is back the plugin reconnects, and is written it
       * again.
       */
      __publicField(this, "machineAway", false);
      /** Hardware the server dismissed for this token; while set, the plugin does not connect. */
      __publicField(this, "dismissedHardware", null);
      /** Set once another tablet replaced this one, until a `yielding` hello is welcomed. */
      __publicField(this, "yielding", false);
      /** Decaid's plugin storage, where the tablet's id and the outbox's Workflow and machine state events are kept. */
      __publicField(this, "storage");
      /** Everything awaiting the server's acknowledgment, kept across reconnects, and its Workflow and machine state events across unloads. */
      __publicField(this, "outbox");
      __publicField(this, "shots");
      __publicField(this, "steams");
      __publicField(this, "machineEvents");
      __publicField(this, "collections");
      /** Carries out the Library writes the server asks for, one at a time, between reads of the lists it writes to. */
      __publicField(this, "writes");
      /** This tablet's id, read from Decaid's plugin storage before the first connection and sent in every `hello`. */
      __publicField(this, "tabletId");
      __publicField(this, "checkingHardware", false);
      __publicField(this, "hardwareCooldown", false);
      this.storage = new PluginStorage(host);
      this.outbox = new Outbox(
        log,
        {
          shot: (id, deliveryId) => this.shots.read(id, deliveryId),
          steam: (id, deliveryId) => this.steams.read(id, deliveryId)
        },
        new KeptDeliveries(this.storage, log, settings.token)
      );
      this.shots = new ShotCapture(this.outbox, log);
      this.steams = new SteamCapture(this.outbox, settings.pollSeconds * 1e3, log);
      this.machineEvents = new MachineEvents(this.outbox);
      const library = new LibraryAccess();
      this.collections = new CollectionCapture(this.outbox, library, settings.pollSeconds * 1e3);
      this.writes = new LibraryWrites(library, this.outbox, this.machineEvents, () => {
        if (this.sentHardware !== null) this.machineAway = true;
      });
      this.tabletId = new TabletId(this.storage, log);
    }
    /**
     * Reads back the outbox's deliveries kept by earlier loads, and connects,
     * from timers, so the caller (onLoad) returns at once.
     */
    start() {
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
    stateUpdate(payload) {
      if (this.stopped) return;
      this.machineEvents.stateUpdate(payload);
      this.checkHardwareSoon();
    }
    workflowUpdated(payload) {
      if (!this.stopped) this.machineEvents.workflowUpdated(payload);
    }
    shotEvent(type, payload) {
      this.shots.event(type, payload);
    }
    /** Decaid's answer to a command to its plugin storage. */
    storageEvent(name, payload) {
      this.storage.answered(name, payload);
    }
    stop() {
      this.stopped = true;
      this.outbox.stop();
      this.shots.stop();
      this.steams.stop();
      this.collections.stop();
      this.tabletId.stop();
      this.storage.stop();
      for (const id of this.timers.values()) clearTimeout(id);
      this.timers.clear();
      this.closeHandle();
    }
    /** Checks the machine's hardware, unless a check started within the cooldown. */
    checkHardwareSoon() {
      if (this.hardwareCooldown) return;
      this.hardwareCooldown = true;
      this.setTimer("hardwareCooldown", HARDWARE_CHECK_COOLDOWN_MS, () => {
        this.hardwareCooldown = false;
      });
      void this.checkHardware();
    }
    async connect() {
      if (this.stopped || this.connecting || this.handle !== void 0) return;
      this.connecting = true;
      const attempt = ++this.attempt;
      try {
        let tabletId;
        try {
          tabletId = await this.tabletId.read();
        } catch (error) {
          if (attempt === this.attempt) this.drop(describe(error));
          return;
        }
        if (this.stopped || attempt !== this.attempt) return;
        const identity = await readTabletIdentity();
        if (this.stopped || attempt !== this.attempt) return;
        if (identity.decaidVersion === null) {
          this.drop("could not read Decaid's version from its API");
          return;
        }
        if (this.transportsInUse >= MAX_TRANSPORTS) {
          this.drop(
            `${this.transportsInUse} earlier connection attempts are still waiting for the server to answer, and Decaid allows no more until one ends. Reloading the plugin releases them`
          );
          return;
        }
        this.setTimer(
          "connect",
          CONNECT_TIMEOUT_MS,
          () => this.drop(`the server did not answer within ${CONNECT_TIMEOUT_MS / 1e3} s`)
        );
        const handle = await this.openTransport();
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
          pluginVersion: "0.2.1",
          decaidVersion: identity.decaidVersion,
          tabletId,
          connectionId: identity.connectionId,
          machine: identity.machine,
          ...this.yielding ? { yielding: true } : {}
        });
      } catch (error) {
        if (attempt === this.attempt) this.drop(`could not connect to ${this.settings.syncUrl}: ${describe(error)}`);
      } finally {
        if (attempt === this.attempt) this.connecting = false;
      }
    }
    onTransportEvent(handle, event) {
      if (handle !== this.handle) return;
      switch (event.type) {
        case "data":
          if (event.dataType === "text") this.onFrame(handle, event.data);
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
              "The server refused this machine's hardware for this Machine's token. Not connecting until the machine reports other hardware, or another token is entered."
            );
            break;
          }
          const final = event.code === void 0 ? void 0 : FINAL_CLOSES.get(event.code);
          const yielding = event.code === void 0 ? void 0 : YIELDING_CLOSES.get(event.code);
          if (final) {
            this.log(final);
            this.stop();
          } else if (yielding) {
            this.yieldToAnotherTablet(yielding);
          } else {
            this.drop(`the server closed the connection${event.code === void 0 ? "" : ` (${event.code}${event.reason ? `: ${event.reason}` : ""})`}`);
          }
          break;
        }
      }
    }
    onFrame(handle, frame) {
      const decoded = decodeServerFrame(frame);
      if (!decoded.ok) {
        this.log(`Ignoring a message from the server: ${decoded.problem}`);
        return;
      }
      if (decoded.message.type !== "chunk") return this.onMessage(handle, decoded.message);
      const added = this.chunks.add(decoded.message, CHUNK_LIMITS);
      if (added.status === "invalid") return this.drop(`the server sent chunks that do not fit together: ${added.problem}`);
      if (added.status === "incomplete") return;
      const whole = decodeServerMessage(added.text);
      if (!whole.ok) return this.log(`Ignoring a message from the server: ${whole.problem}`);
      this.onMessage(handle, whole.message);
    }
    onMessage(handle, message) {
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
          this.machineEvents.welcome();
          this.outbox.welcome(async (delivery) => {
            try {
              await this.send(handle, delivery);
            } catch (error) {
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
          this.machineEvents.resend();
          this.collections.sendAll();
          break;
        case "write":
          void this.writes.apply(message);
          break;
        case "delete":
          void this.writes.remove(message);
          break;
        case "leaveOut":
          void this.writes.leaveOut(message);
          break;
        case "heartbeat":
          break;
        case "error": {
          this.log(`The server reported ${describeError(message.code)}: ${message.message}`);
          const yielding = YIELDING_CLOSES.get(CLOSE_CODES[message.code]);
          if (yielding) this.yieldToAnotherTablet(yielding);
          break;
        }
      }
    }
    scheduleHeartbeat(handle, intervalMs) {
      this.setTimer("heartbeat", intervalMs, () => {
        if (handle !== this.handle) return;
        this.send(handle, { type: "heartbeat" }).then(
          () => this.scheduleHeartbeat(handle, intervalMs),
          (error) => {
            this.sendFailed(handle, `could not send a heartbeat: ${describe(error)}`);
          }
        );
      });
    }
    /** Restarts the wait for the server's next message, dropping the connection if none comes in time. */
    awaitServer(handle) {
      this.setTimer("silence", this.silenceMs, () => {
        if (handle === this.handle) this.drop(`heard nothing from the server for ${this.silenceMs / 1e3} s`);
      });
    }
    /**
     * A send on the handle failed. Its transport's events, the server's last
     * messages among them, are handled first, and decide what happens next; if
     * none ends the connection in time, it is dropped for `reason`.
     */
    sendFailed(handle, reason) {
      if (handle !== this.handle) return;
      this.setTimer("sendFailed", SEND_FAILURE_GRACE_MS, () => {
        if (handle === this.handle) this.drop(reason);
      });
    }
    /** Sends on the handle, in chunks if the message is too large for a frame, unless the handle was dropped. */
    send(handle, message) {
      if (handle !== this.handle || !this.sender) return Promise.reject(new Error("The connection closed"));
      return this.sender.send(message);
    }
    /**
     * Reads the machine's hardware and reconnects if the current connection
     * reported other hardware, or none, or if it differs from hardware the
     * server dismissed.
     */
    async checkHardware() {
      if (this.stopped || this.checkingHardware) return;
      this.checkingHardware = true;
      try {
        const hardware = await readMachineHardware();
        if (this.stopped) return;
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
          this.sentHardware === null ? "The machine reports its hardware now. Reconnecting to tell the server." : "The machine reports different hardware. Reconnecting to tell the server."
        );
        this.reconnectNow();
      } finally {
        this.checkingHardware = false;
      }
    }
    scheduleHardwarePoll() {
      this.setTimer("hardwarePoll", this.settings.pollSeconds * 1e3, () => {
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
    yieldToAnotherTablet(notice) {
      this.yielding = true;
      this.abandon();
      this.log(notice);
      this.setTimer("reconnect", YIELD_MS, () => void this.connect());
    }
    /** Replaces the current connection, or ends a wait, with a new attempt at once. */
    reconnectNow() {
      this.abandon();
      this.reconnectDelayMs = MIN_RECONNECT_MS;
      this.setTimer("reconnect", 0, () => void this.connect());
    }
    /** Abandons the current connection or attempt, if any, without trying again. */
    abandon() {
      this.attempt++;
      this.connecting = false;
      this.clearTimer("reconnect");
      this.closeHandle();
    }
    /** Abandons the current connection or attempt, if any, and tries again after the backoff delay. */
    drop(reason) {
      this.abandon();
      if (this.stopped) return;
      const delay = this.reconnectDelayMs;
      this.reconnectDelayMs = Math.min(delay * 2, MAX_RECONNECT_MS);
      this.log(`Disconnected: ${reason}. Reconnecting in ${Math.round(delay / 1e3)} s.`);
      this.setTimer("reconnect", delay, () => void this.connect());
    }
    closeHandle() {
      const handle = this.handle;
      this.handle = void 0;
      this.welcomed = false;
      this.sender?.close();
      this.sender = void 0;
      this.outbox.disconnected();
      this.clearTimer("heartbeat");
      this.clearTimer("silence");
      this.clearTimer("connect");
      this.clearTimer("sendFailed");
      if (handle !== void 0) this.closeTransport(handle);
    }
    async openTransport() {
      this.transportsInUse++;
      try {
        return (await this.host.transport.open({ kind: "websocket", url: this.settings.syncUrl })).handle;
      } catch (error) {
        this.transportsInUse--;
        throw error;
      }
    }
    /** Closes a transport, which counts against the limit until Decaid has closed it. */
    closeTransport(handle) {
      const release = () => {
        this.transportsInUse--;
      };
      this.host.transport.close(handle).then(release, release);
    }
    setTimer(name, delay, callback) {
      this.clearTimer(name);
      this.timers.set(
        name,
        setTimeout(() => {
          this.timers.delete(name);
          callback();
        }, delay)
      );
    }
    clearTimer(name) {
      const id = this.timers.get(name);
      if (id !== void 0) clearTimeout(id);
      this.timers.delete(name);
    }
  };
  function describeError(code) {
    return code.replace(/_/g, " ");
  }
  function describe(error) {
    return error instanceof Error ? error.message : String(error);
  }

  // src/settings.ts
  var DEFAULT_POLL_SECONDS = 30;
  var MIN_POLL_SECONDS = 5;
  function readSettings(settings) {
    const problems = [];
    const serverUrl = typeof settings.ServerUrl === "string" ? settings.ServerUrl.trim() : "";
    const syncUrl = serverUrl ? syncUrlFor(serverUrl) : void 0;
    if (!serverUrl) problems.push("Server URL is not set");
    else if (!syncUrl) problems.push("Server URL must be the server's http:// or https:// address");
    const token = typeof settings.Token === "string" ? settings.Token.trim() : "";
    if (!token) problems.push("Token is not set");
    const poll = Number(settings.PollSeconds);
    const pollSeconds = settings.PollSeconds !== void 0 && Number.isFinite(poll) && poll > 0 ? Math.max(poll, MIN_POLL_SECONDS) : DEFAULT_POLL_SECONDS;
    if (problems.length > 0) return { ok: false, problems };
    return { ok: true, settings: { syncUrl, token, pollSeconds } };
  }
  function syncUrlFor(serverUrl) {
    const match = /^(https?):\/\/([^/?#@\s]+)(?:[/?#]\S*)?$/i.exec(serverUrl);
    if (!match) return void 0;
    const scheme = match[1].toLowerCase() === "https" ? "wss" : "ws";
    return `${scheme}://${match[2]}${SYNC_PATH}`;
  }

  // src/index.ts
  function createPlugin(host) {
    let connection;
    return {
      id: "decent-sync.reaplugin",
      version: "0.2.1",
      onLoad(settings) {
        host.log(`Decent Sync ${"0.2.1"} loaded (protocol ${PROTOCOL_VERSION})`);
        const read = readSettings(settings ?? {});
        if (!read.ok) {
          host.log(`Not connecting: ${read.problems.join("; ")}. Enter them in this plugin's settings.`);
          return;
        }
        connection = new SyncConnection(host, read.settings, (message) => host.log(message));
        connection.start();
      },
      onUnload() {
        connection?.stop();
        connection = void 0;
      },
      onEvent(event) {
        if (event?.name === "shotStored") connection?.shotEvent("shot", event.payload);
        if (event?.name === "shotUpdated") connection?.shotEvent("shotUpdated", event.payload);
        if (event?.name === "workflowUpdated") connection?.workflowUpdated(event.payload);
        if (event?.name === "stateUpdate") connection?.stateUpdate(event.payload);
        if (event?.name === "storageRead" || event?.name === "storageWrite") connection?.storageEvent(event.name, event.payload);
      }
    };
  }
  return __toCommonJS(index_exports);
})();
var createPlugin = __decentSync.createPlugin;
