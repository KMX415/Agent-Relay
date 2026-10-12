import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTeam } from '../harness/core.mjs';
import { runScenarios } from '../harness/scenarios.mjs';

async function fixture(t) {
  const directory=await mkdtemp(join(tmpdir(),'relay-scenarios-'));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  return createTeam({directory});
}
test('six scripted workers exercise collaboration failures and tested skill reuse',async t=>{
  const team=await fixture(t);
  const report=await runScenarios(team);
  assert.equal(report.passed,true,JSON.stringify(report.scenarios.filter(s=>!s.passed)));
  assert.equal(report.scenarios.length,9);
  assert.equal(report.metrics.maxConcurrent,3);
  assert.equal(report.metrics.completedTasks,3);
  assert.equal(report.metrics.humanDecisionRequirements,3);
  assert.equal(report.metrics.providerUsage,null);
  assert.ok(report.metrics.conflicts>0);
  const skill=report.scenarios.find(s=>s.name==='tested-artifact-and-cross-owner-skill-reuse');
  assert.equal(skill.evidence.initialFixtureFailed,true);
  assert.equal(skill.evidence.reuseAssertions,1);
  const {state}=await team.store.read();
  const record=state.skills.find(s=>s.id===skill.evidence.skillId);
  assert.equal(record.status,'published');
  assert.equal(record.uses.length,1);
  assert.equal(state.agents[record.createdBy].owner,'contributor-c');
  assert.equal(record.uses[0].outcome,'success');
});
test('scenario failures are recorded and do not produce a passing report',async t=>{
  const team=await fixture(t),original=team.call;
  team.call=(key,tool,args)=>tool==='create_skill'?Promise.reject(new Error('Injected publication prerequisite failure')):original(key,tool,args);
  const report=await runScenarios(team);
  assert.equal(report.passed,false);
  assert.equal(report.metrics.scenariosFailed,1);
  assert.match(report.scenarios.find(s=>!s.passed).error,/Injected publication/);
});
