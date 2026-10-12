import test from 'node:test';
import assert from 'node:assert/strict';
import { requestDecision, resolveDecision, getDecision, listDecisions, decisionTaskReasons, decisionView, assertDecisionAdoption } from '../decisions.mjs';

function fixture() {
  let now=Date.parse('2026-01-01T00:00:00Z');
  const ids={alice:'alice/one',bob:'bob/one',other:'bob/two'};
  let state={agents:Object.fromEntries(Object.entries(ids).map(([name,id])=>[id,{id,owner:name==='alice'?'alice':'bob'}])),tasks:[{id:'task',revision:1,kind:'implementation',paths:['src'],assigneeId:ids.alice,createdBy:ids.alice,status:'in_progress',history:[]},{id:'independent',revision:1,kind:'implementation',paths:['src'],assigneeId:ids.bob,createdBy:ids.bob,status:'in_progress',history:[]}],collaborationAgreements:[]};
  const policy=owner=>({owner,allowed_kinds:['implementation'],allowed_paths:['src'],expires_at:'2026-01-02T00:00:00Z'});
  const policies={alice:policy('alice'),bob:policy('bob')};
  const hosts=Object.fromEntries(['alice','bob'].map(owner=>[owner,{now:()=>now,readPolicy:async()=>policies[owner],store:{read:async()=>({state:structuredClone(state)})},actor(s,id){const a=s.agents[id];if(!a||a.owner!==owner)throw new Error('Actor ownership');return a;},async change(fn){const copy=structuredClone(state),value=fn(copy);state=copy;return structuredClone(value);}}]));
  const args={agent_id:ids.alice,issue_key:'parser-choice',required_responders:[ids.alice,ids.bob],question:'Which parser?',options:[{id:'a',label:'A',tradeoffs:'Simple'}, {id:'b',label:'B',tradeoffs:'Flexible'}],evidence:['fixture:test'],task_refs:[{task_id:'task',revision:1}],blocked_task_ids:['task'],deadline:'2026-01-01T01:00:00Z',request_id:'request'};
  const request=(extra={})=>requestDecision.call(hosts.alice,{...args,...extra});
  const respond=(owner,d,extra={})=>resolveDecision.call(hosts[owner],{agent_id:ids[owner],decision_id:d.id,expected_revision:d.revision,request_id:owner+'-'+d.revision,option_id:'a',rationale:'Compatible with current scope',authorization_evidence:['local authorized implementation policy'],...extra});
  const agreements=()=>{state.collaborationAgreements=['alice','bob'].map((owner,i)=>({id:'agreement'+i,owner,peerOwner:owner==='alice'?'bob':'alice',status:'active',expiresAt:'2026-01-02T00:00:00Z',allowedKinds:['implementation'],allowedPaths:['src']}));};
  return {ids,hosts,policies,args,request,respond,agreements,get state(){return state;},tick:ms=>now+=ms,now:()=>now};
}

test('durable decision requires exact unanimous responders and explicitly consumes only selected task gate',async()=>{
  const f=fixture();f.agreements();let d=await f.request();
  assert.equal(decisionTaskReasons(f.state,f.state.tasks[0],f.now()).length,1);
  assert.deepEqual(decisionTaskReasons(f.state,f.state.tasks[1],f.now()),[]);
  d=await f.respond('alice',d);assert.equal(d.status,'open');
  await assert.rejects(f.respond('bob',d,{agent_id:f.ids.other}),/exact designated/);
  d=await f.respond('bob',d,{option_id:'b'});assert.equal(d.status,'open');
  d=await f.respond('bob',d);assert.equal(d.status,'resolved');
  assert.equal(decisionTaskReasons(f.state,f.state.tasks[0],f.now()).length,1);
  const t=f.state.tasks[0];const receipt=assertDecisionAdoption(f.state,d.id,t,f.state.agents[f.ids.alice],f.now(),{expectedDecisionRevision:d.revision,decisionDigest:d.digest});
  t.decisionReceipts=[receipt];t.revision++;t.history.push({action:'adopt_decision',revision:t.revision,...receipt});
  assert.deepEqual(decisionTaskReasons(f.state,t,f.now()),[]);
  assert.equal(decisionView(f.state.decisions[0],f.state,f.now()).status,'resolved');
  t.revision++;t.history.push({action:'progress'});
  assert.equal(decisionView(f.state.decisions[0],f.state,f.now()).status,'superseded');
  assert.deepEqual(decisionTaskReasons(f.state,t,f.now()),[]);
  t.assigneeId=f.ids.bob;
  assert.equal(decisionTaskReasons(f.state,t,f.now()).length,1);
});

test('agent choices require local scope and bilateral agreements; human reports never mutate policy',async()=>{
  const f=fixture();let d=await f.request();await assert.rejects(f.respond('alice',d),/bilateral/);f.agreements();
  f.policies.alice.allowed_paths=['outside'];await assert.rejects(f.respond('alice',d),/policy scope/);
  f.policies.alice=null;await assert.rejects(f.respond('alice',d),/policy/);
  d=await f.respond('alice',d,{authority:'human_report'});assert.equal(d.responses[0].humanConsentVerified,false);
  assert.equal(f.policies.alice,null);
  const g=fixture();g.agreements();const access=await g.request({category:'access'});
  await assert.rejects(g.respond('alice',access),/human answer/);
  const reported=await g.respond('alice',access,{authority:'human_report'});assert.equal(reported.status,'open');assert.equal(reported.responses[0].authority,'human_report');
});

test('duplicate questions and responses preserve identity; payload changes and stale revisions fail',async()=>{
  const f=fixture();f.agreements();const d=await f.request();assert.equal((await f.request()).id,d.id);
  await assert.rejects(f.request({question:'Different'}),/different content/);
  const answered=await f.respond('alice',d);assert.equal((await f.respond('alice',d)).revision,answered.revision);
  await assert.rejects(f.respond('alice',d,{rationale:'Different'}),/different content/);
  await assert.rejects(f.respond('bob',d),/revision changed/);
  await assert.rejects(f.request({request_id:'replacement'}),/cannot reset budget/);
});

test('changed work supersedes decisions and reassessment preserves bounded scope and history',async()=>{
  const f=fixture();f.agreements();let d=await f.request({max_revisions:2});d=await f.respond('alice',d);const old=structuredClone(d.versions[0]);
  f.state.tasks[0].revision++;
  assert.equal((await getDecision.call(f.hosts.alice,{agent_id:f.ids.alice,decision_id:d.id})).status,'superseded');
  await assert.rejects(f.respond('bob',d),/not open/);
  const next={expected_revision:d.revision,task_refs:[{task_id:'task',revision:2}],request_id:'reassess',max_revisions:2};
  await assert.rejects(f.request({...next,blocked_task_ids:[]}),/cannot change scope/);
  d=await f.request(next);assert.equal(d.version,2);assert.deepEqual(d.responses,[]);assert.deepEqual(d.versions[0],old);
  f.state.tasks[0].revision++;
  await assert.rejects(f.request({...next,expected_revision:d.revision,task_refs:[{task_id:'task',revision:3}],request_id:'third'}),/budget exhausted/);
});

test('deadline does not imply consent and expired questions cannot reset their deadline',async()=>{
  const f=fixture();f.agreements();const d=await f.request();f.tick(3600000);
  assert.equal(decisionView(f.state.decisions[0],f.state,f.now()).status,'expired');
  await assert.rejects(f.respond('alice',d),/not open/);
  await assert.rejects(f.request({expected_revision:d.revision,deadline:'2026-01-01T02:00:00Z',request_id:'extend'}),/Only superseded/);
});

test('request cannot freeze another accepted task and input bounds reject malformed options and references',async()=>{
  const f=fixture();await assert.rejects(f.request({task_refs:[{task_id:'independent',revision:1}],blocked_task_ids:['independent']}),/Only own/);
  assert.equal(f.state.decisions,undefined);
  await assert.rejects(f.request({options:[f.args.options[0]]}),/2-5/);
  await assert.rejects(f.request({task_refs:[]}),/1-20/);
  await assert.rejects(f.request({goal_id:'goal'}),/together/);
  await assert.rejects(f.request({blocked_task_ids:['absent']}),/linked tasks/);
  const d=await f.request({blocked_task_ids:[]});assert.equal(d.status,'open');
  assert.deepEqual(decisionTaskReasons(f.state,f.state.tasks[0],f.now()),[]);
});

test('relevant decisions paginate without disclosing unrelated work as participation',async()=>{
  const f=fixture();await f.request();await f.request({issue_key:'another',request_id:'another'});
  const first=await listDecisions.call(f.hosts.bob,{agent_id:f.ids.bob,limit:1});assert.equal(first.decisions.length,1);assert.equal(first.hasMore,true);
  const second=await listDecisions.call(f.hosts.bob,{agent_id:f.ids.bob,limit:1,after:first.nextAfter});assert.equal(second.hasMore,false);
  assert.notEqual(first.decisions[0].id,second.decisions[0].id);
});

test('unassigned ready work cannot be blocked into an unadoptable state',async()=>{
  const f=fixture();f.state.tasks[0].status='ready';f.state.tasks[0].assigneeId=null;
  await assert.rejects(f.request(),/assigned/);assert.equal(f.state.decisions,undefined);
});

test('multiple expired responses can refresh sequentially without deadlock or stale consensus',async()=>{
  const f=fixture();f.agreements();f.policies.alice.expires_at='2026-01-01T00:05:00Z';f.policies.bob.expires_at='2026-01-01T00:05:00Z';
  let d=await f.request();d=await f.respond('alice',d);d=await f.respond('bob',d,{option_id:'b'});f.tick(6*60000);
  assert.deepEqual(decisionView(f.state.decisions[0],f.state,f.now()).staleResponderIds,[f.ids.alice,f.ids.bob]);
  f.policies.alice.expires_at='2026-01-02T00:00:00Z';f.policies.bob.expires_at='2026-01-02T00:00:00Z';
  d=await f.respond('alice',d,{option_id:'b'});assert.equal(d.status,'open');
  d=await f.respond('bob',d,{option_id:'b'});assert.equal(d.status,'resolved');
});

test('changed agreement scope cannot count an earlier vote toward consensus',async()=>{
  const f=fixture();f.agreements();let d=await f.request();d=await f.respond('alice',d);
  f.state.collaborationAgreements[0].allowedPaths=['outside'];
  d=await f.respond('bob',d,{authority:'human_report'});assert.equal(d.status,'open');
  f.state.collaborationAgreements[0].allowedPaths=['src'];
  d=await f.respond('alice',d);assert.equal(d.status,'resolved');
});
