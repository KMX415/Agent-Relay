import test from 'node:test';
import assert from 'node:assert/strict';
import { Mailbox } from '../mailbox.mjs';
import { emptyState } from '../github.mjs';
import { startReviewCycle, getReviewCycle, advanceReviewCycle, assertTaskReviewAction } from '../review-cycles.mjs';

class Store {
  state=emptyState(); revision=0;
  async read(){return {state:structuredClone(this.state),sha:this.revision};}
  async write(state,sha){if(sha!==this.revision)throw Object.assign(new Error('Conflict'),{status:409});this.state=structuredClone(state);this.revision++;}
}
async function setup(max_rounds=2){
  const store=new Store(), builder=new Mailbox(store,'builder'), reviewer=new Mailbox(store,'reviewer');
  for(const box of [builder,reviewer])Object.assign(box,{startReviewCycle,getReviewCycle,advanceReviewCycle});
  const a=(await builder.join({label:'Builder',task:'Work'})).id, b=(await reviewer.join({label:'Reviewer',task:'Review'})).id;
  await reviewer.updateAgent({agent_id:b,provider:'example',expected_revision:0,capabilities:['review']});
  let task=await builder.createTask({agent_id:a,title:'Parser',description:'Fix it',acceptance:['Pass tests'],assignee_id:a,request_id:'task',paths:['src']});
  task=await builder.updateTask({agent_id:a,task_id:task.id,expected_revision:task.revision,action:'accept',request_id:'accept',summary:'Working'});
  const args={agent_id:a,task_id:task.id,reviewer_id:b,max_rounds,expected_task_revision:task.revision,request_id:'start',summary:'Ready',artifacts:['commit:abc']};
  const start=(extra={})=>builder.startReviewCycle({...args,...extra});
  const advance=(box,actor,cycle,action,extra={})=>box.advanceReviewCycle({agent_id:actor,cycle_id:cycle.id,expected_revision:cycle.revision,expected_task_revision:store.state.tasks[0].revision,request_id:action+'-'+cycle.revision,action,summary:'Evidence recorded',artifacts:['tests:pass'],...extra});
  return {store,builder,reviewer,a,b,task,start,advance};
}
test('headless builder review fix approve loop preserves evidence without completing task',async()=>{
  const {store,builder,reviewer,a,b,task,start,advance}=await setup();
  let c=await start();
  assert.throws(()=>assertTaskReviewAction(store.state,task,'complete'),/requires approval/);
  assert.throws(()=>assertTaskReviewAction(store.state,task,'handoff'),/Cancel/);
  c=await advance(reviewer,b,c,'request_changes');
  c=await advance(builder,a,c,'resubmit');
  assert.equal(c.round,2);
  c=await advance(reviewer,b,c,'approve');
  assert.equal(c.phase,'approved'); assert.equal(store.state.tasks[0].status,'in_progress');
  assert.doesNotThrow(()=>assertTaskReviewAction(store.state,task,'complete'));
  assert.equal((await builder.getReviewCycle({agent_id:a,task_id:task.id})).history.length,4);
});
test('round exhaustion cannot be reset and cancellation cannot bypass review completion',async()=>{
  const {store,builder,reviewer,a,b,task,start,advance}=await setup(1);
  let c=await start(); c=await advance(reviewer,b,c,'request_changes');
  assert.equal(c.phase,'exhausted');
  await assert.rejects(advance(builder,a,c,'resubmit'),/phase/);
  await assert.rejects(start({request_id:'reset'}),/already has/);
  c=await advance(builder,a,c,'cancel');
  assert.equal(c.phase,'cancelled');
  assert.throws(()=>assertTaskReviewAction(store.state,task,'complete'),/requires approval/);
});
test('stale submitted work cannot be approved or completed and resubmission binds new revision',async()=>{
  const {store,builder,reviewer,a,b,task,start,advance}=await setup();
  let c=await start(); store.state.tasks[0].revision++;
  await assert.rejects(advance(reviewer,b,c,'approve'),/builder must resubmit/);
  c=await advance(builder,a,c,'resubmit'); c=await advance(reviewer,b,c,'approve');
  assert.doesNotThrow(()=>assertTaskReviewAction(store.state,store.state.tasks[0],'complete'));
  store.state.tasks[0].revision++;
  assert.throws(()=>assertTaskReviewAction(store.state,store.state.tasks[0],'complete'),/current revision/);
  await assert.rejects(advance(builder,a,c,'resubmit'),/round limit/);
});
test('review roles, retry fingerprints and concurrent verdict revision checks',async()=>{
  const {store,builder,reviewer,a,b,start,advance}=await setup();
  let c=await start(); assert.equal((await start()).id,c.id);
  await assert.rejects(start({summary:'Other'}),/different content/);
  await assert.rejects(advance(builder,a,c,'approve'),/designated reviewer/);
  await assert.rejects(advance(reviewer,b,c,'cancel'),/Only builder/);
  const results=await Promise.allSettled([advance(reviewer,b,c,'approve'),advance(reviewer,b,c,'request_changes')]);
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
  assert.match(results.find(r=>r.status==='rejected').reason.message,/revision changed/);
  const winner=results[0].status==='fulfilled'?'approve':'request_changes', revision=store.revision;
  await advance(reviewer,b,c,winner); assert.equal(store.revision,revision);
  await assert.rejects(advance(reviewer,b,c,winner,{summary:'Changed'}),/different content/);
});
test('reviewer local scope and expiry are enforced while cancellation remains available',async()=>{
  const {builder,reviewer,a,b,start,advance}=await setup();
  const c=await start();
  const policy={allowed_kinds:['implementation'],allowed_paths:['src'],allow_unassigned:false,max_chain_depth:10,max_handoffs:10,max_active_tasks:5,max_task_minutes:60,expires_at:'2099-01-01'};
  reviewer.readPolicy=async()=>policy;
  await assert.rejects(advance(reviewer,b,c,'approve'),/category needs user approval/);
  reviewer.readPolicy=async()=>({...policy,allowed_kinds:['review'],expires_at:'2000-01-01'});
  await assert.rejects(advance(reviewer,b,c,'approve'),/expired/);
  builder.readPolicy=async()=>{throw new Error('Invalid policy');};
  assert.equal((await advance(builder,a,c,'cancel')).phase,'cancelled');
});
test('evidence bounds, exact reviewer and cycle capacity fail explicitly',async()=>{
  const {store,a,start}=await setup();
  await assert.rejects(start({artifacts:[]}),/artifacts/);
  await assert.rejects(start({max_rounds:6}),/max_rounds/);
  await assert.rejects(start({reviewer_id:a}),/another exact/);
  await assert.rejects(start({reviewer_id:'unknown'}),/another exact/);
  store.state.reviewCycles=Array.from({length:100},(_,i)=>({id:String(i),taskId:String(i)}));
  await assert.rejects(start(),/registry full/);
});

test('actual task completion enforces review and rejects stale approval after progress',async()=>{
  const {builder,reviewer,a,b,task,start,advance}=await setup();
  const update=(current,action)=>builder.updateTask({agent_id:a,task_id:task.id,expected_revision:current.revision,request_id:action+'-'+current.revision,action,summary:'Recorded task evidence'});
  let c=await start();
  await assert.rejects(update(task,'complete'),/requires approval/);
  c=await advance(reviewer,b,c,'approve');
  let current=await update(task,'progress');
  await assert.rejects(update(current,'complete'),/requires approval/);
  c=await advance(builder,a,c,'resubmit');
  await advance(reviewer,b,c,'approve');
  assert.equal((await update(current,'complete')).status,'completed');
});
