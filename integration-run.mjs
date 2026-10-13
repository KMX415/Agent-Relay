import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir, lstat, realpath } from 'node:fs/promises';
import { resolve, relative, isAbsolute, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
const artifactPath=value=>{if(typeof value!=='string'||!value||value.length>300||/[\\:*?\x00-\x1f]/.test(value)||value.startsWith('/')||value.split('/').some(p=>!p||p==='.'||p==='..'||p.toLowerCase()==='.git'||/[. ]$/.test(p)||/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p)))throw new Error('Invalid relative artifact path');return value;};

const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])) : value;
export const integrationDigest = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
export const integrationManifestDigest = ({digest,attempt,...content}) => integrationDigest(content);
const hex = (value,n) => typeof value==='string' && new RegExp(`^[a-f0-9]{${n}}$`).test(value);
const inside = (root,path) => { const rel=relative(root,path);return rel && rel!=='..'&&!rel.startsWith('..'+sep)&&!isAbsolute(rel); };
async function noLinks(path) {
  let cursor=resolve(path);
  while(true) { try {if((await lstat(cursor)).isSymbolicLink())throw new Error('Symlink paths are not allowed');}catch(error){if(error.code!=='ENOENT')throw error;}const parent=resolve(cursor,'..');if(parent===cursor)break;cursor=parent; }
}
function execute(command,args,cwd,timeout,env,limit=8000) {
  return new Promise(resolvePromise=>{
    let output='',timedOut=false,settled=false,overflow=false;
    const child=spawn(command,args,{cwd,env,shell:false,windowsHide:true,detached:process.platform!=='win32',stdio:['ignore','pipe','pipe']});
    const append=data=>{output+=data.toString();if(output.length>limit){overflow=true;output=output.slice(-limit);}};
    child.stdout.on('data',append);child.stderr.on('data',append);
    const timer=setTimeout(()=>{timedOut=true;if(process.platform==='win32'){const killer=spawn('taskkill',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});killer.on('error',()=>child.kill('SIGKILL'));}else{try{process.kill(-child.pid,'SIGKILL');}catch{child.kill('SIGKILL');}}},timeout);
    const finish=(code,error)=>{if(settled)return;settled=true;clearTimeout(timer);resolvePromise({passed:!error&&!timedOut&&code===0,exitCode:code??null,timedOut,overflow,evidence:error?String(error.message).slice(0,1000):output});};
    child.on('error',error=>finish(null,error));child.on('close',code=>finish(code));
  });
}

/** Executes only a separately authorized local profile. This worktree is not a security sandbox. */
export async function runIntegration({projectRoot,manifest,profilePath,outputRoot,run}) {
  if(!isAbsolute(projectRoot??'')||!isAbsolute(profilePath??''))throw new Error('Project and local profile paths must be absolute');
  await noLinks(projectRoot);await noLinks(profilePath);
  const root=await realpath(projectRoot);
  let deadline=Math.min(Date.parse(manifest?.deadline),(typeof run?.leaseUntil==='number'?run.leaseUntil:Date.parse(run?.leaseUntil)));
  if(typeof run?.id!=='string'||!run.id||!Number.isFinite(deadline)||deadline<=Date.now())throw new Error('A current run lease and manifest deadline are required');
  const remaining=()=>{const value=deadline-Date.now();if(value<=0)throw new Error('Integration deadline or run lease expired');return value;};
  if(!manifest||!hex(manifest.baseSha,40)||!hex(manifest.digest,64)||manifest.digest!==integrationManifestDigest(manifest)||!Number.isInteger(manifest.attempt)||manifest.attempt<1||manifest.attempt>10)throw new Error('Invalid integration manifest digest, base or attempt');
  if(!/^[\w.-]+\/[\w.-]+$/.test(manifest.repository??''))throw new Error('Invalid repository');
  if(!Array.isArray(manifest.contributions)||!manifest.contributions.length||manifest.contributions.length>30||manifest.contributions.some(c=>!hex(c.commitSha,40)||!hex(c.manifestDigest,64)||!c.taskId||!c.handoffId||!Number.isInteger(c.taskRevision)||c.taskRevision<1))throw new Error('Invalid contributions');
  if(!Array.isArray(manifest.paths)||!manifest.paths.length||manifest.paths.length>30)throw new Error('Manifest requires declared integration paths');
  manifest.paths.forEach(artifactPath);
  const bytes=await readFile(profilePath);if(bytes.length>64000)throw new Error('Local profile too large');
  const profile=JSON.parse(bytes);
  if(profile.version!==1||profile.name!==manifest.profile?.name||integrationDigest(profile)!==manifest.profile?.digest||profile.repository!==manifest.repository||!Number.isFinite(Date.parse(profile.expires_at))||Date.parse(profile.expires_at)<=Date.now())throw new Error('Local profile does not authorize this manifest or has expired');
  deadline=Math.min(deadline,Date.parse(profile.expires_at));
  if(!Array.isArray(profile.allowed_paths)||!profile.allowed_paths.length||profile.allowed_paths.length>50)throw new Error('Local profile needs allowed paths');
  profile.allowed_paths.forEach(artifactPath);
  if(!Array.isArray(profile.commands)||!profile.commands.length||profile.commands.length>10||profile.commands.some(c=>typeof c.command!=='string'||!c.command||!Array.isArray(c.args)||c.args.length>100||c.args.some(a=>typeof a!=='string'||a.length>4000)||!Number.isInteger(c.timeout_ms)||c.timeout_ms<1||c.timeout_ms>300000))throw new Error('Invalid local validation commands');
  const output=resolve(outputRoot??resolve(root,'runtime/integration'));
  if(!inside(resolve(root,'runtime'),output))throw new Error('Output must be beneath project runtime');
  await noLinks(output);
  const env={...Object.fromEntries(Object.entries(process.env).filter(([key])=>!key.toUpperCase().startsWith('GIT_'))),GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:process.platform==='win32'?'NUL':'/dev/null',GIT_TERMINAL_PROMPT:'0'};
  let hooks=resolve(output,'disabled-hooks');
  const git=async(args,cwd=root)=>{
    const result=await execute('git',['--no-optional-locks','-c',`safe.directory=${root}`,'-c',`safe.directory=${cwd}`,'-c','core.fsmonitor=false','-c',`core.hooksPath=${hooks}`,'-c','commit.gpgSign=false','-c','merge.gpgSign=false','-c','user.name=Dead Drop Integration','-c','user.email=integration@dead-drop.invalid',...args],cwd,Math.min(30000,remaining()),env,2*1024*1024);
    if(result.overflow)throw new Error('Git inspection exceeds bounded output');if(!result.passed)throw new Error(result.evidence||'Git command failed');return result.evidence.trim();
  };
  if(await realpath(await git(['rev-parse','--show-toplevel']))!==root)throw new Error('Project must be the repository root');
  const origin=await git(['config','--local','--get','remote.origin.url']);
  const remote=/^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([^/]+\/[^/]+?)(?:\.git)?\/?$/i.exec(origin);
  if(remote?.[1].toLowerCase()!==manifest.repository.toLowerCase())throw new Error('Repository origin mismatch');
  await git(['check-ignore','--no-index',relative(root,resolve(output,'probe')).split(sep).join('/')]);
  const config=await git(['config','--local','--list']);
  if(/^(?:filter\.|merge\..*\.driver=|core\.attributesfile=)/mi.test(config))throw new Error('Custom local filters or merge drivers require manual inspection');
  for(const sha of new Set([manifest.baseSha,...manifest.contributions.map(c=>c.commitSha)])) {
    if(await git(['rev-parse','--verify',`${sha}^{commit}`])!==sha)throw new Error('Input must be an exact existing commit');
    const tree=await git(['ls-tree','-r',sha]);
    if(/^(120000|160000) /m.test(tree))throw new Error('Symlinks and submodules require manual integration');
  }
  for(const contribution of manifest.contributions) {
    await git(['merge-base','--is-ancestor',manifest.baseSha,contribution.commitSha]);
    const paths=(await git(['diff','--no-ext-diff','--no-textconv','--name-only','--no-renames',manifest.baseSha,contribution.commitSha])).split('\n').filter(Boolean);
    for(const path of paths){artifactPath(path);if(!profile.allowed_paths.some(p=>path===p||path.startsWith(p+'/')))throw new Error('Contribution exceeds local profile paths');if(!manifest.paths.some(p=>path===p||path.startsWith(p+'/')))throw new Error('Contribution exceeds declared integration paths');}
  }
  await mkdir(output,{recursive:true});
  const runDirectory=resolve(output,`${manifest.digest}-attempt-${manifest.attempt}`);
  try {await mkdir(runDirectory);}catch(error){if(error.code==='EEXIST')throw new Error('Attempt already started; inspect preserved evidence instead of rerunning');throw error;}
  hooks=resolve(runDirectory,'disabled-hooks');await mkdir(hooks);
  const worktree=resolve(runDirectory,'worktree');
  const result={passed:false,verdict:'blocked',runId:run.id,evidence:[],inputDigest:manifest.digest,profileDigest:manifest.profile.digest,attempt:manifest.attempt,runDirectory,worktree,startedAt:new Date().toISOString(),checks:[],commitSha:null,treeSha:null,note:'Local observations, not a sandbox or proof of independent human participation.'};
  await writeFile(resolve(runDirectory,'started.json'),JSON.stringify({manifest,profile,startedAt:result.startedAt},null,2),{flag:'wx'});
  try {
    await git(['worktree','add','--detach',worktree,manifest.baseSha]);
    for(const contribution of manifest.contributions)await git(['merge','--no-ff','--no-edit','--no-autostash',contribution.commitSha],worktree);
    result.commitSha=await git(['rev-parse','HEAD'],worktree);result.treeSha=await git(['rev-parse','HEAD^{tree}'],worktree);
    for(const [index,command] of profile.commands.entries()) {
      const available=Math.min(remaining(),Date.parse(profile.expires_at)-Date.now());if(available<=0)throw new Error('Local profile expired before validation completed');
      const check=await execute(command.command,command.args,worktree,Math.min(available,command.timeout_ms),env);result.checks.push({name:`check-${index+1}`,passed:check.passed,detail:(check.timedOut?'Timed out. ':'')+(check.evidence.trim().slice(-1900)||`Exit code ${check.exitCode}`)});
      await writeFile(resolve(runDirectory,'progress.json'),JSON.stringify(result,null,2));
      if(!check.passed)break;
    }
    remaining();
    if(await git(['rev-parse','HEAD'],worktree)!==result.commitSha||await git(['rev-parse','HEAD^{tree}'],worktree)!==result.treeSha)throw new Error('Validation changed the integrated commit');
    try {await git(['diff','--quiet','--no-ext-diff'],worktree);await git(['diff','--cached','--quiet','--no-ext-diff'],worktree);}catch{throw new Error('Validation changed tracked integration files');}
    remaining();
    result.passed=result.checks.length===profile.commands.length&&result.checks.every(c=>c.passed);result.verdict=result.passed?'passed':'failed';
  } catch(error){result.error=String(error.message).slice(0,2000);result.evidence.push(result.error);result.verdict='blocked';}
  result.finishedAt=new Date().toISOString();result.evidence.push(`Local integration ${result.verdict}: ${result.checks.filter(c=>c.passed).length}/${result.checks.length} observed validation checks passed; input ${result.inputDigest}, attempt ${result.attempt}.`);await writeFile(resolve(runDirectory,'result.json'),JSON.stringify(result,null,2),{flag:'wx'});return result;
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const args=process.argv.slice(2);if(args.length!==8||args[0]!=='--project'||args[2]!=='--input'||args[4]!=='--profile'||args[6]!=='--output')throw new Error('Usage: node integration-run.mjs --project ABS --input MANIFEST.json --profile ABS --output ABS');
    const bytes=await readFile(args[3]);if(bytes.length>100000)throw new Error('Manifest too large');
    const input=JSON.parse(bytes);const result=await runIntegration({projectRoot:args[1],manifest:input.manifest,run:input.run,profilePath:args[5],outputRoot:args[7]});console.log(JSON.stringify(result,null,2));if(!result.passed)process.exitCode=1;
  }catch(error){console.error('Integration verification failed: '+error.message);process.exitCode=1;}
}
