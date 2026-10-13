import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { worker, parseCliArgs, guardedInvoke } from '../cli.mjs';
import { runDurable, replayOutbox } from '../outbox.mjs';

const agentId='owner/11111111-1111-4111-8111-111111111111';
const peerId='owner/22222222-2222-4222-8222-222222222222';
const identity={repo:'owner/mailbox',login:'owner',agentId};
async function temporary(t) {
  const directory=await mkdtemp(join(tmpdir(),'dead-drop-cli-'));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  return directory;
}
test('unattended argument parsing accepts either flag order and rejects invalid requests before setup',()=> {
  assert.deepEqual(parseCliArgs(['check_inbox','--unattended','--input','payload.json']),{name:'check_inbox',unattended:true,inputPath:'payload.json'});
  assert.equal(parseCliArgs(['check_inbox','--input','payload.json','--unattended']).unattended,true);
  for(const argv of [[],['unknown'],['check_inbox','--unattended','--unattended'],['check_inbox','--input'],['resume_outbox','--input','payload.json'],['join_team','--unattended']])assert.throws(()=>parseCliArgs(argv));
});
test('unattended identity loading refuses missing, malformed, and mismatched identities without mailbox calls',async t=> {
  const identityPath=join(await temporary(t),'worker.json');
  const store={repo:identity.repo,read(){throw new Error('Unexpected mailbox access');},mutate(){throw new Error('Unexpected mailbox access');}};
  await assert.rejects(worker(store,'owner',{unattended:true,identityPath}),/existing saved worker/);
  await assert.rejects(worker(store,'owner',{allowedTools:['check_inbox'],identityPath}),/existing saved worker/);
  for(const bad of [null,{},[],{...identity,agentId:'owner/'},{...identity,agentId:peerId,repo:'owner/other'},{...identity,login:'other'}]) {
    await writeFile(identityPath,JSON.stringify(bad));
    await assert.rejects(worker(store,'owner',{unattended:true,identityPath}));
  }
  await writeFile(identityPath,JSON.stringify(identity));
  assert.deepEqual(await worker(store,'owner',{unattended:true,identityPath}),identity);
});
test('unattended invocation pins sender and blocks registration while allowing configured inbox',async()=> {
  let calls=0;
  const mailbox={inbox:async args=>{calls++;return args;}};
  const invoke=guardedInvoke(mailbox,{unattended:true,agentId,allowedTools:['check_inbox','send_message','acknowledge_message']});
  assert.throws(()=>invoke('check_inbox',{agent_id:peerId}),/override/);
  assert.throws(()=>invoke('create_task',{agent_id:agentId}),/allowed|permitted|disabled|exposed|enabled/i);
  assert.throws(()=>guardedInvoke(mailbox,{unattended:true,agentId})('join_team',{}),/cannot join/);
  assert.deepEqual(await invoke('check_inbox',{agent_id:agentId}),{agent_id:agentId});
  assert.equal(calls,1);
});
test('restricted outbox replay leaves excluded operations pending and only dispatches allowed messages',async t=> {
  const directory=await temporary(t);
  const input={agent_id:agentId,request_id:'pending-task',title:'Example'};
  await assert.rejects(runDurable({directory,tool:'create_task',args:input,invoke:async()=>{throw new Error('uncertain');}}));
  await assert.rejects(runDurable({directory,tool:'send_message',args:{agent_id:agentId,request_id:'pending-message',to:peerId,body:'Public example'},invoke:async()=>{throw new Error('uncertain');}}));
  let sends=0;
  const invoke=guardedInvoke({send:async()=>{sends++;return {id:'sent'};},createTask:()=>{throw new Error('Must not execute');}},{unattended:true,agentId,allowedTools:['check_inbox','send_message','acknowledge_message']});
  const result=await replayOutbox({directory,agentId,invoke});
  assert.equal(result.operations.find(x=>x.tool==='create_task').status,'pending');
  assert.equal(result.operations.find(x=>x.tool==='send_message').status,'delivered');
  assert.equal(sends,1);
});
