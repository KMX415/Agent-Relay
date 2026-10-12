import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { Mailbox } from '../mailbox.mjs';
import { emptyState, GitHubStore } from '../github.mjs';
import { call } from '../tools.mjs';
import { runIntegration, integrationDigest } from '../integration-run.mjs';
import { runDurable, replayOutbox } from '../outbox.mjs';

const exec=promisify(execFile);
test('public workflow combines real reviewed deliveries, routes failed evidence, repairs and gates goal completion',async t=>{
  const root=await mkdtemp(join(tmpdir(),'relay-integration-flow-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const git=async(...args)=>(await exec('git',['-c',`safe.directory=${root}`,...args],{cwd:root})).stdout.trim();
  await git('init','-b','main');await git('config','user.name','Synthetic contributor');await git('config','user.email','fixture@example.invalid');await git('remote','add','origin','https://github.com/fixture/project.git');
  await mkdir(join(root,'src'));await mkdir(join(root,'runtime'));
  await writeFile(join(root,'.gitignore'),'runtime/\n');
  await writeFile(join(root,'src/a.cjs'),'module.exports=1;\n');await writeFile(join(root,'src/b.cjs'),'module.exports=1;\n');
  await writeFile(join(root,'check.cjs'),"if(require('./src/a.cjs')===2&&require('./src/b.cjs')===2)process.exit(1);\n");
  await git('add','.');await git('commit','-m','Fixture base');const base=await git('rev-parse','HEAD');
  const edit=async(branch,path,value,from=base)=>{await git('checkout','-b',branch,from);await writeFile(join(root,path),`module.exports=${value};\n`);await git('add',path);await git('commit','-m','Synthetic contribution');return git('rev-parse','HEAD');};
  const one=await edit('one','src/a.cjs',2),two=await edit('two','src/b.cjs',2),repair=await edit('repair','src/b.cjs',3,two);await git('checkout','main');
  const store={state:emptyState(),revision:0,async read(){return {state:structuredClone(this.state),sha:this.revision};},async write(state,sha){if(sha!==this.revision)throw Object.assign(new Error('Conflict'),{status:409});this.state=structuredClone(state);this.revision++;}};
  const ids={},boxes={},expires=new Date(Date.now()+3600000).toISOString();
  for(const owner of ['alice','bob','carol']) {
    const policy={owner,allowed_kinds:['implementation','review','testing'],allowed_paths:['src'],allow_unassigned:false,max_active_tasks:10,max_chain_depth:5,max_handoffs:5,max_task_minutes:60,expires_at:expires};
    boxes[owner]=new Mailbox(store,owner,Date.now,async()=>policy);ids[owner]=(await boxes[owner].join({label:owner,task:'Synthetic test'})).id;
    await boxes[owner].updateAgent({agent_id:ids[owner],expected_revision:0,provider:'synthetic',capabilities:['review'],paths:['src']});
  }
  const invoke=(owner,name,args={})=>call(boxes[owner],name,{agent_id:ids[owner],...args});
  for(const owner of Object.keys(ids))for(const peer of Object.keys(ids))if(peer!==owner)await invoke(owner,'set_collaboration_agreement',{peer_owner:peer,allowed_kinds:['testing'],allowed_paths:['src'],expires_at:expires,request_id:'agreement-'+peer});
  const goal=await invoke('alice','create_goal',{title:'Compatible components',description:'Verify separate contributions together',acceptance:['Combined check passes'],participants:Object.values(ids),allowed_kinds:['implementation','review','testing'],allowed_paths:['src'],max_tasks:4,max_concurrent:2,deadline:expires,required_integration_work_ids:['combined'],request_id:'goal'});
  const deliver=async(label,commit,path,value)=>{
    let task=await invoke('alice','create_task',{title:label,description:'Fixture change',acceptance:['Observed local check'],assignee_id:ids.bob,kind:'implementation',paths:['src'],goal_id:goal.id,request_id:label});
    task=await invoke('bob','update_task',{task_id:task.id,expected_revision:task.revision,action:'accept',summary:'Within fixture scope',request_id:'accept-'+label});
    const cycle=await invoke('bob','start_review_cycle',{task_id:task.id,reviewer_id:ids.alice,expected_task_revision:task.revision,request_id:'review-'+label,summary:'Review exact fixture change',artifacts:[commit]});
    await invoke('alice','advance_review_cycle',{cycle_id:cycle.id,expected_revision:cycle.revision,expected_task_revision:task.revision,action:'approve',summary:'Inspected fixture',artifacts:[commit],request_id:'approve-'+label});
    const handoff=await invoke('bob','create_handoff',{task_id:task.id,expected_task_revision:task.revision,recipient_id:ids.alice,repository:'fixture/project',commit_sha:commit,artifacts:[{path,sha256:createHash('sha256').update(`module.exports=${value};\n`).digest('hex')}],test_evidence:['Synthetic fixture examined'],request_id:'handoff-'+label});
    await invoke('alice','record_handoff_verification',{handoff_id:handoff.id,expected_task_revision:task.revision,manifest_digest:handoff.digest,verdict:'accepted',observed_repository:'fixture/project',observed_commit:commit,observed_artifacts:handoff.artifacts.map(a=>({...a,clean:true})),summary:'Synthetic exact artifact receipt',request_id:'receipt-'+label});
    task=await invoke('bob','update_task',{task_id:task.id,expected_revision:task.revision,action:'complete',summary:'Reviewed fixture complete',handoff_id:handoff.id,request_id:'done-'+label});
    return {task_id:task.id,task_revision:task.revision,commit_sha:commit,handoff_id:handoff.id,manifest_digest:handoff.digest};
  };
  const inputs=[await deliver('one',one,'src/a.cjs',2),await deliver('two',two,'src/b.cjs',2)];
  const profile={version:1,name:'fixture',repository:'fixture/project',allowed_paths:['src'],commands:[{command:process.execPath,args:['check.cjs'],timeout_ms:5000}],expires_at:expires};
  const profilePath=join(root,'runtime/profile.json');await writeFile(profilePath,JSON.stringify(profile));
  const fields={repository:'fixture/project',base_sha:base,contributions:inputs,profile_name:profile.name,profile_digest:integrationDigest(profile)};
  let executionTask=await invoke('alice','create_task',{title:'Verify combined inputs',description:'Run bounded fixture integration',acceptance:['Combined checks pass'],assignee_id:ids.carol,kind:'testing',paths:['src'],goal_id:goal.id,request_id:'integration-task'});
  executionTask=await invoke('carol','update_task',{task_id:executionTask.id,expected_revision:executionTask.revision,action:'accept',summary:'Testing scope accepted',request_id:'accept-integration-task'});
  let check=await invoke('alice','create_integration_check',{work_id:'combined',verifier_id:ids.carol,execution_task_id:executionTask.id,...fields,goal_id:goal.id,deadline:expires,max_attempts:2,request_id:'create-check'});
  const complete=()=>invoke('alice','update_goal',{goal_id:goal.id,expected_revision:goal.revision,action:'complete',summary:'All exact inputs passed',evidence:['Observed integration runner result'],request_id:'complete-goal'});
  await assert.rejects(complete(),/integration/);
  const run=await invoke('carol','begin_worker_run',{host:'synthetic-local',provider:'node-test',trigger:'interactive',evidence:['Actual fixture execution, simulated contributors'],lease_minutes:5,request_id:'run'});
  const start=()=>invoke('carol','advance_integration_check',{integration_id:check.id,expected_revision:check.revision,input_digest:check.manifest.digest,action:'start',run_id:run.id,summary:'Execute authorized fixture profile',request_id:'start-'+check.attempt});
  const report=async(result)=>{
    const projection=Object.fromEntries(['inputDigest','attempt','profileDigest','runId','verdict','commitSha','treeSha','checks','evidence'].map(k=>[k,result[k]]));
    return invoke('carol','advance_integration_check',{integration_id:check.id,expected_revision:check.revision,input_digest:check.manifest.digest,action:'result',run_id:run.id,result:projection,summary:'Observed actual isolated test result',request_id:'result-'+check.attempt});
  };
  check=await start();let observed=await runIntegration({projectRoot:root,...check.execution,profilePath});assert.equal(observed.verdict,'failed');check=await report(observed);
  assert.ok((await invoke('bob','list_notifications')).notifications.some(n=>n.integrationId===check.id));
  assert.ok((await invoke('carol','get_recovery')).integrationChecks.some(c=>c.id===check.id));
  assert.ok((await invoke('carol','next_actions')).actions.some(a=>a.inspect?.tool==='get_integration_check'));
  await assert.rejects(complete(),/integration/);
  inputs.push(await deliver('repair',repair,'src/b.cjs',3));
  check=await invoke('alice','advance_integration_check',{integration_id:check.id,expected_revision:check.revision,input_digest:check.manifest.digest,action:'retry',...fields,contributions:inputs,summary:'New reviewed repair input',request_id:'retry'});
  check=await start();observed=await runIntegration({projectRoot:root,...check.execution,profilePath});assert.equal(observed.verdict,'passed');check=await report(observed);
  await invoke('carol','update_task',{task_id:executionTask.id,expected_revision:executionTask.revision,action:'complete',summary:'Actual combined fixture check passed',artifacts:[observed.commitSha],request_id:'done-integration-task'});
  assert.equal((await complete()).status,'completed');assert.equal(check.attempts[0].result.verdict,'failed');assert.equal(await git('rev-parse','main'),base);
  assert.equal(await git('branch','--show-current'),'main');assert.equal((await invoke('alice','check_inbox')).messages.length,0);
});

test('integration outbox keys preserve exact payloads and target identity across uncertain writes',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'relay-integration-outbox-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  const args={agent_id:'worker',integration_id:'one',action:'block',expected_revision:1,input_digest:'a'.repeat(64),summary:'Interrupted',request_id:'block'};
  for(const integration_id of ['one','two'])await assert.rejects(runDurable({directory,tool:'advance_integration_check',args:{...args,integration_id},invoke:async()=>{throw new Error('Unknown outcome');}}));
  const seen=[];await replayOutbox({directory,agentId:'worker',invoke:async(name,input)=>seen.push({name,input})});
  assert.deepEqual(seen.map(x=>x.input.integration_id).sort(),['one','two']);assert.deepEqual((await replayOutbox({directory,agentId:'worker',invoke:async()=>assert.fail('duplicate')})).operations,[]);
});

test('mailbox rejects malformed optional integration collection before returning state',async()=>{
  const store=new GitHubStore('fixture/mailbox');
  store.api=async path=>path==='repos/fixture/mailbox'?{private:true}:{encoding:'base64',size:100,content:Buffer.from(JSON.stringify({...emptyState(),integrationChecks:{}})).toString('base64')};
  await assert.rejects(store.read(),/schema/);
});
