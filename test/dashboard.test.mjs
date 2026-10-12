import test from 'node:test';
import assert from 'node:assert/strict';
import { dashboard } from '../dashboard.mjs';
import { Mailbox } from '../mailbox.mjs';
import { emptyState } from '../github.mjs';
import { listenViewer } from '../viewer.mjs';
import { skillDigest } from '../skills.mjs';

async function fixture() {
  const store={repo:'demo/mailbox',state:emptyState(),reads:0,
    async read(){this.reads++;return {state:structuredClone(this.state),sha:'x'};},
    async write(state){this.state=structuredClone(state);}};
  const m=new Mailbox(store,'demo',()=>100000);
  const a=await m.join({label:'Demo agent',task:'Private session context'});
  await m.updateAgent({agent_id:a.id,expected_revision:0,provider:'claude',capabilities:['review'],paths:['src']});
  const t=await m.createTask({agent_id:a.id,title:'<script>alert(1)</script>',description:'Review parser',
    acceptance:['Tests pass'],request_id:'private-retry-key',assignee_id:a.id,paths:['src']});
  await m.updateTask({agent_id:a.id,task_id:t.id,expected_revision:1,request_id:'private-update-key',
    action:'accept',summary:'Reviewing',artifacts:['javascript:alert(1)']});
  return {store,t,a};
}
test('dashboard projects task history and profiles without retry keys, fingerprints or private context',async()=>{
  const {store,t}=await fixture();
  const result=dashboard(store.repo,store.state,100000);
  assert.equal(result.counts.in_progress,1);
  assert.equal(result.tasks[0].id,t.id);
  assert.equal(result.tasks[0].assigneeLabel,'Demo agent');
  assert.equal(result.tasks[0].history[0].summary,'Reviewing');
  assert.equal(result.agents[0].profile.availability,'available');
  assert.doesNotMatch(JSON.stringify(result),/private-retry-key|private-update-key|fingerprint|Private session context/);
});
test('dashboard endpoint shares read cache and enforces existing read-only guards',async t=>{
  const {store}=await fixture();store.reads=0;
  const server=await listenViewer({store,port:0,now:()=>100000});t.after(()=>server.close());
  const root='http://127.0.0.1:'+server.address().port;
  const [messages,team]=await Promise.all([fetch(root+'/api/messages'),fetch(root+'/api/dashboard')]);
  assert.equal(messages.status,200);assert.equal(team.status,200);
  assert.equal(store.reads,1);
  assert.equal((await team.json()).counts.in_progress,1);
  assert.equal((await fetch(root+'/api/dashboard',{method:'POST'})).status,405);
  assert.equal((await fetch(root+'/api/dashboard',{headers:{Origin:'https://other.invalid'}})).status,403);
  assert.equal((await fetch(root+'/dashboard.mjs')).status,200);
});
test('legacy empty mailbox has zero totals and malformed tasks fail with sanitized errors',async t=>{
  const empty=dashboard('demo/mailbox',emptyState(),100000);
  assert.deepEqual(empty.tasks,[]);assert.deepEqual(empty.skills,[]);assert.equal(empty.counts.ready,0);
  const store={repo:'demo/mailbox',read:async()=>({state:{...emptyState(),tasks:[{title:'SECRET'}]}})};
  const server=await listenViewer({store,port:0});t.after(()=>server.close());
  const result=await fetch('http://127.0.0.1:'+server.address().port+'/api/dashboard');
  assert.equal(result.status,503);assert.doesNotMatch(await result.text(),/SECRET|Malformed/);
});

test('skill projection preserves provenance and outcomes while excluding private retry metadata',async()=>{
  const {store,a}=await fixture();
  const event={actorId:a.id,summary:'<img src=x onerror=alert(1)>',createdAt:100000,
    evidence:['javascript:alert(1)'],requestId:'private-skill-retry',fingerprint:'private-fingerprint'};
  store.state.skills=[{id:'skill-1',name:'review-a-change',title:'Review a change',description:'Reusable review',
    whenToUse:'Before handoff',steps:['Read diff'],validation:['Run tests'],limitations:[],tags:['review'],evidence:['test result'],
    sourceTaskId:null,supersedesId:null,version:1,revision:4,createdBy:a.id,createdAt:100000,updatedAt:100000,
    status:'published',digest:'a'.repeat(64),reviews:[{...event,verdict:'approve'}],
    uses:[{...event,outcome:'failure',taskId:null}],history:[{...event,action:'publish'}],
    requestId:'private-create-skill',fingerprint:'private-fingerprint',privateContext:'DO NOT PROJECT'}];
  store.state.skills[0].digest=skillDigest(store.state.skills[0]);
  const result=dashboard(store.repo,store.state,100000);
  assert.equal(result.skills[0].creatorLabel,'Demo agent');
  assert.equal(result.skills[0].reviews[0].actorLabel,'Demo agent');
  assert.equal(result.skills[0].uses[0].outcome,'failure');
  assert.equal(result.skills[0].steps[0],'Read diff');
  assert.equal(result.skills[0].reviews[0].summary,event.summary);
  assert.doesNotMatch(JSON.stringify(result),/private-skill-retry|private-create-skill|fingerprint|DO NOT PROJECT/);
  for(const malformed of [null,{...store.state.skills[0],steps:'not a list'},
    {...store.state.skills[0],steps:['Unreviewed replacement']},
    {...store.state.skills[0],reviews:[{...event,verdict:'invalid'}]}]) {
    assert.throws(()=>dashboard(store.repo,{...store.state,skills:[malformed]},100000),/Malformed/);
  }
});
