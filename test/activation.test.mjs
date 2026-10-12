import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { planActivation, recordActivation, renderWakePrompt } from '../activation.mjs';

const relayRoot=path.resolve('relay-fixture'),projectRoot=path.resolve('project-$&-fixture');
const identity={repo:'owner/box',login:'owner',agentId:'worker-a'};
function fixture({receipt,template='Tools RELAY_ROOT; project PROJECT_ROOT.',surface=[{name:'one'}],clientResult,source='original implementation',team=null}={}) {
  const calls=[];
  const deps={relayRoot,toolSurface:surface,node:'node-executable',inspectPath:async()=>({isDirectory:()=>true}),
    listSources:async()=>[{name:'server.mjs',isFile:()=>true},{name:'runtime',isFile:()=>false}],
    diagnosis:async({readIdentity})=>{assert.deepEqual(JSON.parse(await readIdentity()),identity);return {checks:[{name:'identity',ok:true}],team};},
    read:async filename=>{
      if(filename.endsWith('WAKE-PROMPT.md'))return template;
      if(filename.endsWith('mailbox-worker.json'))return JSON.stringify(identity);
      if(filename.endsWith('server.mjs'))return source;
      if(['package.json','package-lock.json'].includes(path.basename(filename)))return '{}';
      if(receipt!==undefined)return typeof receipt==='string'?receipt:JSON.stringify(receipt);
      throw Object.assign(new Error('missing'),{code:'ENOENT'});
    },execute:async(command,args)=>{calls.push({command,args});return clientResult??JSON.stringify([{name:'agent-relay-owner--box',enabled:true,transport:{command:'node-executable',args:[path.join(relayRoot,'server.mjs')],env:{AGENT_MAILBOX_REPO:'owner/box'}}}]);}};
  return {deps,calls};
}
function receiptFor(plan) {return {version:1,selfReported:true,scope:plan.scope,promptHash:plan.promptHash,toolsHash:plan.toolsHash,toolkitHash:plan.toolkitHash,scheduleId:'host-id',evidence:'Observed enabled in supported host',observedAt:'2026-10-12T12:00:00Z'};}

test('activation plan renders all roots literally and reads exact client registration without mutation',async()=>{
  const {deps,calls}=fixture();
  const plan=await planActivation({projectRoot},deps);
  assert.equal(plan.ready,true);assert.equal(plan.receiptStatus,'missing');
  assert.equal(plan.wakePrompt,`Tools ${JSON.stringify(relayRoot)}; project ${JSON.stringify(projectRoot)}.`);
  assert.deepEqual(calls,[{command:'codex',args:['mcp','list','--json']}]);
  assert.throws(()=>renderWakePrompt('RELAY_ROOT PROJECT_ROOT','relative',projectRoot),/absolute/);
});
test('activation catches changed instructions, tool schema, project and worker scope',async()=>{
  const base=await planActivation({projectRoot},fixture().deps),receipt=receiptFor(base);
  assert.equal((await planActivation({projectRoot},fixture({receipt}).deps)).receiptStatus,'current');
  assert.equal((await planActivation({projectRoot},fixture({receipt,template:'New RELAY_ROOT PROJECT_ROOT'}).deps)).receiptStatus,'upgrade_required');
  assert.equal((await planActivation({projectRoot},fixture({receipt,surface:[{name:'one',inputSchema:{changed:true}}]}).deps)).receiptStatus,'upgrade_required');
  const implementation=await planActivation({projectRoot},fixture({receipt,source:'fixed implementation, same schema'}).deps);
  assert.equal(implementation.receiptStatus,'upgrade_required');assert.equal(implementation.toolsHash,base.toolsHash);assert.notEqual(implementation.toolkitHash,base.toolkitHash);
  assert.equal((await planActivation({projectRoot:path.resolve('different')},fixture({receipt}).deps)).receiptStatus,'different_scope');
  receipt.scope.agentId='other-worker';
  assert.equal((await planActivation({projectRoot},fixture({receipt}).deps)).receiptStatus,'different_scope');
  assert.equal((await planActivation({projectRoot},fixture({receipt:'bad JSON'}).deps)).receiptStatus,'unreadable');
});
test('activation rejects extra Codex arguments and mailbox prefixes; missing Claude never adds registration',async()=>{
  for(const transport of [
    {command:'node-executable',args:[path.join(relayRoot,'server.mjs'),'extra'],env:{AGENT_MAILBOX_REPO:'owner/box'}},
    {command:'node-executable',args:[path.join(relayRoot,'server.mjs')],env:{AGENT_MAILBOX_REPO:'owner/box-other'}}
  ]) {
    const plan=await planActivation({projectRoot},fixture({clientResult:JSON.stringify([{name:'agent-relay-owner--box',enabled:true,transport}])}).deps);
    assert.equal(plan.ready,false);
  }
  const f=fixture();f.deps.execute=async(command,args)=>{f.calls.push({command,args});throw new Error('SECRET');};
  const plan=await planActivation({projectRoot,client:'claude'},f.deps);
  assert.equal(plan.ready,false);assert.deepEqual(f.calls,[{command:'claude',args:['mcp','get','agent-relay-owner--box']}]);
  assert.doesNotMatch(JSON.stringify(plan),/SECRET/);
});
test('record requires current hashes, ready identity, verified schedule and preserves conflicting scope',async()=>{
  const current=await planActivation({projectRoot},fixture().deps);
  const options={projectRoot,scheduleVerified:true,scheduleId:'host-id',evidence:'Observed enabled',promptHash:current.promptHash,toolsHash:current.toolsHash,toolkitHash:current.toolkitHash,scopeHash:current.scopeHash};
  const noWrite={plan:async()=>current,write:async()=>assert.fail('unexpected write')};
  await assert.rejects(recordActivation({...options,scheduleVerified:false},noWrite),/observing/);
  await assert.rejects(recordActivation({...options,promptHash:'old'},noWrite),/changed/);
  await assert.rejects(recordActivation({...options,toolkitHash:'old-source'},noWrite),/changed/);
  await assert.rejects(recordActivation({...options,scopeHash:'different-worker'},noWrite),/scope changed/);
  await assert.rejects(recordActivation(options,{...noWrite,plan:async()=>({...current,ready:false})}),/checks/);
  await assert.rejects(recordActivation(options,{...noWrite,plan:async()=>({...current,receiptStatus:'different_scope'})}),/another scope/);
});
test('record stores an atomic local self-reported receipt; no schedule activation is claimed',async()=>{
  const directory=await mkdtemp(path.join(os.tmpdir(),'relay-activation-'));
  try {
    const current=await planActivation({projectRoot},fixture().deps);current.scope.relayRoot=directory;
    const result=await recordActivation({projectRoot,scheduleVerified:true,scheduleId:'host-id',evidence:'Observed enabled',promptHash:current.promptHash,toolsHash:current.toolsHash,toolkitHash:current.toolkitHash,scopeHash:current.scopeHash},{plan:async()=>current,now:()=>new Date('2026-10-12T12:00:00Z')});
    assert.equal(result.recorded,true);
    const saved=JSON.parse(await readFile(path.join(directory,'runtime','activation.json'),'utf8'));
    assert.equal(saved.selfReported,true);assert.equal(saved.scope.agentId,'worker-a');assert.equal(saved.observedAt,'2026-10-12T12:00:00.000Z');
  }finally {await rm(directory,{recursive:true,force:true});}
});

test('activation retains peer health evidence without claiming presence or blocking local readiness',async()=>{
  const team={workers:[{agentId:'peer',health:{schedulerStatus:'enabled'}}],diagnostics:[{kind:'stale_worker',agentId:'peer'}]};
  const plan=await planActivation({projectRoot},fixture({team}).deps);
  assert.deepEqual(plan.team,team);assert.equal(plan.ready,true);assert.match(plan.peerReadinessNote,/do not verify peer presence/);
});

test('concurrent first receipts cannot overwrite different project scopes',async()=>{
  const directory=await mkdtemp(path.join(os.tmpdir(),'relay-activation-race-'));
  try {
    const base=await planActivation({projectRoot},fixture().deps);
    const plan=async({projectRoot:project})=>{
      const result={...base,scope:{...base.scope,relayRoot:directory,projectRoot:project},scopeHash:project};
      try {const saved=JSON.parse(await readFile(path.join(directory,'runtime','activation.json'),'utf8'));if(saved.scope.projectRoot!==project)result.receiptStatus='different_scope';}
      catch(error){if(error.code!=='ENOENT')throw error;}
      return result;
    };
    const options=project=>({projectRoot:project,scheduleVerified:true,scheduleId:'schedule-'+project,evidence:'Observed enabled',promptHash:base.promptHash,toolsHash:base.toolsHash,toolkitHash:base.toolkitHash,scopeHash:project});
    const results=await Promise.allSettled(['project-a','project-b'].map(project=>recordActivation(options(project),{plan})));
    assert.equal(results.filter(result=>result.status==='fulfilled').length,1);
    const rejected=results.find(result=>result.status==='rejected');assert.match(rejected.reason.message,/locked|another scope/);
    const saved=JSON.parse(await readFile(path.join(directory,'runtime','activation.json'),'utf8'));
    assert.equal(saved.scope.projectRoot,results[0].status==='fulfilled'?'project-a':'project-b');
    await assert.rejects(readFile(path.join(directory,'runtime','activation.json.lock')),{code:'ENOENT'});
  }finally {await rm(directory,{recursive:true,force:true});}
});

test('an existing stale lock is never automatically removed or replaced',async()=>{
  const directory=await mkdtemp(path.join(os.tmpdir(),'relay-activation-lock-'));
  try {
    const current=await planActivation({projectRoot},fixture().deps);current.scope.relayRoot=directory;
    await mkdir(path.join(directory,'runtime'));
    const lock=path.join(directory,'runtime','activation.json.lock');await writeFile(lock,'preserve-existing-lock');
    await assert.rejects(recordActivation({projectRoot,scheduleVerified:true,scheduleId:'host',evidence:'Observed enabled',promptHash:current.promptHash,toolsHash:current.toolsHash,toolkitHash:current.toolkitHash,scopeHash:current.scopeHash},{plan:async()=>current}),/locked/);
    assert.equal(await readFile(lock,'utf8'),'preserve-existing-lock');
    await assert.rejects(readFile(path.join(directory,'runtime','activation.json')),{code:'ENOENT'});
  }finally {await rm(directory,{recursive:true,force:true});}
});
