import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { AdminApi, type CreatedMachine } from "./support/admin-api.js";
import {
  type DecaidApi,
  PluginStorage,
  SimulatedTablet,
  type SimulatedTabletOptions,
  derivedDe1Pro,
  derivedWorkflow,
  settingsFor,
} from "./support/simulated-tablet.js";
import { startTestServer, type TestServer } from "./support/test-server.js";

// Seam 1 for ticket #93: the built plugin in a simulated tablet, unloaded and
// loaded again on the same plugin storage, against a real server, with every
// assertion on what reached the server made through the REST API. Workflows
// and machine states are derived from the test tablet's (see the fixtures'
// README); serials are made up.

interface WorkflowEvent { id: string; observedAt: string; workflow: Record<string, unknown> }
interface StateEvent { id: string; state: string; substate: string; observedAt: string }
interface EventPage<T> { events: T[]; total: number }
interface Frame { type: string; id?: string; observedAt?: string; state?: string; substate?: string; workflow?: Record<string, unknown> }

/** The most Workflow and machine state deliveries the outbox keeps, and the most characters of them (kept-deliveries.ts). */
const MAX_KEPT = 2_000;
const MAX_KEPT_CHARACTERS = 2 * 1024 * 1024;
const MACHINE_EVENTS = new Set(["workflow", "machineState"]);
const machineEventsSent = (tablet: SimulatedTablet) => (tablet.sent as Frame[]).filter((frame) => MACHINE_EVENTS.has(frame.type));
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const KEPT_LOG = /^Sending \d+ Workflow and machine state events? kept from before the plugin last unloaded\.$/;
const DROPPED_LOG = /^Dropping the oldest Workflow and machine state events not yet sent: at most 2000 are kept, of at most 2 Mi characters\.$/;

describe("The durable outbox", () => {
  let server: TestServer;
  let api: AdminApi;
  const tablets: SimulatedTablet[] = [];
  const env = { SYNC_HELLO_TIMEOUT_SECONDS: "2", SYNC_HEARTBEAT_SECONDS: "1" };

  beforeAll(async () => {
    server = await startTestServer({ env });
    api = await AdminApi.setUp(server.url);
  }, 60_000);
  afterEach(async () => {
    await Promise.all(tablets.splice(0).map((tablet) => tablet.unload()));
  });
  afterAll(async () => {
    await server?.stop();
  });

  /** Loads the plugin on the tablet whose plugin storage this is, with the Machine's token and Decaid's API. */
  function load(machine: CreatedMachine, storage: PluginStorage, decaid: DecaidApi, options: Pick<SimulatedTabletOptions, "stallUpload"> = {}) {
    const tablet = SimulatedTablet.load({ settings: settingsFor(machine), storage, api: decaid, timeScale: 50, ...options });
    tablets.push(tablet);
    return tablet;
  }
  async function get<T>(path: string): Promise<T> {
    const response = await api.call("GET", path);
    expect(response.status).toBe(200);
    return response.json() as Promise<T>;
  }
  /** The Machine's Workflow events, or state events, oldest first: at most 100, from `offset` from the latest. */
  const workflowEvents = async (machine: CreatedMachine, offset = 0) =>
    get<EventPage<WorkflowEvent>>(`/machines/${machine.machine.id}/workflow-events?limit=100&offset=${offset}`);
  const stateEvents = async (machine: CreatedMachine, offset = 0) =>
    get<EventPage<StateEvent>>(`/machines/${machine.machine.id}/machine-state-events?limit=100&offset=${offset}`);
  const transitions = async (machine: CreatedMachine) =>
    (await stateEvents(machine)).events.map((event) => [event.state, event.substate]).reverse();

  /** Resolves once the server has acknowledged every Workflow and machine state delivery the plugin sent. */
  async function acknowledged(tablet: SimulatedTablet, timeout = 10_000) {
    await expect
      .poll(
        () => machineEventsSent(tablet).every((frame) => (tablet.received as Frame[]).some((reply) => reply.type === "ack" && reply.id === frame.id)),
        { timeout },
      )
      .toBe(true);
  }

  /**
   * A tablet that connected and had its Workflow acknowledged, as Decaid sent
   * it after loading the plugin and as the plugin sent it again on welcome,
   * then was cut off from the server.
   */
  async function offline(machine: CreatedMachine, storage: PluginStorage, decaid: DecaidApi) {
    const tablet = load(machine, storage, decaid);
    await expect.poll(() => machineEventsSent(tablet).length).toBe(2);
    await acknowledged(tablet);
    tablet.loseNetwork();
    await tablet.waitForLog(/^Disconnected: /);
    return tablet;
  }

  it("sends the Workflow changes and state transitions made while the server was unreachable after an unload and reload, once each, in order, with their observed times", async () => {
    const machine = await api.createMachine("Changes kept across a reload");
    const storage = new PluginStorage();
    const decaid = derivedDe1Pro({ serial: "93001" });
    const first = await offline(machine, storage, decaid);
    expect((await workflowEvents(machine)).total).toBe(1);

    const changes = [derivedWorkflow({ targetYield: 38 }), derivedWorkflow({ targetYield: 42 })];
    const made: Frame[] = [];
    const started = Date.now();
    // Apart, so their observed times differ.
    first.setWorkflow(changes[0]!);
    made.push({ type: "workflow", workflow: changes[0] });
    for (const substate of ["preinfusion", "pouring"]) {
      await pause(20);
      first.reportState("espresso", substate);
      made.push({ type: "machineState", state: "espresso", substate });
    }
    await pause(20);
    first.setWorkflow(changes[1]!);
    made.push({ type: "workflow", workflow: changes[1] });
    await pause(20);
    first.reportState("idle", "idle");
    made.push({ type: "machineState", state: "idle", substate: "idle" });
    const ended = Date.now();
    await first.unload();

    // Decaid sends the reloaded plugin its current Workflow, the latest change.
    const second = load(machine, storage, { ...decaid, "/workflow": changes[1] });
    await expect.poll(() => transitions(machine)).toEqual([["espresso", "preinfusion"], ["espresso", "pouring"], ["idle", "idle"]]);
    await expect.poll(async () => (await workflowEvents(machine)).total).toBe(3);
    await acknowledged(second);
    expect(second.logs).toContain("Sending 5 Workflow and machine state events kept from before the plugin last unloaded.");

    // Once each, in order, observed as they were made.
    const workflows = (await workflowEvents(machine)).events.reverse().slice(1);
    const states = (await stateEvents(machine)).events.reverse();
    const stored = [...workflows, ...states].sort((a, b) => Date.parse(a.observedAt) - Date.parse(b.observedAt));
    expect(stored.map((event) => ("workflow" in event ? { type: "workflow", workflow: event.workflow } : { type: "machineState", state: event.state, substate: event.substate }))).toEqual(made);
    for (const event of stored) {
      expect(Date.parse(event.observedAt)).toBeGreaterThanOrEqual(started);
      expect(Date.parse(event.observedAt)).toBeLessThanOrEqual(ended);
    }

    // The plugin sent each once, ahead of everything the reload queued, with the times it observed them.
    // The first load's delivery ids all start with its runtime's.
    const firstRuntime = machineEventsSent(first)[0]!.id!.replace(/-\d+$/, "-");
    const kept = machineEventsSent(second).filter((frame) => frame.id!.startsWith(firstRuntime));
    expect(kept.map(({ type, workflow, state, substate }) => (type === "workflow" ? { type, workflow } : { type, state, substate }))).toEqual(made);
    expect(kept.map((frame) => frame.observedAt)).toEqual(stored.map((event) => event.observedAt));
    expect(new Set(kept.map((frame) => frame.id)).size).toBe(kept.length);
    const delivered = (second.sent as Frame[]).filter((frame) => !["hello", "heartbeat", "chunk"].includes(frame.type));
    expect(delivered.slice(0, kept.length)).toEqual(kept);
  });

  it("does not send again after a reload, or keep in plugin storage, what the server acknowledged before the unload", async () => {
    const machine = await api.createMachine("Acknowledged before the unload");
    const storage = new PluginStorage();
    const decaid = derivedDe1Pro({ serial: "93002" });
    let stalled = false;
    const later = derivedWorkflow({ targetYield: 41 });
    // The later change never reaches the server, even if the plugin sends it once it gives up on keeping it.
    const isLater = (frame: unknown) => (frame as Frame).type === "workflow" && JSON.stringify((frame as Frame).workflow) === JSON.stringify(later);
    const first = load(machine, storage, decaid, { stallUpload: (frame) => isLater(frame) || (stalled && (frame as Frame).type === "machineState") });
    await expect.poll(() => machineEventsSent(first).length).toBe(2);
    const dialledIn = derivedWorkflow({ targetYield: 40 });
    first.setWorkflow(dialledIn);
    await expect.poll(async () => (await workflowEvents(machine)).total).toBe(2);
    await acknowledged(first);

    // A state change, sent once kept, and held on its way to the server.
    stalled = true;
    first.reportState("espresso", "pouring");
    await expect.poll(() => machineEventsSent(first).some((frame) => frame.type === "machineState")).toBe(true);
    const pouring = machineEventsSent(first).find((frame) => frame.type === "machineState")!;
    // Decaid stops answering, so the writes recording its acknowledgment wait behind the keeping of a later change, which
    // is unanswered; the plugin sends them only as it unloads.
    first.holdStorageAnswers();
    first.setWorkflow(later);
    stalled = false;
    first.resumeUpload();
    await expect.poll(() => (first.received as Frame[]).some((reply) => reply.type === "ack" && reply.id === pouring.id)).toBe(true);
    // Ends the connection, so the unload need not wait for the stalled frame.
    first.dropConnections();
    await first.unload();
    const acknowledgedIds = machineEventsSent(first).filter((frame) => !isLater(frame)).map((frame) => frame.id!);
    // Plugin storage holds none of them.
    const held = (storage.readThroughApi(undefined) as string[]).map((key) => String(storage.read(key)));
    expect(acknowledgedIds.filter((id) => held.some((value) => value.includes(`"${id}"`)))).toEqual([]);

    const reloaded = Date.now();
    const second = load(machine, storage, { ...decaid, "/workflow": later });
    // Anything kept is sent before the Workflow Decaid sends after loading the plugin, and again on welcome.
    await expect.poll(() => machineEventsSent(second).filter((frame) => Date.parse(frame.observedAt!) >= reloaded).length).toBe(2);
    await acknowledged(second);
    expect(second.logs).toContain("Sending 1 Workflow and machine state event kept from before the plugin last unloaded.");
    expect(machineEventsSent(second).filter((frame) => acknowledgedIds.includes(frame.id!))).toEqual([]);
    expect(machineEventsSent(second)[0]).toMatchObject({ type: "workflow", workflow: later });
    expect((await workflowEvents(machine)).total).toBe(3);
    expect(await transitions(machine)).toEqual([["espresso", "pouring"]]);
  });

  it("sends nothing extra after a reload with nothing kept", async () => {
    const machine = await api.createMachine("Nothing kept");
    const storage = new PluginStorage();
    const decaid = derivedDe1Pro({ serial: "93003" });
    const first = load(machine, storage, decaid);
    await expect.poll(() => machineEventsSent(first).length).toBe(2);
    await acknowledged(first);
    await first.unload();

    const reloaded = Date.now();
    const second = load(machine, storage, decaid);
    await expect.poll(() => machineEventsSent(second).length).toBe(2);
    await acknowledged(second);
    // As on the first load: the Workflow Decaid sends after loading the plugin, and again on welcome, both observed since.
    expect(machineEventsSent(second).map((frame) => frame.type)).toEqual(machineEventsSent(first).map((frame) => frame.type));
    expect(machineEventsSent(second).every((frame) => Date.parse(frame.observedAt!) >= reloaded)).toBe(true);
    expect(second.logs.filter((log) => KEPT_LOG.test(log))).toEqual([]);
    expect((await workflowEvents(machine)).total).toBe(1);
    expect((await stateEvents(machine)).total).toBe(0);
  });

  it("keeps what it wrote to plugin storage as it unloaded, though Decaid had not yet answered", async () => {
    const machine = await api.createMachine("Unloaded while writing");
    const storage = new PluginStorage();
    const decaid = derivedDe1Pro({ serial: "93004" });
    const first = await offline(machine, storage, decaid);
    // Decaid carries out each command as it arrives, but the plugin hears of none, so it sends the next only as it unloads.
    first.holdStorageAnswers();
    const dialledIn = derivedWorkflow({ targetYield: 37.5 });
    first.setWorkflow(dialledIn);
    first.reportState("espresso", "pouring");
    await first.unload();

    const second = load(machine, storage, { ...decaid, "/workflow": dialledIn });
    await expect.poll(() => transitions(machine)).toEqual([["espresso", "pouring"]]);
    await expect.poll(async () => (await workflowEvents(machine)).events[0]?.workflow).toEqual(dialledIn);
    await acknowledged(second);
    expect(second.logs).toContain("Sending 2 Workflow and machine state events kept from before the plugin last unloaded.");
    expect((await workflowEvents(machine)).total).toBe(2);
  });

  it("sends nothing kept under another token, after the token in the plugin's settings changed", async () => {
    const lab = await api.createMachine("Kept under the lab's token");
    const cafe = await api.createMachine("Loaded with the cafe's token");
    const storage = new PluginStorage();
    const decaid = derivedDe1Pro({ serial: "93007" });
    const first = await offline(lab, storage, decaid);
    const dialledIn = derivedWorkflow({ targetYield: 39 });
    first.setWorkflow(dialledIn);
    first.reportState("espresso", "pouring");
    await first.unload();

    // The tablet moved to the cafe's machine, and its token entered: changing a setting reloads the plugin with it.
    const second = load(cafe, storage, { ...derivedDe1Pro({ serial: "93010" }), "/workflow": dialledIn });
    await expect.poll(() => machineEventsSent(second).length).toBe(2);
    await acknowledged(second);
    expect(second.logs).toContain("Not sending the Workflow and machine state events kept from before the plugin last unloaded, at most 2: they were made under another token.");
    expect(machineEventsSent(second).map((frame) => frame.type)).toEqual(["workflow", "workflow"]);
    expect((await workflowEvents(cafe)).total).toBe(1);
    expect((await stateEvents(cafe)).total).toBe(0);
    expect((await workflowEvents(lab)).total).toBe(1);
    // Plugin storage no longer holds them.
    const held = (storage.readThroughApi(undefined) as string[]).map((key) => String(storage.read(key)));
    expect(held.some((value) => value.includes('"workflow"') || value.includes('"machineState"'))).toBe(false);
  });

  it("waits for Decaid to read back what was kept, sending nothing before it, so nothing is sent out of order", async () => {
    const machine = await api.createMachine("Read back after failing");
    const storage = new PluginStorage();
    const decaid = derivedDe1Pro({ serial: "93008" });
    const first = await offline(machine, storage, decaid);
    first.reportState("espresso", "preinfusion");
    first.reportState("espresso", "pouring");
    await first.unload();
    // Decaid fails two reads of the key holding the first kept, so two attempts to read them back fail.
    const key = (storage.readThroughApi(undefined) as string[]).find((name) => String(storage.read(name)).includes('"preinfusion"'))!;
    storage.failNextReads(2, key);

    const second = load(machine, storage, decaid);
    second.reportState("idle", "idle");
    await expect.poll(() => transitions(machine)).toEqual([["espresso", "preinfusion"], ["espresso", "pouring"], ["idle", "idle"]]);
    await acknowledged(second);
    expect(second.logs.filter((log) => log.startsWith("Could not read the deliveries kept in Decaid's plugin storage, trying again in "))).toHaveLength(2);
    expect(second.logs).toContain("Sending 2 Workflow and machine state events kept from before the plugin last unloaded.");
  });

  it("holds no more than it keeps while it reads back what was kept", { timeout: 60_000 }, async () => {
    const machine = await api.createMachine("Held while reading back");
    const storage = new PluginStorage();
    // Decaid fails every read of what was kept until what happens meanwhile has passed the limits.
    storage.failNextReads(Number.MAX_SAFE_INTEGER, "outbox");
    const tablet = load(machine, storage, derivedDe1Pro({ serial: "93009" }));
    const made = MAX_KEPT + 1;
    const substates = ["preinfusion", "pouring"];
    for (let index = 0; index < made; index++) tablet.reportState("espresso", substates[index % 2]!);
    await tablet.waitForLog(DROPPED_LOG);
    storage.failNextReads(0);
    // Held with the Workflow Decaid sent after loading the plugin, and the one sent again on welcome, the oldest of them dropped.
    const stored = MAX_KEPT - 1;
    await expect.poll(async () => (await stateEvents(machine)).total, { timeout: 45_000 }).toBe(stored);
    await expect.poll(() => machineEventsSent(tablet).length, { timeout: 10_000 }).toBe(stored + 1);
    await acknowledged(tablet);
    const oldest = (await stateEvents(machine, stored - 1)).events[0]!;
    const newest = (await stateEvents(machine)).events[0]!;
    expect([oldest.substate, newest.substate]).toEqual([substates[(made - stored) % 2], substates[(made - 1) % 2]]);
  });

  it("sends what it could not keep once Decaid stops answering, without waiting on Decaid again until it answers", async () => {
    const machine = await api.createMachine("Decaid not answering");
    const storage = new PluginStorage();
    const tablet = load(machine, storage, derivedDe1Pro({ serial: "93011" }));
    await expect.poll(() => machineEventsSent(tablet).length).toBe(2);
    await acknowledged(tablet);

    // Decaid carries out the plugin's storage commands but answers none, as one whose writes fail.
    const release = tablet.holdStorageAnswers();
    const dialledIn = derivedWorkflow({ targetYield: 44 });
    tablet.setWorkflow(dialledIn);
    await expect.poll(async () => (await workflowEvents(machine)).events[0]?.workflow).toEqual(dialledIn);
    // The next are sent without waiting on Decaid.
    const shot: [string, string][] = [["espresso", "preinfusion"], ["espresso", "pouring"], ["idle", "idle"]];
    for (const [state, substate] of shot) tablet.reportState(state, substate);
    await expect.poll(() => transitions(machine)).toEqual(shot);
    await acknowledged(tablet);
    expect(tablet.logs.filter((log) => log.startsWith("Could not keep"))).toEqual([
      "Could not keep a delivery, so it is sent without being kept in Decaid's plugin storage: Decaid's plugin storage did not answer the write of a delivery to keep within 10 s.",
    ]);

    // Once Decaid answers again, deliveries wait for it as before: one it then leaves unanswered fails again.
    release();
    await new Promise((resolve) => setImmediate(resolve));
    const releaseAgain = tablet.holdStorageAnswers();
    tablet.reportState("sleeping", "idle");
    await tablet.waitForLogs(/^Could not keep a delivery/, 2);
    releaseAgain();
    await expect.poll(async () => (await transitions(machine)).at(-1)).toEqual(["sleeping", "idle"]);
    await acknowledged(tablet);
  });

  it(`keeps at most the newest ${MAX_KEPT} while the server is unreachable, in plugin storage and across a reload`, { timeout: 120_000 }, async () => {
    const machine = await api.createMachine("Most kept");
    const storage = new PluginStorage();
    const decaid = derivedDe1Pro({ serial: "93005" });
    const first = await offline(machine, storage, decaid);
    // Each a transition from the one before. Alternating, the oldest kept and the newest differ from the first and last made.
    const made = MAX_KEPT + 101;
    const substates = ["preinfusion", "pouring"];
    for (let index = 0; index < made; index++) first.reportState("espresso", substates[index % 2]!);
    await first.waitForLog(DROPPED_LOG);
    expect(first.logs.filter((log) => DROPPED_LOG.test(log))).toHaveLength(1);
    await first.unload();
    // The deliveries kept, their sequence numbers and the tablet's id.
    expect((storage.readThroughApi(undefined) as string[]).length).toBe(MAX_KEPT + 2);

    // The Workflow Decaid sends after loading the plugin is kept after those read back, dropping the oldest of them,
    // and so is the one sent again on welcome, dropping the next. The server stays unreachable until they are read
    // back, so the welcome comes after.
    const second = load(machine, storage, decaid);
    second.loseNetwork();
    await second.waitForLog(new RegExp(`^Sending ${MAX_KEPT - 1} Workflow and machine state events kept from before the plugin last unloaded\\.$`));
    second.restoreNetwork();
    const stored = MAX_KEPT - 2;
    await expect.poll(async () => (await stateEvents(machine)).total, { timeout: 60_000 }).toBe(stored);
    await expect.poll(() => machineEventsSent(second).length, { timeout: 10_000 }).toBe(stored + 2);
    await acknowledged(second);
    const oldest = (await stateEvents(machine, stored - 1)).events[0]!;
    const newest = (await stateEvents(machine)).events[0]!;
    expect([oldest.substate, newest.substate]).toEqual([substates[(made - stored) % 2], substates[(made - 1) % 2]]);
    expect(machineEventsSent(second).slice(stored).map((frame) => frame.type)).toEqual(["workflow", "workflow"]);
  });

  it(`keeps at most ${MAX_KEPT_CHARACTERS / (1024 * 1024)} Mi characters, the newest, while the server is unreachable, holding no more in memory`, { timeout: 60_000 }, async () => {
    const machine = await api.createMachine("Most characters kept");
    const storage = new PluginStorage();
    const decaid = derivedDe1Pro({ serial: "93006" });
    const first = await offline(machine, storage, decaid);
    // Fewer than MAX_KEPT, but more characters than are kept.
    const changes = Array.from({ length: 800 }, (_, index) => derivedWorkflow({ targetYield: 30 + index / 10 }));
    const size = JSON.stringify({ type: "workflow", id: "x".repeat(40), observedAt: new Date().toISOString(), workflow: changes[0] }).length;
    expect(changes.length * size).toBeGreaterThan(MAX_KEPT_CHARACTERS);
    const before = Date.now();
    for (const change of changes) first.setWorkflow(change);
    const made = Date.now();
    await first.waitForLog(DROPPED_LOG);

    // Back online without a reload: the outbox holds no more than plugin storage keeps. The latest Workflow, sent
    // again on welcome, is queued behind them.
    first.restoreNetwork();
    await expect.poll(() => machineEventsSent(first).some((frame) => Date.parse(frame.observedAt!) > made), { timeout: 30_000 }).toBe(true);
    await acknowledged(first);
    const kept = machineEventsSent(first).filter((frame) => Date.parse(frame.observedAt!) >= before && Date.parse(frame.observedAt!) <= made);
    expect(new Set(kept.map((frame) => frame.id)).size).toBe(kept.length);
    expect(kept.length).toBeLessThan(changes.length);
    expect(kept.map((frame) => frame.workflow)).toEqual(changes.slice(changes.length - kept.length));
    const characters = kept.reduce((total, frame) => total + JSON.stringify(frame).length, 0);
    expect(characters).toBeLessThanOrEqual(MAX_KEPT_CHARACTERS);
    // Nearly all of them: each is kept with its sequence number.
    expect(characters).toBeGreaterThan(0.98 * MAX_KEPT_CHARACTERS);
    // Each stored once: the Workflow sent on welcome is the newest kept, and unchanged.
    await expect.poll(async () => (await workflowEvents(machine)).total).toBe(1 + kept.length);
  });
});
