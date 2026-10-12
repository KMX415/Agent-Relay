import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,writeFile,mkdir,readFile,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { runIntegration,integrationDigest,integrationManifestDigest } from '../integration-run.mjs';
const exec=promisify(execFile);
async function fixture(t) {
  const root=await mkdtemp(join(tmpdir(),'relay-integration-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const git=async(...args)=>(await exec('git',['-c',`safe.directory=${root}`,...args],{cwd:root})).stdout.trim();
  await git('init','-b','main');await git('config','user.name','Fixture contributor');await git('config','user.email','fixture@example.invalid');await git('remote','add','origin','https://github.com/fixture/project.git');
  await writeFile(join(root,'.gitignore'),'runtime/\n');await mkdir(join(root,'src'));
  await writeFile(join(root,'src/a.cjs'),'module.exports=1;\n');await writeFile(join(root,'src/b.cjs'),'module.exports=1;\n');
  await writeFile(join(root,'check.cjs'),"if(require('./src/a.cjs')===2 && require('./src/b.cjs')===2)process.exit(1);\n");
  await git('add','.');await git('commit','-m','base');const base=await git('rev-parse','HEAD');
  const commit=async(file,text)=>{await writeFile(join(root,file),text);await git('add',file);await git('commit','-m','Contribution');return git('rev-parse','HEAD');};
  await git('checkout','-b','one');const one=await commit('src/a.cjs','module.exports=2;\n');await exec(process.execPath,['check.cjs'],{cwd:root});
  await git('checkout','-b','two',base);const two=await commit('src/b.cjs','module.exports=2;\n');await exec(process.execPath,['check.cjs'],{cwd:root});
  const repaired=await commit('src/b.cjs','module.exports=3;\n');await git('checkout','main');
  await mkdir(join(root,'runtime'));
  const profile={version:1,name:'fixture',repository:'fixture/project',allowed_paths:['src'],commands:[{command:process.execPath,args:['check.cjs'],timeout_ms:5000}],expires_at:new Date(Date.now()+120000).toISOString()};
  const profilePath=join(root,'runtime/profile.json');await writeFile(profilePath,JSON.stringify(profile));
  const manifest=(commits=[one,two],attempt=1)=>{const m={paths:['src'],repository:'fixture/project',baseSha:base,contributions:commits.map((commitSha,i)=>({taskId:`task-${i}`,taskRevision:1,commitSha,handoffId:`handoff-${i}`,manifestDigest:'a'.repeat(64)})),contracts:[],profile:{name:profile.name,digest:integrationDigest(profile)},deadline:new Date(Date.now()+120000).toISOString(),attempt};m.digest=integrationManifestDigest(m);return m;};
  const run={id:'fixture-run',leaseUntil:new Date(Date.now()+120000).toISOString()};
  const invoke=(m,extra={})=>runIntegration({projectRoot:root,manifest:m,profilePath,run,...extra});
  return {root,git,base,one,two,repaired,manifest,invoke,profile,profilePath,commit};
}

test('individually passing contributions fail combined, repair passes without moving main',async t=>{
  const f=await fixture(t),m=f.manifest();const failed=await f.invoke(m);
  assert.equal(failed.verdict,'failed');assert.equal(failed.checks[0].passed,false);
  assert.equal(await f.git('rev-parse','HEAD'),f.base);assert.equal(await f.git('branch','--show-current'),'main');
  await assert.rejects(f.invoke(m),/already started/);
  const passed=await f.invoke(f.manifest([f.one,f.repaired],2));assert.equal(passed.verdict,'passed');assert.equal(passed.passed,true);assert.ok(passed.evidence.length);
  assert.equal(await f.git('rev-parse','main'),f.base);
  const parents=await f.git('rev-list',passed.commitSha);assert.ok(parents.includes(f.one));assert.ok(parents.includes(f.repaired));
  assert.equal(JSON.parse(await readFile(join(passed.runDirectory,'result.json'))).inputDigest,passed.inputDigest);
});

test('conflicts retain worktree and evidence',async t=>{
  const f=await fixture(t);await f.git('checkout','-b','conflict',f.base);const conflict=await f.commit('src/a.cjs','module.exports=9;\n');await f.git('checkout','main');
  const result=await f.invoke(f.manifest([f.one,conflict]));assert.equal(result.verdict,'blocked');assert.match(result.error,/CONFLICT|conflict/);assert.equal(result.checks.length,0);assert.equal(await f.git('rev-parse','HEAD'),f.base);
});

test('rejects stale digest, unauthorized profile, outside paths and expired lease before execution',async t=>{
  const f=await fixture(t);const m=f.manifest();
  await assert.rejects(f.invoke({...m,baseSha:f.one}),/manifest digest/);
  f.profile.name='unauthorized';await writeFile(f.profilePath,JSON.stringify(f.profile));await assert.rejects(f.invoke(m),/does not authorize/);
  f.profile.name='fixture';f.profile.allowed_paths=['other'];await writeFile(f.profilePath,JSON.stringify(f.profile));await assert.rejects(f.invoke(f.manifest()),/exceeds local profile/);
  await assert.rejects(f.invoke(f.manifest(),{run:{id:'run',leaseUntil:'2000-01-01T00:00:00Z'}}),/current run lease/);
  await assert.rejects(f.invoke(f.manifest(),{outputRoot:join(f.root,'outside')}),/beneath project runtime/);
});

test('validation times out and retains failed evidence',async t=>{
  const f=await fixture(t);f.profile.commands=[{command:process.execPath,args:['-e','setInterval(()=>{},1000)'],timeout_ms:50}];await writeFile(f.profilePath,JSON.stringify(f.profile));
  const result=await f.invoke(f.manifest([f.one]));assert.equal(result.verdict,'failed');assert.match(result.checks[0].detail,/Timed out/);
});

test('interrupted attempt marker prevents blind execution and wrong repository is rejected',async t=>{
  const f=await fixture(t),m=f.manifest();
  const dir=join(f.root,'runtime/integration',`${m.digest}-attempt-${m.attempt}`);await mkdir(dir,{recursive:true});
  await writeFile(join(dir,'started.json'),JSON.stringify({manifest:m}));
  await assert.rejects(f.invoke(m),/already started/);
  await f.git('remote','set-url','origin','https://github.com/other/project.git');await assert.rejects(f.invoke(f.manifest()),/origin mismatch/);
  assert.equal(await f.git('rev-parse','HEAD'),f.base);
});

test('passing command that changes tracked inputs cannot report integration passed',async t=>{
  const f=await fixture(t);f.profile.commands=[{command:process.execPath,args:['-e',"require('fs').writeFileSync('src/a.cjs','changed')"],timeout_ms:5000}];await writeFile(f.profilePath,JSON.stringify(f.profile));
  const result=await f.invoke(f.manifest([f.one]),{run:{id:'numeric-lease',leaseUntil:Date.now()+120000}});assert.equal(result.verdict,'blocked');assert.match(result.error,/changed tracked/);assert.equal(await f.git('rev-parse','HEAD'),f.base);
});

test('preexisting shared hooks cannot execute during isolated integration',async t=>{
  const f=await fixture(t);const hooks=join(f.root,'runtime/integration/disabled-hooks');await mkdir(hooks,{recursive:true});
  await writeFile(join(hooks,'post-checkout'),'#!/bin/sh\nexit 42\n',{mode:0o755});await writeFile(join(hooks,'pre-merge-commit'),'#!/bin/sh\nexit 42\n',{mode:0o755});
  const result=await f.invoke(f.manifest([f.one]));assert.equal(result.verdict,'passed');
});

 test('broad local profile cannot authorize changes outside declared task scope',async t=>{
  const f=await fixture(t),m=f.manifest();m.paths=['src/a.cjs'];m.digest=integrationManifestDigest(m);
  await assert.rejects(f.invoke(m),/exceeds declared integration paths/);
  assert.equal(await f.git('rev-parse','HEAD'),f.base);
});
