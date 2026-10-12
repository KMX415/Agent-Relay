import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTeam } from '../harness/core.mjs';
import { Mailbox } from '../mailbox.mjs';
import { call } from '../tools.mjs';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'relay-team-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return createTeam({ directory });
}
const message = (team, request_id) => ({ to: team.workers.b1.id, kind: 'question', body: 'Synthetic check', request_id });

test('six saved identities bind three owners, isolated paths and validated local policies', async t => {
  const team = await fixture(t);
  assert.equal(Object.keys(team.workers).length, 6);
  assert.equal(new Set(Object.values(team.workers).map(w => w.owner)).size, 3);
  assert.equal(new Set(Object.values(team.workers).map(w => w.directory)).size, 6);
  const policy = JSON.parse(await readFile(team.workers.a1.policyPath, 'utf8'));
  assert.equal(policy.owner, 'contributor-a');
  await assert.rejects(team.call('a1', 'check_inbox', { agent_id: team.workers.b1.id }), /override/);
  await assert.rejects(call(new Mailbox(team.store, 'contributor-a'), 'check_inbox', { agent_id: team.workers.b1.id }), /authenticated/);
  await assert.rejects(team.call('a1', 'join_team', { label: 'Again', task: 'Again' }), /reuse/);
  const task = await team.call('a1', 'create_task', { title: 'Forbidden scope', description: 'Synthetic boundary', acceptance: ['Denied'], paths: ['src/forbidden'], assignee_id: team.workers.b1.id, request_id: 'scope' });
  const check = await team.call('b1', 'check_task', { task_id: task.id });
  assert.equal(check.allowed, false);
  assert.match(check.reasons.join(' '), /paths/);
  await assert.rejects(createTeam({ directory: team.directory }), /EEXIST/);
});

test('offline writes do not commit, lost responses retry exactly once across restart', async t => {
  const team = await fixture(t);
  team.store.failNext('offline');
  await assert.rejects(team.call('a1', 'send_message', message(team, 'offline')), /offline/);
  assert.equal((await team.store.read()).state.messages.length, 0);
  const payload = message(team, 'lost');
  team.store.failNext('lost-response');
  await assert.rejects(team.call('a1', 'send_message', payload), /lost response/);
  const committed = (await team.store.read()).state.messages[0];
  const writes = team.metrics.writes;
  await team.restart('a1');
  const retried = await team.call('a1', 'send_message', payload);
  assert.equal(retried.id, committed.id);
  assert.equal(team.metrics.writes, writes);
  assert.equal((await team.store.read()).state.messages.length, 1);
  await assert.rejects(team.call('a1', 'send_message', { ...payload, body: 'Changed' }), /different content/);
});

test('serialized CAS preserves concurrent writes and limits dispatched workers to three', async t => {
  const team = await fixture(t);
  team.store.failNext('conflict');
  await Promise.all(Object.keys(team.workers).map(key => team.call(key, 'send_message', message(team, key))));
  const snapshot = await team.store.read();
  assert.equal(snapshot.state.messages.length, 6);
  assert.equal(new Set(snapshot.state.messages.map(m => m.sequence)).size, 6);
  assert.equal(team.metrics.maxConcurrent, 3);
  assert.ok(team.metrics.conflicts >= 1);
  snapshot.state.messages.length = 0;
  assert.equal((await team.store.read()).state.messages.length, 6);
  await assert.rejects(team.store.write(snapshot.state, -1), e => e.status === 409);
  team.advance(121 * 60000);
  assert.equal((await team.call('a1', 'find_agents')).agents.length, 0);
  assert.throws(() => team.advance(-1), /Invalid/);
});
