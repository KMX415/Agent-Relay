import test from 'node:test';
import assert from 'node:assert/strict';
import { Mailbox } from '../mailbox.mjs';
import { emptyState } from '../github.mjs';
import { call } from '../tools.mjs';

class Store {
  state = emptyState(); revision = 0;
  async read() { return {state:structuredClone(this.state), sha:this.revision}; }
  async write(state, sha) {
    if (sha !== this.revision) throw Object.assign(new Error('Conflict'), {status:409});
    this.state = structuredClone(state); this.revision++;
  }
}
async function setup() {
  const store = new Store(), alice = new Mailbox(store,'alice'), bob = new Mailbox(store,'bob');
  const a = (await alice.join({label:'Alice',task:'Work'})).id;
  const b = (await bob.join({label:'Bob',task:'Work'})).id;
  const create = (extra = {}) => call(alice,'create_task',{agent_id:a,title:'Parser',description:'Fix parser',acceptance:['Tests pass'],request_id:'create',...extra});
  const update = (mailbox, agent, task, action, extra = {}) => call(mailbox,'update_task',{
    agent_id:agent,task_id:task.id,expected_revision:task.revision,request_id:`${action}-${task.revision}`,action,summary:'Recorded evidence',...extra});
  return {store,alice,bob,a,b,create,update};
}
test('task lifecycle preserves durable handoff context across independent workers',async()=>{
  const {alice,bob,a,b,create,update} = await setup();
  let t = await create({assignee_id:a});
  t = await update(alice,a,t,'accept');
  t = await update(alice,a,t,'block',{summary:'Need fixture'});
  t = await update(alice,a,t,'progress',{summary:'Fixture located'});
  t = await update(alice,a,t,'resume');
  t = await update(alice,a,t,'handoff',{assignee_id:b,summary:'Parser fixed',next_steps:['Run fixture tests'],artifacts:['branch/parser']});
  assert.equal(t.status,'ready'); assert.equal(t.assigneeId,b);
  const persisted = await call(bob,'get_task',{agent_id:b,task_id:t.id});
  assert.deepEqual(persisted.history.at(-1).nextSteps,['Run fixture tests']);
  assert.deepEqual(persisted.history.at(-1).artifacts,['branch/parser']);
  await assert.rejects(update(alice,a,t,'accept'),/assigned agent/);
  t = await update(bob,b,t,'accept');
  t = await update(bob,b,t,'complete',{summary:'Fixture tests pass'});
  assert.equal(t.status,'completed');
  await assert.rejects(update(bob,b,t,'progress'),/terminal/);
});
test('retry keys survive later changes and reject altered payloads',async()=>{
  const {store,alice,a,create,update} = await setup();
  const t = await create();
  assert.equal((await create()).id,t.id);
  await assert.rejects(create({title:'Changed'}),/different content/);
  const accepted = await update(alice,a,t,'accept');
  await update(alice,a,accepted,'progress');
  const revision = store.revision;
  assert.equal((await update(alice,a,t,'accept')).revision,3);
  assert.equal(store.revision,revision);
  await assert.rejects(update(alice,a,t,'accept',{summary:'Changed'}),/different content/);
});
test('concurrent acceptance has one winner and stale edits cannot overwrite it',async()=>{
  const {alice,bob,a,b,create,update} = await setup();
  const t = await create();
  const results = await Promise.allSettled([update(alice,a,t,'accept'),update(bob,b,t,'accept')]);
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
  assert.match(results.find(r=>r.status==='rejected').reason.message,/revision changed/);
  await assert.rejects(update(alice,a,t,'cancel'),/revision changed/);
});
test('dependencies gate execution and cancellation does not satisfy dependents',async()=>{
  const {alice,a,create,update} = await setup();
  let dep = await create();
  const task = await create({request_id:'dependent',depends_on:[dep.id]});
  await assert.rejects(update(alice,a,task,'accept'),/Dependencies/);
  dep = await update(alice,a,dep,'accept');
  await update(alice,a,dep,'complete');
  assert.equal((await update(alice,a,task,'accept')).status,'in_progress');
  const cancelled = await create({request_id:'cancel'});
  await update(alice,a,cancelled,'cancel');
  const blocked = await create({request_id:'blocked',depends_on:[cancelled.id]});
  await assert.rejects(update(alice,a,blocked,'accept'),/Dependencies/);
});
test('ownership, transitions, bounds and handoff requirements are enforced',async()=>{
  const {alice,bob,a,b,create,update} = await setup();
  const t = await create({assignee_id:a});
  await assert.rejects(update(bob,a,t,'accept'),/identity/);
  await assert.rejects(update(bob,b,t,'assign',{assignee_id:b}),/creator/);
  await assert.rejects(update(bob,b,t,'cancel'),/creator/);
  await assert.rejects(update(alice,a,t,'complete'),/transition/);
  const active = await update(alice,a,t,'accept');
  await assert.rejects(update(alice,a,active,'handoff',{assignee_id:b}),/next steps/);
  await assert.rejects(update(alice,a,active,'progress',{artifacts:'bad'}),/artifacts/);
  await assert.rejects(create({request_id:'invalid',assignee_id:'missing'}),/registered/);
  await assert.rejects(create({request_id:'invalid',depends_on:['missing']}),/dependency/);
  await assert.rejects(create({request_id:'invalid',acceptance:[]}),/acceptance/);
});
test('legacy mailboxes list empty tasks and pagination/filtering works after creation',async()=>{
  const {store,alice,a,b,create,update} = await setup();
  assert.equal(store.state.tasks,undefined);
  assert.deepEqual((await call(alice,'list_tasks',{agent_id:a})).tasks,[]);
  let t = await create();
  t = await update(alice,a,t,'assign',{assignee_id:b});
  await create({request_id:'second'});
  const page = await call(alice,'list_tasks',{agent_id:a,limit:1});
  assert.equal(page.hasMore,true);
  assert.equal((await call(alice,'list_tasks',{agent_id:a,after:page.nextAfter})).tasks.length,1);
  assert.equal((await call(alice,'list_tasks',{agent_id:a,assignee_id:b,status:'ready'})).tasks[0].id,t.id);
  await assert.rejects(call(alice,'list_tasks',{agent_id:a,limit:0}),/pagination/);
});

test('concurrent task creation preserves both records and message writes preserve tasks',async()=>{
  const {store,alice,a,create} = await setup();
  await Promise.all([create(),create({request_id:'other'})]);
  assert.equal(store.state.tasks.length,2);
  await alice.send({agent_id:a,to:'team',body:'Task update',request_id:'message'});
  assert.equal(store.state.tasks.length,2);
});

test('task and history capacity fail without silently pruning records',async()=>{
  const {store,alice,a,create,update} = await setup();
  let t = await create();
  t = await update(alice,a,t,'accept');
  store.state.tasks[0].history = Array.from({length:100},(_,i)=>({actorId:a,requestId:`old-${i}`}));
  await assert.rejects(update(alice,a,t,'progress'),/history full/);
  assert.equal(store.state.tasks[0].history.length,100);
  store.state.tasks = Array.from({length:500},(_,i)=>({...t,id:String(i),requestId:`old-${i}`}));
  await assert.rejects(create({request_id:'overflow'}),/registry full/);
  assert.equal(store.state.tasks.length,500);
});
