import test from 'node:test';
import assert from 'node:assert/strict';
import { Mailbox } from '../mailbox.mjs';
import { emptyState } from '../github.mjs';
import { call, tools } from '../tools.mjs';
import { supportsDurable } from '../outbox.mjs';

async function fixture() {
  let state=emptyState(),sha=0;
  const store={read:async()=>({state:structuredClone(state),sha}),write:async(next,expected)=>{
    if(expected!==sha)throw Object.assign(new Error('Conflict'),{status:409});
    state=structuredClone(next);sha++;
  }};
  const now=Date.parse('2026-10-12T12:00:00Z');
  const policy={allowed_kinds:['implementation','review'],allowed_paths:['src'],allow_unassigned:false,max_active_tasks:3,max_chain_depth:3,max_handoffs:3,max_task_minutes:60,expires_at:new Date(now+3600000).toISOString()};
  const alice=new Mailbox(store,'alice',()=>now,async()=>policy),bob=new Mailbox(store,'bob',()=>now,async()=>policy);
  const a=(await alice.join({label:'Requester',task:'Collaboration'})).id,b=(await bob.join({label:'Performer',task:'Collaboration'})).id;
  const invoke=(who,name,args={})=>call(who==='a'?alice:bob,name,{agent_id:who==='a'?a:b,...args});
  for(const [who,peer] of [['a','bob'],['b','alice']])await invoke(who,'set_collaboration_agreement',{peer_owner:peer,allowed_kinds:['implementation'],allowed_paths:['src'],expires_at:policy.expires_at,request_id:'agreement'});
  const terms={title:'Implement parser',description:'Scoped peer implementation',acceptance:['Parser fixture passes'],kind:'implementation',paths:['src'],required_capabilities:[]};
  let n=await invoke('a','propose_negotiation',{recipient_id:b,work_id:'parser',terms,deadline:policy.expires_at,max_rounds:3,request_id:'proposal'});
  const respond=(who,action,extra={})=>invoke(who,'advance_negotiation',{negotiation_id:n.id,expected_revision:n.revision,action,summary:'Scoped response',request_id:action+'-'+n.revision,...extra});
  n=await respond('b','counter',{terms:{...terms,paths:['src/parser']}});
  n=await respond('a','accept');
  const task=await invoke('b','get_task',{task_id:n.taskId});
  const update=(t,action,extra={})=>invoke('b','update_task',{task_id:t.id,expected_revision:t.revision,action,summary:'Observed progress',request_id:action+'-'+t.revision,...extra});
  return {invoke,a,b,alice,bob,store,n,task,update};
}

test('public tools negotiate, discover work, verify delivery and complete without dashboard',async()=>{
  const {invoke,a,task,update}=await fixture();
  assert.equal(task.status,'ready');assert.deepEqual(task.paths,['src/parser']);
  assert.ok((await invoke('b','next_actions')).actions.some(e=>e.kind==='accept_task'&&e.status==='actionable'));
  let t=await update(task,'accept');
  await assert.rejects(update(t,'complete'),/handoff/i);
  await assert.rejects(update(t,'handoff',{assignee_id:a,next_steps:['Continue']}),/binding/);
  await assert.rejects(invoke('a','route_task',{task_id:t.id,expected_revision:t.revision,request_id:'route',summary:'Move',next_steps:['Review']}),/Negotiated/);
  const h=await invoke('b','create_handoff',{task_id:t.id,expected_task_revision:t.revision,recipient_id:a,repository:'example/project',commit_sha:'a'.repeat(40),artifacts:[{path:'src/parser/index.mjs',sha256:'b'.repeat(64)}],test_evidence:['Sender reports parser tests passed'],assumptions:['Node 22'],request_id:'manifest'});
  assert.ok((await invoke('a','next_actions')).actions.some(e=>e.kind==='verify_handoff'&&e.status==='actionable'));
  await invoke('a','record_handoff_verification',{handoff_id:h.id,expected_task_revision:t.revision,manifest_digest:h.digest,verdict:'accepted',observed_repository:'example/project',observed_commit:'a'.repeat(40),observed_artifacts:[{path:'src/parser/index.mjs',sha256:'b'.repeat(64),clean:true}],summary:'Recipient observed matching fixture',request_id:'receipt'});
  const payload={handoff_id:h.id};
  t=await update(t,'complete',payload);assert.equal(t.status,'completed');
  assert.equal(t.history.at(-1).handoffId,h.id);
  assert.equal((await update({...t,revision:t.revision-1},'complete',payload)).status,'completed');
});

test('revocation blocks execution suggestions and progress but permits recording a stop',async()=>{
  const {invoke,task,update}=await fixture();
  const t=await update(task,'accept');
  const agreement=(await invoke('a','list_collaboration_agreements')).agreements.find(a=>a.owner==='alice');
  await invoke('a','revoke_collaboration_agreement',{agreement_id:agreement.id,expected_revision:agreement.revision,request_id:'revoke',summary:'Owner ended collaboration'});
  assert.equal((await invoke('b','check_task',{task_id:t.id})).allowed,false);
  assert.ok((await invoke('b','next_actions')).actions.some(e=>e.taskId===t.id&&e.status==='blocked'));
  await assert.rejects(update(t,'progress'),/agreement/i);
  assert.equal((await update(t,'block')).status,'blocked');
});

test('new coordination writes participate in durable outbox and read tools stay read-only',()=>{
  for(const name of ['set_collaboration_agreement','revoke_collaboration_agreement','propose_negotiation','advance_negotiation','create_handoff','record_handoff_verification']) {
    assert.ok(tools.some(t=>t.name===name));
    assert.equal(supportsDurable(name,{agent_id:'worker',request_id:'stable'}),true);
  }
  for(const name of ['get_negotiation','list_negotiations','list_collaboration_agreements','get_handoff','list_handoffs'])assert.equal(tools.find(t=>t.name===name).annotations.readOnlyHint,true);
});

test('negotiated review uses reviewer scope and becomes blocked after agreement revocation',async()=>{
  const {invoke,a,task,update}=await fixture();
  await invoke('a','update_agent',{expected_revision:0,provider:'test',capabilities:['review'],paths:['src']});
  const t=await update(task,'accept');
  const cycle=await invoke('b','start_review_cycle',{task_id:t.id,expected_task_revision:t.revision,reviewer_id:a,request_id:'review',summary:'Review exact work',artifacts:['fixture']});
  assert.ok((await invoke('a','next_actions')).actions.some(e=>e.kind==='review_submission'&&e.status==='actionable'));
  const agreement=(await invoke('a','list_collaboration_agreements')).agreements.find(a=>a.owner==='alice');
  await invoke('a','revoke_collaboration_agreement',{agreement_id:agreement.id,expected_revision:agreement.revision,request_id:'stop',summary:'Scope withdrawn'});
  assert.ok((await invoke('a','next_actions')).actions.some(e=>e.kind==='review_submission'&&e.status==='blocked'));
  await assert.rejects(invoke('a','advance_review_cycle',{cycle_id:cycle.id,expected_revision:cycle.revision,expected_task_revision:t.revision,action:'approve',request_id:'approve',summary:'Review',artifacts:['fixture']}),/agreement/i);
});

test('declined negotiation produces a deduplicated decision without an automatic message',async()=>{
  const {invoke,b,store}=await fixture();
  const n=await invoke('a','propose_negotiation',{recipient_id:b,work_id:'other-work',terms:{title:'Other work',description:'Optional work',acceptance:['Done'],paths:['src']},deadline:'2026-10-12T13:00:00Z',request_id:'other'});
  await invoke('b','advance_negotiation',{negotiation_id:n.id,expected_revision:n.revision,action:'decline',summary:'Outside current priorities',request_id:'decline'});
  const event=(await invoke('a','list_notifications')).notifications.find(e=>e.negotiationId===n.id);
  assert.equal(event.kind,'negotiation_declined');
  await invoke('a','acknowledge_notification',{notification_id:event.id});
  assert.ok(!(await invoke('a','list_notifications')).notifications.some(e=>e.id===event.id));
  assert.equal((await store.read()).state.messages.length,0);
});

test('ordinary progress and completion preserve reporting when local policy becomes unreadable',async()=>{
  const {invoke,b,bob}=await fixture();
  let task=await invoke('b','create_task',{title:'Ordinary work',description:'Existing workflow',acceptance:['Evidence'],paths:['src'],assignee_id:b,request_id:'ordinary'});
  task=await invoke('b','update_task',{task_id:task.id,expected_revision:task.revision,action:'accept',summary:'Start',request_id:'ordinary-accept'});
  bob.readPolicy=async()=>{throw new Error('Unreadable local policy');};
  task=await invoke('b','update_task',{task_id:task.id,expected_revision:task.revision,action:'progress',summary:'Evidence recorded',request_id:'ordinary-progress'});
  const args={task_id:task.id,expected_revision:task.revision,action:'complete',summary:'Done',request_id:'ordinary-complete'};
  assert.equal((await invoke('b','update_task',args)).status,'completed');
  assert.equal((await invoke('b','update_task',args)).status,'completed');
});
