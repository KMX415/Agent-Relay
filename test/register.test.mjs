import test from 'node:test';
import assert from 'node:assert/strict';
import { register, serverName } from '../register.mjs';

const opts = { name: 'dead-drop-owner--box', repo: 'owner/box', node: '/usr/bin/node', server: '/relay/server.mjs' };
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
  assert.equal(serverName('Owner/Box'), 'dead-drop-owner--box');
});

test('codex stays the default and is registered when absent', async () => {
  const { run, calls } = fake({ 'codex mcp list': '[]' });
  await register(run, ['codex'], opts);
  assert.ok(calls.includes('codex mcp add dead-drop-owner--box --env AGENT_MAILBOX_REPO=owner/box -- /usr/bin/node /relay/server.mjs'));
  assert.ok(!calls.some(c => c.startsWith('claude')));
});

test('claude code is registered in addition to codex, at user scope', async () => {
  const { run, calls } = fake({ 'codex mcp list': '[]', 'claude mcp get': new Error('No MCP server found') });
  const out = await register(run, ['codex', 'claude'], opts);
  assert.equal(out.length, 2);
  assert.ok(calls.some(c => c.startsWith('codex mcp add')));
  assert.ok(calls.includes('claude mcp add dead-drop-owner--box --scope user --env AGENT_MAILBOX_REPO=owner/box -- /usr/bin/node /relay/server.mjs'));
});

test('a matching claude registration is kept, a different one is refused', async () => {
  const same = fake({ 'claude mcp get': 'dead-drop-owner--box:\n  Command: /usr/bin/node\n  Args: /relay/server.mjs\n  Environment:\n    AGENT_MAILBOX_REPO=owner/box\n' });
  assert.match((await register(same.run, ['claude'], opts))[0], /already matches/);
  assert.ok(!same.calls.some(c => c.startsWith('claude mcp add')));
  const other = fake({ 'claude mcp get': 'dead-drop-owner--box:\n  Args: /elsewhere/server.mjs\n' });
  await assert.rejects(register(other.run, ['claude'], opts), /different Claude Code registration/);
});

test('a different codex registration is still refused', async () => {
  const { run } = fake({ 'codex mcp list': JSON.stringify([{ name: opts.name, enabled: true, transport: { command: 'node', args: ['/x.mjs'], env: {} } }]) });
  await assert.rejects(register(run, ['codex'], opts), /different\/disabled Codex registration/);
});

const shownRegistration = ({command=opts.node, args=opts.server, environment='    AGENT_MAILBOX_REPO='+opts.repo}={}) =>
  'dead-drop-owner--box:\n  Command: '+command+'\n  Args: '+args+'\n  Environment:\n'+environment+'\n';

test('Claude refuses wrong executable, partial paths, and extra arguments', async () => {
  for (const changes of [
    {command:'/different/node'}, {command:opts.node+'-other'},
    {args:opts.server+'.backup'}, {args:opts.server+' --other'},
    {args:'--require /other.mjs '+opts.server},
  ]) {
    const {run,calls}=fake({'claude mcp get':shownRegistration(changes)});
    await assert.rejects(register(run,['claude'],opts),/different Claude Code registration/);
    assert.equal(calls.length,1);
  }
});

test('Claude requires exactly the mailbox variable in the environment section', async () => {
  for (const environment of [
    '    AGENT_MAILBOX_REPO=owner/box-other',
    '    OTHER_REPO=owner/box',
    '    PREFIX_AGENT_MAILBOX_REPO=owner/box',
    '    AGENT_MAILBOX_REPO=owner/box\n    AGENT_MAILBOX_REPO=owner/other',
    '',
  ]) {
    const {run,calls}=fake({'claude mcp get':shownRegistration({environment})});
    await assert.rejects(register(run,['claude'],opts),/different Claude Code registration/);
    assert.equal(calls.length,1);
  }
  const {run}=fake({'claude mcp get':shownRegistration().replace('  Environment:', '  Notes:')});
  await assert.rejects(register(run,['claude'],opts),/different Claude Code registration/);
});

test('Claude refuses missing or ambiguous fields', async () => {
  for (const shown of [
    shownRegistration().replace('  Command: '+opts.node+'\n',''),
    shownRegistration().replace('  Args: '+opts.server+'\n',''),
    shownRegistration()+'  Command: '+opts.node+'\n',
    shownRegistration()+'  Args: '+opts.server+'\n',
    'Unrecognized output '+opts.node+' '+opts.server+' '+opts.repo,
  ]) {
    const {run,calls}=fake({'claude mcp get':shown});
    await assert.rejects(register(run,['claude'],opts),/different Claude Code registration/);
    assert.equal(calls.length,1);
  }
});

test('Claude accepts exact Windows paths with spaces, escaped paths, and CRLF output', async () => {
  const windows={...opts,node:'C:\\Program Files\\nodejs\\node.exe',server:'C:\\My Dead Drop\\server.mjs'};
  for (const escaped of [false,true]) {
    const format=value=>escaped?value.replaceAll('\\','\\\\'):value;
    const shown=shownRegistration({command:format(windows.node),args:format(windows.server),
      environment:'    AGENT_MAILBOX_REPO: '+opts.repo}).replaceAll('\n','\r\n');
    const {run,calls}=fake({'claude mcp get':shown});
    assert.match((await register(run,['claude'],windows))[0],/already matches/);
    assert.equal(calls.length,1);
  }
});
