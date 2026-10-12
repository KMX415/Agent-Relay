import test from 'node:test';
import assert from 'node:assert/strict';
import { Mailbox } from '../mailbox.mjs';
import { emptyState } from '../github.mjs';
import { call, tools } from '../tools.mjs';
import { supportsDurable } from '../outbox.mjs';

async function fixture(){
  let state=emptyState(),revision=0;
  const now=1000000000000;
  const store={async read(){return {state:structuredClone(state),sha:revision};},async write(s,r){assert.equal(r,revision);state=structuredClone(s);revision++;}};
  const policy={allowed_kinds:['implementation','review'],allowed_paths:['src'],allow_unassigned:false,max_active_tasks:10,max_chain_depth:5,max_handoffs:5,max_task_minutes:60,expires_at:new Date(now+3600000).toISOString()};
  const m=new Mailbox(store,'team',()=>now,async()=>policy);
  const a=(await m.join({label:'Builder',task:'test'})).id,b=(await m.join({label:'Reviewer',task:'test'})).id;
  for(const id of [a,b])await m.updateAgent({agent_id:id,expected_revision:0,provider:'test',capabilities:['review'],paths:['src']});
  const goal=await call(m,'create_goal',{agent_id:a,title:'Verified parser',description:'One bounded outcome',acceptance:['Reviewed parser passes tests'],participants:[a,b],allowed_kinds:['implementation','review'],allowed_paths:['src'],max_tasks:2,max_concurrent:1,max_usage_units:20,deadline:new Date(now+3600000).toISOString(),request_id:'goal'});
  return {m,a,b,goal,now};
}
test('tool-dispatched budgeted goal discovers work, permits peer advice, and completes with settled evidence',async()=>{
  const {m,a,b,goal,now}=await fixture();
  let task=await call(m,'create_task',{agent_id:a,goal_id:goal.id,title:'Parser',description:'Build parser',acceptance:['Tests'],paths:['src'],assignee_id:a,request_id:'task'});
  const reservation=await call(m,'reserve_goal_usage',{agent_id:a,goal_id:goal.id,task_id:task.id,expected_revision:1,units:10,request_id:'reserve'});
  const update=async action=>task=await call(m,'update_task',{agent_id:a,task_id:task.id,expected_revision:task.revision,request_id:action,action,summary:'Observed '+action});
  await update('accept');await update('block');
  let help=await call(m,'request_peer_help',{agent_id:a,task_id:task.id,expected_task_revision:task.revision,recipient_id:b,max_attempts:1,deadline:new Date(now+600000).toISOString(),summary:'Review edge case',request_id:'help'});
  const queue=await call(m,'next_actions',{agent_id:b});
  assert.equal(queue.actions.find(x=>x.kind==='inspect_peer_help').status,'actionable');
  help=await call(m,'advance_peer_help',{agent_id:b,help_id:help.id,expected_revision:help.revision,expected_task_revision:task.revision,action:'respond',summary:'Inspect empty token',evidence:['fixture result'],request_id:'answer'});
  const final=await call(m,'next_actions',{agent_id:a});
  assert.equal(final.actions.find(x=>x.kind==='inspect_peer_help').status,'actionable');
  await call(m,'advance_peer_help',{agent_id:a,help_id:help.id,expected_revision:help.revision,expected_task_revision:task.revision,action:'resolve',summary:'Advice verified',evidence:['edge case test'],request_id:'resolved'});
  assert.equal((await m.getTask({agent_id:a,task_id:task.id})).status,'blocked');
  await update('resume');await update('complete');
  await call(m,'settle_goal_usage',{agent_id:a,goal_id:goal.id,reservation_id:reservation.id,expected_revision:2,actual_units:8,evidence:'Observed host usage',request_id:'settle'});
  const done=await call(m,'update_goal',{agent_id:a,goal_id:goal.id,expected_revision:3,action:'complete',summary:'Outcome verified',evidence:['Parser reviewed and tests passed'],request_id:'done'});
  assert.equal(done.status,'completed');
  assert((await m.listNotifications({agent_id:a})).notifications.some(n=>n.kind==='goal_completed'));
});
test('all new coordination writes are discoverable through MCP and durable CLI dispatch',()=>{
  for(const name of ['create_goal','update_goal','reserve_goal_usage','settle_goal_usage','request_peer_help','advance_peer_help','record_skill_validation','begin_worker_run','finish_worker_run']){
    assert(tools.some(t=>t.name===name),name);
    assert(supportsDurable(name,{agent_id:'a',request_id:'stable'}),name);
  }
});
