import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { AdminApi, type CreatedMachine, type MachineView } from "./support/admin-api.js";
import { waitForLockWaits } from "./support/lock-waits.js";
import {
  PluginStorage,
  RawConnection,
  SimulatedTablet,
  type SimulatedTabletOptions,
  derivedDe1Pro,
  helloWith,
  settingsFor,
} from "./support/simulated-tablet.js";
import { runAsSteps } from "./support/steps.js";
import { type TestServer, startTestServer } from "./support/test-server.js";

// Seam 1 for ticket #79: each tablet's id, which the built plugin keeps in
// Decaid's plugin storage, and the tablets the server records for each
// Machine, through simulated tablets and raw frames against two server
// instances on one database. Assertions go through the REST API. Serials are
// made up, from 13001.

const HEARTBEAT_SECONDS = 0.5;
const env = { SYNC_HELLO_TIMEOUT_SECONDS: "1", SYNC_HEARTBEAT_SECONDS: String(HEARTBEAT_SECONDS) };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const de1Pro = (serial: string) => ({ model: "DE1Pro", serial, firmware: "1333" });

describe("Tablets", { timeout: 20_000 }, () => {
  let server: TestServer;
  let other: TestServer;
  /** The Admin on the first instance, and on the second. */
  let api: AdminApi;
  let otherApi: AdminApi;
  const tablets: SimulatedTablet[] = [];
  const connections: RawConnection[] = [];

  const loadTablet = (options: SimulatedTabletOptions) => {
    const tablet = SimulatedTablet.load(options);
    tablets.push(tablet);
    return tablet;
  };

  /** The tablet ids in the hellos the plugin sent, in order. */
  const helloTabletIds = (tablet: SimulatedTablet) =>
    tablet.sent.filter((frame) => (frame as { type?: unknown }).type === "hello").map((hello) => (hello as { tabletId?: unknown }).tabletId);

  /** Opens a raw connection to an instance and sends a hello, resolving once the server welcomes it. */
  const connect = async (hello: Record<string, unknown>, instance = server) => {
    const raw = await RawConnection.welcomed(instance.url, hello, HEARTBEAT_SECONDS * 500);
    connections.push(raw);
    return raw;
  };

  const machine = async (id: string): Promise<MachineView> =>
    ((await (await api.call("GET", `/machines/${id}`)).json()) as { machine: MachineView }).machine;

  /** The ids of a Machine's current tablet and its earlier ones. */
  const tabletIds = (viewed: MachineView) => ({ current: viewed.tablet?.id ?? null, earlier: viewed.earlierTablets.map((tablet) => tablet.id) });

  beforeAll(async () => {
    server = await startTestServer({ env });
    other = await startTestServer({ env, sharing: server });
    api = await AdminApi.setUp(server.url);
    otherApi = api.at(other.url);
  }, 60_000);
  afterEach(async () => {
    await Promise.all(connections.splice(0).map((raw) => raw.terminate()));
  });
  afterAll(async () => {
    await Promise.all(tablets.map((tablet) => tablet.unload()));
    await other?.stop();
    await server?.stop();
  });

  describe("a simulated tablet's id", () => {
    runAsSteps();

    let lab: CreatedMachine;
    /** The test tablet's plugin storage, kept across the plugin's loads. */
    const storage = new PluginStorage();
    let first: string;
    let firstSeenAt: string;
    let backup: ReadonlyMap<string, unknown>;
    let reset: string;
    const labApi = () => derivedDe1Pro({ serial: "13001" });

    it("is made on the first load, kept in plugin storage and sent in the hello", async () => {
      lab = await api.createMachine("Lab");
      expect(storage.read("tabletId")).toBeNull();
      const tablet = loadTablet({ settings: settingsFor(lab), storage, api: labApi() });
      const online = await api.waitForMachine("Lab", (machine) => machine.online);

      first = storage.read("tabletId") as string;
      expect(first).toMatch(UUID);
      expect(helloTabletIds(tablet)).toEqual([first]);
      expect(tablet.logs).toContain(`This tablet had no id in Decaid's plugin storage, so it was given one: ${first}.`);
      expect(online.tablet).toEqual({ id: first, firstSeenAt: expect.any(String), lastSeenAt: expect.any(String) });
      expect(online.earlierTablets).toEqual([]);
      firstSeenAt = online.tablet!.firstSeenAt;
      await tablet.unload();
      await api.waitForMachine("Lab", (machine) => !machine.online);
    });

    it("is kept when the plugin loads again, and in a Decaid backup", async () => {
      const tablet = loadTablet({ settings: settingsFor(lab), storage, api: labApi() });
      await tablet.waitForLog(/^Connected to /);
      expect(helloTabletIds(tablet)).toEqual([first]);
      expect(tablet.logs.join("\n")).not.toContain("was given");
      // Decaid's backups hold it only once its store API has read the plugin's storage, which the plugin has it do.
      await expect.poll(() => storage.save().get("tabletId")).toBe(first);

      const reloaded = await api.waitForMachine("Lab", (machine) => machine.online && machine.tablet!.lastSeenAt > firstSeenAt);
      expect(tabletIds(reloaded)).toEqual({ current: first, earlier: [] });
      expect(reloaded.tablet!.firstSeenAt).toBe(firstSeenAt);
      await tablet.unload();
      await api.waitForMachine("Lab", (machine) => !machine.online);
    });

    it("is kept when the plugin's settings change, which reloads it with them", async () => {
      const tablet = loadTablet({ settings: { ...settingsFor(lab), PollSeconds: 10 }, storage, api: labApi() });
      await tablet.waitForLog(/^Connected to /);
      expect(helloTabletIds(tablet)).toEqual([first]);
      expect(tablet.logs.join("\n")).not.toContain("was given");
      expect(tabletIds(await api.waitForMachine("Lab", (machine) => machine.online))).toEqual({ current: first, earlier: [] });
      await tablet.unload();
      await api.waitForMachine("Lab", (machine) => !machine.online);
    });

    it("is new once the tablet's Decaid data is reset, and the Machine lists a new tablet", async () => {
      backup = storage.save();
      storage.clear();
      const tablet = loadTablet({ settings: settingsFor(lab), storage, api: labApi() });
      await tablet.waitForLog(/^Connected to /);

      reset = storage.read("tabletId") as string;
      expect(reset).toMatch(UUID);
      expect(reset).not.toBe(first);
      expect(helloTabletIds(tablet)).toEqual([reset]);
      const listed = await api.waitForMachine("Lab", (machine) => machine.online && machine.tablet?.id === reset);
      expect(tabletIds(listed)).toEqual({ current: reset, earlier: [first] });
      expect(listed.earlierTablets[0]!.firstSeenAt).toBe(firstSeenAt);
      await tablet.unload();
      await api.waitForMachine("Lab", (machine) => !machine.online);
    });

    it("comes back when a Decaid backup holding it is restored", async () => {
      storage.restore(backup);
      const tablet = loadTablet({ settings: settingsFor(lab), storage, api: labApi() });
      await tablet.waitForLog(/^Connected to /);

      expect(helloTabletIds(tablet)).toEqual([first]);
      const restored = await api.waitForMachine("Lab", (machine) => machine.online && machine.tablet?.id === first);
      expect(tabletIds(restored)).toEqual({ current: first, earlier: [reset] });
      expect(restored.tablet!.firstSeenAt).toBe(firstSeenAt);
      await tablet.unload();
      await api.waitForMachine("Lab", (machine) => !machine.online);
    });

    it("is read again, not made anew, when a read of plugin storage fails", async () => {
      storage.failNextReads(1, "tabletId");
      // 50 times faster: Decaid's unanswered read is given up on after 200 ms, and retried 20 ms later.
      const tablet = loadTablet({ settings: settingsFor(lab), storage, api: labApi(), timeScale: 50 });
      await tablet.waitForLog(/^Connected to /);

      expect(tablet.logs.filter((log) => log.startsWith("Disconnected"))).toEqual([
        "Disconnected: Decaid's plugin storage did not answer a read of this tablet's id within 10 s. Reconnecting in 1 s.",
      ]);
      expect(helloTabletIds(tablet)).toEqual([first]);
      expect(storage.read("tabletId")).toBe(first);
      expect(tabletIds(await api.waitForMachine("Lab", (machine) => machine.online))).toEqual({ current: first, earlier: [reset] });
      await tablet.unload();
      await api.waitForMachine("Lab", (machine) => !machine.online);
    });

    it("is replaced, and kept, when plugin storage holds something else under its key", async () => {
      storage.write("tabletId", "not a tablet id");
      const tablet = loadTablet({ settings: settingsFor(lab), storage, api: labApi() });
      await tablet.waitForLog(/^Connected to /);

      const replaced = storage.read("tabletId") as string;
      expect(replaced).toMatch(UUID);
      expect(tablet.logs).toContain(`This tablet's id in Decaid's plugin storage was not a UUID, so it was given a new one: ${replaced}.`);
      expect(helloTabletIds(tablet)).toEqual([replaced]);
      expect(tabletIds(await api.waitForMachine("Lab", (machine) => machine.tablet?.id === replaced))).toEqual({
        current: replaced,
        earlier: [first, reset],
      });
      await tablet.unload();
    });
  });

  it("keeps asking Decaid's store API to read the plugin's storage until it does, so backups hold the tablet's id", async () => {
    const created = await api.createMachine("Backed up");
    const storage = new PluginStorage();
    // 50 times faster: the plugin asks again 600 ms after each read that fails.
    const tablet = loadTablet({ settings: settingsFor(created), storage, api: derivedDe1Pro({ serial: "13601" }), timeScale: 50 });
    tablet.failNextApiReads("/store/decent-sync.reaplugin", 2);
    await tablet.waitForLog(/^Connected to /);

    const tabletId = storage.read("tabletId");
    expect(tabletId).toMatch(UUID);
    await expect.poll(() => storage.save().get("tabletId"), { timeout: 10_000 }).toBe(tabletId);
    // Two reads failed, and the third, answered, was the last.
    expect(tablet.requests.filter((route) => route === "/store/decent-sync.reaplugin")).toHaveLength(3);
  });

  it("keeps the current tablet's last-seen time current with heartbeats, on whichever instance", async () => {
    const created = await api.createMachine("Heartbeats");
    const tabletId = randomUUID();
    await connect(helloWith(created.token, { tabletId, machine: de1Pro("13101") }), other);
    const connected = (await machine(created.machine.id)).tablet!;

    const later = await api.waitForMachine("Heartbeats", (viewed) => Date.parse(viewed.tablet!.lastSeenAt) > Date.parse(connected.firstSeenAt) + HEARTBEAT_SECONDS * 1000);
    expect(later.tablet).toEqual({ id: tabletId, firstSeenAt: connected.firstSeenAt, lastSeenAt: expect.any(String) });
  });

  it("keeps the latest connection's tablet current while an earlier connection's heartbeats continue", async () => {
    const roastery = await api.createMachine("Two tablets");
    const other = await api.createMachine("Other token");
    const earlier = randomUUID();
    const later = randomUUID();
    await (await connect(helloWith(other.token, { machine: de1Pro("13802") }))).close();
    // The Machine's own tablet stays connected, sending heartbeats.
    await connect(helloWith(roastery.token, { tabletId: earlier, machine: de1Pro("13801") }));
    // Another tablet reports the Machine's hardware with another Machine's token, after it, and leaves.
    await (await connect(helloWith(other.token, { tabletId: later, machine: de1Pro("13801") }))).close();

    const record = (viewed: MachineView, id: string) =>
      [...(viewed.tablet ? [viewed.tablet] : []), ...viewed.earlierTablets].find((tablet) => tablet.id === id);
    // Once the earlier tablet has been heard from after the later one last was, the later one is still current.
    const heard = await api.waitForMachine("Two tablets", (viewed) => {
      const [first, second] = [record(viewed, earlier), record(viewed, later)];
      return first !== undefined && second !== undefined && Date.parse(first.lastSeenAt) > Date.parse(second.lastSeenAt);
    });
    expect(tabletIds(heard)).toEqual({ current: later, earlier: [earlier] });
  });

  it("records a tablet once, whichever instance its connections go through", async () => {
    const created = await api.createMachine("Two instances");
    const tabletId = randomUUID();
    const onFirst = await connect(helloWith(created.token, { tabletId, machine: de1Pro("13201") }));
    const before = (await machine(created.machine.id)).tablet!;
    await onFirst.close();
    await api.waitForMachine("Two instances", (viewed) => !viewed.online);

    await connect(helloWith(created.token, { tabletId, machine: de1Pro("13201") }), other);
    const after = await otherApi.waitForMachine("Two instances", (viewed) => viewed.online);
    expect(after.tablet).toEqual({ id: tabletId, firstSeenAt: before.firstSeenAt, lastSeenAt: expect.any(String) });
    expect(Date.parse(after.tablet!.lastSeenAt)).toBeGreaterThan(Date.parse(before.lastSeenAt));
    expect(after.earlierTablets).toEqual([]);
    expect(await api.machineNamed("Two instances")).toMatchObject({ tablet: { id: tabletId, firstSeenAt: before.firstSeenAt }, earlierTablets: [] });
  });

  it("records a tablet moved to another Machine against that Machine too", async () => {
    const roastery = await api.createMachine("Roastery");
    const uptown = await api.createMachine("Uptown");
    const tabletId = randomUUID();
    await (await connect(helloWith(roastery.token, { tabletId, machine: de1Pro("13301") }))).close();
    // Moved to Uptown's machine, and given its token.
    await connect(helloWith(uptown.token, { tabletId, machine: de1Pro("13302") }));

    expect(tabletIds(await machine(roastery.machine.id))).toEqual({ current: tabletId, earlier: [] });
    expect(tabletIds(await machine(uptown.machine.id))).toEqual({ current: tabletId, earlier: [] });
  });

  describe("a mismatched connection's tablet", () => {
    runAsSteps();

    let home: CreatedMachine;
    const homeTablet = randomUUID();
    const movedTablet = randomUUID();
    let cafeId: string;

    it("is recorded against the Pending Machine holding the hardware it reports, not its token's Machine", async () => {
      home = await api.createMachine("Home");
      await (await connect(helloWith(home.token, { tabletId: homeTablet, machine: de1Pro("13401") }))).close();
      // Home's token, on a tablet attached to other hardware.
      await connect(helloWith(home.token, { tabletId: movedTablet, machine: de1Pro("13402") }));

      expect(await machine(home.machine.id)).toMatchObject({ identification: "mismatch", tablet: { id: homeTablet }, earlierTablets: [] });
    });

    it("goes to the Machine created for that hardware, with what was held for it", async () => {
      const pending = (await api.pendingMachines()).find((candidate) => candidate.serial === "13402")!;
      const response = await api.call("POST", `/pending-machines/${pending.id}/machine`, { name: "Cafe" });
      expect(response.status).toBe(201);
      cafeId = (await api.issued(response)).machine.id;

      expect(tabletIds(await machine(cafeId))).toEqual({ current: movedTablet, earlier: [] });
      expect(tabletIds(await machine(home.machine.id))).toEqual({ current: homeTablet, earlier: [] });
    });

    it("is recorded against the Machine that has the hardware it reports", async () => {
      const another = randomUUID();
      await connect(helloWith(home.token, { tabletId: another, machine: de1Pro("13402") }));

      expect(tabletIds(await machine(cafeId))).toEqual({ current: another, earlier: [movedTablet] });
      expect(tabletIds(await machine(home.machine.id))).toEqual({ current: homeTablet, earlier: [] });
    });
  });

  it("joins the records of one tablet when a Machine binds hardware a Pending Machine held, keeping the earliest first sighting", async () => {
    const owner = await api.createMachine("Lent token");
    const unbound = await api.createMachine("Unbound");
    const tabletId = randomUUID();
    await (await connect(helloWith(owner.token, { machine: de1Pro("13501") }))).close();
    // The tablet first reports hardware 13502 with another Machine's token, which a Pending Machine then holds.
    await (await connect(helloWith(owner.token, { tabletId, machine: de1Pro("13502") }))).close();
    const pendingSeenAt = Date.parse((await api.pendingMachines()).find((candidate) => candidate.serial === "13502")!.lastSeenAt!);
    // Then with its own token while its machine is off, and then on, binding the hardware.
    await (await connect(helloWith(unbound.token, { tabletId, machine: null }))).close();
    const ownFirstSeenAt = Date.parse((await machine(unbound.machine.id)).tablet!.firstSeenAt);
    await connect(helloWith(unbound.token, { tabletId, machine: de1Pro("13502") }));

    const bound = await machine(unbound.machine.id);
    expect(bound).toMatchObject({ identification: "identified", serial: "13502", tablet: { id: tabletId }, earlierTablets: [] });
    // First seen when the Pending Machine was, by the same transaction's clock, which PostgreSQL rounds to the
    // millisecond where the Pending Machine's time was truncated.
    const firstSeenAt = Date.parse(bound.tablet!.firstSeenAt);
    expect(firstSeenAt).toBeLessThan(ownFirstSeenAt);
    expect(Math.abs(firstSeenAt - pendingSeenAt)).toBeLessThanOrEqual(1);
  });

  it("keeps a mismatched connection's tablet seen once a Machine takes its hardware over and joins the two records of it", async () => {
    const lender = await api.createMachine("Lends its token");
    const unidentified = await api.createMachine("Unidentified until entered");
    const tabletId = randomUUID();
    await (await connect(helloWith(lender.token, { machine: de1Pro("13701") }))).close();
    // The tablet first connects as an Unidentified Machine, whose machine reports no serial.
    await (await connect(helloWith(unidentified.token, { tabletId, machine: de1Pro("0") }))).close();
    // Then it stays connected with another Machine's token while its machine reports a serial no Machine has.
    await connect(helloWith(lender.token, { tabletId, machine: de1Pro("13702") }));
    // An Admin enters that serial for the Unidentified Machine, which takes over the Pending Machine's record of the tablet.
    expect((await api.call("PUT", `/machines/${unidentified.machine.id}/hardware`, { model: "DE1Pro", serial: "13702" })).status).toBe(200);
    const joined = (await machine(unidentified.machine.id)).tablet!;
    expect(joined.id).toBe(tabletId);

    // The connection's heartbeats keep the joined record seen.
    const later = await api.waitForMachine(
      "Unidentified until entered",
      (viewed) => Date.parse(viewed.tablet!.lastSeenAt) > Date.parse(joined.lastSeenAt),
    );
    expect(tabletIds(later)).toEqual({ current: tabletId, earlier: [] });
  });

  it("makes the tablet of the hello accepted last current, though another hello began after it", async () => {
    const created = await api.createMachine("Accepted last");
    const accepted = randomUUID();
    const replaced = randomUUID();
    const database = await server.connectDatabase();
    try {
      // The test holds the hardware's lock, which a hello reporting it takes first.
      await database.query("BEGIN");
      await database.query("SELECT pg_advisory_xact_lock(4000002, hashtext($1::text || '/' || $2::text))", ["DE1Pro", "14101"]);
      const waiting = await RawConnection.open(server.url);
      connections.push(waiting);
      waiting.send(helloWith(created.token, { tabletId: accepted, machine: de1Pro("14101") }));
      await waitForLockWaits(server, { advisory: true });
      // A hello reporting no hardware takes no such lock, and is accepted meanwhile.
      await connect(helloWith(created.token, { tabletId: replaced, machine: null }));
      await database.query("COMMIT");
      expect(await waiting.message(0)).toMatchObject({ type: "welcome" });
    } finally {
      await database.end();
    }
    expect(tabletIds(await machine(created.machine.id))).toEqual({ current: accepted, earlier: [replaced] });
  });

  it("makes the tablet of the hello accepted last current, whatever tokens the hellos use", async () => {
    const owner = await api.createMachine("Owns the hardware");
    const lender = await api.createMachine("Reports another's hardware");
    const reported = randomUUID();
    const own = randomUUID();
    await (await connect(helloWith(owner.token, { tabletId: own, machine: de1Pro("14301") }))).close();
    await (await connect(helloWith(lender.token, { machine: de1Pro("14302") }))).close();
    // A tablet reporting the owner's hardware with the other Machine's token is recorded against the owner.
    await (await connect(helloWith(lender.token, { tabletId: reported, machine: de1Pro("14301") }))).close();

    const database = await server.connectDatabase();
    try {
      // The test holds that record, as a heartbeat updating it would, so the tablet's next hello waits to record it.
      await database.query("BEGIN");
      await database.query("SELECT 1 FROM machine_tablets WHERE tablet_id = $1 FOR UPDATE", [reported]);
      const mismatched = await RawConnection.open(server.url);
      connections.push(mismatched);
      mismatched.send(helloWith(lender.token, { tabletId: reported, machine: de1Pro("14301") }));
      await waitForLockWaits(server);
      // The owner's own tablet connects without hardware meanwhile, and is accepted first.
      await connect(helloWith(owner.token, { tabletId: own, machine: null }));
      await database.query("COMMIT");
      expect(await mismatched.message(0)).toMatchObject({ type: "welcome" });
    } finally {
      await database.end();
    }
    // Accepted last, the tablet that waited is current.
    expect(tabletIds(await machine(owner.machine.id))).toEqual({ current: reported, earlier: [own] });
  });

  it("keeps the tablet of the hello accepted last current when adoption joins two holders' tablets", async () => {
    const lender = await api.createMachine("Lends its token to a pending tablet");
    const unidentified = await api.createMachine("Adopts the pending hardware");
    const pendingTablet = randomUUID();
    const ownTablet = randomUUID();
    await (await connect(helloWith(lender.token, { machine: de1Pro("14401") }))).close();
    // With the other Machine's token, a tablet reports hardware no Machine has, so a Pending Machine holds its record.
    await (await connect(helloWith(lender.token, { tabletId: pendingTablet, machine: de1Pro("14402") }))).close();

    const database = await server.connectDatabase();
    try {
      // The test holds that record, so the tablet's next hello waits to record it.
      await database.query("BEGIN");
      await database.query("SELECT 1 FROM machine_tablets WHERE tablet_id = $1 FOR UPDATE", [pendingTablet]);
      const mismatched = await RawConnection.open(server.url);
      connections.push(mismatched);
      mismatched.send(helloWith(lender.token, { tabletId: pendingTablet, machine: de1Pro("14402") }));
      await waitForLockWaits(server);
      // Another Machine's own tablet connects meanwhile, its machine reporting no serial, and is accepted first.
      await connect(helloWith(unidentified.token, { tabletId: ownTablet, machine: de1Pro("0") }));
      await database.query("COMMIT");
      expect(await mismatched.message(0)).toMatchObject({ type: "welcome" });
    } finally {
      await database.end();
    }
    // An Admin enters the pending hardware for that Machine, which takes over the Pending Machine's tablet.
    expect((await api.call("PUT", `/machines/${unidentified.machine.id}/hardware`, { model: "DE1Pro", serial: "14402" })).status).toBe(200);
    expect(tabletIds(await machine(unidentified.machine.id))).toEqual({ current: pendingTablet, earlier: [ownTablet] });
  });

  it("keeps the sighting of a mismatched connection's heartbeat that waited for its hardware's adoption", async () => {
    const lender = await api.createMachine("Lends a token while heard");
    const unidentified = await api.createMachine("Entered while heard");
    const tabletId = randomUUID();
    await (await connect(helloWith(lender.token, { machine: de1Pro("14201") }))).close();
    await (await connect(helloWith(unidentified.token, { tabletId, machine: de1Pro("0") }))).close();
    // The tablet connects with the other Machine's token to an instance that waits 30 s for a heartbeat, longer
    // than the test's waits, and sends heartbeats only when the test does.
    const patient = await startTestServer({ env: { ...env, SYNC_HEARTBEAT_SECONDS: "10" }, sharing: server });
    try {
      const raw = await RawConnection.open(patient.url);
      connections.push(raw);
      raw.send(helloWith(lender.token, { tabletId, machine: de1Pro("14202") }));
      await raw.message(0);
      const heldSince = Date.parse((await api.pendingMachines()).find((candidate) => candidate.serial === "14202")!.lastSeenAt!);

      const database = await server.connectDatabase();
      try {
        // Entering the hardware joins the Pending Machine's record of the tablet into the Machine's, then waits
        // to remove the Pending Machine, whose row the test holds.
        await database.query("BEGIN");
        await database.query("SELECT 1 FROM pending_machines WHERE model = 'DE1Pro' AND serial = '14202' FOR UPDATE");
        const entered = api.call("PUT", `/machines/${unidentified.machine.id}/hardware`, { model: "DE1Pro", serial: "14202" });
        await waitForLockWaits(server);
        // A heartbeat meanwhile waits for the record the adoption has removed.
        raw.send({ type: "heartbeat" });
        await waitForLockWaits(server, { count: 2 });
        await database.query("COMMIT");
        expect((await entered).status).toBe(200);
      } finally {
        await database.end();
      }
      // The heartbeat is still recorded, on the record the Machine took over. PostgreSQL rounds a record's
      // times to the millisecond where the Pending Machine's was truncated.
      const heard = await api.waitForMachine(
        "Entered while heard",
        (viewed) => viewed.tablet?.id === tabletId && Date.parse(viewed.tablet.lastSeenAt) > heldSince + 1,
      );
      expect(heard.earlierTablets).toEqual([]);
    } finally {
      await patient.stop();
    }
  });

  it("records nothing for a refused hello", async () => {
    const refused = await api.createMachine("Refused");
    const raw = await RawConnection.open(server.url);
    connections.push(raw);
    raw.send(helloWith(refused.token, { decaidVersion: "0.8.6+2801" }));
    await raw.closed;
    expect(await machine(refused.machine.id)).toMatchObject({ lastRefusal: { reason: expect.stringContaining("0.8.6") }, tablet: null, earlierTablets: [] });
  });
});
