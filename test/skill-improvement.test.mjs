import test from 'node:test';
import assert from 'node:assert/strict';
import { Mailbox } from '../mailbox.mjs';
import { emptyState } from '../github.mjs';
import { assessSkills, proposeSkillImprovement, resolveSkillImprovement, improvementTools } from '../skill-improvement.mjs';

class Store {
  state = emptyState(); revision = 0;
  async read() { return {state:structuredClone(this.state),sha:this.revision}; }
  async write(state,sha) {
    if (sha !== this.revision) throw Object.assign(new Error('Conflict'),{status:409});
    this.state = structuredClone(state); this.revision++;
  }
}
async function setup() {
  const store = new Store(), alice = new Mailbox(store,'alice'), bob = new Mailbox(store,'bob');
  const a = (await alice.join({label:'Author',task:'Learn'})).id, b = (await bob.join({label:'Peer',task:'Reuse'})).id;
  const create = (extra = {}) => alice.createSkill({agent_id:a,name:'test-procedure',title:'Test procedure',description:'Repeatable checks',
    when_to_use:'Before completion',steps:['Run checks'],validation:['Inspect results'],evidence:['Fixture'],request_id:'create',...extra});
  const publish = async skill => {
    skill = await bob.reviewSkill({agent_id:b,skill_id:skill.id,expected_revision:skill.revision,request_id:'review-'+skill.id,verdict:'approve',summary:'Checked',evidence:['Fixture']});
    return alice.updateSkill({agent_id:a,skill_id:skill.id,expected_revision:skill.revision,request_id:'publish-'+skill.id,action:'publish',summary:'Reviewed'});
  };
  const use = (skill,key,extra = {}) => bob.recordSkillUse({agent_id:b,skill_id:skill.id,request_id:key,outcome:'failure',summary:'Check failed',evidence:['Fixture failure'],...extra});
  const assess = (extra = {}) => assessSkills.call(alice,{agent_id:a,...extra});
  const propose = (skill,extra = {}) => proposeSkillImprovement.call(bob,{agent_id:b,skill_id:skill.id,request_id:'proposal',...extra});
  const resolve = (proposal,extra = {}) => resolveSkillImprovement.call(alice,{agent_id:a,improvement_id:proposal.id,expected_revision:proposal.revision,request_id:'close',action:'dismiss',summary:'Different environment',...extra});
  return {store,alice,bob,a,b,create,publish,use,assess,propose,resolve};
}

test('assessment is read only and unique failures produce a durable cross-worker CAS proposal',async()=>{
  const {store,alice,a,create,publish,use,assess,propose} = await setup();
  const before = store.revision;
  assert.deepEqual((await assess()).skills,[]); assert.equal(store.revision,before);
  const skill = await publish(await create());
  await use(skill,'first'); await use(skill,'first');
  await assert.rejects(propose(skill),/Insufficient/);
  await use(skill,'second'); await use(skill,'good',{outcome:'success'});
  const revision = store.revision, results = await assess();
  assert.equal(store.revision,revision); assert.equal(results.skills[0].failures,2);
  assert.equal(results.skills[0].successes,1); assert.equal(results.skills[0].improvementNeeded,true);
  const [left,right] = await Promise.all([propose(skill),proposeSkillImprovement.call(alice,{agent_id:a,skill_id:skill.id,request_id:'other-worker'})]);
  assert.equal(left.id,right.id); assert.equal(store.state.skillImprovements.length,1);
  assert.equal(left.evidence.length,2); assert.equal(left.digest,skill.digest);
  assert.equal((await propose(skill)).id,left.id);
  assert.equal((await assess()).skills[0].proposal.id,left.id);
  assert.doesNotMatch(JSON.stringify(left),/requestId|fingerprint/);
  assert.equal(store.state.skills[0].status,'published');
});

test('duplicate task reports count once per worker even under different request keys',async()=>{
  const {store,create,publish,use,assess,propose} = await setup();
  const skill = await publish(await create());
  store.state.tasks = [{id:'task-one',status:'completed'},{id:'task-two',status:'completed'}];
  await use(skill,'one',{task_id:'task-one'}); await use(skill,'two',{task_id:'task-one'});
  assert.equal((await assess()).skills[0].failures,1);
  await assert.rejects(propose(skill),/Insufficient/);
  await use(skill,'three',{task_id:'task-two'});
  assert.equal((await propose(skill)).failureCount,2);
});

test('resolution requires original creator, current revision and independently published descendant',async()=>{
  const {store,bob,b,create,publish,use,assess,propose,resolve} = await setup();
  const skill = await publish(await create()); await use(skill,'a'); await use(skill,'b');
  const proposal = await propose(skill);
  await assert.rejects(resolveSkillImprovement.call(bob,{agent_id:b,improvement_id:proposal.id,expected_revision:1,request_id:'other',action:'dismiss',summary:'Skip'}),/creator/);
  await assert.rejects(resolve(proposal,{expected_revision:2}),/revision changed/);
  const draft = await create({request_id:'next',supersedes_id:skill.id,steps:['Improved checks']});
  await assert.rejects(resolve(proposal,{action:'resolve',successor_id:draft.id}),/published descendant/);
  const successor = await publish(draft);
  const assessment = (await assess({skill_id:skill.id})).skills[0];
  assert.equal(assessment.latestPublishedSuccessor.skillId,successor.id);
  const args = {action:'resolve',successor_id:successor.id};
  const result = await resolve(proposal,args);
  assert.equal(result.status,'resolved'); assert.equal(result.successorId,successor.id);
  assert.equal((await resolve(proposal,args)).revision,2);
  await assert.rejects(resolve(proposal,{...args,summary:'Changed'}),/different content/);
  assert.equal(store.state.skills[0].status,'published');
  assert.equal((await propose(skill,{request_id:'later-wake'})).id,proposal.id);
});

test('unrelated successors and missing inputs fail; dismissal remains durable',async()=>{
  const {create,publish,use,propose,resolve,assess} = await setup();
  const skill = await publish(await create()); await use(skill,'a'); await use(skill,'b');
  const proposal = await propose(skill);
  const other = await publish(await create({name:'other-procedure',request_id:'other'}));
  await assert.rejects(resolve(proposal,{action:'resolve',successor_id:other.id}),/published descendant/);
  await assert.rejects(resolve(proposal,{action:'resolve'}),/successor_id/);
  await assert.rejects(resolve(proposal,{successor_id:other.id}),/does not accept/);
  const closed = await resolve(proposal); assert.equal(closed.status,'dismissed');
  await assert.rejects(resolve(closed,{request_id:'again'}),/already closed/);
  assert.equal((await propose(skill,{request_id:'again'})).status,'dismissed');
  for (const args of [{failure_threshold:1},{failure_threshold:21},{limit:101},{after:-1}]) await assert.rejects(assess(args));
  assert.equal(improvementTools.length,3);
});

test('tampered content, identity spoofing and full proposal storage fail explicitly',async()=>{
  const {store,bob,a,create,publish,use,propose,assess} = await setup();
  const skill = await publish(await create()); await use(skill,'a'); await use(skill,'b');
  await assert.rejects(assessSkills.call(bob,{agent_id:a}),/identity/);
  await assert.rejects(propose(skill,{agent_id:a}),/identity/);
  store.state.skillImprovements = Array.from({length:100},(_,i)=>({id:'p'+i,skillId:'other'+i}));
  await assert.rejects(propose(skill),/registry full/);
  store.state.skills[0].steps.push('Unreviewed change');
  await assert.rejects(assess(),/digest mismatch/);
  await assert.rejects(propose(skill),/digest mismatch/);
  assert.equal(store.state.skillImprovements.length,100);
});
