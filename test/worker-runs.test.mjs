import test from 'node:test';
import assert from 'node:assert/strict';
import { Mailbox } from '../mailbox.mjs';
import { emptyState } from '../github.mjs';
async function setup(){
  let state=emptyState(),rev=0,now=100000;
  const store={async read(){return {state:structuredClone(state),sha:rev};},async write(s,r){if(r!==rev)throw Object.assign(new Error('CAS'),{status:409});state=structuredClone(s);rev++;}};
  const m=new Mailbox(store,'alice',()=>now),b=new Mailbox(store,'bob',()=>now);
  const a=(await m.join({label:'a',task:'test'})).id;
  const other=(await b.join({label:'b',task:'test'})).id;
  const input={agent_id:a,request_id:'wake-1',host:'test-host',provider:'cursor',trigger:'scheduled',schedule_id:'host-schedule',scheduler_run_id:'observed-1',evidence:['Host run log 1'],lease_minutes:1};
  return {m,b,a,other,input,advance:()=>now+=61000};
}
test('run lease serializes concurrent wakes and exact retry does not renew it',async()=>{
  const {m,input}=await setup();
  const results=await Promise.allSettled([m.beginWorkerRun(input),m.beginWorkerRun({...input,request_id:'wake-2',scheduler_run_id:'observed-2'})]);
  assert.equal(results.filter(x=>x.status==='fulfilled').length,1);
  const run=results.find(x=>x.status==='fulfilled').value;
  assert.equal((await m.beginWorkerRun(input)).leaseUntil,run.leaseUntil);
  await assert.rejects(m.beginWorkerRun({...input,host:'changed'}),/different content/);
});
test('expired run remains interrupted; late reports cannot prove completion or block later wake',async()=>{
  const {m,input,advance}=await setup();const run=await m.beginWorkerRun(input);advance();
  assert.equal((await m.listWorkerRuns({agent_id:input.agent_id})).runs[0].effectiveStatus,'interrupted');
  const result=await m.finishWorkerRun({agent_id:input.agent_id,run_id:run.id,request_id:'finish',expected_revision:1,status:'completed',summary:'Late result',evidence:['Actual output']});
  assert.equal(result.status,'interrupted');assert.equal(result.reportedOutcome,'completed');
  await m.beginWorkerRun({...input,request_id:'wake-2',scheduler_run_id:'observed-2'});
});
test('scheduled and interactive evidence remain distinct, identities and replay keys enforced',async()=>{
  const {m,b,input,other}=await setup();
  await assert.rejects(m.beginWorkerRun({...input,scheduler_run_id:undefined}),/scheduler_run_id/);
  await assert.rejects(m.beginWorkerRun({...input,trigger:'interactive'}),/Interactive/);
  const run=await m.beginWorkerRun(input);
  await assert.rejects(b.finishWorkerRun({agent_id:other,run_id:run.id,request_id:'f',expected_revision:1,status:'completed',summary:'wrong worker',evidence:['x']}),/not found/);
  const finish={agent_id:input.agent_id,run_id:run.id,request_id:'f',expected_revision:1,status:'completed',summary:'Two approved reads completed',evidence:['tool result record']};
  await m.finishWorkerRun(finish);await m.finishWorkerRun(finish);
  await assert.rejects(m.finishWorkerRun({...finish,summary:'changed'}),/different content/);
  await assert.rejects(m.beginWorkerRun({...input,request_id:'new'}),/already recorded/);
});
test('archival requires finalized exact evidence and preserves replay protection',async()=>{
  const {m,input}=await setup();const run=await m.beginWorkerRun(input);
  const args={agent_id:input.agent_id,run_id:run.id,request_id:'archive',expected_digest:run.archiveDigest,archive_evidence:'runtime/saved-run.json'};
  await assert.rejects(m.archiveWorkerRun(args),/Finalize/);
  const done=await m.finishWorkerRun({agent_id:input.agent_id,run_id:run.id,request_id:'done',expected_revision:1,status:'completed',summary:'Observed result',evidence:['tool output']});
  await assert.rejects(m.archiveWorkerRun(args),/changed/);
  const saved={...args,expected_digest:done.archiveDigest};
  await m.archiveWorkerRun(saved);await m.archiveWorkerRun(saved);
  assert.equal((await m.listWorkerRuns({agent_id:input.agent_id})).runs.length,0);
  await assert.rejects(m.beginWorkerRun(input),/archived/);
  await assert.rejects(m.beginWorkerRun({...input,request_id:'other'}),/archived/);
  await m.beginWorkerRun({...input,request_id:'next',scheduler_run_id:'observed-2'});
});
