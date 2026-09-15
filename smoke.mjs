// Real MCP wire test with two separate server processes. Synthetic messages only.
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
const clients=[];
async function connect(label){
  const client=new Client({name:label,version:'0.1.0'});
  await client.connect(new StdioClientTransport({command:process.execPath,args:[fileURLToPath(new URL('./server.mjs',import.meta.url))],env:process.env.AGENT_MAILBOX_REPO ? {AGENT_MAILBOX_REPO:process.env.AGENT_MAILBOX_REPO} : undefined}));
  clients.push(client);return client;
}
async function call(client,name,args={}){
  const result=await client.callTool({name,arguments:args});
  if(result.isError)throw new Error(result.content[0].text);
  return JSON.parse(result.content[0].text);
}
try{
  const a=await connect('smoke-a'),b=await connect('smoke-b');
  assert.equal((await a.listTools()).tools.length,7);
  if(!process.argv.includes('--exchange')){
    await call(a,'team_status');console.log('MCP initialize/list/read passed. Use --exchange for a synthetic two-process conversation.');
  }else{
    const from=await call(a,'join_team',{label:'Smoke sender',task:'Synthetic MCP verification'});
    const to=await call(b,'join_team',{label:'Smoke receiver',task:'Synthetic MCP verification'});
    const message=await call(a,'send_message',{agent_id:from.id,to:to.id,kind:'question',body:'Synthetic transport check: please acknowledge receipt.',request_id:'smoke-question'});
    assert.equal((await call(b,'check_inbox',{agent_id:to.id})).messages[0].id,message.id);
    const reply=await call(b,'send_message',{agent_id:to.id,to:from.id,kind:'answer',body:'Synthetic receipt confirmed.',reply_to:message.id,request_id:'smoke-answer'});
    await call(b,'acknowledge_message',{agent_id:to.id,message_id:message.id});
    assert.equal((await call(a,'check_inbox',{agent_id:from.id})).messages[0].id,reply.id);
    await call(a,'acknowledge_message',{agent_id:from.id,message_id:reply.id});
    console.log('PASS: two independent MCP processes exchanged and acknowledged a question and reply through GitHub. This is not a test on the buddy’s computer.');
  }
}finally{await Promise.all(clients.map(c=>c.close()));}
