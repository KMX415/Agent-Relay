import { mkdir, readFile, writeFile, rename, unlink } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Mailbox } from '../mailbox.mjs';
import { call as dispatch, tools } from '../tools.mjs';
import { emptyState } from '../github.mjs';
import { policyReader } from '../coordination.mjs';

const REPO = 'simulation/team-mailbox';
const error = (message, status = 0) => Object.assign(new Error(message), { status });

// One process owns this store. Serialized CAS writes model contention among its
// workers; this is not an inter-process database, sandbox, or GitHub auth test.
async function localStore(directory, metrics) {
  const path = join(directory, 'mailbox.json');
  await writeFile(path, JSON.stringify({ sha: 0, state: emptyState() }), { flag: 'wx' });
  let tail = Promise.resolve();
  const faults = [];
  const serialize = run => {
    const operation = tail.then(run);
    tail = operation.catch(() => {});
    return operation;
  };
  const readRecord = async () => {
    const content = await readFile(path, 'utf8');
    if (Buffer.byteLength(content) > 751000) throw new Error('Oversized simulation store');
    const record = JSON.parse(content);
    return { sha: record.sha, state: structuredClone(record.state) };
  };
  return {
    repo: REPO,
    path,
    failNext(mode) {
      if (!['offline', 'lost-response', 'conflict'].includes(mode)) throw new Error('Unknown fault mode');
      if (faults.length >= 20) throw new Error('Fault queue full');
      faults.push(mode);
    },
    async read() {
      // Windows can reject replacing a destination with an open read handle.
      // Queue reads too, while keeping each read/CAS pair separate for races.
      return serialize(readRecord);
    },
    async write(state, sha) {
      // Snapshot at invocation, before waiting for another worker's write.
      const json = JSON.stringify(state);
      if (Buffer.byteLength(json) > 750000) throw new Error('Mailbox full; archive it before adding more data');
      return serialize(async () => {
        const fault = faults.shift();
        if (fault) metrics.faults++;
        // Offline: no commit. Conflict: one synthetic 409, ordinary Mailbox retry.
        if (fault === 'offline') throw error('Injected offline write; nothing committed');
        if (fault === 'conflict') { metrics.conflicts++; throw error('Injected CAS conflict', 409); }
        const current = await readRecord();
        if (sha !== current.sha) { metrics.conflicts++; throw error('Simulation CAS revision changed', 409); }
        const temp = path + '.' + randomUUID() + '.tmp';
        try {
          await writeFile(temp, JSON.stringify({ sha: sha + 1, state: JSON.parse(json) }), { flag: 'wx' });
          await rename(temp, path);
        } finally { await unlink(temp).catch(e => { if (e.code !== 'ENOENT') throw e; }); }
        metrics.writes++;
        // Lost response: committed exactly once, nonretry error to the caller.
        // Caller retries the same tool payload/request_id to reconcile.
        if (fault === 'lost-response') throw error('Injected lost response after commit');
      });
    },
  };
}

/** Six scripted workers, three synthetic owners; no models or real accounts. */
export async function createTeam({ directory, now = Date.parse('2026-01-01T00:00:00Z') } = {}) {
  if (typeof directory !== 'string' || !directory.trim()) throw new Error('Explicit simulation directory required');
  directory = resolve(directory);
  let clock = typeof now === 'function' ? now() : now;
  if (!Number.isSafeInteger(clock) || !Number.isFinite(new Date(clock).getTime())) throw new Error('Invalid simulation time');
  await mkdir(directory, { recursive: true });
  const metrics = { calls: 0, writes: 0, conflicts: 0, faults: 0, maxConcurrent: 0 };
  const store = await localStore(directory, metrics);
  const workers = {}, mailboxes = new Map();
  let active = 0;
  const waiting = [];
  async function limited(run) {
    if (active >= 3) await new Promise(resolve => waiting.push(resolve));
    else active++;
    metrics.maxConcurrent = Math.max(metrics.maxConcurrent, active);
    try { metrics.calls++; return await run(); }
    finally { const next = waiting.shift(); if (next) next(); else active--; }
  }
  const bind = worker => new Mailbox(store, worker.owner, () => clock,
    policyReader(REPO, worker.owner, worker.policyPath));
  for (const [key, role] of [['a1','implementer'],['a2','reviewer'],['b1','implementer'],['b2','tester'],['c1','implementer'],['c2','reviewer']]) {
    const owner = 'contributor-' + key[0];
    const workerDirectory = join(directory, owner, key);
    await mkdir(join(workerDirectory, 'workspace'), { recursive: true });
    const worker = { owner, role, directory: workerDirectory, policyPath: join(workerDirectory, 'autonomy.json') };
    const policy = { version: 1, repo: REPO, owner, allowed_kinds: ['implementation','review','research','documentation','testing'],
      allowed_paths: ['src/shared', 'src/' + owner], allow_unassigned: false, max_active_tasks: 3,
      max_chain_depth: 3, max_handoffs: 4, max_task_minutes: 120,
      expires_at: new Date(clock + 24 * 60 * 60 * 1000).toISOString() };
    await writeFile(worker.policyPath, JSON.stringify(policy, null, 2), { flag: 'wx' });
    const mailbox = bind(worker);
    const registered = await limited(() => dispatch(mailbox, 'join_team', { label: key + ' ' + role, task: 'Synthetic team acceptance' }));
    worker.id = registered.id;
    await writeFile(join(workerDirectory, 'identity.json'), JSON.stringify({ repo: REPO, login: owner, agentId: worker.id }), { flag: 'wx' });
    workers[key] = worker;
    mailboxes.set(key, mailbox);
    await limited(() => dispatch(mailbox, 'update_agent', { agent_id: worker.id, expected_revision: 0,
      provider: 'scripted-simulation', capabilities: ['implementation','review','testing'], paths: ['src'], lease_minutes: 120 }));
  }
  function workerFor(key) { if (!Object.hasOwn(workers, key)) throw new Error('Unknown simulation worker'); return workers[key]; }
  return {
    directory, store, workers, metrics,
    async call(key, name, args = {}) {
      const worker = workerFor(key);
      if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Tool arguments must be an object');
      if (Object.hasOwn(args, 'agent_id') && args.agent_id !== worker.id) throw new Error('Cannot override simulation worker identity');
      if (name === 'join_team') throw new Error('Simulation workers must reuse saved identities');
      const needsActor = tools.find(t => t.name === name)?.inputSchema.properties.agent_id;
      const payload = structuredClone(needsActor ? { ...args, agent_id: worker.id } : args);
      return limited(() => dispatch(mailboxes.get(key), name, payload));
    },
    async restart(key) {
      const worker = workerFor(key);
      const identity = JSON.parse(await readFile(join(worker.directory, 'identity.json'), 'utf8'));
      if (identity.repo !== REPO || identity.login !== worker.owner || identity.agentId !== worker.id) throw new Error('Saved simulation identity mismatch');
      const mailbox = bind(worker);
      await mailbox.readPolicy();
      mailboxes.set(key, mailbox);
      return worker;
    },
    advance(ms) {
      if (!Number.isSafeInteger(ms) || ms < 0 || !Number.isSafeInteger(clock + ms) || !Number.isFinite(new Date(clock + ms).getTime())) throw new Error('Invalid clock advance');
      clock += ms; return clock;
    },
  };
}
