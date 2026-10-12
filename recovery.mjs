import { contractView } from './contracts.mjs';
import { createHash } from 'node:crypto';
import { boundedText } from './coordination.mjs';
import { skillObservations } from './skill-improvement.mjs';

const active = status => ['ready','in_progress','blocked'].includes(status);
const revision = (value, name, min = 0) => {
  if (!Number.isInteger(value) || value < min) throw new Error('Invalid '+name);
};
const items = (values, name, required = false) => {
  if (!Array.isArray(values) || values.length > 30 || (required && !values.length)) throw new Error('Invalid '+name);
  return [...new Set(values.map(value => boundedText(value,name,500)))];
};
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const checkpointView = ({history,...record}) => ({...record,history:history.map(({fingerprint,requestId,...entry})=>entry)});

export async function saveCheckpoint({agent_id,task_id,expected_revision,expected_task_revision,request_id,summary,next_steps,artifacts=[]}) {
  task_id=boundedText(task_id,'task_id',150); request_id=boundedText(request_id,'request_id',120);
  summary=boundedText(summary,'summary',4000); next_steps=items(next_steps,'next_steps',true); artifacts=items(artifacts,'artifacts');
  revision(expected_revision,'checkpoint revision'); revision(expected_task_revision,'task revision',1);
  const fingerprint=digest({expected_revision,expected_task_revision,summary,next_steps,artifacts});
  return this.change(state=>{
    const actor=this.actor(state,agent_id), records=state.checkpoints??=[];
    let checkpoint=records.find(c=>c.agentId===agent_id && c.taskId===task_id);
    const old=checkpoint?.history.find(h=>h.requestId===request_id);
    if (old) {
      if (old.fingerprint!==fingerprint) throw new Error('request_id already used for different content');
      return checkpointView(checkpoint);
    }
    if ((checkpoint?.revision??0)!==expected_revision) throw new Error('Checkpoint revision changed; read recovery before updating');
    const task=(state.tasks??[]).find(t=>t.id===task_id);
    if (!task || task.assigneeId!==agent_id || !['in_progress','blocked'].includes(task.status)) throw new Error('Checkpoint requires your assigned active task');
    if (task.revision!==expected_task_revision) throw new Error('Task revision changed; revalidate before saving checkpoint');
    if (checkpoint?.history.length>=30) throw new Error('Checkpoint history full; archive deliberately before continuing');
    if (!checkpoint && records.length>=500) throw new Error('Checkpoint registry full; archive deliberately before continuing');
    const now=this.now();
    if (!checkpoint) { checkpoint={agentId:agent_id,taskId:task_id,revision:0,history:[]}; records.push(checkpoint); }
    Object.assign(checkpoint,{revision:expected_revision+1,taskRevision:task.revision,taskStatus:task.status,summary,nextSteps:next_steps,artifacts,updatedAt:now});
    checkpoint.history.push({revision:checkpoint.revision,taskRevision:task.revision,taskStatus:task.status,summary,nextSteps:next_steps,artifacts,createdAt:now,requestId:request_id,fingerprint});
    actor.seenAt=now; return checkpointView(checkpoint);
  });
}

export async function getRecovery({agent_id}) {
  const {state}=await this.store.read(), actor=this.actor(state,agent_id), tasks=state.tasks??[];
  return {
    contracts:(state.contracts??[]).filter(c=>c.participants.includes(agent_id)).map(c=>contractView(c,this.now())),
    tasks:tasks.filter(t=>t.assigneeId===agent_id && active(t.status)),
    goals:(state.goals??[]).filter(g=>g.participants.includes(agent_id)&&!['completed','cancelled'].includes(g.status)),
    peerHelp:(state.peerHelp??[]).filter(h=>[h.requesterId,h.recipientId].includes(agent_id)&&!['resolved','escalated'].includes(h.phase)),
    interruptedRuns:(state.workerRuns??[]).filter(r=>r.agentId===agent_id&&r.status==='running'&&this.now()>=r.leaseUntil),
    checkpoints:(state.checkpoints??[]).filter(c=>c.agentId===agent_id).map(c=>{
      const task=tasks.find(t=>t.id===c.taskId);
      return {...checkpointView(c),needsRevalidation:!task || task.revision!==c.taskRevision || task.status!==c.taskStatus || task.assigneeId!==agent_id,
        currentTaskRevision:task?.revision??null,currentTaskStatus:task?.status??null};
    }),
    messages:state.messages.filter(m=>m.from!==agent_id && ['question','handoff','review_request'].includes(m.kind) &&
      (m.to===agent_id || m.to==='team' || m.to.toLowerCase()===actor.owner.toLowerCase()) && !m.acknowledgedBy.includes(agent_id)),
    pendingTasks:tasks.filter(t=>(t.createdBy===agent_id || t.routing?.requestedBy===agent_id) && t.status==='ready'),
    reviewCycles:(state.reviewCycles??[]).filter(c=>c.builderId===agent_id || c.reviewerId===agent_id),
    negotiations:(state.negotiations??[]).filter(n=>[n.requesterId,n.recipientId].includes(agent_id) && ['proposed','deferred'].includes(n.status)),
    handoffs:(state.handoffs??[]).filter(h=>[h.senderId,h.recipientId].includes(agent_id) && tasks.some(t=>t.id===h.taskId && active(t.status) && t.revision===h.taskRevision)),
    skillImprovements:(state.skillImprovements??[]).filter(p=>p.status==='proposed' &&
      (p.createdBy===agent_id || (state.skills??[]).some(s=>s.id===p.skillId && s.createdBy===agent_id))),
    note:'Read-only recovery snapshot. Recheck task eligibility, current user scope, claims and actual artifacts before continuing. Checkpoints do not execute steps or guarantee exactly-once external actions. Reading does not acknowledge messages.'
  };
}

export async function reportWorkerHealth({agent_id,expected_revision,scheduler_status,expected_interval_minutes}) {
  revision(expected_revision,'health revision');
  if (!['enabled','disabled','unknown'].includes(scheduler_status)) throw new Error('Invalid scheduler status');
  if (expected_interval_minutes!==undefined && (!Number.isInteger(expected_interval_minutes) || expected_interval_minutes<1 || expected_interval_minutes>1440)) throw new Error('Invalid expected interval');
  if (scheduler_status==='enabled' && expected_interval_minutes===undefined) throw new Error('Enabled scheduler requires expected interval');
  return this.change(state=>{
    const actor=this.actor(state,agent_id);
    if ((actor.health?.revision??0)!==expected_revision) throw new Error('Health revision changed; read team health');
    const now=this.now();
    actor.health={revision:expected_revision+1,schedulerStatus:scheduler_status,expectedIntervalMinutes:expected_interval_minutes??null,observedAt:now};
    actor.seenAt=now;
    return {agentId:agent_id,...actor.health,note:'Worker self-report; does not configure or verify a scheduler.'};
  });
}

export async function teamHealth({stale_minutes=30}={}) {
  if (!Number.isInteger(stale_minutes) || stale_minutes<1 || stale_minutes>10080) throw new Error('Invalid stale_minutes');
  const {state}=await this.store.read(), now=this.now(), diagnostics=[];
  const add=(code,fields)=>diagnostics.push({code,...fields});
  const workers=Object.values(state.agents).map(a=>{
    if (a.profile && a.profile.availableUntil<=now) add('availability_expired',{agentId:a.id});
    const report=a.health;
    if (!report) add('worker_health_unknown',{agentId:a.id});
    else {
      if (report.schedulerStatus!=='enabled') add('scheduler_'+report.schedulerStatus,{agentId:a.id});
      if (now-report.observedAt>=Math.max(stale_minutes,2*(report.expectedIntervalMinutes??0))*60000) add('worker_report_stale',{agentId:a.id,observedAt:report.observedAt});
    }
    return {agentId:a.id,health:report??null};
  });
  for (const task of state.tasks??[]) {
    if (!active(task.status)) continue;
    if (task.assigneeId && !Object.hasOwn(state.agents,task.assigneeId)) add('orphan_assignee',{taskId:task.id,agentId:task.assigneeId});
    if (now-task.updatedAt>=stale_minutes*60000 && (task.status!=='ready' || task.assigneeId)) add(task.status==='ready'?'acceptance_stalled':'task_stalled',{taskId:task.id,status:task.status,updatedAt:task.updatedAt});
  }
  for (const cycle of state.reviewCycles??[]) if (cycle.phase==='exhausted') add('review_cycle_exhausted',{cycleId:cycle.id,taskId:cycle.taskId});
  for (const skill of state.skills??[]) {
    const failures=skillObservations(skill).filter(use=>use.outcome==='failure').length;
    const proposal=(state.skillImprovements??[]).find(p=>p.skillId===skill.id);
    if (skill.status==='published' && failures>=2) add('skill_repeated_failures',{skillId:skill.id,version:skill.version,failures,proposalStatus:proposal?.status??null,successorId:proposal?.successorId??null});
  }
  return {observedAt:now,workers,diagnostics,note:'Mailbox observations and worker self-reports only. Authentication, host reachability and actual scheduler operation are not verified. No repairs or notifications are performed.'};
}

const string={type:'string',minLength:1};
const agent={agent_id:string};
const list={type:'array',maxItems:30,items:{...string,maxLength:500}};
const tool=(name,description,properties,required,readOnly=false)=>({name,description,inputSchema:{type:'object',properties,required,additionalProperties:false},annotations:{readOnlyHint:readOnly,destructiveHint:false,openWorldHint:true}});
export const recoveryTools=[
  tool('save_checkpoint','Save durable progress and next steps for your accepted task. Preserve retry keys and inspect artifacts before replaying external actions.',{...agent,task_id:{...string,maxLength:150},expected_revision:{type:'integer',minimum:0},expected_task_revision:{type:'integer',minimum:1},request_id:{...string,maxLength:120},summary:{...string,maxLength:4000},next_steps:{...list,minItems:1},artifacts:list},['agent_id','task_id','expected_revision','expected_task_revision','request_id','summary','next_steps']),
  tool('get_recovery','Read your active tasks, checkpoints, actionable unread messages and pending created tasks. Revalidate current authorization before resuming; does not acknowledge or execute.',agent,['agent_id'],true),
  tool('report_worker_health','Self-report scheduler setup and expected wake interval. Does not create or verify scheduling.',{...agent,expected_revision:{type:'integer',minimum:0},scheduler_status:{type:'string',enum:['enabled','disabled','unknown']},expected_interval_minutes:{type:'integer',minimum:1,maximum:1440}},['agent_id','expected_revision','scheduler_status']),
  tool('team_health','Diagnose stale mailbox activity, missing assignees, reported scheduler issues and repeated skill failures. Read-only; does not test remote hosts or repair anything.',{stale_minutes:{type:'integer',minimum:1,maximum:10080}},[],true)
];
export const recoveryMethods={save_checkpoint:'saveCheckpoint',get_recovery:'getRecovery',report_worker_health:'reportWorkerHealth',team_health:'teamHealth'};
