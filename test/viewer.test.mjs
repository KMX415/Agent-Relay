import test from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createViewer, listenViewer } from '../viewer.mjs';

async function request(server, { method = 'GET', path = '/', headers = {} } = {}) {
  const { port } = server.address();
  return new Promise((resolve, reject) => {
    const req = httpRequest({ hostname: '127.0.0.1', port, method, path, headers }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({
        status: response.statusCode,
        headers: response.headers,
        text: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    req.on('error', reject);
    req.end();
  });
}

async function start(options) {
  const server = createViewer(options);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return server;
}

test('API exposes only mapped history and useful agent labels without writing mailbox state', async t => {
  let reads = 0;
  const store = {
    repo: 'example/private',
    async read() {
      reads += 1;
      return { state: {
        agents: {
          a: { id: 'alice/id', owner: 'alice', label: 'Renderer', task: 'secret task' },
          b: { id: 'bob/id', owner: 'bob', label: 'Reviewer' },
        },
        messages: [{
          id: 'message-1', sequence: 7, from: 'alice/id', to: 'bob', kind: 'question',
          body: 'Please review', createdAt: 1_700_000_000_000, replyTo: null,
          acknowledgedBy: ['bob/id'], requestId: 'private-key', depth: 2,
        }],
        claims: [{ task: 'not public' }],
      }, sha: 'secret-sha' };
    },
    async write() { assert.fail('viewer must not write'); },
    async verify() { assert.fail('viewer must not register or verify an identity'); },
  };
  const server = await start({ store, now: () => 1_800_000_000_000 });
  t.after(() => server.close());

  const response = await request(server, { path: '/api/messages' });
  assert.equal(response.status, 200);
  assert.equal(reads, 1);
  assert.deepEqual(JSON.parse(response.text), {
    repo: 'example/private',
    fetchedAt: '2027-01-15T08:00:00.000Z',
    messages: [{
      id: 'message-1', sequence: 7, from: 'alice/id', to: 'bob', kind: 'question',
      body: 'Please review', createdAt: 1_700_000_000_000, replyTo: null,
      fromLabel: 'Renderer (alice)', toLabel: 'bob (all registered workers)',
    }],
  });
});

test('server is GET-only and enforces loopback Host, Origin, and fetch-site headers', async t => {
  const server = await start({ store: { repo: 'x/y', read: async () => ({ state: { agents: {}, messages: [] } }) } });
  t.after(() => server.close());
  const { port } = server.address();

  const post = await request(server, { method: 'POST', path: '/api/messages' });
  assert.equal(post.status, 405);
  assert.equal(post.headers.allow, 'GET');
  assert.equal((await request(server, { path: '/api/messages', headers: { Host: `localhost:${port}` } })).status, 403);
  assert.equal((await request(server, { path: '/api/messages', headers: { Origin: 'https://attacker.invalid' } })).status, 403);
  assert.equal((await request(server, { path: '/api/messages', headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
  assert.equal((await request(server, { path: '/api/messages', headers: { Origin: `http://127.0.0.1:${port}` } })).status, 200);
});

test('fixed assets and routing use restrictive browser headers', async t => {
  const assetDirectory = await mkdtemp(join(tmpdir(), 'dead-drop-viewer-'));
  await Promise.all([
    writeFile(join(assetDirectory, 'index.html'), '<!doctype html><title>Viewer</title>'),
    writeFile(join(assetDirectory, 'app.mjs'), 'export {};'),
    writeFile(join(assetDirectory, 'style.css'), 'body{}'),
  ]);
  t.after(() => rm(assetDirectory, { recursive: true, force: true }));
  const server = await start({ assetDirectory, store: { repo: 'x/y', read: async () => ({ state: { agents: {}, messages: [] } }) } });
  t.after(() => server.close());

  const index = await request(server);
  assert.equal(index.status, 200);
  assert.match(index.headers['content-type'], /^text\/html/);
  assert.equal(index.headers['cache-control'], 'no-store');
  assert.equal(index.headers['x-content-type-options'], 'nosniff');
  assert.equal(index.headers['x-frame-options'], 'DENY');
  assert.match(index.headers['content-security-policy'], /script-src 'self'/);
  assert.match(index.headers['content-security-policy'], /style-src 'self'/);
  assert.doesNotMatch(index.headers['content-security-policy'], /unsafe-inline/);
  assert.match((await request(server, { path: '/app.mjs?v=1' })).headers['content-type'], /^text\/javascript/);
  assert.equal((await request(server, { path: '/missing' })).status, 404);
  assert.equal((await request(server, { path: '/%2fapi/messages' })).status, 404);
  assert.equal((await request(server, { path: 'http://attacker.invalid/api/messages' })).status, 400);
});

test('successful reads are cached and concurrent refreshes are coalesced', async t => {
  let reads = 0;
  let release;
  let markStarted;
  let clock = 1000;
  const gate = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { markStarted = resolve; });
  const store = {
    repo: 'x/y',
    async read() {
      reads += 1;
      markStarted();
      if (reads === 1) await gate;
      return { state: { agents: {}, messages: [] } };
    },
  };
  const server = await start({ store, cacheMs: 15_000, now: () => clock });
  t.after(() => server.close());

  const first = request(server, { path: '/api/messages' });
  const second = request(server, { path: '/api/messages' });
  await started;
  assert.equal(reads, 1);
  release();
  assert.deepEqual((await Promise.all([first, second])).map(result => result.status), [200, 200]);
  assert.equal((await request(server, { path: '/api/messages' })).status, 200);
  assert.equal(reads, 1);
  clock += 15_001;
  assert.equal((await request(server, { path: '/api/messages' })).status, 200);
  assert.equal(reads, 2);
});

test('failures are sanitized, briefly coalesced, and never replaced with stale success', async t => {
  let reads = 0;
  let clock = 10_000;
  let fail = false;
  const store = {
    repo: 'x/y',
    async read() {
      reads += 1;
      if (fail) throw new Error('gh token ghp_super_secret failed against private URL');
      return { state: { agents: {}, messages: [] } };
    },
  };
  const server = await start({ store, cacheMs: 100, failureCacheMs: 2_000, now: () => clock });
  t.after(() => server.close());

  assert.equal((await request(server, { path: '/api/messages' })).status, 200);
  fail = true;
  clock += 101;
  const failed = await request(server, { path: '/api/messages' });
  assert.equal(failed.status, 503);
  assert.doesNotMatch(failed.text, /ghp_|private URL|super_secret/);
  assert.match(JSON.parse(failed.text).error, /authentication and network connectivity/);
  assert.equal((await request(server, { path: '/api/messages' })).status, 503);
  assert.equal(reads, 2);
  clock += 2_001;
  assert.equal((await request(server, { path: '/api/messages' })).status, 503);
  assert.equal(reads, 3);
});

test('malformed history fails visibly without exposing record contents', async t => {
  const store = {
    repo: 'x/y',
    async read() {
      return { state: {
        agents: {},
        messages: [{ id: 'sensitive-id', sequence: 1, from: 'alice', to: 'team', kind: {}, body: 'sensitive body', createdAt: 0 }],
      } };
    },
  };
  const server = await start({ store });
  t.after(() => server.close());

  const response = await request(server, { path: '/api/messages' });
  assert.equal(response.status, 503);
  assert.doesNotMatch(response.text, /sensitive-id|sensitive body|Malformed/);
});

test('listenViewer always binds loopback and accepts ephemeral port zero', async t => {
  const server = await listenViewer({ port: 0, store: { repo: 'x/y', read: async () => ({ state: { agents: {}, messages: [] } }) } });
  t.after(() => server.close());
  assert.equal(server.address().address, '127.0.0.1');
  assert.ok(server.address().port > 0);
});
