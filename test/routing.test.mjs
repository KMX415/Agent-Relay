import test from 'node:test';
import assert from 'node:assert/strict';
import { Mailbox } from '../mailbox.mjs';
import { emptyState } from '../github.mjs';
import { call } from '../tools.mjs';

async function fixture(policy=null) {
  let now=100000;
  const store={state:emptyState(),rev:0,async read(){return {state:structuredClone(this.state),sha:this.rev};},async write(state,sha){if(sha!==this.rev)throw Object.assign(new Error('Conflict'),{status:409});this.state=structuredClone(state);this.rev++;}};
  const m=new Mailbox(store,'owner',()=>now,async()=>policy),agents=[];
  for(const label of ['sender','one','two']) {
    const a=await m.join({label,task:'Work'});agents.push(a.id);
    await m.updateAgent({agent_id:a.id,expected_revision:0,provider:'test',capabilities:['testing','review'],paths:['src'],lease_minutes:120});
  }
  const [a,b,c]=agents;
  const create=()=>m.createTask({agent_id:a,title:'Test work',description:'Run checks',acceptance:['Pass'],paths:['src/file'],required_capabilities:['testing'],request_id:'create'});
  const route=(t,extra={})=>call(m,'route_task',{agent_id:a,task_id:t.id,expected_revision:t.revision,request_id:'route-'+t.revision,summary:'Route work',next_steps:['Check tests'],timeout_minutes:1,max_attempts:2,...extra});
  const update=(t,action,extra={})=>m.updateTask({agent_id:t.assigneeId,task_id:t.id,expected_revision:t.revision,request_id:action+'-'+t.revision,action,summary:'Recorded',...extra});
  return {store,m,a,b,c,create,route,update,tick:()=>now+=60001};
}
test('routing selects matching workers, waits for acceptance and caps fallback attempts',async()=>{
  const {store,create,route,tick}=await fixture();
  let t=await create();t=(await route(t)).task;
  const first=t.assigneeId;
  assert.equal((await route(t)).reason,'Waiting for acceptance');tick();
  t=(await route(t)).task;assert.notEqual(t.assigneeId,first);assert.equal(t.routing.attempted.length,2);
  tick();assert.match((await route(t)).reason,/limit/);
  assert.equal(store.state.tasks[0].history.length,2);
});
test('accepted work cannot be taken over and consumed delivery permits onward routing',async()=>{
  const {m,a,create,route,update,tick}=await fixture();
  let t=(await route(await create())).task;
  const senderRevision=t.revision;
  t=await update(t,'accept');assert.equal(t.routing,undefined);tick();
  await assert.rejects(route(t),/Only creator/);
  await assert.rejects(route({...t,revision:senderRevision},{request_id:'stale'}),/revision changed/);
  t=(await route(t,{agent_id:t.assigneeId,request_id:'onward'})).task;
  assert.equal(t.status,'ready');assert.notEqual(t.assigneeId,t.routing.requestedBy);
  assert.equal((await m.getTask({agent_id:a,task_id:t.id})).revision,t.revision);
});
test('concurrent acceptance wins over stale routing; route retries never select twice',async()=>{
  const {store,create,route,update,tick}=await fixture();
  const original=await create();const first=await route(original);
  assert.equal((await route(original)).task.assigneeId,first.task.assigneeId);
  await assert.rejects(route(original,{summary:'changed'}),/different content/);
  tick();
  const results=await Promise.allSettled([update(first.task,'accept'),route(first.task)]);
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
  assert.match(results.find(r=>r.status==='rejected').reason.message,/revision changed/);
  assert.equal(store.state.tasks[0].revision,3);
});
test('routing respects bounded paths, availability, policy and immutable limits',async()=>{
  const {store,b,c,create,route,tick}=await fixture();
  store.state.agents[b].profile.paths=['src-other'];store.state.agents[c].profile.availableUntil=0;
  let t=await create();assert.equal((await route(t)).routed,false);
  store.state.agents[b].profile.paths=['src'];t=(await route(t)).task;tick();
  await assert.rejects(route(t,{max_attempts:3}),/limits cannot change/);
  const f=await fixture({allowed_kinds:['testing'],allowed_paths:['src'],allow_unassigned:true,max_chain_depth:2,max_handoffs:2,max_task_minutes:60,max_active_tasks:2,expires_at:'2999-01-01'});
  await assert.rejects(f.route(await f.create()),/category/);
});
