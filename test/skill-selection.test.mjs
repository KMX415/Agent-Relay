import test from 'node:test';
import assert from 'node:assert/strict';
import { Mailbox } from '../mailbox.mjs';
import { emptyState } from '../github.mjs';
import { rankSkills, recordSkillValidation, getSkillValidations } from '../skill-selection.mjs';

class Store {
  state=emptyState(); revision=0;
  async read(){return {state:structuredClone(this.state),sha:this.revision};}
  async write(state,sha){if(sha!==this.revision)throw Object.assign(new Error('Conflict'),{status:409});this.state=structuredClone(state);this.revision++;}
}
async function setup(){
  const store=new Store(),a=new Mailbox(store,'alice'),b=new Mailbox(store,'bob');
  const alice=(await a.join({label:'Author',task:'Learn'})).id,bob=(await b.join({label:'Peer',task:'Validate'})).id;
  let s=await a.createSkill({agent_id:alice,name:'test-review',title:'Review',description:'Review code',when_to_use:'Review code',steps:['Read code'],validation:['Compare'],evidence:['Fixture'],tags:['review'],request_id:'create'});
  s=await b.reviewSkill({agent_id:bob,skill_id:s.id,expected_revision:s.revision,request_id:'review',verdict:'approve',summary:'Checked',evidence:['Fixture']});
  s=await a.updateSkill({agent_id:alice,skill_id:s.id,expected_revision:s.revision,request_id:'publish',action:'publish',summary:'Ready'});
  const report=(extra={})=>recordSkillValidation.call(b,{agent_id:bob,skill_id:s.id,digest:s.digest,expected_revision:store.state.skills[0].revision,request_id:'validate',case_id:'fixture',run_id:'first',provider:'claude',platform:'windows',compatible:true,outcome:'success',procedure:'Compare fixture output to expected bytes',expected:'Exact match',actual:'Exact match',evidence:['fixture-sha256:abc'],...extra});
  const rank=(extra={})=>rankSkills.call(b,{agent_id:bob,...extra});
  return {store,a,b,alice,bob,s,report,rank};
}
test('selection excludes unreviewed, corrupt and explicitly incompatible versions, without guessing compatibility',async()=>{
  const {store,s,report,rank}=await setup();
  assert.equal((await rank({query:'review'})).skills[0].compatibility,'unknown');
  assert.equal((await rank({query:'unrelated'})).skills.length,0);
  await report({compatible:false,outcome:'failure',actual:'Unsupported platform'});
  assert.equal((await rank({provider:'claude',platform:'windows'})).skills.length,0);
  assert.equal((await rank({provider:'codex'})).skills[0].compatibility,'unknown');
  store.state.skills[0].reviews=[];
  assert.equal((await rank()).skills.length,0);
  store.state.skills[0].reviews=[{actorId:'peer',verdict:'approve'}];
  store.state.skills[0].title='Tampered';
  assert.equal((await rank()).skills.length,0);
  assert.equal(store.state.skills[0].id,s.id);
});
test('repeatable cases retain evidence but repeated runs and identical reuse do not inflate ranking; failures counterweight',async()=>{
  const {store,b,bob,s,report,rank}=await setup();
  await report();const first=(await rank()).skills[0];
  await report({run_id:'second',request_id:'second'});
  assert.equal((await rank()).skills[0].score,first.score);
  for(const request_id of ['use1','use2']) await b.recordSkillUse({agent_id:bob,skill_id:s.id,request_id,outcome:'success',summary:'Worked',evidence:['Same fixture']});
  const success=(await rank()).skills[0];assert.equal(success.reuse.successes,1);
  await report({run_id:'third',request_id:'third',outcome:'failure',actual:'Mismatch'});
  const failed=(await rank()).skills[0];assert.ok(failed.score<success.score);assert.deepEqual(failed.validation,{successes:0,failures:1});
  await b.recordSkillUse({agent_id:bob,skill_id:s.id,request_id:'failure',outcome:'failure',summary:'Failed',evidence:['Same fixture']});
  assert.deepEqual((await rank()).skills[0].reuse,{successes:0,failures:1});
  const read=await getSkillValidations.call(b,{agent_id:bob,skill_id:s.id});
  assert.equal(read.reports.length,3);assert.doesNotMatch(JSON.stringify(read),/requestId|fingerprint/);
  assert.equal(read.revision,store.state.skills[0].revision);
});
test('validation enforces actor ownership, exact digests, revision, stable retries and immutable case/run identities',async()=>{
  const {store,alice,report,rank}=await setup();const revision=store.state.skills[0].revision;
  await assert.rejects(report({agent_id:alice}),/owner|belong|another|identity/i);
  await assert.rejects(report({digest:'wrong'}),/digest/);
  await report({expected_revision:revision});
  const before=store.revision;
  await report({expected_revision:revision});assert.equal(store.revision,before);
  await assert.rejects(report({expected_revision:revision,actual:'Different'}),/different content/);
  await assert.rejects(report({expected_revision:revision,request_id:'stale',run_id:'other'}),/revision changed/);
  await assert.rejects(report({request_id:'duplicate'}),/run_id/);
  await assert.rejects(report({request_id:'changed',run_id:'other',procedure:'New test'}),/case definition/);
  await assert.rejects(rank({agent_id:alice}),/owner|belong|another|identity/i);
});

test('concurrent reports respect CAS revisions and exact retries survive retirement',async()=>{
  const {store,a,alice,s,report,rank}=await setup();const revision=store.state.skills[0].revision;
  const outcomes=await Promise.allSettled([report({expected_revision:revision}),report({expected_revision:revision,request_id:'concurrent',run_id:'concurrent'})]);
  assert.equal(outcomes.filter(r=>r.status==='fulfilled').length,1);
  assert.match(outcomes.find(r=>r.status==='rejected').reason.message,/revision changed/);
  await a.updateSkill({agent_id:alice,skill_id:s.id,expected_revision:store.state.skills[0].revision,request_id:'retire',action:'retire',summary:'Obsolete'});
  const before=store.revision;
  await report({expected_revision:revision});assert.equal(store.revision,before);
  assert.equal((await rank()).skills.length,0);
  await assert.rejects(report({request_id:'new',run_id:'new'}),/published/);
});
