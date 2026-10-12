import test from 'node:test';
import assert from 'node:assert/strict';
import { Mailbox } from '../mailbox.mjs';
import { emptyState } from '../github.mjs';
import { nextActions } from '../next-actions.mjs';
import { skillDigest } from '../skills.mjs';

function fixture() {
  const now=10000000, state=emptyState();
  state.agents={a:{id:'a',owner:'alice',profile:{capabilities:['review'],paths:['src'],availability:'available',availableUntil:now+1000}},b:{id:'b',owner:'bob'}};
  const policy={allowed_kinds:['implementation','review'],allowed_paths:['src'],allow_unassigned:true,max_active_tasks:10,max_chain_depth:2,max_handoffs:4,max_task_minutes:60,expires_at:new Date(now+3600000).toISOString()};
  const mailbox=new Mailbox({read:async()=>({state:structuredClone(state)})},'alice',()=>now,async()=>policy);
  mailbox.readPolicy=async()=>policy;
  const task=(id,fields={})=>({id,assigneeId:'a',createdBy:'a',status:'in_progress',revision:2,dependsOn:[],requiredCapabilities:[],paths:['src'],kind:'implementation',history:[],...fields});
  const run=args=>nextActions.call(mailbox,{agent_id:'a',...args});
  return {state,policy,mailbox,task,run,now};
}

test('next actions is deterministic, paginated and read-only across mixed continuation work',async()=>{
  const {state,task,run}=fixture();
  state.tasks=[task('z'),task('a'),task('ready',{status:'ready'})];
  state.checkpoints=[{agentId:'a',taskId:'z',revision:1,taskRevision:1,taskStatus:'in_progress'}];
  state.messages=[{id:'m',sequence:1,from:'b',to:'a',kind:'question',acknowledgedBy:[]}];
  const before=JSON.stringify(state), first=await run({limit:2}), second=await run({after:2,limit:100});
  assert.deepEqual(first.actions.map(a=>a.kind),['recover_checkpoint','inspect_message']);
  assert.equal(first.actions[0].needsRevalidation,true);
  assert.deepEqual(second.actions.map(a=>a.id),['continue_task:a','continue_task:z','accept_task:ready']);
  assert.equal(first.nextAfter,2); assert.equal(first.hasMore,true); assert.equal(second.hasMore,false);
  assert.deepEqual((await run({limit:2})).actions,first.actions);
  assert.equal(JSON.stringify(state),before);
});

test('missing, invalid or expired policy never yields autonomous work eligibility',async()=>{
  const {state,task,run,mailbox,policy,now}=fixture();
  state.tasks=[task('work'),task('ready',{status:'ready'})];
  mailbox.readPolicy=async()=>null;
  let result=await run();
  assert.equal(result.counts.blocked,2);
  assert.match(result.actions[0].eligibility.reasons.join(),/No local autonomy policy/);
  mailbox.readPolicy=async()=>{throw new Error('sensitive local file contents');};
  result=await run(); assert.equal(result.policyError,true);
  assert.ok(!JSON.stringify(result).includes('sensitive'));
  mailbox.readPolicy=async()=>policy; policy.expires_at=new Date(now).toISOString();
  result=await run(); assert.match(result.actions[0].eligibility.reasons.join(),/expired/);
});

test('review suggestions enforce actor, revision, source state and round budgets',async()=>{
  const {state,task,run}=fixture();
  state.tasks=[task('review',{assigneeId:'b'}),task('fix'),task('approved'),task('cancelled')];
  state.reviewCycles=[
    {id:'r',taskId:'review',builderId:'b',reviewerId:'a',phase:'awaiting_review',submittedTaskRevision:1,round:1,maxRounds:3,revision:1},
    {id:'f',taskId:'fix',builderId:'a',reviewerId:'b',phase:'changes_requested',submittedTaskRevision:1,round:3,maxRounds:3,revision:2},
    {id:'p',taskId:'approved',builderId:'a',reviewerId:'b',phase:'approved',submittedTaskRevision:2,round:1,maxRounds:3,revision:2},
    {id:'c',taskId:'cancelled',builderId:'a',reviewerId:'b',phase:'cancelled',submittedTaskRevision:2,round:1,maxRounds:3,revision:2}
  ];
  const result=await run(), byKind=Object.fromEntries(result.actions.map(a=>[a.kind,a]));
  assert.equal(byKind.review_submission.status,'blocked');
  assert.match(byKind.review_submission.eligibility.reasons.join(),/resubmit/);
  assert.equal(byKind.revise_submission.status,'blocked');
  assert.match(byKind.revise_submission.eligibility.reasons.join(),/round limit/);
  assert.equal(byKind.verify_completion.status,'actionable');
  assert.equal(byKind.review_decision.status,'blocked');
  assert.equal(result.actions.some(a=>a.kind==='continue_task'),false);
  state.reviewCycles[0].submittedTaskRevision=2;
  assert.equal((await run()).actions.find(a=>a.kind==='review_submission').status,'actionable');
});

test('routing preserves deadlines, fixed limits and accepted ownership',async()=>{
  const {state,task,run,now}=fixture();
  state.agents.c={id:'c',owner:'charlie',profile:{availability:'available',availableUntil:now+1000,capabilities:[],paths:['src']}};
  const routing={requestedBy:'a',assigneeId:'b',attempted:['b'],acceptBy:now+1,maxAttempts:2,timeoutMinutes:30};
  state.tasks=[task('delivery',{assigneeId:'b',status:'ready',routing})];
  assert.equal((await run()).actions[0].status,'waiting');
  routing.acceptBy=now;
  let entry=(await run()).actions[0]; assert.equal(entry.status,'actionable');
  assert.deepEqual(entry.limits,{attempts:1,maxAttempts:2,timeoutMinutes:30});
  routing.attempted.push('c'); entry=(await run()).actions[0];
  assert.equal(entry.status,'blocked'); assert.match(entry.eligibility.reasons.join(),/attempt limit/);
  state.tasks[0].status='in_progress';
  assert.equal((await run()).actions.length,0);
});

test('answer and update consumption does not propose replies; only addressed unread records appear',async()=>{
  const {state,run}=fixture();
  const message=(id,fields={})=>({id,sequence:1,from:'b',to:'a',kind:'answer',acknowledgedBy:[],...fields});
  state.messages=[message('answer'),message('update',{kind:'update',to:'ALICE'}),message('self',{from:'a'}),message('other',{to:'b'}),message('done',{acknowledgedBy:['a']})];
  const result=await run();
  assert.deepEqual(result.actions.map(a=>a.messageId),['answer','update']);
  assert.ok(result.actions.every(a=>a.replyRequired===false && a.inspect.tool==='check_inbox'));
  assert.equal(state.messages[0].acknowledgedBy.length,0);
});

test('skill improvement suggestions suppress resolved proposals and reject corrupted versions',async()=>{
  const {state,run}=fixture();
  const skill={id:'s',createdBy:'a',status:'published',name:'test',version:1,steps:['step'],uses:[{actorId:'a',requestId:'1',outcome:'failure'},{actorId:'b',requestId:'2',outcome:'failure'}]};
  skill.digest=skillDigest(skill); state.skills=[skill];
  assert.equal((await run()).actions[0].kind,'inspect_skill_improvement');
  skill.steps=['tampered']; assert.equal((await run()).actions[0].status,'blocked');
  state.skillImprovements=[{id:'p',skillId:'s',createdBy:'a',status:'resolved'}];
  assert.equal((await run()).actions.length,0);
});

test('identity, pagination and unrelated historical checkpoints are handled safely',async()=>{
  const {state,task,run}=fixture();
  for (const args of [{after:-1},{limit:0},{limit:101},{after:1.5}]) await assert.rejects(run(args),/pagination/);
  await assert.rejects(run({agent_id:'b'}),/identity/);
  state.tasks=[task('done',{status:'completed'}),task('other',{assigneeId:'b'})];
  state.checkpoints=[{agentId:'a',taskId:'done'},{agentId:'a',taskId:'other'},{agentId:'a',taskId:'missing'}];
  assert.equal((await run()).actions.length,0);
});

test('task suggestions retain dependency, capability, path and elapsed-time limits',async()=>{
  const {state,task,run,now,policy}=fixture();
  state.tasks=[task('restricted',{dependsOn:['unfinished'],requiredCapabilities:['deployment'],paths:['outside'],startedAt:now-policy.max_task_minutes*60000})];
  const result=await run(), entry=result.actions[0];
  assert.equal(entry.status,'blocked');
  for (const reason of ['Dependencies are not completed','Worker lacks required reported capabilities','Task paths need user approval','Task time budget exhausted; record progress and escalate']) {
    assert.ok(entry.eligibility.reasons.includes(reason),reason);
  }
  assert.equal(result.limits.maxTaskMinutes,policy.max_task_minutes);
});

test('message inspection fetches the selected record beyond the inbox default page',async()=>{
  const {state,run,mailbox}=fixture();
  state.messages=Array.from({length:35},(_,i)=>({id:String(35-i).padStart(2,'0'),sequence:i+1,from:'b',to:'a',kind:'question',acknowledgedBy:[]}));
  const selected=(await run({limit:1})).actions[0];
  assert.equal(selected.messageId,'01');
  assert.deepEqual(selected.inspect.args,{agent_id:'a',unread_only:true,after:34,limit:1});
  const inspected=await mailbox.inbox(selected.inspect.args);
  assert.equal(inspected.messages.length,1);
  assert.equal(inspected.messages[0].id,selected.messageId);
});

test('a new assignee sees inherited review gates after handoff instead of losing the task',async()=>{
  const {state,task,run}=fixture();
  state.tasks=[task('inherited',{revision:5})];
  state.reviewCycles=[{id:'previous-cycle',taskId:'inherited',builderId:'b',reviewerId:'c',phase:'approved',submittedTaskRevision:2,revision:2,round:1,maxRounds:3}];
  let actions=(await run()).actions;
  assert.equal(actions.length,1);
  assert.equal(actions[0].kind,'review_source_changed');
  assert.equal(actions[0].status,'blocked');
  assert.equal(actions.some(a=>a.kind==='verify_completion'),false,'old approval cannot cover reassignment revisions');
  state.reviewCycles[0].phase='cancelled';
  actions=(await run()).actions;
  assert.equal(actions.length,1);
  assert.equal(actions[0].kind,'review_decision');
  assert.equal(actions[0].status,'blocked');
});
