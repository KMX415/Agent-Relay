import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp,mkdir,writeFile,rm,symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Mailbox } from '../mailbox.mjs';
import { emptyState } from '../github.mjs';
import {createHandoff,getHandoff,listHandoffs,recordHandoffVerification,assertVerifiedHandoff,handoffDigest,verifyLocalHandoff,artifactPath} from '../handoffs.mjs';
const digest=s=>createHash('sha256').update(s).digest('hex');
class Store {
  state=emptyState();revision=0;
  async read(){return {state:structuredClone(this.state),sha:this.revision};}
  async write(state,sha){if(sha!==this.revision)throw Object.assign(new Error('Conflict'),{status:409});this.state=structuredClone(state);this.revision++;}
}
async function setup() {
  const store=new Store(),a=new Mailbox(store,'a'),b=new Mailbox(store,'b'),c=new Mailbox(store,'c');
  for(const box of [a,b,c])Object.assign(box,{createHandoff,getHandoff,listHandoffs,recordHandoffVerification});
  const ids=[];for(const box of [a,b,c])ids.push((await box.join({label:'Worker',task:'handoff test'})).id);
  let task=await a.createTask({agent_id:ids[0],title:'Change',description:'Scoped work',acceptance:['Verified'],assignee_id:ids[0],paths:['src'],request_id:'task'});
  task=await a.updateTask({agent_id:ids[0],task_id:task.id,expected_revision:task.revision,action:'accept',summary:'Started',request_id:'accept'});
  const create=(extra={})=>a.createHandoff({agent_id:ids[0],task_id:task.id,expected_task_revision:task.revision,recipient_id:ids[1],repository:'Owner/Project',commit_sha:'a'.repeat(40),artifacts:[{path:'src/File.txt',sha256:digest('content')}],test_evidence:['Observed tests passed; sender report'],assumptions:['Only listed paths'],request_id:'manifest',...extra});
  const receipt=(h,extra={})=>b.recordHandoffVerification({agent_id:ids[1],handoff_id:h.id,expected_task_revision:h.taskRevision,manifest_digest:h.digest,verdict:'accepted',observed_repository:h.repository,observed_commit:h.commitSha,observed_artifacts:h.artifacts.map(a=>({...a,clean:true})),summary:'Observed exact files',request_id:'verify',...extra});
  return {store,a,b,c,ids,task,create,receipt};
}

test('manifest and receipt pin immutable content, exact worker and current source revision',async()=>{
  const {store,a,b,c,ids,task,create,receipt}=await setup();
  const h=await create();assert.equal(h.digest,handoffDigest(h));assert.equal(h.repository,'owner/project');
  assert.equal((await create()).id,h.id);
  await assert.rejects(create({commit_sha:'b'.repeat(40)}),/different content/);
  assert.throws(()=>assertVerifiedHandoff(store.state,task,ids[0],ids[1],h.id),/accepted/);
  await assert.rejects(c.recordHandoffVerification({agent_id:ids[2],handoff_id:h.id,expected_task_revision:h.taskRevision,manifest_digest:h.digest,verdict:'rejected',summary:'foreign',request_id:'foreign'}),/exact recipient/);
  await assert.rejects(receipt(h,{observed_artifacts:[{...h.artifacts[0],sha256:'b'.repeat(64),clean:true}]}),/matching/);
  await assert.rejects(receipt(h,{observed_artifacts:[{...h.artifacts[0],clean:false}]}),/matching/);
  const accepted=await receipt(h);assert.equal(accepted.receipt.verdict,'accepted');assert.equal((await receipt(h)).id,h.id);
  assert.doesNotThrow(()=>assertVerifiedHandoff(store.state,task,ids[0],ids[1],h.id));
  assert.throws(()=>assertVerifiedHandoff(store.state,task,ids[0],ids[2],h.id),/accepted/);
  await assert.rejects(receipt(h,{verdict:'rejected',request_id:'change'}),/immutable/);
  const page=await b.listHandoffs({agent_id:ids[1],recipient_id:ids[1],limit:1});assert.equal(page.handoffs.length,1);
  store.state.tasks[0].revision++;
  assert.throws(()=>assertVerifiedHandoff(store.state,store.state.tasks[0],ids[0],ids[1],h.id),/changed/);
  store.state.handoffs[0].commitSha='c'.repeat(40);
  await assert.rejects(a.getHandoff({agent_id:ids[0],handoff_id:h.id}),/digest mismatch/);
});

test('stale manifests, foreign senders, out-of-scope paths and unsafe paths reject',async()=>{
  const {store,a,b,ids,create,receipt}=await setup();
  await assert.rejects(create({expected_task_revision:1}),/changed/);
  await assert.rejects(create({artifacts:[{path:'private/key',sha256:'a'.repeat(64)}]}),/declared task paths/);
  const h=await create();
  await assert.rejects(b.createHandoff({agent_id:ids[1],task_id:h.taskId,expected_task_revision:h.taskRevision,recipient_id:ids[0],repository:h.repository,commit_sha:h.commitSha,artifacts:h.artifacts,test_evidence:h.testEvidence,request_id:'foreign'}),/changed/);
  store.state.tasks[0].revision++;
  await assert.rejects(receipt(h),/changed/);
  for(const path of ['../secret','/root','src/../key','src\\file','src/.git/config','src/x:ads','src/file.','src/CON'])assert.throws(()=>artifactPath(path));
  assert.equal(artifactPath('src/MixedCase.txt'),'src/MixedCase.txt');
  await assert.rejects(a.listHandoffs({agent_id:ids[0],limit:0}),/pagination/);
});

test('read-only verifier checks exact repository HEAD bytes and index without invoking tests',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'relay-handoff-')),git=async(...args)=>(await promisify(execFile)('git',args,{cwd:directory,windowsHide:true})).stdout.trim();
  try {
    await git('init');await git('config','user.name','Fixture');await git('config','user.email','fixture@example.invalid');await git('config','core.autocrlf','false');await git('remote','add','origin','https://github.com/Owner/Project.git');
    await mkdir(join(directory,'src'));await writeFile(join(directory,'src','File.txt'),'content');await git('add','.');await git('commit','-m','Fixture');
    const sha=await git('rev-parse','HEAD');
    const {create}=await setup();const h=await create({commit_sha:sha,test_evidence:['DO NOT EXECUTE: arbitrary test prose']});
    let observed=await verifyLocalHandoff({project:directory,manifest:h});assert.equal(observed.passed,true);assert.equal(observed.observed_commit,sha);assert.equal(observed.observed_artifacts[0].clean,true);
    // An unrelated dirty file is outside the manifest's explicit verification boundary.
    await writeFile(join(directory,'unrelated.txt'),'dirty');assert.equal((await verifyLocalHandoff({project:directory,manifest:h})).passed,true);
    await writeFile(join(directory,'src','File.txt'),'changed');observed=await verifyLocalHandoff({project:directory,manifest:h});assert.equal(observed.passed,false);assert.equal(observed.observed_artifacts[0].clean,false);
    await git('add','src/File.txt');await writeFile(join(directory,'src','File.txt'),'content');observed=await verifyLocalHandoff({project:directory,manifest:h});assert.equal(observed.observed_artifacts[0].clean,false);
    await git('reset','--','src/File.txt');
    await git('remote','set-url','origin','git@github.com:owner/wrong.git');assert.equal((await verifyLocalHandoff({project:directory,manifest:h})).passed,false);
    await git('remote','set-url','origin','git@github.com:owner/project.git');assert.equal((await verifyLocalHandoff({project:directory,manifest:h})).passed,true);
    await git('commit','--allow-empty','-m','Changed revision');observed=await verifyLocalHandoff({project:directory,manifest:h});assert.equal(observed.passed,false);assert.equal(observed.checks.find(c=>c.name==='commit').passed,false);
  } finally {await rm(directory,{recursive:true,force:true});}
});

test('verifier refuses symlink escape',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'relay-handoff-link-'));
  try {
    const project=join(directory,'project');await mkdir(project);await mkdir(join(directory,'outside'));await writeFile(join(directory,'outside','File.txt'),'content');
    const git=async(...args)=>(await promisify(execFile)('git',args,{cwd:project,windowsHide:true})).stdout.trim();
    await git('init');await git('config','user.name','Fixture');await git('config','user.email','fixture@example.invalid');await git('remote','add','origin','https://github.com/owner/project');await git('commit','--allow-empty','-m','Fixture');
    try {await symlink(join(directory,'outside'),join(project,'src'),process.platform==='win32'?'junction':'dir');}catch(error){if(['EPERM','EACCES'].includes(error.code)){t.skip('Host cannot create links');return;}throw error;}
    const {create}=await setup();const h=await create({commit_sha:await git('rev-parse','HEAD')});const result=await verifyLocalHandoff({project,manifest:h});assert.equal(result.passed,false);assert.match(result.checks.at(-1).detail,/escapes|Symlink/);
  } finally {await rm(directory,{recursive:true,force:true});}
});
