import test from 'node:test';
import assert from 'node:assert/strict';
import { Mailbox } from '../mailbox.mjs';
import { emptyState } from '../github.mjs';
import { call } from '../tools.mjs';

async function fixture() {
  const now=Date.parse('2026-01-01T00:00:00Z');
  const store={state:emptyState(),revision:0,async read(){return {state:structuredClone(this.state),sha:this.revision};},async write(state,sha){if(sha!==this.revision)throw Object.assign(new Error('Conflict'),{status:409});this.state=structuredClone(state);this.revision++;}};
  let policy={owner:'alice',allowed_kinds:['implementation'],allowed_paths:['src'],allow_unassigned:false,max_active_tasks:10,max_chain_depth:3,max_handoffs:3,max_task_minutes:120,expires_at:'2026-01-02T00:00:00Z'};
  const box=new Mailbox(store,'alice',()=>now,async()=>policy);
  const worker=(await box.join({label:'Builder',task:'Synthetic decision workflow'})).id;
  const peer=(await box.join({label:'Peer',task:'Synthetic decision workflow'})).id;
  const invoke=(name,args={})=>call(box,name,{agent_id:worker,...args});
  const create=(key,extra={})=>invoke('create_task',{title:key,description:'Fixture implementation',acceptance:['Fixture checks pass'],kind:'implementation',paths:['src'],assignee_id:worker,request_id:key,...extra});
  const update=(task,action,extra={})=>invoke('update_task',{task_id:task.id,expected_revision:task.revision,request_id:action+'-'+task.id+'-'+task.revision,action,summary:'Observed synthetic evidence',...extra});
  const request=(tasks,extra={})=>invoke('request_decision',{issue_key:'fixture-choice',required_responders:[worker],question:'Choose compatible parser',options:[{id:'a',label:'Simple',tradeoffs:'Fewer options'},{id:'b',label:'Flexible',tradeoffs:'More complexity'}],evidence:['fixture:test'],task_refs:tasks.map(t=>({task_id:t.id,revision:t.revision})),blocked_task_ids:tasks.map(t=>t.id),deadline:'2026-01-01T01:00:00Z',request_id:'question',...extra});
  const resolve=(decision,extra={})=>invoke('resolve_decision',{decision_id:decision.id,expected_revision:decision.revision,request_id:'answer',option_id:'a',rationale:'Within task scope',authorization_evidence:['Existing local authorization'],...extra});
  const adopt=(task,decision,extra={})=>update(task,'adopt_decision',{decision_id:decision.id,decision_digest:decision.digest,expected_decision_revision:decision.revision,...extra});
  return {store,worker,peer,invoke,create,update,request,resolve,adopt,get policy(){return policy;},set policy(value){policy=value;}};
}

test('public tools selectively gate ordinary progress, completion, assignment and check_task until adoption',async()=>{
  const f=await fixture();let t=await f.update(await f.create('work'),'accept');const independent=await f.update(await f.create('independent'),'accept');
  let d=await f.request([t]);
  for(const action of ['progress','complete'])await assert.rejects(f.update(t,action),/Decision .*open/);
  const checked=await f.invoke('check_task',{task_id:t.id});assert.equal(checked.allowed,false);assert.match(checked.reasons.join(),/Decision/);
  assert.equal((await f.invoke('check_task',{task_id:independent.id})).allowed,true);
  assert.equal((await f.update(independent,'progress')).status,'in_progress');
  d=await f.resolve(d);await assert.rejects(f.update(t,'complete'),/resolved.*adopt/);
  t=await f.adopt(t,d);assert.equal(t.status,'in_progress');assert.equal(t.decisionReceipts[0].actorId,f.worker);
  assert.equal((await f.invoke('check_task',{task_id:t.id})).allowed,true);
  assert.equal((await f.update(t,'complete')).status,'completed');
  const ready=await f.create('ready');await f.request([ready],{issue_key:'assignment',request_id:'assignment'});
  await assert.rejects(f.update(ready,'assign',{assignee_id:f.peer}),/Decision/);
});

test('human report cannot bypass adoption policy and adoption preserves blocked status with idempotent retry',async()=>{
  const f=await fixture();let t=await f.update(await f.create('work'),'accept');t=await f.update(t,'block');
  let d=await f.request([t],{category:'access'});d=await f.resolve(d,{authority:'human_report'});
  assert.equal(d.resolution.humanConsentVerified,false);
  const original=f.policy;f.policy=null;await assert.rejects(f.adopt(t,d),/local policy/);
  f.policy={...original,allowed_paths:['outside']};await assert.rejects(f.adopt(t,d),/local policy/);
  f.policy=original;
  const adopted=await f.adopt(t,d);assert.equal(adopted.status,'blocked');assert.equal(adopted.revision,t.revision+1);
  const revision=f.store.revision;assert.deepEqual(await f.adopt(t,d),adopted);assert.equal(f.store.revision,revision);
  assert.equal((await f.update(adopted,'resume')).status,'in_progress');
});

test('one task adoption does not invalidate another adoption but actual progress does',async()=>{
  const f=await fixture();let first=await f.update(await f.create('one'),'accept');let second=await f.update(await f.create('two'),'accept');
  const d=await f.resolve(await f.request([first,second]));first=await f.adopt(first,d);
  assert.equal((await f.invoke('get_decision',{decision_id:d.id})).status,'resolved');
  second=await f.adopt(second,d);assert.equal(second.decisionReceipts[0].digest,d.digest);
  await f.update(first,'progress');assert.equal((await f.invoke('get_decision',{decision_id:d.id})).status,'superseded');
  assert.equal((await f.update(second,'progress')).status,'in_progress');
});

test('changed context before remaining adoption requires explicit reassessment',async()=>{
  const f=await fixture();let first=await f.update(await f.create('one'),'accept');const second=await f.update(await f.create('two'),'accept');
  const d=await f.resolve(await f.request([first,second]));first=await f.adopt(first,d);await f.update(first,'progress');
  await assert.rejects(f.adopt(second,d),/resolved and current/);
  assert.equal((await f.invoke('check_task',{task_id:second.id})).allowed,false);
});

test('independent decisions on one task can each be adopted without artificial reassessment',async()=>{
  const f=await fixture();let t=await f.update(await f.create('work'),'accept');
  const a=await f.resolve(await f.request([t]));
  const b=await f.resolve(await f.request([t],{issue_key:'other-choice',request_id:'other-question'}),{request_id:'other-answer'});
  t=await f.adopt(t,a);assert.equal((await f.invoke('get_decision',{decision_id:b.id})).status,'resolved');
  t=await f.adopt(t,b);assert.equal(t.decisionReceipts.length,2);
  assert.equal((await f.invoke('get_decision',{decision_id:a.id})).status,'resolved');
  assert.equal((await f.invoke('check_task',{task_id:t.id})).allowed,true);
});

test('ordinary task work rechecks current policy after decision adoption',async()=>{
  const f=await fixture();let t=await f.update(await f.create('work'),'accept');t=await f.adopt(t,await f.resolve(await f.request([t])));
  const original=f.policy;
  for(const invalid of [null,{...original,allowed_paths:['outside']},{...original,expires_at:'2025-12-31T00:00:00Z'}]) {
    f.policy=invalid;
    for(const action of ['progress','complete'])await assert.rejects(f.update(t,action),/policy|approval|scope/i);
  }
  f.policy=original;assert.equal((await f.update(t,'complete')).status,'completed');
});
