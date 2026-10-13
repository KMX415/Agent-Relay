import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { tools } from '../tools.mjs';
import { normalizeAllowedTools } from '../tool-access.mjs';

test('tool allowlist rejects malformed and unknown names',()=>{
  for(const value of ['',[],['*'],['send_message','send_message'],['unknown'],42])assert.throws(()=>normalizeAllowedTools(value));
  assert.deepEqual(normalizeAllowedTools('send_message, check_inbox'),['check_inbox','send_message']);
});

test('restricted stdio server hides and refuses excluded tools before authentication', {timeout:15000}, async()=>{
  const client=new Client({name:'restricted-test',version:'1.0.0'});
  try {
    await client.connect(new StdioClientTransport({command:process.execPath,
      args:[fileURLToPath(new URL('../server.mjs',import.meta.url))],
      env:{AGENT_MAILBOX_REPO:'example/unused-schema-test',DEAD_DROP_TOOLS:'check_inbox,send_message,acknowledge_message'}}));
    assert.deepEqual((await client.listTools()).tools.map(t=>t.name).sort(),['acknowledge_message','check_inbox','send_message']);
    for(const name of ['join_team','create_task','unknown']) {
      const result=await client.callTool({name,arguments:{}});
      assert.equal(result.isError,true);
      assert.match(result.content[0].text,/not enabled/);
    }
  } finally {await client.close();}
});

test('real stdio server exposes task schemas without GitHub authentication', {timeout:15000}, async()=>{
  const client = new Client({name:'schema-test',version:'1.0.0'});
  try {
    await client.connect(new StdioClientTransport({command:process.execPath,
      args:[fileURLToPath(new URL('../server.mjs',import.meta.url))],
      env:{AGENT_MAILBOX_REPO:'example/unused-schema-test'}}));
    const listed = (await client.listTools()).tools;
    assert.deepEqual(listed.map(t=>t.name).sort(),tools.map(t=>t.name).sort());
    assert.deepEqual(listed.find(t=>t.name==='update_task').inputSchema.required,
      ['agent_id','task_id','expected_revision','request_id','action','summary']);
  } finally { await client.close(); }
});
