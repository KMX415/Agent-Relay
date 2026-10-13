import { createHash, randomUUID } from 'node:crypto';
import { readFile, readdir, mkdir, writeFile, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { diagnose } from './doctor.mjs';
import { run } from './github.mjs';
import { tools } from './tools.mjs';
import { register, serverName } from './register.mjs';
import { hermesConfigPath, parseHermesConfig, inspectHermesEntry, hermesEnvironmentIssue } from './hermes.mjs';
import { inspectCursorEntry } from './cursor.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const hash = value => createHash('sha256').update(value).digest('hex');
const text = (value, label, max=2000) => {
  if (typeof value !== 'string' || !value.trim() || value.length>max || /[\x00-\x1f]/.test(value)) throw new Error('Invalid '+label);
  return value;
};
function absolute(value, label) {
  text(value,label);
  if (!path.isAbsolute(value)) throw new Error(label+' must be an absolute path on this host');
  return path.normalize(value);
}
export function renderWakePrompt(template, relayRoot, projectRoot) {
  relayRoot=absolute(relayRoot,'relay root');projectRoot=absolute(projectRoot,'project root');
  if (!template.includes('RELAY_ROOT') || !template.includes('PROJECT_ROOT')) throw new Error('Wake template lacks required root placeholders');
  // A replacement callback preserves literal dollar signs in Windows/POSIX paths.
  return template.replace(/RELAY_ROOT|PROJECT_ROOT/g,token=>JSON.stringify(token==='RELAY_ROOT'?relayRoot:projectRoot));
}

// No registration writes: the existing Claude parser is reused behind a read-only command gate.
async function inspectClient(client, scope, execute, node, read, userHome, environment) {
  if(client==='cli')return true;
  const name=serverName(scope.repo),server=path.join(scope.relayRoot,'server.mjs');
  if(client==='codex') {
    const entry=JSON.parse(await execute('codex',['mcp','list','--json'])).find(item=>item.name===name);
    return !!entry?.enabled && entry.transport?.command===node && JSON.stringify(entry.transport?.args)===JSON.stringify([server]) && entry.transport?.env?.AGENT_MAILBOX_REPO===scope.repo;
  }
  if(client==='hermes') {
    if(await hermesEnvironmentIssue({env:environment,read}))return false;
    const config=parseHermesConfig(await read(scope.hermesConfigPath,'utf8'));
    return inspectHermesEntry(config.mcp_servers?.[name],{name,repo:scope.repo,node,server})==='matches';
  }
  if(client==='cursor') {
    const readConfig=async filename=>{
      let value;
      try {const raw=await read(filename,'utf8');if(Buffer.byteLength(raw)>1024*1024)throw new Error('Cursor configuration too large');value=JSON.parse(raw.replace(/^\uFEFF/,''));}catch(error){if(error.code==='ENOENT')return {};throw error;}
      if(!value||typeof value!=='object'||Array.isArray(value)||value.mcpServers!==undefined&&(!value.mcpServers||typeof value.mcpServers!=='object'||Array.isArray(value.mcpServers)))throw new Error('Invalid Cursor MCP configuration');
      return value.mcpServers??{};
    };
    const global=await readConfig(path.join(userHome,'.cursor','mcp.json'));
    const project=await readConfig(path.join(scope.projectRoot,'.cursor','mcp.json'));
    // A project entry shadows the global entry even when it is disabled or wrong.
    const entry=Object.hasOwn(project,name)?project[name]:global[name];
    return inspectCursorEntry(entry,{name,repo:scope.repo,node,server})==='matches';
  }
  await register(async(command,args)=>{
    if(command!=='claude'||args[0]!=='mcp'||args[1]!=='get')throw new Error('Registration missing');
    return execute(command,args);
  },['claude'],{name,repo:scope.repo,node,server});
  return true;
}

export async function planActivation({projectRoot,client='codex'}={}, {
  relayRoot=root, read=readFile, listSources=readdir, inspectPath=stat, diagnosis=diagnose, execute=run,
  toolSurface=tools, node=process.execPath, userHome=homedir(), environment=process.env
}={}) {
  relayRoot=absolute(relayRoot,'relay root');projectRoot=absolute(projectRoot,'project root');
  if(!['codex','claude','cursor','hermes','cli'].includes(client))throw new Error('Client must be codex, claude, cursor, hermes, or cli');
  const template=await read(path.join(relayRoot,'WAKE-PROMPT.md'),'utf8');
  const wakePrompt=renderWakePrompt(template,relayRoot,projectRoot);
  const promptHash=hash(wakePrompt),toolsHash=hash(JSON.stringify(toolSurface));
  // Hash only root toolkit modules and dependency manifests. Never recurse into
  // runtime, projects, credentials, installed packages, or worker identities.
  const entries=await listSources(relayRoot,{withFileTypes:true});
  const sourceNames=entries.filter(entry=>entry.name.endsWith('.mjs')).map(entry=>{
    if(!entry.isFile() || path.basename(entry.name)!==entry.name)throw new Error('Toolkit module must be a regular root file');
    return entry.name;
  });
  if(!sourceNames.length)throw new Error('Toolkit modules missing');
  const sourceDigests=[];
  for(const name of [...sourceNames,'package.json','package-lock.json'].sort()) {
    sourceDigests.push([name,hash(await read(path.join(relayRoot,name),'utf8'))]);
  }
  const toolkitHash=hash(JSON.stringify(sourceDigests));
  let identityText=null;
  try {identityText=await read(path.join(relayRoot,'runtime','mailbox-worker.json'),'utf8');}catch {}
  const diagnostics=await diagnosis({readIdentity:async()=>{if(identityText===null)throw new Error('Identity missing');return identityText;}});
  const checks=[...diagnostics.checks];
  try {if(!(await inspectPath(projectRoot)).isDirectory())throw new Error();checks.push({name:'project',ok:true,detail:'Development project directory exists'});}
  catch {checks.push({name:'project',ok:false,detail:'Development project directory is missing or unreadable'});}
  let scope=null;
  if(checks.some(c=>c.name==='identity'&&c.ok)) {
    try {
      const identity=JSON.parse(identityText);
      if(!/^[\w.-]+\/[\w.-]+$/.test(identity.repo))throw new Error();
      scope={relayRoot,projectRoot,client,repo:identity.repo,login:text(identity.login,'login',100),agentId:text(identity.agentId,'worker',200),...(client==='hermes'?{hermesConfigPath:hermesConfigPath({env:environment,home:userHome})}:{})};
    }catch {checks.push({name:'activation_identity',ok:false,detail:'Cannot bind activation to the saved worker'});}
  }
  if(scope) {
    try {if(!await inspectClient(client,scope,execute,node,read,userHome,environment))throw new Error();checks.push({name:'client',ok:true,detail:client==='cli'?'CLI selected; host still supplies wake-ups':client==='hermes'?'Selected Hermes profile registration matches. Live tool loading, model access, and scheduling are not verified.':client==='cursor'?'Effective Cursor MCP configuration matches this checkout and mailbox. Tool approval, live connection, and scheduling are not verified.':'Exact MCP registration matches this checkout and mailbox'});}
    catch {checks.push({name:'client',ok:false,detail:'Client registration is missing, different, disabled, or unreadable; inspect it before setup'});}
  }
  let receiptStatus='missing',receipt=null;
  try {
    const saved=JSON.parse(await read(path.join(relayRoot,'runtime','activation.json'),'utf8'));
    if(saved.version!==1||saved.selfReported!==true||!Number.isFinite(Date.parse(saved.observedAt))||typeof saved.scheduleId!=='string'||!saved.scheduleId.trim()||typeof saved.evidence!=='string'||!saved.evidence.trim())throw new Error();
    if(!scope||JSON.stringify(saved.scope)!==JSON.stringify(scope))receiptStatus='different_scope';
    else if(saved.promptHash!==promptHash||saved.toolsHash!==toolsHash||saved.toolkitHash!==toolkitHash)receiptStatus='upgrade_required';
    else {receiptStatus='current';receipt={scheduleId:saved.scheduleId,observedAt:saved.observedAt,selfReported:true};}
  }catch(error){if(error.code!=='ENOENT')receiptStatus='unreadable';}
  return {ready:!!scope&&checks.every(c=>c.ok),scope,scopeHash:scope?hash(JSON.stringify(scope)):null,checks,promptHash,toolsHash,toolkitHash,wakePrompt,receiptStatus,receipt,
    team:diagnostics.team??null,
    peerReadinessNote:'Team findings are shared-state observations and worker self-reports, including stale records. They do not verify peer presence, reachability, scheduled execution, or an actual exchange. Local ready status does not mean the peer is ready.',
    nextSteps:client==='hermes'?['Use the same HERMES_HOME/profile for setup, chat, and scheduled work.','Verify Relay tools in that Hermes session and in the cron toolset separately.','Only within user authorization, save this full prompt in the existing supported Hermes schedule with the explicit project workdir; keep the supported scheduler running.','Observe an actual scheduled peer exchange before claiming background readiness.']:client==='cursor'?['Resolve failed configuration checks, including any project .cursor/mcp.json override.','Inspect Cursor MCP settings and tool approvals, then test the intended connection; matching configuration is not proof of either.','Use a user-authorized supported host wake mechanism only if available. Cursor MCP configuration does not establish a scheduler.','Record a receipt only after independently observing an enabled supported schedule with this complete prompt and current hashes.']:receiptStatus==='current'?['Inspect the supported host scheduler to confirm it remains enabled; a saved receipt is not live verification.']:['Resolve failed checks.','Inspect existing supported host schedules; save this complete wake prompt in the matching schedule within user-authorized scope.','After observing the enabled schedule, explicitly record its ID, evidence, and these hashes.'],
    note:'Read-only plan. No worker, registration, policy, or schedule is created. Receipts record a local self-reported observation, not proof of a live scheduler or peer response.'};
}

export async function recordActivation(options,{plan=planActivation,now=()=>new Date(),write=writeFile,makeDirectory=mkdir,move=rename,remove=rm}={}) {
  if(options.scheduleVerified!==true)throw new Error('Record only after observing the enabled supported host schedule');
  const scheduleId=text(options.scheduleId,'schedule ID',300),evidence=text(options.evidence,'schedule evidence');
  const validate=current=>{
    if(!current.ready)throw new Error('Activation checks must pass before saving a receipt');
    if(options.scopeHash!==current.scopeHash)throw new Error('Worker or project scope changed; inspect and verify the intended schedule again');
    if(options.promptHash!==current.promptHash||options.toolsHash!==current.toolsHash||options.toolkitHash!==current.toolkitHash)throw new Error('Prompt or toolkit changed; restart affected MCP tools, update and verify the saved host prompt before recording');
    if(current.receiptStatus==='different_scope')throw new Error('Existing receipt belongs to another scope; inspect and archive it before recording');
  };
  const initial=await plan({projectRoot:options.projectRoot,client:options.client});validate(initial);
  const directory=path.join(initial.scope.relayRoot,'runtime'),destination=path.join(directory,'activation.json'),temporary=destination+'.'+randomUUID()+'.tmp',lock=destination+'.lock';
  await makeDirectory(directory,{recursive:true});
  try {await write(lock,JSON.stringify({pid:process.pid,createdAt:now().toISOString()})+'\n',{mode:0o600,flag:'wx'});}
  catch(error){if(error.code==='EEXIST')throw new Error('Activation receipt is locked; wait for the writer, or inspect a stale lock before explicitly removing it');throw error;}
  try {
    // Re-read configuration, source hashes and the receipt while holding the
    // exclusive lock. Two first-time writers cannot overwrite different scopes.
    const current=await plan({projectRoot:options.projectRoot,client:options.client});validate(current);
    if(current.scope.relayRoot!==initial.scope.relayRoot)throw new Error('Relay root changed during activation');
    const receipt={version:1,scope:current.scope,promptHash:current.promptHash,toolsHash:current.toolsHash,toolkitHash:current.toolkitHash,scheduleId,evidence,observedAt:now().toISOString(),selfReported:true};
    await write(temporary,JSON.stringify(receipt,null,2)+'\n',{mode:0o600,flag:'wx'});await move(temporary,destination);
  } finally {
    try {await remove(temporary,{force:true});}
    finally {await remove(lock,{force:true});}
  }
  return {recorded:true,receiptStatus:'current',note:'Saved local self-reported scheduler observation. This does not activate a scheduler or verify a peer.'};
}

if(process.argv[1]===fileURLToPath(import.meta.url)) {
  try {
    const options={},names={'--project':'projectRoot','--client':'client','--schedule-id':'scheduleId','--evidence':'evidence','--prompt-hash':'promptHash','--tools-hash':'toolsHash','--toolkit-hash':'toolkitHash','--scope-hash':'scopeHash'};
    let record=false;
    for(let i=2;i<process.argv.length;i++) {
      const arg=process.argv[i];
      if(arg==='--record'){record=true;continue;}
      if(arg==='--schedule-verified'){options.scheduleVerified=true;continue;}
      if(!names[arg]||!process.argv[i+1]||process.argv[i+1].startsWith('--'))throw new Error('Use --project ABSOLUTE_PATH [--client codex|claude|cursor|cli]; recording also requires --record --schedule-verified --schedule-id ID --evidence TEXT --prompt-hash HASH --tools-hash HASH --toolkit-hash HASH --scope-hash HASH');
      if(options[names[arg]]!==undefined)throw new Error('Duplicate argument');
      options[names[arg]]=process.argv[++i];
    }
    if(!record&&Object.keys(options).some(key=>!['projectRoot','client'].includes(key)))throw new Error('Receipt arguments require --record');
    const result=record?await recordActivation(options):await planActivation(options);
    console.log(JSON.stringify(result,null,2));if(result.ready===false)process.exitCode=1;
  } catch {console.error('Activation failed. Supply an absolute --project and --client codex|claude|cursor|cli; inspect local configuration. Recording requires passed checks, verified schedule evidence, and current scope/prompt/tools/toolkit hashes. No schedule was changed.');process.exitCode=1;}
}
