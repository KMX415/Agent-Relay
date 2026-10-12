import test from 'node:test';
import assert from 'node:assert/strict';
import { Mailbox } from '../mailbox.mjs';
import { call } from '../tools.mjs';
import { emptyState } from '../github.mjs';

test('headless continuation routes, recovers, reviews, improves a skill and reports health through public tools',async()=>{
  const store={state:emptyState(),revision:0,async read(){return {state:structuredClone(this.state),sha:this.revision};},async write(state,sha){assert.equal(sha,this.revision);this.state=structuredClone(state);this.revision++;}};
  let mailbox=new Mailbox(store,'team');
  const run=(name,args={})=>call(mailbox,name,args);
  const author=(await run('join_team',{label:'Author',task:'Review'})).id;
  const builder=(await run('join_team',{label:'Builder',task:'Implement'})).id;
  for(const id of [author,builder])await run('update_agent',{agent_id:id,expected_revision:0,provider:'test',capabilities:['testing','review'],paths:['src']});
  let task=await run('create_task',{agent_id:author,title:'Validate recovery',description:'Exercise continuation',acceptance:['Tests pass'],paths:['src'],required_capabilities:['testing'],request_id:'task'});
  task=(await run('route_task',{agent_id:author,task_id:task.id,expected_revision:task.revision,request_id:'route',summary:'Delegate checks',next_steps:['Run checks']})).task;
  assert.equal(task.assigneeId,builder);
  task=await run('update_task',{agent_id:builder,task_id:task.id,expected_revision:task.revision,request_id:'accept',action:'accept',summary:'Accepted'});
  await run('save_checkpoint',{agent_id:builder,task_id:task.id,expected_revision:0,expected_task_revision:task.revision,request_id:'checkpoint',summary:'Prepared fixture',next_steps:['Run tests'],artifacts:['test fixture']});
  mailbox=new Mailbox(store,'team'); // New host process can rebuild from persisted state.
  const recovered=await run('get_recovery',{agent_id:builder});
  assert.equal(recovered.checkpoints[0].summary,'Prepared fixture');
  let cycle=await run('start_review_cycle',{agent_id:builder,task_id:task.id,reviewer_id:author,expected_task_revision:task.revision,request_id:'cycle',summary:'Review fixture',artifacts:['fixture v1'],max_rounds:2});
  assert.equal((await run('get_recovery',{agent_id:author})).reviewCycles[0].id,cycle.id);
  const verdict=async(action,id,artifacts)=>run('advance_review_cycle',{agent_id:id,cycle_id:cycle.id,expected_revision:cycle.revision,expected_task_revision:task.revision,request_id:action+'-'+cycle.revision,action,summary:'Recorded review evidence',artifacts});
  cycle=await verdict('request_changes',author,['Missing retry case']);
  task=await run('update_task',{agent_id:builder,task_id:task.id,expected_revision:task.revision,request_id:'fix',action:'progress',summary:'Added retry case'});
  cycle=await verdict('resubmit',builder,['fixture v2']);
  cycle=await verdict('approve',author,['All criteria pass']);
  task=await run('update_task',{agent_id:builder,task_id:task.id,expected_revision:task.revision,request_id:'complete',action:'complete',summary:'Criteria and current review passed'});
  assert.equal(task.status,'completed');
  const draft={agent_id:builder,name:'check-retries',title:'Check retries',description:'Verify retries',when_to_use:'Testing writes',steps:['Retry with same key'],validation:['One record'],evidence:['fixture v2'],source_task_id:task.id,request_id:'skill'};
  let skill=await run('create_skill',draft);
  const publish=async(s)=>{
    s=await run('review_skill',{agent_id:author,skill_id:s.id,expected_revision:s.revision,request_id:'review-'+s.id,verdict:'approve',summary:'Checked',evidence:['Fixture inspected']});
    return run('update_skill',{agent_id:builder,skill_id:s.id,expected_revision:s.revision,request_id:'publish-'+s.id,action:'publish',summary:'Reviewed'});
  };
  skill=await publish(skill);
  for(const id of [author,builder])await run('record_skill_use',{agent_id:id,skill_id:skill.id,request_id:'use-'+id,outcome:'failure',summary:'Missing timeout scenario',evidence:['Reproduction']});
  const assessment=await run('assess_skills',{agent_id:builder,skill_id:skill.id});
  assert.equal(assessment.skills[0].improvementNeeded,true);
  let proposal=await run('propose_skill_improvement',{agent_id:author,skill_id:skill.id,request_id:'improve'});
  assert.equal((await run('get_recovery',{agent_id:builder})).skillImprovements[0].id,proposal.id);
  const successor=await publish(await run('create_skill',{...draft,supersedes_id:skill.id,steps:['Retry after timeout with same key'],request_id:'skill-v2'}));
  proposal=await run('resolve_skill_improvement',{agent_id:builder,improvement_id:proposal.id,expected_revision:proposal.revision,request_id:'resolve',action:'resolve',summary:'Timeout procedure reviewed',successor_id:successor.id});
  assert.equal(proposal.status,'resolved');
  await run('report_worker_health',{agent_id:builder,expected_revision:0,scheduler_status:'enabled',expected_interval_minutes:5});
  const health=await run('team_health');
  assert.equal(health.workers.find(w=>w.agentId===builder).health.schedulerStatus,'enabled');
});
