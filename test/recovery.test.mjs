import test from 'node:test';
import assert from 'node:assert/strict';
import { Mailbox } from '../mailbox.mjs';
import { emptyState } from '../github.mjs';
import { saveCheckpoint,getRecovery,reportWorkerHealth,teamHealth } from '../recovery.mjs';

class Store {
  state=emptyState(); revision=0;
  async read() { return {state:structuredClone(this.state),sha:this.revision}; }
  async write(state,sha) {
    if (sha!==this.revision) throw Object.assign(new Error('Conflict'),{status:409});
    this.state=structuredClone(state); this.revision++;
  }
}
async function setup() {
  const store=new Store(); let now=100000000;
  const alice=new Mailbox(store,'alice',()=>now), bob=new Mailbox(store,'bob',()=>now);
  for (const mailbox of [alice,bob]) Object.assign(mailbox,{saveCheckpoint,getRecovery,reportWorkerHealth,teamHealth});
  const a=(await alice.join({label:'Builder',task:'Build'})).id, b=(await bob.join({label:'Reviewer',task:'Review'})).id;
  const task=await alice.createTask({agent_id:a,title:'Build',description:'A change',acceptance:['Tests'],assignee_id:a,request_id:'create'});
  const active=await alice.updateTask({agent_id:a,task_id:task.id,expected_revision:1,request_id:'accept',action:'accept',summary:'Started'});
  const input={agent_id:a,task_id:task.id,expected_revision:0,expected_task_revision:active.revision,request_id:'checkpoint',summary:'Implemented parser',next_steps:['Run tests'],artifacts:['branch/feature']};
  return {store,alice,bob,a,b,task:active,input,advance:minutes=>now+=minutes*60000};
}
test('checkpoints survive a new process and retry after later changes without duplicate writes',async()=>{
  const {store,alice,a,input}=await setup();
  await alice.saveCheckpoint(input);
  await alice.saveCheckpoint({...input,expected_revision:1,request_id:'second',summary:'Tests running'});
  const before=store.revision;
  assert.equal((await alice.saveCheckpoint(input)).revision,2);
  assert.equal(store.revision,before);
  await assert.rejects(alice.saveCheckpoint({...input,summary:'Changed'}),/different content/);
  const restored=new Mailbox(store,'alice');
  const recovery=await getRecovery.call(restored,{agent_id:a});
  assert.equal(recovery.checkpoints[0].summary,'Tests running');
  assert.equal(recovery.checkpoints[0].needsRevalidation,false);
  assert.equal(recovery.checkpoints[0].history[0].requestId,undefined);
});
test('concurrent checkpoint writers have one winner and task changes require revalidation',async()=>{
  const {alice,a,input,task}=await setup();
  const results=await Promise.allSettled([alice.saveCheckpoint(input),alice.saveCheckpoint({...input,request_id:'other',summary:'Different progress'})]);
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
  assert.match(results.find(r=>r.status==='rejected').reason.message,/revision changed/);
  await alice.updateTask({agent_id:a,task_id:task.id,expected_revision:task.revision,request_id:'progress',action:'progress',summary:'Updated'});
  assert.equal((await alice.getRecovery({agent_id:a})).checkpoints[0].needsRevalidation,true);
  await assert.rejects(alice.saveCheckpoint({...input,expected_revision:1,request_id:'stale'}),/Task revision changed/);
});
test('ownership, accepted state and bounds protect checkpoints without losing old records',async()=>{
  const {store,alice,bob,a,b,input,task}=await setup();
  await assert.rejects(bob.saveCheckpoint(input),/identity/);
  await assert.rejects(bob.saveCheckpoint({...input,agent_id:b}),/assigned active task/);
  await assert.rejects(alice.saveCheckpoint({...input,next_steps:[]}),/next_steps/);
  await assert.rejects(alice.saveCheckpoint({...input,expected_revision:-1}),/revision/);
  await assert.rejects(alice.saveCheckpoint({...input,summary:'x'.repeat(4001)}),/summary/);
  await alice.saveCheckpoint(input);
  store.state.checkpoints[0].history=Array.from({length:30},(_,i)=>({requestId:String(i)}));
  await assert.rejects(alice.saveCheckpoint({...input,expected_revision:1,request_id:'full'}),/history full/);
  assert.equal(store.state.checkpoints[0].history.length,30);
  store.state.checkpoints=Array.from({length:500},(_,i)=>({agentId:a,taskId:String(i),revision:1,history:[]}));
  await assert.rejects(alice.saveCheckpoint(input),/registry full/);
  await alice.updateTask({agent_id:a,task_id:task.id,expected_revision:task.revision,request_id:'finish',action:'complete',summary:'Done'});
  await assert.rejects(alice.saveCheckpoint(input),/assigned active task/);
});
test('recovery only returns addressed actionable unread messages and never mutates',async()=>{
  const {store,alice,bob,a,b,task}=await setup();
  await bob.send({agent_id:b,to:a,kind:'question',body:'Question',request_id:'q'});
  await bob.send({agent_id:b,to:'alice',kind:'handoff',body:'Handoff',request_id:'h'});
  await bob.send({agent_id:b,to:'team',kind:'review_request',body:'Review',request_id:'r'});
  await bob.send({agent_id:b,to:a,kind:'answer',body:'Answer',request_id:'a'});
  await alice.send({agent_id:a,to:b,kind:'question',body:'Outgoing',request_id:'out'});
  await alice.acknowledge({agent_id:a,message_id:store.state.messages[0].id});
  const before=JSON.stringify(store.state), recovery=await alice.getRecovery({agent_id:a});
  assert.deepEqual(recovery.messages.map(m=>m.kind),['handoff','review_request']);
  assert.equal(recovery.tasks[0].id,task.id);
  assert.equal(JSON.stringify(store.state),before);
  await assert.rejects(bob.getRecovery({agent_id:a}),/identity/);
});
test('worker health reports are owned, revision guarded and stale by expected interval',async()=>{
  const {store,alice,bob,a,advance}=await setup();
  const input={agent_id:a,expected_revision:0,scheduler_status:'enabled',expected_interval_minutes:20};
  await assert.rejects(bob.reportWorkerHealth(input),/identity/);
  await assert.rejects(alice.reportWorkerHealth({...input,expected_interval_minutes:0}),/interval/);
  await assert.rejects(alice.reportWorkerHealth({...input,expected_interval_minutes:undefined}),/requires/);
  const outcomes=await Promise.allSettled([alice.reportWorkerHealth(input),alice.reportWorkerHealth(input)]);
  assert.equal(outcomes.filter(r=>r.status==='fulfilled').length,1);
  assert.equal((await alice.teamHealth()).diagnostics.some(d=>d.agentId===a&&d.code==='worker_report_stale'),false);
  advance(39);
  assert.equal((await alice.teamHealth()).diagnostics.some(d=>d.agentId===a&&d.code==='worker_report_stale'),false);
  advance(1);
  const before=JSON.stringify(store.state);
  assert.equal((await alice.teamHealth()).diagnostics.some(d=>d.agentId===a&&d.code==='worker_report_stale'),true);
  assert.equal(JSON.stringify(store.state),before);
});
test('health diagnostics detect stale work, expired profiles, orphan assignments and skill failures',async()=>{
  const {store,alice,a,b,advance}=await setup();
  await alice.updateAgent({agent_id:a,expected_revision:0,provider:'test',lease_minutes:1});
  const task=await alice.createTask({agent_id:a,title:'Review',description:'Review change',acceptance:['Read'],assignee_id:b,request_id:'review'});
  advance(30);
  delete store.state.agents[b];
  store.state.skills=[{id:'skill',status:'published',version:1,uses:[{actorId:a,taskId:'one',outcome:'failure'},{actorId:a,taskId:'two',outcome:'failure'}]}];
  store.state.reviewCycles=[{id:'cycle',taskId:task.id,phase:'exhausted'}];
  const result=await alice.teamHealth();
  for (const code of ['availability_expired','worker_health_unknown','orphan_assignee','acceptance_stalled','task_stalled','skill_repeated_failures','review_cycle_exhausted']) assert.ok(result.diagnostics.some(d=>d.code===code),code);
  await assert.rejects(alice.teamHealth({stale_minutes:0}),/stale_minutes/);
});

test('recovery tracks routing initiated by a worker other than task creator',async()=>{
  const {store,alice,bob,a,b}=await setup();
  const task=await bob.createTask({agent_id:b,title:'Delegated',description:'Review',acceptance:['Checked'],request_id:'delegated'});
  store.state.tasks.find(t=>t.id===task.id).routing={requestedBy:a,assigneeId:b,acceptBy:123};
  const pending=(await alice.getRecovery({agent_id:a})).pendingTasks;
  assert.equal(pending.length,1);
  assert.equal(pending[0].id,task.id);
});

test('recovery discovers participant review cycles and relevant pending skill improvements',async()=>{
  const {store,alice,a,b}=await setup();
  store.state.reviewCycles=[{id:'review',builderId:b,reviewerId:a,phase:'awaiting_review'},{id:'other',builderId:b,reviewerId:b}];
  store.state.skills=[{id:'skill',createdBy:a}];
  store.state.skillImprovements=[{id:'proposal',skillId:'skill',createdBy:b,status:'proposed'},{id:'other',skillId:'unknown',createdBy:b,status:'proposed'}];
  const recovery=await alice.getRecovery({agent_id:a});
  assert.deepEqual(recovery.reviewCycles.map(c=>c.id),['review']);
  assert.deepEqual(recovery.skillImprovements.map(p=>p.id),['proposal']);
});
