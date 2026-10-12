import test from 'node:test';
import assert from 'node:assert/strict';
import { createIntegrationCheck,advanceIntegrationCheck,getIntegrationCheck,listIntegrationChecks,assertGoalIntegration } from '../integration-checks.mjs';
import { handoffDigest } from '../handoffs.mjs';
const sha=x=>x.repeat(40),digest=x=>x.repeat(64);
function fixture() {
 let now=Date.parse('2026-01-01T00:00:00Z');
 const state={agents:{a:{id:'a',owner:'alice'},b:{id:'b',owner:'bob'},v:{id:'v',owner:'carol'}},tasks:[],handoffs:[],workerRuns:[{id:'run',agentId:'v',status:'running',leaseUntil:now+600000}],claims:[],collaborationAgreements:[]};
 for(const owner of ['alice','bob','carol'])for(const peerOwner of ['alice','bob','carol'])if(owner!==peerOwner)state.collaborationAgreements.push({id:owner+peerOwner,owner,peerOwner,status:'active',expiresAt:'2026-01-01T01:00:00Z',allowedKinds:['testing'],allowedPaths:['src']});
 const add=(id,worker='b',path='src/item',commit='b')=>{const h={id:'h'+id,taskId:id,taskRevision:2,senderId:worker,recipientId:'a',repository:'example/project',commitSha:sha(commit),artifacts:[{path,sha256:digest('a')}],testEvidence:['Observed fixture test'],assumptions:[],createdAt:now};h.digest=handoffDigest(h);h.receipt={actorId:'a',verdict:'accepted',taskRevision:2,manifestDigest:h.digest};state.handoffs.push(h);state.tasks.push({id,createdBy:'a',assigneeId:worker,kind:'implementation',status:'completed',revision:3,paths:[path],history:[{revision:3,action:'complete',handoffId:h.id}]});return {task_id:id,task_revision:3,commit_sha:h.commitSha,handoff_id:h.id,manifest_digest:h.digest};};
 const contribution=add('t');state.tasks.push({id:'execution',createdBy:'a',assigneeId:'v',kind:'testing',status:'in_progress',revision:2,paths:['src'],dependsOn:['t'],history:[],startedAt:now});let policy={owner:'carol',allowed_kinds:['testing'],allowed_paths:['src'],max_active_tasks:2,max_chain_depth:3,max_handoffs:3,max_task_minutes:30,allow_unassigned:false,expires_at:'2026-01-01T01:00:00Z'};
 const box={now:()=>now,actor:(s,id)=>{if(!s.agents[id])throw new Error('Unknown worker');return s.agents[id];},readPolicy:async()=>policy,store:{read:async()=>({state:structuredClone(state)})},change:async fn=>{const copy=structuredClone(state);const out=fn(copy);for(const k of Object.keys(state))delete state[k];Object.assign(state,copy);return structuredClone(out);}};
 const fields={repository:'example/project',base_sha:sha('a'),contributions:[contribution],profile_name:'unit',profile_digest:digest('c')};
 const create=(extra={})=>createIntegrationCheck.call(box,{agent_id:'a',work_id:'combined',verifier_id:'v',execution_task_id:'execution',...fields,deadline:'2026-01-01T00:30:00Z',request_id:'create',...extra});
 const advance=(c,action,extra={})=>advanceIntegrationCheck.call(box,{agent_id:'v',integration_id:c.id,expected_revision:c.revision,input_digest:c.manifest.digest,request_id:action+c.revision,summary:'Observed synthetic evidence',action,...extra});
 const result=(c,extra={})=>({inputDigest:c.manifest.digest,attempt:c.attempt,profileDigest:c.manifest.profile.digest,runId:'run',verdict:'passed',commitSha:sha('d'),treeSha:sha('e'),checks:[{name:'unit',passed:true}],evidence:['Local fixture passed'],...extra});
 return {state,box,fields,create,advance,result,add,tick:ms=>now+=ms,setPolicy:p=>policy=p,now:()=>now};
}
test('exact completed inputs progress through a live verifier run and idempotent result',async()=>{
 const f=fixture();let c=await f.create();assert.equal(c.status,'pending');assert.equal((await f.create()).id,c.id);await assert.rejects(f.create({base_sha:sha('f')}),/different content/);
 c=await f.advance(c,'start',{run_id:'run'});assert.equal(c.execution.run.id,'run');const original=c,r=f.result(c);c=await f.advance(c,'result',{run_id:'run',result:r});assert.equal(c.status,'passed');assert.equal((await f.advance(original,'result',{run_id:'run',result:r})).revision,c.revision);
 await assert.rejects(f.advance(original,'result',{run_id:'run',result:{...r,evidence:['different']}}),/different content/);
 assert.equal((await getIntegrationCheck.call(f.box,{agent_id:'b',integration_id:c.id})).status,'passed');
 assert.equal((await listIntegrationChecks.call(f.box,{agent_id:'v',limit:1})).integrationChecks.length,1);
});
test('source revisions, receipt digests and completion linkage must match',async()=>{
 for(const mutate of [f=>f.state.tasks[0].revision++,f=>f.state.handoffs[0].receipt.manifestDigest=digest('f'),f=>f.state.tasks[0].history[0].handoffId='other',f=>f.state.handoffs[0].commitSha=sha('c'),f=>f.state.tasks[0].status='in_progress']){const f=fixture();mutate(f);await assert.rejects(f.create(),/Source/);}
 const f=fixture();f.state.reviewCycles=[{taskId:'t',phase:'approved',submittedTaskRevision:1}];await assert.rejects(f.create(),/review is stale/);
});
test('start gates testing policy, bilateral agreements and claims',async()=>{
 for(const mutate of [f=>f.setPolicy(null),f=>f.state.collaborationAgreements.pop(),f=>f.state.claims.push({agentId:'b',expiresAt:f.now()+1000,paths:['src']})]){const f=fixture();const c=await f.create();mutate(f);await assert.rejects(f.advance(c,'start',{run_id:'run'}),/policy|agreements|claim/);}
 const f=fixture(),c=await f.create();await assert.rejects(f.advance(c,'start',{agent_id:'b',run_id:'run'}),/exact verifier/);await assert.rejects(f.advance(c,'start',{run_id:'unknown'}),/lease/);
});
test('results cannot borrow another run, stale input, profile or attempt',async()=>{
 const f=fixture();const c=await f.advance(await f.create(),'start',{run_id:'run'});
 for(const extra of [{runId:'other'},{inputDigest:digest('f')},{profileDigest:digest('f')},{attempt:2},{checks:[{name:'unit',passed:false}]},{commitSha:null}])await assert.rejects(f.advance(c,'result',{run_id:'run',result:f.result(c,extra)}),/exact|Passed/);
 f.tick(600001);await assert.rejects(f.advance(c,'result',{run_id:'run',result:f.result(c)}),/lease/);
 assert.equal((await getIntegrationCheck.call(f.box,{agent_id:'v',integration_id:c.id})).interrupted,true);
 const blocked=await f.advance(c,'block');assert.equal(blocked.status,'blocked');
});
test('failed and repaired inputs retain attempts and never reset budgets',async()=>{
 const f=fixture();let c=await f.advance(await f.create({max_attempts:2}),'start',{run_id:'run'});c=await f.advance(c,'result',{run_id:'run',result:f.result(c,{verdict:'failed',checks:[{name:'unit',passed:false}]})});
 await assert.rejects(f.advance(c,'retry',{...f.fields}),/recovery evidence/);
 const repair=f.add('repair','b','src/item','f');c=await f.advance(c,'retry',{...f.fields,contributions:[repair]});assert.equal(c.attempt,2);assert.equal(c.attempts[0].result.verdict,'failed');
 c=await f.advance(c,'start',{run_id:'run'});c=await f.advance(c,'result',{run_id:'run',result:f.result(c)});await assert.rejects(f.advance(c,'retry',{...f.fields,base_sha:sha('f')}),/budget exhausted/);
});
test('retries preserve repository, paths, participants and explicit interruption handling',async()=>{
 const f=fixture();let c=await f.advance(await f.create(),'start',{run_id:'run'});await assert.rejects(f.advance(c,'retry',{...f.fields,base_sha:sha('f')}),/Finish/);c=await f.advance(c,'block');
 await assert.rejects(f.advance(c,'retry',{...f.fields,repository:'other/repo'}),/repository/);
 const repair=f.add('outside','b','other/file','f');await assert.rejects(f.advance(c,'retry',{...f.fields,contributions:[repair]}),/expand paths/);
 f.state.agents.new={id:'new',owner:'bob'};const newWorker=f.add('replacement','new','src/item','f');await assert.rejects(f.advance(c,'retry',{...f.fields,contributions:[newWorker]}),/replace participants/);
});
test('contract supersession invalidates completed source inputs',async()=>{
 const f=fixture();f.state.tasks[0].contractId='contract';f.state.tasks[0].contractDigest=digest('a');
 await assert.rejects(f.create(),/contract pin/);
 await assert.rejects(f.create({contracts:[{contract_id:'contract',digest:digest('a')}]}),/Contract not found/);
});
test('goal gate requires current passing inputs and all implementation task coverage',async()=>{
 const f=fixture();const goal={id:'goal',owner:'alice',status:'active',participants:['a','b','v'],allowedKinds:['testing','implementation'],allowedPaths:['src'],deadline:'2026-01-01T01:00:00Z',requiredIntegrationWorkIds:['combined'],maxConcurrent:2,maxUsageUnits:null,reservations:[]};f.state.goals=[goal];f.state.tasks[0].goalId='goal';f.state.tasks.find(t=>t.id==='execution').goalId='goal';
 let c=await f.create({goal_id:'goal'});assert.throws(()=>assertGoalIntegration(f.state,goal,f.now()),/passing/);c=await f.advance(c,'start',{run_id:'run'});c=await f.advance(c,'result',{run_id:'run',result:f.result(c)});assert.doesNotThrow(()=>assertGoalIntegration(f.state,goal,f.now()));
 f.state.tasks[0].revision++;assert.throws(()=>assertGoalIntegration(f.state,goal,f.now()),/exact current/);f.state.tasks[0].revision--;
 f.add('extra');f.state.tasks.at(-1).goalId='goal';assert.throws(()=>assertGoalIntegration(f.state,goal,f.now()),/cover all/);
});

test('agreement revocation and current policy still gate results after start',async()=>{
 const f=fixture();const c=await f.advance(await f.create(),'start',{run_id:'run'});f.state.collaborationAgreements[0].status='revoked';await assert.rejects(f.advance(c,'result',{run_id:'run',result:f.result(c)}),/agreements/);f.state.collaborationAgreements[0].status='active';f.setPolicy(null);await assert.rejects(f.advance(c,'result',{run_id:'run',result:f.result(c)}),/policy/);assert.equal((await f.advance(c,'block')).status,'blocked');
});
test('deadline expiry blocks late results and retry but allows explicit interruption recording',async()=>{
 const f=fixture();let c=await f.advance(await f.create(),'start',{run_id:'run'});f.tick(1800001);await assert.rejects(f.advance(c,'result',{run_id:'run',result:f.result(c)}),/deadline/);c=await f.advance(c,'block');assert.equal(c.status,'expired');await assert.rejects(f.advance(c,'retry',{...f.fields,base_sha:sha('f')}),/deadline/);
});
test('a changed base creates a new pending attempt and invalidates old passed status',async()=>{
 const f=fixture();let c=await f.advance(await f.create(),'start',{run_id:'run'});c=await f.advance(c,'result',{run_id:'run',result:f.result(c)});const prior=c.manifest.digest;c=await f.advance(c,'retry',{...f.fields,base_sha:sha('f')});assert.equal(c.status,'pending');assert.notEqual(c.manifest.digest,prior);assert.equal(c.attempts[0].status,'passed');assert.equal(c.manifest.deadline,c.deadline);
});

test('superseding an agreed source interface blocks an in-flight integration result',async()=>{
 const f=fixture();for(const a of f.state.collaborationAgreements)a.allowedKinds.push('implementation');
 const t=f.state.tasks[0];Object.assign(t,{contractId:'contract',contractDigest:digest('a')});
 f.state.contracts=[{id:'contract',participants:['a','b'],kind:'implementation',paths:['src'],repository:'example/project',goalId:null,status:'agreed',deadline:'2026-01-01T01:00:00Z',versions:[{digest:digest('a'),responses:[]}]}];
 const c=await f.advance(await f.create({contracts:[{contract_id:'contract',digest:digest('a')}]}),'start',{run_id:'run'});
 f.state.contracts[0].versions.push({digest:digest('b'),responses:[]});await assert.rejects(f.advance(c,'result',{run_id:'run',result:f.result(c)}),/superseded/);
});


test('same-input recovery requires explicit reconciliation evidence and consumes an attempt',async()=>{
 const f=fixture();let c=await f.advance(await f.create({max_attempts:2}),'start',{run_id:'run'});f.tick(600001);c=await f.advance(c,'block');
 await assert.rejects(f.advance(c,'retry',{...f.fields}),/recovery evidence/);const original=c.manifest.digest;c=await f.advance(c,'retry',{...f.fields,recovery_evidence:['Inspected preserved worktree and logs; prior process stopped without completing checks.']});assert.equal(c.attempt,2);assert.equal(c.manifest.digest,original);assert.equal(c.attempts[1].recoveryEvidence.length,1);c=await f.advance(c,'block');await assert.rejects(f.advance(c,'retry',{...f.fields,recovery_evidence:['Inspected again']}),/budget exhausted/);
});
test('same-input recovery cannot rerun a passed attempt',async()=>{
 const f=fixture();let c=await f.advance(await f.create(),'start',{run_id:'run'});c=await f.advance(c,'result',{run_id:'run',result:f.result(c)});await assert.rejects(f.advance(c,'retry',{...f.fields,recovery_evidence:['Already passed']}),/failed or blocked/);
});


test('an assigned testing task binds execution and cannot reset integration budgets',async()=>{
 const f=fixture();await assert.rejects(f.create({execution_task_id:undefined}),/execution_task_id/);await assert.rejects(f.create({execution_task_id:'t'}),/testing execution task/);const c=await f.create();assert.equal(c.executionTaskId,'execution');await assert.rejects(f.create({work_id:'budget-reset',request_id:'other'}),/already belongs/);
 const task=f.state.tasks.find(t=>t.id==='execution');task.status='blocked';await assert.rejects(f.advance(c,'start',{run_id:'run'}),/testing execution task/);task.status='ready';await assert.rejects(f.advance(c,'start',{run_id:'run'}),/testing execution task/);task.status='in_progress';task.assigneeId='b';await assert.rejects(f.advance(c,'start',{run_id:'run'}),/testing execution task/);
});
test('execution task inherits active task limits, goal concurrency and usage reservations',async()=>{
 const f=fixture();const goal={id:'goal',owner:'alice',status:'active',participants:['a','b','v'],allowedKinds:['testing','implementation'],allowedPaths:['src'],deadline:'2026-01-01T01:00:00Z',maxConcurrent:1,maxUsageUnits:10,reservations:[]};f.state.goals=[goal];for(const t of f.state.tasks)t.goalId='goal';const c=await f.create({goal_id:'goal'});
 await assert.rejects(f.advance(c,'start',{run_id:'run'}),/reservation/);f.state.goals[0].reservations.push({taskId:'execution',actorId:'v',status:'reserved',units:1});
 f.state.tasks.push({id:'other',goalId:'goal',status:'in_progress',assigneeId:'b'});await assert.rejects(f.advance(c,'start',{run_id:'run'}),/concurrency/);f.state.tasks.pop();
 f.state.tasks.push({id:'other',status:'in_progress',assigneeId:'v'},{id:'third',status:'blocked',assigneeId:'v'});await assert.rejects(f.advance(c,'start',{run_id:'run'}),/Active task limit/);f.state.tasks.splice(-2);
 assert.equal((await f.advance(c,'start',{run_id:'run'})).status,'running');
});
test('task time and policy expiry clamp the original integration lease',async()=>{
 const f=fixture();const task=f.state.tasks.find(t=>t.id==='execution');task.startedAt=f.now()-29*60000;const c=await f.advance(await f.create(),'start',{run_id:'run'});assert.equal(c.execution.run.leaseUntil,f.now()+60000);
 // Even if policy is later extended, the original attempt cannot silently gain time.
 f.state.tasks.find(t=>t.id==='execution').startedAt=f.now();f.tick(60001);await assert.rejects(f.advance(c,'result',{run_id:'run',result:f.result(c)}),/original running lease|time budget/);
 const p=fixture();p.setPolicy({owner:'carol',allowed_kinds:['testing'],allowed_paths:['src'],max_active_tasks:2,max_task_minutes:30,expires_at:new Date(p.now()+30000).toISOString()});const clamped=await p.advance(await p.create(),'start',{run_id:'run'});assert.equal(clamped.execution.run.leaseUntil,p.now()+30000);
});
test('execution task pause and negotiated terms gate reporting without hiding interruption',async()=>{
 const f=fixture();let c=await f.advance(await f.create(),'start',{run_id:'run'});const task=f.state.tasks.find(t=>t.id==='execution');task.status='blocked';await assert.rejects(f.advance(c,'result',{run_id:'run',result:f.result(c)}),/testing execution task/);task.status='in_progress';task.negotiationId='missing';await assert.rejects(f.advance(c,'result',{run_id:'run',result:f.result(c)}),/Negotiated task/);c=await f.advance(c,'block');assert.equal(c.status,'blocked');
});
test('result checks reject undeclared fields without storing their payload',async()=>{
 const f=fixture();const c=await f.advance(await f.create(),'start',{run_id:'run'});await assert.rejects(f.advance(c,'result',{run_id:'run',result:f.result(c,{checks:[{name:'test',passed:true,extra:'unbounded input'}]})}),/check fields/);assert.equal(f.state.integrationChecks[0].status,'running');
});


test('declared source scope travels in every manifest and cannot drift from record scope',async()=>{
 const f=fixture();let c=await f.create();assert.deepEqual(c.manifest.paths,['src/item']);const original=c.manifest.paths;c=await f.advance(c,'block');c=await f.advance(c,'retry',{...f.fields,base_sha:sha('f')});assert.deepEqual(c.manifest.paths,original);
 f.state.integrationChecks[0].attempts.at(-1).manifest.paths=['src'];await assert.rejects(f.advance(c,'start',{run_id:'run'}),/manifest paths/);
});
