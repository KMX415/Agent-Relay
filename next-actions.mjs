import { eligibility, profileView, within } from './coordination.mjs';
import { skillObservations } from './skill-improvement.mjs';
import { skillDigest } from './skills.mjs';
import { assertCollaborationTaskAction } from './collaboration.mjs';
import { peerHelpView } from './peer-help.mjs';
import { goalReasons } from './goals.mjs';
import { contractView, contractTaskReasons } from './contracts.mjs';

const active = task => ['ready','in_progress','blocked'].includes(task.status);

// A snapshot, not a worker: suggestions carry read tools and never replay writes.
export async function nextActions({agent_id,after=0,limit=20}) {
  if (!Number.isInteger(after) || after<0 || !Number.isInteger(limit) || limit<1 || limit>100) throw new Error('Invalid pagination');
  const {state}=await this.store.read(), actor=this.actor(state,agent_id), now=this.now();
  let policy=null, policyError=false;
  try { policy=await this.readPolicy(); } catch { policyError=true; }
  const tasks=state.tasks??[], cycles=state.reviewCycles??[], entries=[];
  const check=(task,extra=[],goalExecution=true)=>{
    const result=eligibility(state,actor,task,policy,now,{goalExecution,contractSource:goalExecution?task:tasks.find(t=>t.id===task.id)??task});
    const reasons=[...result.reasons,...extra];
    if (task.negotiationId) {
      const source=tasks.find(t=>t.id===task.id)??task;
      // Reviewer eligibility uses its own scope, while agreement checks retain
      // the original negotiated terms and performer binding.
      try { assertCollaborationTaskAction(state,source,state.agents[source.assigneeId]??actor,policy,now); }
      catch(error) { reasons.push(error.message); }
    }
    if (!policy) reasons.push(policyError?'Local autonomy policy cannot be read; repair it before autonomous work':'No local autonomy policy; establish authorized scope before autonomous work');
    return {...result,allowed:reasons.length===0,reasons};
  };
  const add=(priority,kind,id,reason,tool,args,fields={})=>entries.push({id:kind+':'+id,priority,kind,status:'actionable',reason,inspect:{tool,args:{agent_id,...args}},...fields});
  for(const record of state.contracts??[]) {
    if(!record.participants.includes(agent_id))continue;
    const c=contractView(record,now),v=c.versions.at(-1);
    const changed=v.responses.some(r=>r.action==='request_changes');
    const responded=v.responses.some(r=>r.actorId===agent_id);
    const stopped=['expired','declined'].includes(c.status)||c.exhausted;
    if(c.status==='agreed')continue;
    add(24,'inspect_contract',c.id,stopped?'Contract needs a scoped decision; do not reset its deadline or version budget.':changed?'Inspect requested changes; only the proposer can create a successor.':'Inspect the exact interface digest before responding within your authorized scope.',
      'get_contract',{contract_id:c.id},{status:stopped||!policy?'blocked':changed?(c.createdBy===agent_id?'actionable':'waiting'):responded?'waiting':'actionable',contractRevision:c.revision,digest:c.digest});
  }
  for(const run of state.workerRuns??[]) {
    if(run.agentId!==agent_id || run.status!=='running' || now<run.leaseUntil)continue;
    add(5,'inspect_interrupted_run',run.id,'An earlier lease expired. Inspect actual effects, finalize its interrupted record, and reconcile outbox before continuing.','list_worker_runs',{}, {status:'blocked',runId:run.id});
  }
  for(const goal of state.goals??[]) {
    if(!goal.participants.includes(agent_id)||['completed','cancelled'].includes(goal.status))continue;
    const stopped=goal.status!=='active'||now>=Date.parse(goal.deadline);
    add(65,'advance_goal',goal.id,stopped?'Inspect the paused or expired goal; do not create replacement work to reset limits.':'Inspect acceptance criteria, linked tasks, and remaining limits before proposing the next task.','get_goal',{goal_id:goal.id}, {status:stopped||!policy?'blocked':'actionable',goalRevision:goal.revision});
  }
  for(const record of state.peerHelp??[]) {
    if(![record.requesterId,record.recipientId].includes(agent_id)||['resolved','escalated'].includes(record.phase))continue;
    const help=peerHelpView(record,now),requester=record.requesterId===agent_id;
    const stopped=help.effectivePhase==='expired';
    const turn=requester?record.phase==='responded':record.phase==='awaiting_response';
    const task=tasks.find(t=>t.id===record.taskId),stale=!task||task.revision!==record.taskRevision;
    add(30,'inspect_peer_help',record.id,stale?'Task changed; requester must escalate stale advice.':stopped?'Peer-help deadline expired; requester must escalate.':help.effectivePhase==='exhausted'&&requester?'Final response available; resolve with evidence or escalate. No retries remain.':turn?'Inspect the addressed help request or response within your own scope.':'Waiting for the peer; do not create another request.','get_peer_help',{help_id:record.id},{status:stale||stopped?'blocked':turn?'actionable':'waiting',taskId:record.taskId,helpRevision:record.revision});
  }
  const work=(priority,kind,task,reason,decision,fields={})=>add(priority,kind,task.id,reason,'get_task',{task_id:task.id},
    {taskId:task.id,taskRevision:task.revision,status:decision.allowed?'actionable':'blocked',eligibility:decision,...fields});

  for (const n of state.negotiations??[]) {
    if (![n.requesterId,n.recipientId].includes(agent_id) || !['proposed','deferred'].includes(n.status)) continue;
    const expired=now>=Date.parse(n.deadline), waiting=n.offeredBy===agent_id;
    add(25,'negotiate_work',n.id,expired?'Negotiation deadline expired; inspect and resolve within user scope':waiting?'The peer owns the next response':'Inspect terms and contributor agreements; accept, counter, decline or defer within scope',
      'get_negotiation',{negotiation_id:n.id},{status:expired?'blocked':waiting?'waiting':'actionable',negotiationRevision:n.revision,
        limits:{round:n.round,maxRounds:n.maxRounds,deadline:n.deadline}});
  }
  for (const h of state.handoffs??[]) {
    if (![h.senderId,h.recipientId].includes(agent_id)) continue;
    const task=tasks.find(t=>t.id===h.taskId);
    if (!task || !active(task)) continue;
    const stale=task.revision!==h.taskRevision;
    if (stale) continue;
    const receiver=h.recipientId===agent_id;
    add(26,'verify_handoff',h.id,receiver?'Inspect the immutable manifest and verify local artifacts before recording a receipt':'Inspect the recipient receipt before completing or transferring work',
      'get_handoff',{handoff_id:h.id},{status:h.receipt?.verdict==='rejected'?'blocked':receiver?(h.receipt?'waiting':'actionable'):(h.receipt?'actionable':'waiting'),taskId:task.id,taskRevision:task.revision});
  }

  for (const checkpoint of state.checkpoints??[]) {
    const task=tasks.find(t=>t.id===checkpoint.taskId);
    if (checkpoint.agentId!==agent_id || !task || task.assigneeId!==agent_id || !active(task)) continue;
    add(10,'recover_checkpoint',task.id,'Inspect saved progress and actual artifacts before another work segment','get_recovery',{},
      {taskId:task.id,taskRevision:task.revision,checkpointRevision:checkpoint.revision,
        needsRevalidation:task.revision!==checkpoint.taskRevision || task.status!==checkpoint.taskStatus,
        continuationEligibility:check(task)});
  }
  for (const cycle of cycles) {
    const task=tasks.find(t=>t.id===cycle.taskId);
    if (cycle.builderId!==agent_id && cycle.reviewerId!==agent_id && task?.assigneeId!==agent_id) continue;
    if (!task || !active(task)) continue;
    const fields={cycleId:cycle.id,taskId:task.id,taskRevision:task.revision,cycleRevision:cycle.revision,
      limits:{round:cycle.round,maxRounds:cycle.maxRounds,roundsRemaining:Math.max(0,cycle.maxRounds-cycle.round)}};
    const emit=(kind,reason,status,decision)=>add(20,kind,cycle.id,reason,'get_review_cycle',{cycle_id:cycle.id},
      {...fields,status,...(decision?{eligibility:decision}:{})});
    if (['exhausted','cancelled'].includes(cycle.phase)) {
      emit('review_decision','Review cannot continue or authorize completion; an explicit scoped decision is required','blocked'); continue;
    }
    if (task.status!=='in_progress' || task.assigneeId!==cycle.builderId) {
      emit('review_source_changed','Review requires an in-progress task still assigned to its builder','blocked'); continue;
    }
    const stale=cycle.submittedTaskRevision!==task.revision;
    if (cycle.reviewerId===agent_id && cycle.phase==='awaiting_review') {
      const decision=check({...task,assigneeId:agent_id,kind:'review',requiredCapabilities:['review']},stale?['Builder must resubmit the current task revision']:[],false);
      emit('review_submission','Inspect the submitted artifacts and record an evidence-backed verdict',decision.allowed?'actionable':'blocked',decision);
    }
    if (cycle.builderId!==agent_id) continue;
    if (stale || cycle.phase==='changes_requested') {
      const decision=check(task,cycle.round>=cycle.maxRounds?['Review round limit reached; explicit decision required']:[]);
      emit('revise_submission',stale?'Task changed since submission; inspect artifacts before resubmitting':'Inspect findings, fix within scope, then resubmit',decision.allowed?'actionable':'blocked',decision);
    } else if (cycle.phase==='approved') {
      const decision=check(task);
      emit('verify_completion','Current task revision is approved; verify acceptance evidence before completing',decision.allowed?'actionable':'blocked',decision);
    } else emit('await_review','The designated reviewer owns the next verdict','waiting');
  }
  for (const message of state.messages) {
    if (message.from===agent_id || message.acknowledgedBy.includes(agent_id) ||
        !(message.to===agent_id || message.to==='team' || message.to.toLowerCase()===actor.owner.toLowerCase())) continue;
    // Answers and updates can unblock work, but must never generate reply loops.
    add(30,'inspect_message',message.id,['answer','update'].includes(message.kind)?'Consume the result; no automated reply is required':'Inspect the addressed request against user scope before acting',
      'check_inbox',{unread_only:true,after:message.sequence-1,limit:1},{messageId:message.id,messageKind:message.kind,replyRequired:false});
  }
  for (const task of tasks) {
    if (!active(task)) continue;
    const cycle=cycles.find(c=>c.taskId===task.id);
    if (task.assigneeId===agent_id && task.status!=='ready' && !cycle) {
      work(40,task.status==='blocked'?'reassess_blocker':'continue_task',task,
        task.status==='blocked'?'Recheck the recorded blocker; resume only when it is resolved':'Revalidate scope, claims and artifacts before continuing',check(task),
        task.status==='blocked'?{status:'blocked'}:{});
    }
    const route=task.routing;
    if (route?.requestedBy===agent_id && task.status==='ready' && task.assigneeId===route.assigneeId) {
      const reasons=[];
      if (route.attempted.length>=route.maxAttempts) reasons.push('Routing attempt limit reached; human decision required');
      if (!task.paths?.length) reasons.push('Routing requires declared task paths');
      if (policy && (task.handoffCount??0)+1>policy.max_handoffs) reasons.push('Handoff count exceeds policy');
      if (cycle && ['awaiting_review','changes_requested'].includes(cycle.phase)) reasons.push('Cancel the active review before changing ownership');
      const candidate=Object.values(state.agents).some(a=>{
        const profile=profileView(a,now);
        return contractTaskReasons(state,{...task,assigneeId:a.id},a,now).length===0 && goalReasons(state,{...task,assigneeId:a.id},a,now,{execution:false}).length===0 && a.id!==agent_id && !route.attempted.includes(a.id) && profile.availability==='available' &&
          (task.requiredCapabilities??[]).every(c=>profile.capabilities.includes(c)) && task.paths?.every(p=>profile.paths.some(root=>within(p,root)));
      });
      if (!candidate) reasons.push('No available matching worker');
      const decision=check({...task,assigneeId:agent_id,requiredCapabilities:[]},reasons,false);
      work(50,'retry_route',task,now<route.acceptBy?'Wait for the current acceptance deadline':'Delivery is overdue; inspect the fixed retry budget',decision,
        {status:now<route.acceptBy?'waiting':decision.allowed?'actionable':'blocked',retryAt:route.acceptBy,
          limits:{attempts:route.attempted.length,maxAttempts:route.maxAttempts,timeoutMinutes:route.timeoutMinutes}});
    }
    if (task.status==='ready' && (task.assigneeId===agent_id || (!task.assigneeId && policy?.allow_unassigned))) {
      work(70,'accept_task',task,'Inspect requirements and active claims before explicitly accepting responsibility',check(task));
    }
  }
  for (const skill of state.skills??[]) {
    const proposal=(state.skillImprovements??[]).find(p=>p.skillId===skill.id);
    if (skill.createdBy!==agent_id && proposal?.createdBy!==agent_id) continue;
    if (proposal && proposal.status!=='proposed') continue;
    if (!proposal && (skill.status!=='published' || skillObservations(skill).filter(u=>u.outcome==='failure').length<2)) continue;
    const valid=skillDigest(skill)===skill.digest;
    const owner=skill.createdBy===agent_id;
    add(60,'inspect_skill_improvement',skill.id,valid?(owner?'Inspect reported failures and any existing successor before drafting or resolving an improvement':'The skill creator owns correction and resolution'):'Skill content digest mismatch; do not reuse or improve this corrupted record',
      'assess_skills',{skill_id:skill.id},{skillId:skill.id,improvementId:proposal?.id??null,status:!valid?'blocked':owner?'actionable':'waiting'});
  }
  entries.sort((a,b)=>a.priority-b.priority || a.id.localeCompare(b.id,'en'));
  const counts={actionable:0,blocked:0,waiting:0};
  for (const entry of entries) counts[entry.status]++;
  const actions=entries.slice(after,after+limit);
  return {observedAt:now,actions,counts,nextAfter:after+actions.length,hasMore:after+actions.length<entries.length,
    policyConfigured:!!policy,policyError,limits:policy?{maxActiveTasks:policy.max_active_tasks,maxTaskMinutes:policy.max_task_minutes,maxHandoffs:policy.max_handoffs,maxChainDepth:policy.max_chain_depth,expiresAt:policy.expires_at}:null,
    note:'Read-only suggestions, not execution permission. Inspect tools do not acknowledge messages. Recheck revisions, user scope, claims and actual artifacts before acting. Reconcile the local CLI outbox separately; shared state cannot see local pending writes. Completion and review never authorize merge or deployment.'};
}

export const nextActionTools=[{name:'next_actions',description:'Read a prioritized, bounded queue of recovery, review, messages, active work, routing and skill improvement suggestions with eligibility and limits. Does not acknowledge, execute or authorize work.',inputSchema:{type:'object',additionalProperties:false,properties:{agent_id:{type:'string',minLength:1},after:{type:'integer',minimum:0},limit:{type:'integer',minimum:1,maximum:100}},required:['agent_id']},annotations:{readOnlyHint:true,destructiveHint:false,openWorldHint:true}}];
export const nextActionMethods={next_actions:'nextActions'};
