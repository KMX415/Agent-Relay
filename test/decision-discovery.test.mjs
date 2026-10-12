import test from 'node:test';
import assert from 'node:assert/strict';
import { nextActions } from '../next-actions.mjs';
import { getRecovery } from '../recovery.mjs';
import { notificationEvents } from '../notifications.mjs';

function fixture() {
  const now=10000000;
  const task={id:'task',revision:1,assigneeId:'a',createdBy:'a',status:'ready',kind:'implementation',paths:['src'],dependsOn:[],requiredCapabilities:[],history:[]};
  const decision={id:'choice',createdBy:'b',requiredResponders:['a','b'],blockedTaskIds:['task'],goalId:null,revision:1,maxRevisions:3,deadline:new Date(now+60000).toISOString(),status:'open',category:'implementation',updatedAt:now,versions:[{number:1,digest:'digest',taskRefs:[{task_id:'task',revision:1}],responses:[],question:'A or B?',options:[],evidence:[]}]};
  const state={agents:{a:{id:'a',owner:'owner'},b:{id:'b',owner:'owner'},c:{id:'c',owner:'owner'}},tasks:[task],decisions:[decision],messages:[],claims:[]};
  const host={store:{read:async()=>({state})},now:()=>now,actor:(s,id)=>s.agents[id],readPolicy:async()=>null};
  const actions=async id=>(await nextActions.call(host,{agent_id:id})).actions.filter(a=>a.kind==='inspect_decision');
  return {state,task,decision,host,actions,now};
}

test('decision discovery is addressed, read-only, and distinguishes pending conflict and adoption',async()=>{
  const f=fixture(),before=JSON.stringify(f.state);
  assert.equal((await f.actions('a'))[0].status,'actionable');
  assert.deepEqual(await f.actions('c'),[]);
  assert.equal((await getRecovery.call(f.host,{agent_id:'a'})).decisions.length,1);
  assert.equal((await getRecovery.call(f.host,{agent_id:'c'})).decisions.length,0);
  assert.equal(JSON.stringify(f.state),before);
  f.decision.versions[0].responses=[{actorId:'a',optionId:'one',authority:'human_report'}];
  assert.equal((await f.actions('a'))[0].status,'waiting');
  f.decision.versions[0].responses.push({actorId:'b',optionId:'two',authority:'human_report'});
  assert.match((await f.actions('a'))[0].reason,/conflict/);
  f.decision.status='resolved';
  assert.match((await f.actions('a'))[0].reason,/explicitly adopt/);
  f.task.decisionReceipts=[{decisionId:'choice',version:1,digest:'digest',actorId:'a'}];
  assert.deepEqual(await f.actions('a'),[]);
  f.task.assigneeId='c';
  assert.equal((await f.actions('c'))[0].status,'actionable');
});

test('decision notifications suppress routine responses and deduplicate meaningful version conditions',()=>{
  const f=fixture();
  assert.deepEqual(notificationEvents(f.state,'a',f.now),[]);
  f.decision.category='access';
  const initial=notificationEvents(f.state,'a',f.now)[0];
  assert.equal(initial.kind,'decision_human_required');
  f.decision.revision++;
  f.decision.versions[0].responses.push({actorId:'b',optionId:'one'});
  assert.equal(notificationEvents(f.state,'a',f.now)[0].id,initial.id);
  assert.deepEqual(notificationEvents(f.state,'c',f.now),[]);
  f.decision.versions[0].responses.push({actorId:'a',optionId:'two'});
  const conflict=notificationEvents(f.state,'a',f.now)[0];
  assert.equal(conflict.kind,'decision_conflict');
  assert.notEqual(conflict.id,initial.id);
  f.decision.status='resolved';
  assert.equal(notificationEvents(f.state,'a',f.now)[0].kind,'decision_resolved');
  f.task.revision++;
  assert.equal(notificationEvents(f.state,'a',f.now)[0].kind,'decision_superseded');
});

test('expired and stale decisions are inspectable blockers without execution suggestions',async()=>{
  const f=fixture();
  f.decision.deadline=new Date(f.now).toISOString();
  assert.equal((await f.actions('a'))[0].status,'blocked');
  assert.equal(notificationEvents(f.state,'a',f.now)[0].kind,'decision_expired');
  f.task.revision++;
  const entry=(await f.actions('a'))[0];
  assert.equal(entry.inspect.tool,'get_decision');
  assert.equal(entry.status,'blocked');
  assert.equal((await getRecovery.call(f.host,{agent_id:'a'})).decisions[0].status,'superseded');
});

test('an open stale vote requests its exact responder to refresh authorization',async()=>{
  const f=fixture();
  f.decision.versions[0].responses=[{actorId:'a',optionId:'one',authority:'agent',policyExpiresAt:new Date(f.now-1).toISOString(),agreementIds:[]}];
  const entry=(await f.actions('a'))[0];
  assert.equal(entry.status,'actionable');
  assert.match(entry.reason,/refresh only your own/);
});

test('consumed resolved questions stay quiet after progress but a new assignee sees the stale gate',async()=>{
  const f=fixture();f.decision.status='resolved';
  f.task.decisionReceipts=[{decisionId:'choice',version:1,digest:'digest',actorId:'a'}];
  f.task.revision=3;
  assert.deepEqual(await f.actions('a'),[]);
  assert.deepEqual(await f.actions('b'),[]);
  assert.deepEqual(notificationEvents(f.state,'a',f.now),[]);
  assert.equal((await getRecovery.call(f.host,{agent_id:'a'})).decisions[0].status,'superseded');
  f.task.assigneeId='c';
  assert.equal((await f.actions('c'))[0].status,'blocked');
  assert.equal(notificationEvents(f.state,'c',f.now)[0].kind,'decision_superseded');
});
