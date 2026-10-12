import test from 'node:test';
import assert from 'node:assert/strict';
import { Mailbox } from '../mailbox.mjs';
import { emptyState } from '../github.mjs';
import { listNotifications, acknowledgeNotification } from '../notifications.mjs';

class Store {
  state = emptyState(); revision = 0;
  async read() { return { state: structuredClone(this.state), sha: this.revision }; }
  async write(state, sha) {
    if (sha !== this.revision) throw Object.assign(new Error('Conflict'), { status: 409 });
    this.state = structuredClone(state); this.revision++;
  }
}
async function setup() {
  const store = new Store(); let now = 100000000;
  const alice = new Mailbox(store, 'alice', () => now), bob = new Mailbox(store, 'bob', () => now);
  for (const mailbox of [alice, bob]) Object.assign(mailbox, { listNotifications, acknowledgeNotification });
  const a = (await alice.join({ label: 'Builder', task: 'Build' })).id;
  const b = (await bob.join({ label: 'Reviewer', task: 'Review' })).id;
  const task = await alice.createTask({ agent_id: a, title: 'Build', description: 'A change', acceptance: ['Tests'], assignee_id: a, request_id: 'create' });
  const update = async (action, summary = action) => {
    const current = await alice.getTask({ agent_id: a, task_id: task.id });
    return alice.updateTask({ agent_id: a, task_id: task.id, expected_revision: current.revision, request_id: `${action}-${current.revision}`, action, summary });
  };
  await update('accept');
  const list = () => alice.listNotifications({ agent_id: a });
  const ack = id => alice.acknowledgeNotification({ agent_id: a, notification_id: id });
  return { store, alice, bob, a, b, task, update, list, ack, advance: minutes => now += minutes * 60000 };
}

test('reads are silent and completion is retained until explicit idempotent acknowledgement', async () => {
  const { store, list, ack, update } = await setup();
  assert.equal((await list()).notifications.length, 0);
  await update('complete', 'Tests passed; branch ready');
  const before = JSON.stringify(store.state), first = await list();
  assert.deepEqual(await list(), first);
  assert.equal(JSON.stringify(store.state), before);
  assert.equal(first.notifications[0].kind, 'task_completed');
  assert.equal(first.notifications[0].summary, 'Tests passed; branch ready');
  await ack(first.notifications[0].id);
  const revision = store.revision;
  await ack(first.notifications[0].id);
  assert.equal(store.revision, revision);
  assert.equal((await list()).notifications.length, 0);
  assert.equal(store.state.notificationReceipts.length, 1);
});

test('blocker polling and progress do not repeat an alert; a new blocked episode does', async () => {
  const { store, list, ack, update } = await setup();
  await update('block', 'Need repository access');
  const first = (await list()).notifications[0];
  await ack(first.id);
  await update('progress', 'Still waiting');
  assert.equal((await list()).notifications.length, 0);
  await update('resume');
  await update('block', 'Different decision needed');
  const second = (await list()).notifications[0];
  assert.notEqual(second.id, first.id);
  assert.equal(second.summary, 'Different decision needed');
  await ack(second.id);
  assert.equal(store.state.notificationReceipts.length, 1, 'new episode replaces the source receipt');
  await assert.rejects(ack(first.id), /no longer current/);
});

test('acknowledgement checks identity, current event and per-worker ownership without arbitrary receipt growth', async () => {
  const { store, alice, bob, a, b, list, ack, update, task } = await setup();
  await update('block');
  const first = (await list()).notifications[0];
  await assert.rejects(bob.listNotifications({ agent_id: a }), /identity/);
  await assert.rejects(bob.acknowledgeNotification({ agent_id: a, notification_id: first.id }), /identity/);
  await assert.rejects(bob.acknowledgeNotification({ agent_id: b, notification_id: first.id }), /not addressed/);
  await assert.rejects(ack('a'.repeat(64)), /not addressed/);
  await assert.rejects(ack('bad'), /notification_id/);
  assert.equal(store.state.notificationReceipts, undefined);
  await update('resume');
  await assert.rejects(ack(first.id), /no longer current/);
  // Same task is now related to both workers, but their delivery receipts remain independent.
  store.state.tasks.find(t => t.id === task.id).createdBy = b;
  await update('complete');
  const own = (await alice.listNotifications({ agent_id: a })).notifications[0];
  const other = (await bob.listNotifications({ agent_id: b })).notifications[0];
  assert.notEqual(own.id, other.id);
  await ack(own.id);
  assert.equal((await bob.listNotifications({ agent_id: b })).notifications.length, 1);
});

test('concurrent acknowledgement retries converge on one durable receipt', async () => {
  const { store, list, ack, update } = await setup();
  await update('complete');
  const id = (await list()).notifications[0].id;
  const before = store.revision;
  await Promise.all([ack(id), ack(id)]);
  assert.equal(store.state.notificationReceipts.length, 1);
  assert.equal(store.revision, before + 1);
});

test('health alerts recur only after a new progress/report episode becomes stale', async () => {
  const { alice, a, list, ack, update, advance } = await setup();
  await alice.reportWorkerHealth({ agent_id: a, expected_revision: 0, scheduler_status: 'enabled', expected_interval_minutes: 20 });
  advance(40);
  const events = (await list()).notifications;
  assert.deepEqual(new Set(events.map(e => e.kind)), new Set(['task_stalled', 'worker_report_stale']));
  for (const event of events) await ack(event.id);
  advance(40);
  assert.equal((await list()).notifications.length, 0);
  await update('progress');
  await alice.reportWorkerHealth({ agent_id: a, expected_revision: 1, scheduler_status: 'enabled', expected_interval_minutes: 20 });
  assert.equal((await list()).notifications.length, 0);
  advance(40);
  const renewed = (await list()).notifications;
  assert.equal(renewed.length, 2);
  assert.ok(renewed.every(event => !events.some(old => old.id === event.id)));
});

test('exhausted routing/reviews and missing workers create decisions; unrelated work stays out', async () => {
  const { store, list, a, b, task } = await setup();
  const record = store.state.tasks.find(t => t.id === task.id);
  record.status = 'ready';
  record.routing = { requestedBy: a, acceptBy: 1, attempted: [b], maxAttempts: 1 };
  store.state.reviewCycles = [{ id: 'cycle', builderId: a, reviewerId: b, taskId: task.id, phase: 'exhausted', revision: 3, updatedAt: 5 }];
  let events = (await list()).notifications;
  assert.deepEqual(new Set(events.map(e => e.kind)), new Set(['routing_exhausted', 'review_exhausted']));
  record.assigneeId = 'missing-worker';
  assert.ok((await list()).notifications.some(event => event.kind === 'orphan_assignee'));
  record.createdBy = b;
  delete record.routing;
  store.state.reviewCycles = [];
  assert.equal((await list()).notifications.length, 0);
});

test('bounded batches drain only after acknowledgement and receipt capacity fails without discarding history', async () => {
  const { store, alice, a, list, ack, update, advance } = await setup();
  await update('block');
  await alice.reportWorkerHealth({ agent_id: a, expected_revision: 0, scheduler_status: 'enabled', expected_interval_minutes: 5 });
  advance(40);
  const first = await alice.listNotifications({ agent_id: a, limit: 1 });
  assert.equal(first.notifications.length, 1);
  assert.equal(first.hasMore, true);
  assert.equal(first.notifications[0].priority, 'decision');
  await ack(first.notifications[0].id);
  assert.equal((await list()).notifications.length, 1);
  await assert.rejects(alice.listNotifications({ agent_id: a, limit: 0 }), /limit/);
  store.state.notificationReceipts = Array.from({ length: 5000 }, (_, i) => ({ agentId: a, sourceKey: `old:${i}`, notificationId: String(i) }));
  const next = (await list()).notifications[0];
  await assert.rejects(ack(next.id), /receipts full/);
  assert.equal(store.state.notificationReceipts.length, 5000);
});
