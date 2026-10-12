import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,rm,readdir,writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runDurable,replayOutbox,supportsDurable } from '../outbox.mjs';

const args={agent_id:'alice/worker',task_id:'task',expected_revision:1,request_id:'accept',action:'accept',summary:'Starting'};
async function fixture(t) {
  const directory=await mkdtemp(join(tmpdir(),'relay-outbox-'));
  t.after(()=>rm(directory,{recursive:true,force:true})); return directory;
}
const interrupted=async()=>{ throw new Error('Private server detail'); };
test('failed delivery persists exact input across restart and successful replay is skipped thereafter',async t=>{
  const directory=await fixture(t);
  await assert.rejects(runDurable({directory,tool:'update_task',args,invoke:interrupted}));
  const invocations=[];
  const invoke=async(tool,input)=>invocations.push({tool,input});
  const first=await replayOutbox({directory,agentId:args.agent_id,invoke});
  assert.equal(first.operations[0].status,'delivered');
  assert.deepEqual(invocations,[{tool:'update_task',input:args}]);
  assert.deepEqual((await replayOutbox({directory,agentId:args.agent_id,invoke})).operations,[]);
  assert.equal(invocations.length,1);
});
test('same key rejects different payload, canonical ordering matches, separate task keys do not collide',async t=>{
  const directory=await fixture(t), invoke=async()=>({ok:true});
  await runDurable({directory,tool:'update_task',args,invoke});
  await assert.rejects(runDurable({directory,tool:'update_task',args:{...args,summary:'Changed'},invoke}),/different content/);
  assert.deepEqual(await runDurable({directory,tool:'update_task',args:Object.fromEntries(Object.entries(args).reverse()),invoke}),{ok:true});
  await runDurable({directory,tool:'update_task',args:{...args,task_id:'other'},invoke});
  assert.equal((await readdir(directory)).filter(f=>f.endsWith('.json')).length,2);
});
test('concurrent different payload cannot replace the first immutable operation',async t=>{
  const directory=await fixture(t), sent=[];
  const outcomes=await Promise.allSettled([args,{...args,summary:'Other'}].map(input=>runDurable({directory,tool:'update_task',args:input,invoke:async(_tool,a)=>sent.push(a)})));
  assert.equal(outcomes.filter(r=>r.status==='fulfilled').length,1);
  assert.equal(sent.length,1);
});
test('explicit retry rejects corrupt delivery marker before invoking again',async t=>{
  const directory=await fixture(t);
  let calls=0;
  const invoke=async()=>{calls++;};
  await runDurable({directory,tool:'update_task',args,invoke});
  const marker=(await readdir(directory)).find(f=>f.endsWith('.done'));
  await writeFile(join(directory,marker),'invalid');
  await assert.rejects(runDurable({directory,tool:'update_task',args,invoke}),/delivery marker/);
  assert.equal(calls,1);
});
test('capacity races retain immutable records for every potentially delivered operation',async t=>{
  const directory=await fixture(t);
  for(let i=0;i<499;i++)await writeFile(join(directory,`placeholder-${i}.json`),'{}');
  const invocations=[];
  // Race different payload keys and same-key retries near the cap. No caller
  // may remove a payload another caller could have started delivering.
  const calls=Array.from({length:24},(_,i)=>({...args,task_id:'race-'+(i%12)}));
  await Promise.allSettled(calls.map(input=>runDurable({directory,tool:'update_task',args:input,invoke:async(_tool,sent)=>{
    invocations.push(sent.task_id); throw new Error('Unconfirmed delivery');
  }})));
  const files=(await readdir(directory)).filter(f=>f.endsWith('.json')&&!f.startsWith('placeholder-'));
  const {readFile}=await import('node:fs/promises');
  const persisted=await Promise.all(files.map(async file=>JSON.parse(await readFile(join(directory,file),'utf8')).args.task_id));
  for(const id of invocations)assert.ok(persisted.includes(id),'Potentially delivered input must remain recoverable');
  // Every distinct key that reached persistence stays present, even if it was
  // over capacity; recovery requires deliberate archival rather than deletion.
  assert.ok(files.length>=1);
});
test('replay ignores foreign workers, sanitizes failures and validates entire outbox before invocation',async t=>{
  const directory=await fixture(t);
  await assert.rejects(runDurable({directory,tool:'update_task',args,invoke:interrupted}));
  assert.deepEqual((await replayOutbox({directory,agentId:'bob/worker',invoke:interrupted})).operations,[]);
  const failure=await replayOutbox({directory,agentId:args.agent_id,invoke:interrupted});
  assert.equal(failure.operations[0].status,'pending');
  assert.equal(JSON.stringify(failure).includes('Private server'),false);
  await writeFile(join(directory,'bad.json'),'{bad');
  let calls=0;
  await assert.rejects(replayOutbox({directory,agentId:args.agent_id,invoke:async()=>calls++}),/Invalid outbox/);
  assert.equal(calls,0);
});
test('allowlist, byte limits, record capacity and replay batch size are enforced',async t=>{
  const directory=await fixture(t);
  for (const tool of ['join_team','update_agent','report_worker_health','run_shell']) {
    assert.equal(supportsDurable(tool,args),false);
    await assert.rejects(runDurable({directory,tool,args,invoke:interrupted}),/does not support/);
  }
  await assert.rejects(runDurable({directory,tool:'update_task',args:{...args,summary:'x'.repeat(102400)},invoke:interrupted}),/100 KB/);
  for (let i=0;i<21;i++) await assert.rejects(runDurable({directory,tool:'update_task',args:{...args,task_id:String(i)},invoke:interrupted}));
  const batch=await replayOutbox({directory,agentId:args.agent_id,invoke:async()=>{}});
  assert.equal(batch.operations.length,20); assert.equal(batch.hasMore,true);
  assert.equal((await replayOutbox({directory,agentId:args.agent_id,invoke:async()=>{}})).operations.length,1);
  for (let i=21;i<500;i++) await writeFile(join(directory,`placeholder-${i}.json`),'{}');
  await assert.rejects(runDurable({directory,tool:'update_task',args:{...args,task_id:'overflow'},invoke:interrupted}),/Outbox full/);
});
