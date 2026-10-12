import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Mailbox } from '../mailbox.mjs';
import { call as dispatch } from '../tools.mjs';

const execute = promisify(execFile);

/** Scripted protocol actors, not model-driven agents or real GitHub accounts. */
export async function runScenarios(team) {
  const started = performance.now();
  const scenarios = [];
  const run = async (name, work) => {
    try { scenarios.push({name, status:'passed', passed:true, evidence:await work()}); }
    catch (error) { scenarios.push({name, status:'failed', passed:false, error:error.message}); }
  };
  const call = (key, tool, args={}) => team.call(key, tool, args);
  const id = key => team.workers[key].id;
  const create = (key, name, extra={}) => call(key,'create_task', {
    title:name, description:'Synthetic bounded collaboration acceptance', acceptance:['Concrete assertions pass'],
    paths:['src/shared'], required_capabilities:['testing'], request_id:name, ...extra,
  });
  const update = (key,t,action,extra={}) => call(key,'update_task', {
    task_id:t.id, expected_revision:t.revision, request_id:`${action}-${t.id}-${t.revision}`,
    action, summary:'Scripted fixture evidence', ...extra,
  });
  const workerKey = workerId => Object.keys(team.workers).find(k=>id(k)===workerId);

  await run('contributor-ownership',async()=>{
    const foreign = new Mailbox(team.store,team.workers.a1.owner);
    await assert.rejects(dispatch(foreign,'check_inbox',{agent_id:id('b1')}),/identity/);
    assert.notEqual(team.workers.a1.owner,team.workers.b1.owner);
    return {rejectedImpersonation:true, boundary:'Injected login ownership check; no real account authentication'};
  });
  await run('different-local-scopes',async()=>{
    const t=await create('a1','scope-check',{assignee_id:id('b1'),paths:['src/contributor-a']});
    const decision=await call('b1','check_task',{task_id:t.id});
    assert.equal(decision.allowed,false);
    await assert.rejects(update('b1',t,'accept'),/paths/);
    await update('a1',t,'cancel');
    return {taskId:t.id,reasons:decision.reasons,humanDecisionRequired:true};
  });
  await run('lost-response-exact-retry',async()=>{
    const payload={to:id('b2'),kind:'question',body:'Synthetic retry check',request_id:'harness-lost-response'};
    const path=join(team.workers.a1.directory,'pending-message.json');
    await writeFile(path,JSON.stringify(payload,null,2));
    team.store.failNext('offline');
    await assert.rejects(call('a1','send_message',payload));
    assert.equal((await team.store.read()).state.messages.filter(m=>m.requestId===payload.request_id).length,0);
    team.store.failNext('lost-response');
    await assert.rejects(call('a1','send_message',payload));
    await team.restart('a1');
    const retried=await call('a1','send_message',JSON.parse(await readFile(path,'utf8')));
    assert.equal((await call('a1','send_message',payload)).id,retried.id);
    await assert.rejects(call('a1','send_message',{...payload,body:'Changed'}),/different content/);
    const {state}=await team.store.read();
    assert.equal(state.messages.filter(m=>m.requestId===payload.request_id).length,1);
    await call('b2','acknowledge_message',{message_id:retried.id});
    return {messageId:retried.id,committedRecords:1,exactPayloadSaved:true};
  });
  await run('concurrent-writes',async()=>{
    team.store.failNext('conflict');
    const results=await Promise.all(['a2','b2','c2'].map(key=>call(key,'send_message',{
      to:id('a1'),kind:'update',body:`Synthetic concurrent write ${key}`,request_id:'concurrent-'+key,
    })));
    const {state}=await team.store.read();
    for(const m of results)assert.ok(state.messages.some(record=>record.id===m.id));
    return {messages:results.map(m=>m.id),concurrentActors:3};
  });
  await run('advisory-claim-conflict',async()=>{
    const claim={paths:['src/shared/file.mjs'],task:'Synthetic edit',branch:'fixture/claims'};
    const first=await call('a1','claim_work',claim);
    assert.equal(first.claimed,true);
    const second=await call('b1','claim_work',{...claim,paths:['src/shared']});
    assert.equal(second.claimed,false);
    assert.ok(second.conflicts.length);
    // The scripted agent deliberately does not write when its claim conflicts.
    await call('a1','release_work');
    assert.equal((await call('b1','claim_work',claim)).claimed,true);
    await call('b1','release_work');
    return {overlappingEditSkipped:true,retryAfterRelease:true,boundary:'Cooperative, not a filesystem lock'};
  });
  await run('offline-routing-budget',async()=>{
    let t=await create('c1','offline-route');
    const route=()=>call('c1','route_task',{task_id:t.id,expected_revision:t.revision,
      request_id:'offline-route-'+t.revision,summary:'Try available recipient',next_steps:['Inspect fixture'],timeout_minutes:1,max_attempts:2});
    t=(await route()).task;
    const first=t.assigneeId;
    // Advertised presence can be stale: first recipient never accepts.
    assert.match((await route()).reason,/Waiting/);
    team.advance(60001);
    t=(await route()).task;
    assert.notEqual(first,t.assigneeId);
    team.advance(60001);
    assert.match((await route()).reason,/limit/);
    const attempts=t.routing.attempted.length;
    assert.equal(attempts,2);
    await update('c1',t,'cancel');
    let accepted=await create('c1','accepted-route');
    accepted=(await call('c1','route_task',{task_id:accepted.id,expected_revision:accepted.revision,
      request_id:'accepted-route-delivery',summary:'Deliver',next_steps:['Inspect fixture'],timeout_minutes:1,max_attempts:2})).task;
    accepted=await update(workerKey(accepted.assigneeId),accepted,'accept');
    team.advance(60001);
    await assert.rejects(call('c1','route_task',{task_id:accepted.id,expected_revision:accepted.revision,
      request_id:'forbidden-takeover',summary:'Must fail',next_steps:['Do not take over']}),/Only creator/);
    await update(workerKey(accepted.assigneeId),accepted,'complete');
    return {attempts,humanDecisionRequired:true,acceptedWorkNotTakenOver:true};
  });
  await run('checkpoint-restart',async()=>{
    let t=await create('b1','checkpoint-work',{assignee_id:id('b1')});
    t=await update('b1',t,'accept');
    await call('b1','save_checkpoint',{task_id:t.id,expected_revision:0,expected_task_revision:t.revision,
      request_id:'saved-checkpoint',summary:'Fixture inspected',next_steps:['Revalidate actual artifact before continuing']});
    const original=id('b1');
    await team.restart('b1');
    assert.equal(id('b1'),original);
    const recovery=await call('b1','get_recovery');
    assert.ok(recovery.checkpoints.some(c=>c.taskId===t.id&&c.summary==='Fixture inspected'));
    await update('b1',t,'complete');
    return {taskId:t.id,identityPreserved:true,checkpointRecovered:true};
  });
  await run('review-budget-exhaustion',async()=>{
    let t=await create('a1','bounded-review',{assignee_id:id('a1')});
    t=await update('a1',t,'accept');
    let cycle=await call('a1','start_review_cycle',{task_id:t.id,reviewer_id:id('c2'),expected_task_revision:t.revision,
      request_id:'bounded-review-cycle',summary:'Synthetic review',artifacts:['fixture deliberately incomplete'],max_rounds:1});
    cycle=await call('c2','advance_review_cycle',{cycle_id:cycle.id,expected_revision:cycle.revision,expected_task_revision:t.revision,
      request_id:'bounded-review-verdict',action:'request_changes',summary:'Acceptance criterion missing',artifacts:['Missing fixture case']});
    assert.equal(cycle.phase,'exhausted');
    await assert.rejects(update('a1',t,'complete'),/approval/i);
    await assert.rejects(call('a1','start_review_cycle',{task_id:t.id,reviewer_id:id('b2'),expected_task_revision:t.revision,
      request_id:'reset-budget',summary:'Must not reset',artifacts:['same task'],max_rounds:1}),/already/i);
    return {taskId:t.id,cycleId:cycle.id,phase:cycle.phase,humanDecisionRequired:true,budgetResetRejected:true};
  });
  await run('tested-artifact-and-cross-owner-skill-reuse',async()=>{
    const fixtureDir=join(team.workers.c1.directory,'workspace','src','shared');
    await mkdir(fixtureDir,{recursive:true});
    const artifact=join(fixtureDir,'unique.mjs'),check=join(fixtureDir,'verify.mjs');
    await writeFile(check,"import assert from 'node:assert/strict';\nimport {unique} from './unique.mjs';\nassert.deepEqual(unique(['a','b','a']), ['a','b']);\nassert.deepEqual(unique([]), []);\nassert.deepEqual(unique(['__proto__','x','__proto__']), ['__proto__','x']);\nconsole.log('3 fixture assertions passed');\n");
    await writeFile(artifact,"export const unique = values => values;\n");
    await assert.rejects(execute(process.execPath,[check],{timeout:10000,windowsHide:true}));
    let t=await create('c1','fixture-implementation',{assignee_id:id('c1')});
    t=await update('c1',t,'accept');
    let cycle=await call('c1','start_review_cycle',{task_id:t.id,reviewer_id:id('a2'),expected_task_revision:t.revision,
      request_id:'fixture-review',summary:'Test exposed duplicates',artifacts:['Initial node fixture failed'],max_rounds:2});
    const verdict=(actor,action,evidence)=>call(actor,'advance_review_cycle',{cycle_id:cycle.id,expected_revision:cycle.revision,
      expected_task_revision:t.revision,request_id:'fixture-'+action,action,summary:evidence,artifacts:[evidence]});
    cycle=await verdict('a2','request_changes','Duplicate input is returned unchanged');
    await writeFile(artifact,"export const unique = values => [...new Set(values)];\n");
    const checked=await execute(process.execPath,[check],{timeout:10000,windowsHide:true});
    assert.match(checked.stdout,/3 fixture assertions passed/);
    t=await update('c1',t,'progress',{summary:'Fixed duplicates; actual Node fixture passed'});
    cycle=await verdict('c1','resubmit','Fixed fixture passes 3 assertions');
    cycle=await verdict('a2','approve','Reviewed Set insertion order and fixture result');
    t=await update('c1',t,'complete');
    let skill=await call('c1','create_skill',{name:'stable-string-deduplication',title:'Preserve first-seen string order',
      description:'Deduplicate strings with a Set',when_to_use:'Repeated string identifiers need stable order',
      steps:['Construct a Set from the input strings','Spread the Set to an array'],validation:['Test repeated values, empty input and special object keys'],
      limitations:['Strings only; not structural object equality'],evidence:['Actual Node fixture passed 3 assertions'],source_task_id:t.id,request_id:'fixture-skill'});
    skill=await call('b2','review_skill',{skill_id:skill.id,expected_revision:skill.revision,request_id:'fixture-skill-review',
      verdict:'approve',summary:'Scripted reviewer checked fixture evidence',evidence:['Three edge cases executed by Node']});
    skill=await call('c1','update_skill',{skill_id:skill.id,expected_revision:skill.revision,request_id:'fixture-skill-publish',action:'publish',summary:'Independent simulated owner reviewed'});
    const received=await call('a1','get_skill',{skill_id:skill.id});
    assert.equal(received.status,'published');
    const reuseDir=join(team.workers.a1.directory,'workspace','src','shared');
    await mkdir(reuseDir,{recursive:true});
    const reuse=join(reuseDir,'reuse.mjs');
    // Fixed harness code applies the documented technique, never executes skill text.
    await writeFile(reuse,"import assert from 'node:assert/strict';\nconst tags=['review','build','review','test','build'];\nassert.deepEqual([...new Set(tags)], ['review','build','test']);\nconsole.log('Unseen tag fixture passed');\n");
    assert.match((await execute(process.execPath,[reuse],{timeout:10000,windowsHide:true})).stdout,/Unseen tag fixture passed/);
    await call('a1','record_skill_use',{skill_id:skill.id,request_id:'fixture-skill-reuse',outcome:'success',
      summary:'Applied the technique to new tag inputs',evidence:['Separate contributor workspace: Node assertion passed']});
    return {taskId:t.id,skillId:skill.id,reviewCycleId:cycle.id,initialFixtureFailed:true,correctedAssertions:3,reuseAssertions:1,
      artifact,scope:'Scripted technique application; no autonomous learning or measured skill benefit'};
  });
  const finalState=(await team.store.read()).state;
  return {mode:'scripted-simulation',status:scenarios.every(s=>s.passed)?'passed':'failed',passed:scenarios.every(s=>s.passed),scenarios,
    metrics:{...team.metrics,scenariosPassed:scenarios.filter(s=>s.passed).length,scenariosFailed:scenarios.filter(s=>!s.passed).length,
      completedTasks:(finalState.tasks??[]).filter(t=>t.status==='completed').length,
      duplicatesPrevented:scenarios.some(s=>s.name==='lost-response-exact-retry'&&s.passed)?1:0,
      failuresInjected:team.metrics.faults,elapsedMs:Math.round(performance.now()-started),providerUsage:null,
      humanDecisionRequirements:scenarios.filter(s=>s.evidence?.humanDecisionRequired).length},
    limitations:['No live models, real contributor accounts, operating-system isolation, network faults, or host scheduler verification.',
      'Shared in-process storage and injected login contexts exercise cooperative protocol controls, not adversarial security.']};
}
