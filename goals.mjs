import { assertGoalIntegration } from './integration-checks.mjs';
import { randomUUID } from 'node:crypto';
import { boundedText as text, strings, relativePath, within, taskKinds } from './coordination.mjs';
const find=(state,id)=>{const g=(state.goals??[]).find(g=>g.id===id);if(!g)throw new Error('Goal not found');return g;};
const revision=(g,v)=>{if(!Number.isInteger(v)||g.revision!==v)throw new Error('Goal revision changed; reread goal');};
const retry=(g,actor,key,fp)=>{const old=g.history.find(h=>h.actorId===actor&&h.requestId===key);if(old&&old.fingerprint!==fp)throw new Error('request_id already used for different content');return old;};
const member=(g,id)=>{if(!g.participants.includes(id))throw new Error('Worker is not a goal participant');};
const usage=g=>g.reservations.reduce((n,r)=>n+(r.status==='reserved'?r.units:r.actualUnits),0);
export function goalReasons(state,task,actor,now,{creating=false,execution=true}={}) {
  if(!task.goalId)return [];
  const g=(state.goals??[]).find(g=>g.id===task.goalId);if(!g)return ['Goal not found'];
  const reasons=[];
  if(!g.participants.includes(actor.id))reasons.push('Worker is not a goal participant');
  if(g.status!=='active')reasons.push('Goal is '+g.status);
  if(now>=Date.parse(g.deadline))reasons.push('Goal deadline exhausted');
  if(!g.allowedKinds.includes(task.kind)||!task.paths?.length||task.paths.some(p=>!g.allowedPaths.some(root=>within(p,root))))reasons.push('Task exceeds goal scope');
  const tasks=(state.tasks??[]).filter(t=>t.goalId===g.id);
  if(creating&&tasks.length>=g.maxTasks)reasons.push('Goal task budget exhausted');
  if(!creating&&execution&&tasks.filter(t=>t.id!==task.id&&['in_progress','blocked'].includes(t.status)).length>=g.maxConcurrent)reasons.push('Goal concurrency budget exhausted');
  if(g.maxUsageUnits!==null) {
    if(usage(g)>g.maxUsageUnits)reasons.push('Goal usage budget exhausted');
    if(!creating&&execution&&!g.reservations.some(r=>r.taskId===task.id&&r.actorId===actor.id&&r.status==='reserved'))reasons.push('Goal usage reservation required');
  }
  return reasons;
}
export function assertGoalTask(state,task,actor,now,action) {
  if(!task.goalId||['block','cancel','evidence'].includes(action))return;
  const reasons=goalReasons(state,task,actor,now,{creating:action==='create',execution:!['create','assign','handoff','route','pin_contract','adopt_decision'].includes(action)});
  if(reasons.length)throw new Error(reasons.join('; '));
  if(task.assigneeId&&!find(state,task.goalId).participants.includes(task.assigneeId))throw new Error('Assignee is not a goal participant');
}
export async function createGoal({agent_id,title,description,acceptance,participants,allowed_kinds,allowed_paths,max_tasks,max_concurrent,deadline,max_usage_units=null,required_integration_work_ids=[],request_id}) {
  required_integration_work_ids=strings(required_integration_work_ids,'required_integration_work_ids',10).map(id=>text(id,'required_integration_work_ids',120));
  title=text(title,'title',200);description=text(description,'description',4000);acceptance=strings(acceptance,'acceptance');participants=strings(participants,'participants');allowed_kinds=strings(allowed_kinds,'allowed_kinds');allowed_paths=strings(allowed_paths,'allowed_paths').map(relativePath);request_id=text(request_id,'request_id',120);
  if(!acceptance.length||!participants.includes(agent_id)||!allowed_kinds.length||allowed_kinds.some(k=>!taskKinds.includes(k))||!allowed_paths.length)throw new Error('Goal requires acceptance, creator participation and scope');
  if(!Number.isInteger(max_tasks)||max_tasks<1||max_tasks>100||!Number.isInteger(max_concurrent)||max_concurrent<1||max_concurrent>max_tasks)throw new Error('Invalid goal task budgets');
  if(max_usage_units!==null&&(!Number.isFinite(max_usage_units)||max_usage_units<=0))throw new Error('Invalid usage budget');
  if(typeof deadline!=='string'||!Number.isFinite(Date.parse(deadline)))throw new Error('Invalid goal deadline');
  deadline=new Date(deadline).toISOString();
  const payload={title,description,acceptance,participants,allowedKinds:allowed_kinds,allowedPaths:allowed_paths,maxTasks:max_tasks,maxConcurrent:max_concurrent,deadline,maxUsageUnits:max_usage_units,...(required_integration_work_ids.length?{requiredIntegrationWorkIds:required_integration_work_ids}:{})};
  const fp=JSON.stringify(payload),id=randomUUID();
  return this.change(state=>{const actor=this.actor(state,agent_id);const goals=state.goals??=[];const old=goals.find(g=>g.createdBy===agent_id&&g.requestId===request_id);if(old){if(old.fingerprint!==fp)throw new Error('request_id already used for different content');return old;}
    if(goals.length>=100)throw new Error('Goal registry full');if(Date.parse(deadline)<=this.now())throw new Error('Goal deadline must be future');
    if(participants.some(id=>!Object.hasOwn(state.agents,id)))throw new Error('Unknown participant');
    const g={id,...payload,owner:actor.owner,createdBy:agent_id,requestId:request_id,fingerprint:fp,status:'active',revision:1,createdAt:this.now(),updatedAt:this.now(),history:[],reservations:[]};goals.push(g);return g;});
}
export async function getGoal({agent_id,goal_id}) {const {state}=await this.store.read();this.actor(state,agent_id);const g=find(state,goal_id);return {...g,accountedUsageUnits:usage(g),tasks:(state.tasks??[]).filter(t=>t.goalId===g.id).map(t=>({id:t.id,status:t.status,revision:t.revision,assigneeId:t.assigneeId}))};}
export async function listGoals({agent_id,after=0,limit=30}) {const {state}=await this.store.read();this.actor(state,agent_id);if(!Number.isInteger(after)||after<0||!Number.isInteger(limit)||limit<1||limit>100)throw new Error('Invalid pagination');const all=(state.goals??[]).filter(g=>g.participants.includes(agent_id));return {goals:all.slice(after,after+limit).map(({history,reservations,fingerprint,...g})=>g),nextAfter:after+Math.min(limit,Math.max(0,all.length-after)),hasMore:all.length>after+limit};}
export async function updateGoal({agent_id,goal_id,expected_revision,request_id,action,summary,evidence=[]}) {
  request_id=text(request_id,'request_id',120);summary=text(summary,'summary',4000);evidence=strings(evidence,'evidence');if(!['pause','resume','complete','cancel'].includes(action))throw new Error('Invalid goal action');const fp=JSON.stringify({expected_revision,action,summary,evidence});
  return this.change(state=>{const actor=this.actor(state,agent_id),g=find(state,goal_id);if(actor.owner!==g.owner)throw new Error('Only goal owner can update goal');if(retry(g,agent_id,request_id,fp))return g;revision(g,expected_revision);
    if(['completed','cancelled'].includes(g.status))throw new Error('Goal is terminal');
    if(action==='resume'&&(g.status!=='paused'||this.now()>=Date.parse(g.deadline)||g.maxUsageUnits!==null&&usage(g)>g.maxUsageUnits))throw new Error('Goal cannot resume');
    if(action==='complete'){assertGoalIntegration(state,g,this.now());const tasks=(state.tasks??[]).filter(t=>t.goalId===g.id);if(!tasks.length||tasks.some(t=>t.status!=='completed')||evidence.length!==g.acceptance.length||g.reservations.some(r=>r.status==='reserved'))throw new Error('Complete all goal tasks, settle reservations and provide evidence for every acceptance criterion');}
    g.status={pause:'paused',resume:'active',complete:'completed',cancel:'cancelled'}[action];record(g,agent_id,request_id,fp,this.now(),{action,summary,evidence});return g;});
}
function record(g,actorId,requestId,fingerprint,now,extra){if(g.history.length>=500)throw new Error('Goal history full');g.revision++;g.updatedAt=now;g.history.push({actorId,requestId,fingerprint,createdAt:now,...extra});}
export async function reserveGoalUsage({agent_id,goal_id,task_id,expected_revision,request_id,units}) {
  request_id=text(request_id,'request_id',120);if(!Number.isFinite(units)||units<=0)throw new Error('Invalid reservation units');const fp=JSON.stringify({task_id,expected_revision,units});const id=randomUUID();
  return this.change(state=>{this.actor(state,agent_id);const g=find(state,goal_id);member(g,agent_id);const old=retry(g,agent_id,request_id,fp);if(old)return g.reservations.find(r=>r.id===old.reservationId);revision(g,expected_revision);const t=(state.tasks??[]).find(t=>t.id===task_id);if(!t||t.goalId!==g.id||t.assigneeId!==agent_id||['completed','cancelled'].includes(t.status))throw new Error('Reservation requires assigned goal task');
    if(g.status!=='active'||this.now()>=Date.parse(g.deadline)||g.maxUsageUnits===null||usage(g)+units>g.maxUsageUnits)throw new Error('Goal usage budget unavailable');if(g.reservations.some(r=>r.taskId===task_id&&r.status==='reserved'))throw new Error('Task already has a reservation');
    const r={id,taskId:task_id,actorId:agent_id,units,status:'reserved',createdAt:this.now()};g.reservations.push(r);record(g,agent_id,request_id,fp,this.now(),{action:'reserve',reservationId:id});return r;});
}
export async function settleGoalUsage({agent_id,goal_id,reservation_id,expected_revision,request_id,actual_units,evidence}) {
  request_id=text(request_id,'request_id',120);evidence=text(evidence,'evidence',4000);if(!Number.isFinite(actual_units)||actual_units<0)throw new Error('Invalid actual units');const fp=JSON.stringify({reservation_id,expected_revision,actual_units,evidence});
  return this.change(state=>{this.actor(state,agent_id);const g=find(state,goal_id);if(retry(g,agent_id,request_id,fp))return g.reservations.find(r=>r.id===reservation_id);revision(g,expected_revision);const r=g.reservations.find(r=>r.id===reservation_id);if(!r||r.actorId!==agent_id||r.status!=='reserved')throw new Error('Only reserving worker can settle an open reservation');Object.assign(r,{status:'settled',actualUnits:actual_units,evidence,settledAt:this.now()});record(g,agent_id,request_id,fp,this.now(),{action:'settle',reservationId:r.id});return r;});
}
const str={type:'string',minLength:1};const arr={type:'array',minItems:1,maxItems:30,items:str};const keys={agent_id:str,goal_id:str};const write={expected_revision:{type:'integer',minimum:1},request_id:str};
const tool=(name,description,properties,required,readOnlyHint=false)=>({name,description,inputSchema:{type:'object',properties,required,additionalProperties:false},annotations:{readOnlyHint,destructiveHint:false,openWorldHint:true}});
export const goalTools=[
 tool('create_goal','Record a shared outcome and immutable scope/budgets within existing human authorization. Participants are not granted execution permission.',{agent_id:str,title:str,description:str,acceptance:arr,participants:arr,allowed_kinds:arr,allowed_paths:arr,max_tasks:{type:'integer',minimum:1,maximum:100},max_concurrent:{type:'integer',minimum:1,maximum:100},deadline:str,required_integration_work_ids:{type:'array',maxItems:10,items:str},max_usage_units:{type:'number',exclusiveMinimum:0},request_id:str},['agent_id','title','description','acceptance','participants','allowed_kinds','allowed_paths','max_tasks','max_concurrent','deadline','request_id']),
 tool('get_goal','Read goal, linked tasks and self-reported usage.',keys,['agent_id','goal_id'],true),
 tool('list_goals','List goals for this exact participant.',{agent_id:str,after:{type:'integer',minimum:0},limit:{type:'integer',minimum:1,maximum:100}},['agent_id'],true),
 tool('update_goal','Owner pauses, resumes, cancels or completes outcome with evidence ordered to acceptance criteria. No budget expansion.',{...keys,...write,action:{type:'string',enum:['pause','resume','cancel','complete']},summary:str,evidence:{type:'array',maxItems:30,items:str}},[...Object.keys(keys),...Object.keys(write),'action','summary']),
 tool('reserve_goal_usage','Reserve self-reported units atomically before work. No provider metering or hard spending enforcement.',{...keys,...write,task_id:str,units:{type:'number',exclusiveMinimum:0}},[...Object.keys(keys),...Object.keys(write),'task_id','units']),
 tool('settle_goal_usage','Record actual self-reported usage, even over budget or after stop. Outstanding reservations never expire automatically.',{...keys,...write,reservation_id:str,actual_units:{type:'number',minimum:0},evidence:str},[...Object.keys(keys),...Object.keys(write),'reservation_id','actual_units','evidence'])
];
export const goalMethods={create_goal:'createGoal',get_goal:'getGoal',list_goals:'listGoals',update_goal:'updateGoal',reserve_goal_usage:'reserveGoalUsage',settle_goal_usage:'settleGoalUsage'};
