import test from 'node:test';
import assert from 'node:assert/strict';
import { Mailbox } from '../mailbox.mjs';
import { emptyState } from '../github.mjs';
import * as goals from '../goals.mjs';
class Store {state=emptyState();revision=0;async read(){return {state:structuredClone(this.state),sha:this.revision};}async write(state,sha){if(sha!==this.revision)throw Object.assign(new Error('Conflict'),{status:409});this.state=structuredClone(state);this.revision++;}}
async function setup(extra={}) {
 const store=new Store();let now=1000000000000;const a=new Mailbox(store,'alice',()=>now),b=new Mailbox(store,'bob',()=>now);for(const m of [a,b])for(const name of Object.values(goals.goalMethods))m[name]=goals[name];
 const aid=(await a.join({label:'A',task:'work'})).id,bid=(await b.join({label:'B',task:'work'})).id;
 let g=await a.createGoal({agent_id:aid,title:'Outcome',description:'Ship parser',acceptance:['Parser verified'],participants:[aid,bid],allowed_kinds:['implementation'],allowed_paths:['src'],max_tasks:3,max_concurrent:1,deadline:new Date(now+60000).toISOString(),request_id:'goal',...extra});
 const create=(n,more={})=>a.createTask({agent_id:aid,title:n,description:'Change parser',acceptance:['Test'],assignee_id:aid,paths:['src/a'],goal_id:g.id,request_id:n,...more});
 const update=(t,action,more={})=>a.updateTask({agent_id:aid,task_id:t.id,expected_revision:t.revision,request_id:action+t.revision,action,summary:'Evidence',...more});
 return {store,a,b,aid,bid,g,create,update,advance:()=>now+=60001};
}
test('goal concurrency is atomic and cancelled tasks do not reset creation budget',async()=>{
 const {a,aid,g,create,update}=await setup({max_tasks:2});const t1=await create('one'),t2=await create('two');
 const results=await Promise.allSettled([update(t1,'accept'),update(t2,'accept')]);assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.match(results.find(r=>r.status==='rejected').reason.message,/concurrency/);
 await update(results.find(r=>r.status==='fulfilled').value,'cancel');await assert.rejects(create('three'),/task budget/);
 const current=await a.getGoal({agent_id:aid,goal_id:g.id});assert.equal(current.tasks.length,2);
});
test('goal pause and expiry block execution but allow durable evidence and block',async()=>{
 const {a,aid,g,create,update,advance}=await setup();let t=await update(await create('one'),'accept');
 let paused=await a.updateGoal({agent_id:aid,goal_id:g.id,expected_revision:1,request_id:'pause',action:'pause',summary:'Human decision'});
 assert.equal((await a.checkTask({agent_id:aid,task_id:t.id})).allowed,false);await assert.rejects(update(t,'progress'),/paused/);
 t=await update(t,'evidence');t=await update(t,'block');await assert.rejects(update(t,'resume'),/paused/);
 await a.updateGoal({agent_id:aid,goal_id:g.id,expected_revision:paused.revision,request_id:'resume',action:'resume',summary:'Continue'});advance();await assert.rejects(update(t,'resume'),/deadline/);
});
test('goal membership scope inheritance owner controls and acceptance are enforced',async()=>{
 const {a,b,aid,bid,g,create,update}=await setup();await assert.rejects(create('bad',{paths:['other']}),/scope/);
 await assert.rejects(b.updateGoal({agent_id:bid,goal_id:g.id,expected_revision:1,request_id:'p',action:'pause',summary:'No'}),/owner/);
 const parent=await create('parent');const child=await create('child',{goal_id:undefined,parent_task_id:parent.id});assert.equal(child.goalId,g.id);
 await assert.rejects(a.updateGoal({agent_id:aid,goal_id:g.id,expected_revision:1,request_id:'done',action:'complete',summary:'Done',evidence:['test']}),/Complete all/);
 let p=await update(parent,'accept');await update(p,'complete');let c=await update(child,'accept');await update(c,'complete');
 const done=await a.updateGoal({agent_id:aid,goal_id:g.id,expected_revision:1,request_id:'done',action:'complete',summary:'Done',evidence:['test']});assert.equal(done.status,'completed');await assert.rejects(create('late'),/completed/);
});
test('usage reservation retries are exact and overrun blocks future work without losing evidence',async()=>{
 const {a,aid,g,create,update}=await setup({max_usage_units:10});let t=await create('one');await assert.rejects(update(t,'accept'),/reservation/);
 const input={agent_id:aid,goal_id:g.id,task_id:t.id,expected_revision:1,request_id:'reserve',units:7};const r=await a.reserveGoalUsage(input);assert.equal((await a.reserveGoalUsage(input)).id,r.id);await assert.rejects(a.reserveGoalUsage({...input,units:8}),/different content/);
 t=await update(t,'accept');t=await update(t,'complete');const settled=await a.settleGoalUsage({agent_id:aid,goal_id:g.id,reservation_id:r.id,expected_revision:2,request_id:'settle',actual_units:12,evidence:'Provider usage report'});assert.equal(settled.actualUnits,12);await assert.rejects(create('two'),/usage budget/);
});

test('usage reservations cannot oversubscribe concurrently and settled keys cannot change amounts',async()=>{
 const {a,aid,g,create}=await setup({max_usage_units:10});const one=await create('one'),two=await create('two');
 const reserve=t=>a.reserveGoalUsage({agent_id:aid,goal_id:g.id,task_id:t.id,expected_revision:1,request_id:'reserve-'+t.id,units:7});
 const results=await Promise.allSettled([reserve(one),reserve(two)]);assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
 const loser=results[0].status==='rejected'?one:two;await assert.rejects(a.reserveGoalUsage({agent_id:aid,goal_id:g.id,task_id:loser.id,expected_revision:2,request_id:'reserve-again',units:7}),/budget unavailable/);
 const r=results.find(r=>r.status==='fulfilled').value;const payload={agent_id:aid,goal_id:g.id,reservation_id:r.id,expected_revision:2,request_id:'settle',actual_units:3,evidence:'Observed usage'};
 await a.settleGoalUsage(payload);assert.equal((await a.settleGoalUsage(payload)).actualUnits,3);await assert.rejects(a.settleGoalUsage({...payload,actual_units:0}),/different content/);
});
test('goal scope never expands local policy and nonparticipants cannot receive linked tasks',async()=>{
 const {a,aid,g,create,update}=await setup();const outsider=(await a.join({label:'Outside',task:'Other'})).id;
 await assert.rejects(create('outsider',{assignee_id:outsider}),/participant/);
 a.readPolicy=async()=>({allowed_kinds:['documentation'],allowed_paths:['docs'],allow_unassigned:false,max_active_tasks:2,max_chain_depth:2,max_handoffs:2,max_task_minutes:30,expires_at:'2030-01-01T00:00:00Z'});
 const t=await create('one');await assert.rejects(update(t,'accept'),/user approval/);
 assert.equal((await a.checkTask({agent_id:aid,task_id:t.id})).allowed,false);
});
test('cross-contributor negotiations retain immutable goal and consume shared task budget',async()=>{
 const {a,b,aid,bid,g}=await setup({max_tasks:1,max_usage_units:20});
 const policy={allowed_kinds:['implementation'],allowed_paths:['src'],allow_unassigned:false,max_active_tasks:2,max_chain_depth:2,max_handoffs:2,max_task_minutes:30,expires_at:'2030-01-01T00:00:00Z'};a.readPolicy=b.readPolicy=async()=>policy;
 for(const [m,id,peer] of [[a,aid,'bob'],[b,bid,'alice']])await m.setCollaborationAgreement({agent_id:id,peer_owner:peer,allowed_kinds:['implementation'],allowed_paths:['src'],expires_at:'2030-01-01T00:00:00Z',request_id:'agree'});
 const input={agent_id:aid,recipient_id:bid,work_id:'parser',goal_id:g.id,terms:{title:'Parser',description:'Implement parser',acceptance:['Tests'],paths:['src/parser']},deadline:g.deadline,request_id:'propose'};
 let n=await a.proposeNegotiation(input);n=await b.advanceNegotiation({agent_id:bid,negotiation_id:n.id,expected_revision:n.revision,request_id:'accept',action:'accept',summary:'Accepted'});
 const t=await b.getTask({agent_id:bid,task_id:n.taskId});assert.equal(t.goalId,g.id);
 await assert.rejects(a.proposeNegotiation({...input,work_id:'extra',request_id:'extra'}),/task budget/);
 await assert.rejects(b.updateTask({agent_id:bid,task_id:t.id,expected_revision:1,request_id:'start',action:'accept',summary:'Start'}),/reservation/);
 await b.reserveGoalUsage({agent_id:bid,goal_id:g.id,task_id:t.id,expected_revision:1,request_id:'reserve',units:5});
 assert.equal((await b.updateTask({agent_id:bid,task_id:t.id,expected_revision:1,request_id:'start',action:'accept',summary:'Start'})).status,'in_progress');
});
test('routing selects only goal participants without requiring execution reservation',async()=>{
 const {a,b,aid,bid,g,create}=await setup({max_usage_units:10});const outside=(await a.join({label:'Other',task:'Other'})).id;
 for(const [m,id] of [[a,outside],[b,bid]])await m.updateAgent({agent_id:id,expected_revision:0,provider:'test',capabilities:[],paths:['src'],availability:'available'});
 const t=await create('route');const routed=await a.routeTask({agent_id:aid,task_id:t.id,expected_revision:1,request_id:'route',summary:'Delegate',next_steps:['Implement']});assert.equal(routed.task.assigneeId,bid);assert.equal(routed.task.goalId,g.id);
});
test('review submission rejects nonparticipants before creating a cycle and permits participant review without builder reservation ownership',async()=>{
 const {a,b,aid,bid,g,create,update}=await setup({allowed_kinds:['implementation','review'],max_usage_units:10});const outside=(await a.join({label:'Other',task:'Other'})).id;
 let t=await create('reviewed');await a.reserveGoalUsage({agent_id:aid,goal_id:g.id,task_id:t.id,expected_revision:1,request_id:'reserve',units:5});t=await update(t,'accept');
 const input={agent_id:aid,task_id:t.id,reviewer_id:outside,expected_task_revision:t.revision,request_id:'review',summary:'Ready',artifacts:['test output']};
 await assert.rejects(a.startReviewCycle(input),/participant/);
 await b.updateAgent({agent_id:bid,expected_revision:0,provider:'test',capabilities:['review'],paths:['src']});
 const cycle=await a.startReviewCycle({...input,reviewer_id:bid});
 assert.equal((await b.advanceReviewCycle({agent_id:bid,cycle_id:cycle.id,expected_revision:1,expected_task_revision:t.revision,request_id:'verdict',action:'approve',summary:'Inspected tests',artifacts:['test output']})).phase,'approved');
});
