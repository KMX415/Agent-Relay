import { createHash } from 'node:crypto';
import { skillDigest } from './skills.mjs';

const note = 'Ranking and compatibility are self-reported evidence, not trust or execution permission. Inspect exact versions before reuse. No commands are run and no skills are installed.';
const text = (v,n,max=200) => { if(typeof v !== 'string'||!v.trim()||v.length>max||/\x00/.test(v)) throw new Error(`Invalid ${n}`); return v.trim(); };
const hash = v => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const context = v => text(v,'provider/platform',64).toLowerCase();
const publicReport = ({requestId,fingerprint,...r}) => r;
function find(state,id) {
  const s=(state.skills??[]).find(s=>s.id===id);
  if(!s) throw new Error('Skill not found');
  if(skillDigest(s)!==s.digest) throw new Error('Skill content digest mismatch');
  return s;
}
function eligible(s) {
  return s.status==='published' && skillDigest(s)===s.digest &&
    s.reviews.some(r=>r.actorId!==s.createdBy&&r.verdict==='approve') && !s.reviews.some(r=>r.verdict==='request_changes');
}
export async function recordSkillValidation({agent_id,skill_id,digest,expected_revision,request_id,case_id,run_id,provider,platform,compatible,outcome,procedure,expected,actual,evidence}) {
  request_id=text(request_id,'request_id',120);
  if(!Number.isInteger(expected_revision)||expected_revision<1) throw new Error('Invalid expected_revision');
  if(typeof compatible!=='boolean'||!['success','failure'].includes(outcome)) throw new Error('Invalid compatibility/outcome');
  if(!compatible&&outcome==='success') throw new Error('Incompatible validation cannot succeed');
  if(!Array.isArray(evidence)||!evidence.length||evidence.length>20) throw new Error('Invalid evidence');
  const payload={digest:text(digest,'digest',64),caseId:text(case_id,'case_id',120),runId:text(run_id,'run_id',120),provider:context(provider),platform:context(platform),compatible,outcome,procedure:text(procedure,'procedure',4000),expected:text(expected,'expected',2000),actual:text(actual,'actual',2000),evidence:[...new Set(evidence.map(e=>text(e,'evidence',1000)))]};
  const fingerprint=hash({...payload,expected_revision});
  return this.change(state=>{
    const actor=this.actor(state,agent_id),s=find(state,skill_id),reports=s.validationReports??=[];
    const old=[...reports,...s.uses,...s.reviews,...s.history].find(r=>r.actorId===agent_id&&r.requestId===request_id);
    if(old){if(old.fingerprint!==fingerprint) throw new Error('request_id already used for different content'); return {...publicReport(old),revision:s.revision,note};}
    if(s.revision!==expected_revision) throw new Error('Skill revision changed; read skill before updating');
    if(!eligible(s)||payload.digest!==s.digest) throw new Error('Validation requires reviewed published exact digest');
    if(reports.length>=100) throw new Error('Skill validation history full');
    if(reports.some(r=>r.actorId===agent_id&&r.runId===payload.runId)) throw new Error('Validation run_id already recorded');
    const prior=reports.find(r=>r.actorId===agent_id&&r.caseId===payload.caseId);
    if(prior&&(prior.procedure!==payload.procedure||prior.expected!==payload.expected)) throw new Error('Validation case definition changed; use a new case_id');
    const now=this.now(),report={...payload,actorId:agent_id,createdAt:now,requestId:request_id,fingerprint};
    reports.push(report);s.revision++;s.updatedAt=now;actor.seenAt=now;
    return {...publicReport(report),revision:s.revision,note};
  });
}
export async function getSkillValidations({agent_id,skill_id}) {
  const {state}=await this.store.read();this.actor(state,agent_id);const s=find(state,skill_id);
  return {skillId:s.id,digest:s.digest,revision:s.revision,reports:(s.validationReports??[]).map(publicReport),note};
}
export async function rankSkills({agent_id,query='',tags=[],provider,platform,after=0,limit=30}) {
  if(typeof query!=='string'||query.length>200||/\x00/.test(query)) throw new Error('Invalid query');
  if(!Array.isArray(tags)||tags.length>20) throw new Error('Invalid tags');
  tags=[...new Set(tags.map(t=>text(t,'tag',64).toLowerCase()))];
  if(provider!==undefined) provider=context(provider);if(platform!==undefined) platform=context(platform);
  if(!Number.isInteger(after)||after<0||!Number.isInteger(limit)||limit<1||limit>100) throw new Error('Invalid pagination');
  const {state}=await this.store.read();this.actor(state,agent_id);
  const terms=[...new Set(query.toLowerCase().split(/\s+/).filter(Boolean))],ranked=[];
  for(const s of state.skills??[]) {
    if(!eligible(s)) continue;
    const reports=(s.validationReports??[]).filter(r=>r.digest===s.digest&&(!provider||r.provider===provider)&&(!platform||r.platform===platform));
    if((provider||platform)&&reports.some(r=>r.compatible===false)) continue;
    const haystack=[s.name,s.title,s.description,s.whenToUse,...s.tags].join(' ').toLowerCase();
    const relevance=terms.filter(t=>haystack.includes(t)).length*3+tags.filter(t=>s.tags.includes(t)).length*4;
    if((terms.length||tags.length)&&!relevance) continue;
    // A task or identical evidence contributes at most once per worker; failures win conflicts.
    const distinct=new Map();
    for(const u of s.uses) {
      if(!['success','failure'].includes(u.outcome)||!u.evidence?.length) continue;
      const key=JSON.stringify([u.actorId,u.taskId??[...u.evidence].sort()]);
      if(!distinct.has(key)||u.outcome==='failure') distinct.set(key,u.outcome);
    }
    const cases=new Map();
    for(const r of reports) {const key=JSON.stringify([r.actorId,r.caseId,r.provider,r.platform]);if(!cases.has(key)||r.outcome==='failure') cases.set(key,r.outcome);}
    const counts=values=>{const all=[...values];return {successes:all.filter(v=>v==='success').length,failures:all.filter(v=>v==='failure').length};};
    const reuse=counts(distinct.values()),validation=counts(cases.values());
    const compatibility=reports.length?'reported-compatible':'unknown';
    ranked.push({id:s.id,name:s.name,title:s.title,version:s.version,digest:s.digest,revision:s.revision,relevance,compatibility:reports.some(r=>!r.compatible)?'reported-incompatible':compatibility,reuse,validation,
      score:relevance+Math.min(reuse.successes,10)*2-reuse.failures*4+Math.min(validation.successes,5)-validation.failures*3});
  }
  ranked.sort((a,b)=>b.score-a.score||a.id.localeCompare(b.id));
  return {skills:ranked.slice(after,after+limit),nextAfter:Math.min(after+limit,ranked.length),hasMore:after+limit<ranked.length,note};
}
const str={type:'string',minLength:1,maxLength:200},agent={agent_id:str};
const tool=(name,description,properties,required,readOnlyHint=false)=>({name,description,inputSchema:{type:'object',properties,required,additionalProperties:false},annotations:{readOnlyHint,destructiveHint:false,openWorldHint:true}});
export const selectionTools=[
  tool('rank_skills','Rank reviewed published exact versions using relevance and distinct self-reported outcomes. Explicit incompatible context reports exclude candidates; unknown compatibility stays unknown. No execution or installation.',{...agent,query:{type:'string',maxLength:200},tags:{type:'array',items:{...str,maxLength:64},maxItems:20},provider:{...str,maxLength:64},platform:{...str,maxLength:64},after:{type:'integer',minimum:0},limit:{type:'integer',minimum:1,maximum:100}},['agent_id'],true),
  tool('get_skill_validations','Inspect exact-version repeatable validation evidence and explicit provider/platform compatibility assertions.',{...agent,skill_id:str},['agent_id','skill_id'],true),
  tool('record_skill_validation','Record an already observed case/run result against a reviewed published digest. Self-reported only; does not run the procedure. Case definitions are immutable per worker/version.',{...agent,skill_id:str,digest:{...str,maxLength:64},expected_revision:{type:'integer',minimum:1},request_id:{...str,maxLength:120},case_id:{...str,maxLength:120},run_id:{...str,maxLength:120},provider:{...str,maxLength:64},platform:{...str,maxLength:64},compatible:{type:'boolean'},outcome:{type:'string',enum:['success','failure']},procedure:{...str,maxLength:4000},expected:{...str,maxLength:2000},actual:{...str,maxLength:2000},evidence:{type:'array',minItems:1,maxItems:20,items:{...str,maxLength:1000}}},['agent_id','skill_id','digest','expected_revision','request_id','case_id','run_id','provider','platform','compatible','outcome','procedure','expected','actual','evidence'])
];
export const selectionMethods={rank_skills:'rankSkills',get_skill_validations:'getSkillValidations',record_skill_validation:'recordSkillValidation'};
