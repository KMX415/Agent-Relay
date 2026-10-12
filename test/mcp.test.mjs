import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { tools } from '../tools.mjs';

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
