import test from 'node:test';
import assert from 'node:assert/strict';
import { Mailbox } from '../mailbox.mjs';
import { emptyState } from '../github.mjs';
import { requestPeerHelp,advancePeerHelp,getPeerHelp,listPeerHelp } from '../peer-help.mjs';
class Store {
  state=emptyState();revision=0;
  async read(){return {state:structuredClone(this.state),sha:this.revision};}
  async write(state,sha){if(sha!==this.revision)throw Object.assign(new Error('Conflict'),{status:409});this.state=structuredClone(state);this.revision++;}
}
async function setup(max_attempts=2){
  const store=new Store(),a=new Mailbox(store,'owner'),b=new Mailbox(store,'owner'),c=new Mailbox(store,'other');
  let now=Date.parse('2026-10-12T00:00:00Z');
  for(const box of [a,b,c])Object.assign(box,{requestPeerHelp,advancePeerHelp,getPeerHelp,listPeerHelp,now:()=>now});
  const x=(await a.join({label:'Builder',task:'Build'})).id,y=(await b.join({label:'Peer',task:'Review'})).id,z=(await c.join({label:'Other',task:'Review'})).id;
  await b.updateAgent({agent_id:y,expected_revision:0,provider:'test',capabilities:['parser']});
  let task=await a.createTask({agent_id:x,title:'Work',description:'Implement',acceptance:['Test'],paths:['src'],assignee_id:x,request_id:'task'});
  task=await a.updateTask({agent_id:x,task_id:task.id,expected_revision:task.revision,action:'accept',summary:'Start',request_id:'accept'});
  task=await a.updateTask({agent_id:x,task_id:task.id,expected_revision:task.revision,action:'block',summary:'Parser issue',request_id:'block'});
  const args={agent_id:x,task_id:task.id,expected_task_revision:task.revision,recipient_id:y,max_attempts,deadline:'2026-10-12T01:00:00Z',summary:'Need parser advice',request_id:'help'};
  const start=(extra={})=>a.requestPeerHelp({...args,...extra});
  const act=(box,id,record,action,extra={})=>box.advancePeerHelp({agent_id:id,help_id:record.id,expected_revision:record.revision,expected_task_revision:task.revision,action,summary:'Observed evidence',evidence:['test:parser'],request_id:action+'-'+record.revision,...extra});
  return {store,a,b,c,x,y,z,task,start,act,setTime:t=>now=t};
}
test('peer advice loop is bounded and never resumes blocked work',async()=>{
  const {store,a,b,x,y,start,act}=await setup();let r=await start();
  assert.equal((await b.listPeerHelp({agent_id:y})).help[0].id,r.id);
  r=await act(b,y,r,'respond');r=await act(a,x,r,'retry',{recipient_id:y});
  assert.equal(r.attempt,2);r=await act(b,y,r,'respond');
  assert.equal((await a.getPeerHelp({agent_id:x,help_id:r.id})).effectivePhase,'exhausted');
  await assert.rejects(act(a,x,r,'retry',{recipient_id:y}),/budget exhausted/);
  r=await act(a,x,r,'resolve');assert.equal(r.phase,'resolved');
  assert.equal(store.state.tasks[0].status,'blocked');
  await assert.rejects(start({request_id:'new',max_attempts:5}),/cannot reset/);
});
test('exact roles and immutable retry keys reject impersonation and changed payload',async()=>{
  const {store,a,b,c,x,y,z,start,act}=await setup();const r=await start();
  assert.equal((await start()).id,r.id);
  await assert.rejects(start({summary:'other'}),/different content/);
  await assert.rejects(act(a,x,r,'respond'),/designated/);
  await assert.rejects(act(c,z,r,'respond'),/designated/);
  await assert.rejects(c.getPeerHelp({agent_id:z,help_id:r.id}),/not found/);
  await act(b,y,r,'respond');store.state.tasks[0].revision++;
  assert.equal((await act(b,y,r,'respond')).revision,2);
  await assert.rejects(act(b,y,r,'respond',{summary:'changed'}),/different content/);
  assert.equal((await start()).id,r.id);
});
test('stale task and expired help stop advice and still permit explicit escalation',async()=>{
  const {store,a,b,x,y,start,act,setTime}=await setup();let r=await start();
  store.state.tasks[0].revision++;
  await assert.rejects(act(b,y,r,'respond'),/Task revision changed/);
  r=await act(a,x,r,'escalate');assert.equal(r.phase,'escalated');
  const f=await setup();r=await f.start();f.setTime(Date.parse('2026-10-12T02:00:00Z'));
  assert.equal((await f.a.getPeerHelp({agent_id:f.x,help_id:r.id})).effectivePhase,'expired');
  await assert.rejects(f.act(f.b,f.y,r,'respond'),/deadline expired/);
  assert.equal((await f.act(f.a,f.x,r,'escalate')).phase,'escalated');
});
test('cross-owner help requires bilateral review scope and peer policy',async()=>{
  const {store,a,c,x,z,start,act}=await setup();
  await assert.rejects(start({recipient_id:z}),/bilateral/);
  store.state.collaborationAgreements=['owner','other'].map(owner=>({owner,peerOwner:owner==='owner'?'other':'owner',status:'active',allowedKinds:['review'],allowedPaths:['src'],expiresAt:'2099-01-01'}));
  const r=await start({recipient_id:z});
  c.readPolicy=async()=>({allowed_kinds:['implementation'],allowed_paths:['src'],expires_at:'2099-01-01'});
  await assert.rejects(act(c,z,r,'respond'),/category/);
  c.readPolicy=async()=>null;store.state.collaborationAgreements[0].status='revoked';
  await assert.rejects(act(c,z,r,'respond'),/bilateral/);
  assert.equal((await act(a,x,r,'escalate')).phase,'escalated');
});
test('capability discovery checks availability and registry, evidence and pagination are bounded',async()=>{
  const {store,a,b,x,y,start,act,setTime}=await setup();
  await assert.rejects(start({recipient_id:undefined,required_capabilities:['unknown']}),/No eligible/);
  const r=await start({recipient_id:undefined,required_capabilities:['parser']});assert.equal(r.recipientId,y);
  await assert.rejects(act(b,y,r,'respond',{evidence:[]}),/Evidence/);
  await assert.rejects(a.listPeerHelp({agent_id:x,limit:101}),/pagination/);
  const f=await setup();f.setTime(Date.parse('2026-10-12T00:30:00Z'));
  await assert.rejects(f.start({recipient_id:undefined,required_capabilities:['parser']}),/No eligible/);
  f.store.state.peerHelp=Array.from({length:200},(_,i)=>({taskId:String(i)}));
  await assert.rejects(f.start(),/registry full/);
});
test('goal advice skips execution reservations and concurrency but retains membership, scope and deadline',async()=>{
  const {store,b,y,z,start,act}=await setup();
  const task=store.state.tasks[0];task.goalId='goal';
  const goal={id:'goal',participants:[task.assigneeId,y],status:'active',deadline:'2026-10-12T01:00:00Z',allowedKinds:['implementation','review'],allowedPaths:['src'],maxConcurrent:1,maxUsageUnits:10,reservations:[]};
  store.state.goals=[goal];
  store.state.tasks.push({...task,id:'another-task',assigneeId:z});
  const r=await start();
  // Neither participant has an execution reservation; other task fills concurrency.
  store.state.goals[0].participants=[task.assigneeId];
  await assert.rejects(act(b,y,r,'respond'),/goal participant/);
  store.state.goals[0].participants.push(y);store.state.goals[0].allowedKinds=['implementation'];
  await assert.rejects(act(b,y,r,'respond'),/goal scope/);
  store.state.goals[0].allowedKinds.push('review');store.state.goals[0].deadline='2026-10-11T00:00:00Z';
  await assert.rejects(act(b,y,r,'respond'),/Goal deadline/);
  store.state.goals[0].deadline='2026-10-12T01:00:00Z';
  assert.equal((await act(b,y,r,'respond')).phase,'responded');
  assert.equal(store.state.goals[0].reservations.length,0);
});
test('peer selection excludes nonparticipants without spending a goal help attempt',async()=>{
  const {store,a,b,x,y,start,act}=await setup();
  const extra=(await b.join({label:'Qualified participant',task:'Advice'})).id;
  await b.updateAgent({agent_id:extra,expected_revision:0,provider:'test',capabilities:['parser']});
  store.state.tasks[0].goalId='goal';
  store.state.goals=[{id:'goal',participants:[x,extra],status:'active',deadline:'2026-10-12T01:00:00Z',allowedKinds:['implementation','review'],allowedPaths:['src'],maxConcurrent:1,maxUsageUnits:null,reservations:[]}];
  await assert.rejects(start({recipient_id:y}),/goal participant/);
  assert.equal(store.state.peerHelp?.length??0,0);
  let r=await start({recipient_id:undefined,required_capabilities:['parser']});
  assert.equal(r.recipientId,extra);r=await act(b,extra,r,'respond');
  await assert.rejects(act(a,x,r,'retry',{recipient_id:y}),/goal participant/);
  assert.equal(store.state.peerHelp[0].attempt,1);
  assert.equal(store.state.peerHelp[0].revision,r.revision);
});
