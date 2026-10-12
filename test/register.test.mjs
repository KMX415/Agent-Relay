import test from 'node:test';
import assert from 'node:assert/strict';
import { register, serverName } from '../register.mjs';

const opts = { name: 'agent-relay-owner--box', repo: 'owner/box', node: '/usr/bin/node', server: '/relay/server.mjs' };
function fake(responses) {
  const calls = [];
  const run = async (cmd, args) => {
    calls.push([cmd, ...args].join(' '));
    const r = responses[cmd + ' ' + args.slice(0, 2).join(' ')];
    if (r instanceof Error) throw r;
    return r ?? 'Added';
  };
  return { run, calls };
}

test('server name is derived from the mailbox repo', () => {
  assert.equal(serverName('Owner/Box'), 'agent-relay-owner--box');
});

test('codex stays the default and is registered when absent', async () => {
  const { run, calls } = fake({ 'codex mcp list': '[]' });
  await register(run, ['codex'], opts);
  assert.ok(calls.includes('codex mcp add agent-relay-owner--box --env AGENT_MAILBOX_REPO=owner/box -- /usr/bin/node /relay/server.mjs'));
  assert.ok(!calls.some(c => c.startsWith('claude')));
});

test('claude code is registered in addition to codex, at user scope', async () => {
  const { run, calls } = fake({ 'codex mcp list': '[]', 'claude mcp get': new Error('No MCP server found') });
  const out = await register(run, ['codex', 'claude'], opts);
  assert.equal(out.length, 2);
  assert.ok(calls.some(c => c.startsWith('codex mcp add')));
  assert.ok(calls.includes('claude mcp add agent-relay-owner--box --scope user --env AGENT_MAILBOX_REPO=owner/box -- /usr/bin/node /relay/server.mjs'));
});

test('a matching claude registration is kept, a different one is refused', async () => {
  const same = fake({ 'claude mcp get': 'agent-relay-owner--box:\n  Command: /usr/bin/node\n  Args: /relay/server.mjs\n  Environment:\n    AGENT_MAILBOX_REPO=owner/box\n' });
  assert.match((await register(same.run, ['claude'], opts))[0], /already matches/);
  assert.ok(!same.calls.some(c => c.startsWith('claude mcp add')));
  const other = fake({ 'claude mcp get': 'agent-relay-owner--box:\n  Args: /elsewhere/server.mjs\n' });
  await assert.rejects(register(other.run, ['claude'], opts), /different Claude Code registration/);
});

test('a different codex registration is still refused', async () => {
  const { run } = fake({ 'codex mcp list': JSON.stringify([{ name: opts.name, enabled: true, transport: { command: 'node', args: ['/x.mjs'], env: {} } }]) });
  await assert.rejects(register(run, ['codex'], opts), /different\/disabled Codex registration/);
});
