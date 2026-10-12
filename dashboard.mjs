import { profileView, taskKinds } from './coordination.mjs';
import { taskStatuses } from './tasks.mjs';
import { skillDigest } from './skills.mjs';

const isText = value => typeof value === 'string';
const isList = value => Array.isArray(value) && value.every(isText);
const requireRecord = ok => { if (!ok) throw new Error('Malformed coordination state'); };
export function dashboard(repo,state,fetchedAt) {
  requireRecord(state.agents && typeof state.agents==='object' && !Array.isArray(state.agents));
  requireRecord(state.tasks===undefined || Array.isArray(state.tasks));
  requireRecord(state.skills===undefined || Array.isArray(state.skills));
  const agents=Object.values(state.agents).map(a=>{
    requireRecord(a && isText(a.id) && isText(a.owner) && isText(a.label));
    if (a.profile) requireRecord(isText(a.profile.provider) && isList(a.profile.capabilities) &&
      isList(a.profile.paths) && ['available','busy','offline'].includes(a.profile.availability) &&
      Number.isFinite(a.profile.reportedAt) && Number.isFinite(a.profile.availableUntil));
    return {id:a.id,owner:a.owner,label:a.label,seenAt:Number.isFinite(a.seenAt)?a.seenAt:null,profile:profileView(a,fetchedAt)};
  });
  const label=id=>agents.find(a=>a.id===id)?.label ?? id ?? 'Unassigned';
  const tasks=(state.tasks??[]).map(t=>{
    requireRecord(t && ['id','title','description','createdBy'].every(k=>isText(t[k])) &&
      taskStatuses.includes(t.status) && isList(t.acceptance) && isList(t.dependsOn) &&
      (t.assigneeId===null || isText(t.assigneeId)) && Number.isInteger(t.revision) &&
      Number.isFinite(t.createdAt) && Number.isFinite(t.updatedAt) && Array.isArray(t.history));
    requireRecord((t.paths===undefined||isList(t.paths)) && (t.requiredCapabilities===undefined||isList(t.requiredCapabilities)));
    requireRecord((t.kind===undefined||taskKinds.includes(t.kind)) &&
      (t.parentTaskId===undefined||t.parentTaskId===null||isText(t.parentTaskId)) &&
      (t.chainDepth===undefined||Number.isInteger(t.chainDepth)) &&
      (t.handoffCount===undefined||Number.isInteger(t.handoffCount)));
    const history=t.history.map(h=>{
      requireRecord(h && ['action','summary','actorId','status'].every(k=>isText(h[k])) &&
        isList(h.artifacts) && isList(h.nextSteps) && Number.isFinite(h.createdAt) &&
        Number.isInteger(h.revision) && (h.assigneeId===null||isText(h.assigneeId)));
      return {revision:h.revision,action:h.action,summary:h.summary,actorId:h.actorId,actorLabel:label(h.actorId),
        status:h.status,assigneeId:h.assigneeId,artifacts:h.artifacts,nextSteps:h.nextSteps,createdAt:h.createdAt};
    });
    return {id:t.id,title:t.title,description:t.description,acceptance:t.acceptance,status:t.status,
      revision:t.revision,assigneeId:t.assigneeId,assigneeLabel:label(t.assigneeId),createdBy:t.createdBy,
      creatorLabel:label(t.createdBy),createdAt:t.createdAt,updatedAt:t.updatedAt,
      kind:t.kind??'implementation',paths:t.paths??[],requiredCapabilities:t.requiredCapabilities??[],
      parentTaskId:t.parentTaskId??null,chainDepth:t.chainDepth??0,handoffCount:t.handoffCount??0,
      dependencies:t.dependsOn.map(id=>{
        const dep=(state.tasks??[]).find(d=>d.id===id);
        return {id,title:dep?.title??id,status:dep?.status??'missing'};
      }),history};
  });
  const skills=(state.skills??[]).map(s=>{
    requireRecord(s && ['id','name','title','description','whenToUse','createdBy','digest'].every(k=>isText(s[k])) &&
      ['draft','published','retired'].includes(s.status) && Number.isInteger(s.version) && Number.isInteger(s.revision) &&
      Number.isFinite(s.createdAt) && Number.isFinite(s.updatedAt) &&
      ['steps','validation','limitations','tags','evidence'].every(k=>isList(s[k])) &&
      ['sourceTaskId','supersedesId'].every(k=>s[k]===null||isText(s[k])) &&
      ['reviews','uses','history'].every(k=>Array.isArray(s[k])));
    requireRecord(skillDigest(s) === s.digest);
    const entry=h=>{
      requireRecord(h && ['actorId','summary'].every(k=>isText(h[k])) && Number.isFinite(h.createdAt));
      return {actorId:h.actorId,actorLabel:label(h.actorId),summary:h.summary,createdAt:h.createdAt};
    };
    const reviews=s.reviews.map(h=>{
      requireRecord(h && ['approve','request_changes'].includes(h.verdict) && isList(h.evidence));
      return {...entry(h),verdict:h.verdict,evidence:h.evidence};
    });
    const uses=s.uses.map(h=>{
      requireRecord(h && ['success','failure'].includes(h.outcome) && isList(h.evidence) && (h.taskId===null||isText(h.taskId)));
      return {...entry(h),outcome:h.outcome,evidence:h.evidence,taskId:h.taskId};
    });
    const history=s.history.map(h=>{
      requireRecord(h && isText(h.action));return {...entry(h),action:h.action};
    });
    return {id:s.id,name:s.name,title:s.title,description:s.description,whenToUse:s.whenToUse,
      steps:s.steps,validation:s.validation,limitations:s.limitations,tags:s.tags,evidence:s.evidence,
      sourceTaskId:s.sourceTaskId,supersedesId:s.supersedesId,version:s.version,revision:s.revision,
      createdBy:s.createdBy,creatorLabel:label(s.createdBy),createdAt:s.createdAt,updatedAt:s.updatedAt,
      status:s.status,digest:s.digest,reviews,uses,history};
  });
  return {repo,fetchedAt:new Date(fetchedAt).toISOString(),tasks,agents,skills,
    counts:Object.fromEntries(taskStatuses.map(status=>[status,tasks.filter(t=>t.status===status).length]))};
}
