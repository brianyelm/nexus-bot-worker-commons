import { test } from "node:test";
import assert from "node:assert/strict";
import { ReminderDOBase } from "../src/durable/ReminderDOBase.js";

// In-memory fake of the CF DO storage API. Only the methods we use.
class FakeStorage {
  constructor() { this._alarm = null; }
  async getAlarm() { return this._alarm; }
  async setAlarm(t) { this._alarm = t; }
  async deleteAlarm() { this._alarm = null; }
}
function makeState() { return { storage: new FakeStorage() }; }

// Concrete subclass for tests. Tracks fireDue calls.
class TestReminderDO extends ReminderDOBase {
  constructor(state, env, opts = {}) {
    super(state, env);
    this._dueAt = opts.dueAt;
    this._fireResult = opts.fireResult ?? { fired: 0, errors: 0 };
    this.fireCalls = 0;
  }
  async getDueAt() { return this._dueAt; }
  async fireDue() {
    this.fireCalls++;
    return this._fireResult;
  }
}

test("_scheduleAt sets alarm when none exists", async () => {
  const state = makeState();
  const d = new TestReminderDO(state, {});
  await d._scheduleAt(5000);
  assert.equal(await state.storage.getAlarm(), 5000);
});

test("_scheduleAt prefers the earlier time (min-merge)", async () => {
  const state = makeState();
  const d = new TestReminderDO(state, {});
  await d._scheduleAt(8000);
  await d._scheduleAt(3000);
  assert.equal(await state.storage.getAlarm(), 3000);
});

test("_scheduleAt does NOT push a later time over an earlier one", async () => {
  const state = makeState();
  const d = new TestReminderDO(state, {});
  await d._scheduleAt(3000);
  await d._scheduleAt(8000);
  assert.equal(await state.storage.getAlarm(), 3000);
});

test("_bootstrap clears alarm when no pending reminders", async () => {
  const state = makeState();
  await state.storage.setAlarm(1234);
  const d = new TestReminderDO(state, {}, { dueAt: null });
  await d._bootstrap();
  assert.equal(await state.storage.getAlarm(), null);
});

test("_bootstrap sets alarm from getDueAt when pending exists", async () => {
  const state = makeState();
  const d = new TestReminderDO(state, {}, { dueAt: 9000 });
  await d._bootstrap();
  assert.equal(await state.storage.getAlarm(), 9000);
});

test("_bootstrap respects the min-merge invariant", async () => {
  const state = makeState();
  await state.storage.setAlarm(2000); // existing earlier alarm
  const d = new TestReminderDO(state, {}, { dueAt: 9000 });
  await d._bootstrap();
  assert.equal(await state.storage.getAlarm(), 2000);
});

test("alarm() invokes fireDue then reseeds from next pending", async () => {
  const state = makeState();
  const d = new TestReminderDO(state, {}, { dueAt: 12345, fireResult: { fired: 2, errors: 0 } });
  await d.alarm();
  assert.equal(d.fireCalls, 1);
  // Alarm cleared by initial bootstrap path then re-set to 12345 from getDueAt.
  assert.equal(await state.storage.getAlarm(), 12345);
});

test("alarm() reseeds to null when no further pending reminders", async () => {
  const state = makeState();
  const d = new TestReminderDO(state, {}, { dueAt: null });
  await d.alarm();
  assert.equal(d.fireCalls, 1);
  assert.equal(await state.storage.getAlarm(), null);
});

test("alarm() still reseeds even when fireDue throws", async () => {
  const state = makeState();
  class ThrowingDO extends TestReminderDO {
    async fireDue() { this.fireCalls++; throw new Error("boom"); }
  }
  const d = new ThrowingDO(state, {}, { dueAt: 7000 });
  await d.alarm();
  assert.equal(d.fireCalls, 1);
  // Despite the throw, the next alarm is set so we don't lose future fires.
  assert.equal(await state.storage.getAlarm(), 7000);
});

test("fetch /schedule sets alarm via JSON body", async () => {
  const state = makeState();
  const d = new TestReminderDO(state, {});
  const req = new Request("https://x/schedule", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ fireAt: 4242 }),
  });
  const res = await d.fetch(req);
  assert.equal(res.status, 200);
  assert.equal(await state.storage.getAlarm(), 4242);
});

test("fetch /schedule rejects non-numeric fireAt with 400", async () => {
  const state = makeState();
  const d = new TestReminderDO(state, {});
  const req = new Request("https://x/schedule", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ fireAt: "not-a-number" }),
  });
  const res = await d.fetch(req);
  assert.equal(res.status, 400);
});

test("fetch /bootstrap triggers _bootstrap path", async () => {
  const state = makeState();
  const d = new TestReminderDO(state, {}, { dueAt: 5555 });
  const req = new Request("https://x/bootstrap", { method: "POST" });
  const res = await d.fetch(req);
  assert.equal(res.status, 200);
  assert.equal(await state.storage.getAlarm(), 5555);
});

test("fetch returns 404 for unknown path", async () => {
  const state = makeState();
  const d = new TestReminderDO(state, {});
  const res = await d.fetch(new Request("https://x/whatever"));
  assert.equal(res.status, 404);
});

test("base class throws when subclass doesn't override getDueAt", async () => {
  const d = new ReminderDOBase(makeState(), {});
  await assert.rejects(() => d.getDueAt({}), /subclass must override getDueAt/);
});

test("base class throws when subclass doesn't override fireDue", async () => {
  const d = new ReminderDOBase(makeState(), {});
  await assert.rejects(() => d.fireDue({}), /subclass must override fireDue/);
});
