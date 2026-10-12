import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { GitHubStore, run } from './github.mjs';
import { Mailbox } from './mailbox.mjs';
import { policyReader } from './coordination.mjs';

// Diagnostics never create an identity, alter credentials, or repair permission scope.
export async function diagnose({execute=run,makeStore=()=>new GitHubStore(),readIdentity=()=>readFile(new URL('./runtime/mailbox-worker.json',import.meta.url),'utf8'),nodeVersion=process.versions.node,readPolicy=policyReader}={}) {
  const checks=[];
  const add=(name,ok,detail)=>checks.push({name,ok,detail});
  add('node',Number(nodeVersion.split('.')[0])>=22,'Node.js '+nodeVersion+'; requires 22 or newer');
  for(const command of ['git','gh']) {
    try {await execute(command,['--version']);add(command,true,'Command available');}
    catch {add(command,false,'Install '+command+' and make it available on PATH');}
  }
  let store,login,identity;
  try {store=makeStore();add('configuration',true,'Mailbox repository configured');}
  catch {add('configuration',false,'Run setup with a dedicated private mailbox repository');}
  if(store) {
    try {login=await store.verify();add('access',true,'Authenticated account has write access to private mailbox');}
    catch {add('access',false,'Check gh auth status, network connectivity, repository privacy, and invitation/write access');}
  }
  if(login) {
    try {
      identity=JSON.parse(await readIdentity());
      if(identity.repo!==store.repo||identity.login!==login||typeof identity.agentId!=='string')throw new Error();
      const {state}=await store.read();
      if(state.agents[identity.agentId]?.owner!==login)throw new Error();
      add('identity',true,'Saved worker matches mailbox and account');
    } catch {identity=null;add('identity',false,'Check saved worker configuration; run setup for this mailbox without replacing another worker');}
  }
  let team;
  if(identity) {
    try {
      const policy=await readPolicy(store.repo,login)();
      add('policy',!policy||Date.parse(policy.expires_at)>Date.now(),policy?'Local policy loaded; check expiry and authorized scope':'No optional local policy; existing user authorization still required');
    } catch {add('policy',false,'Local autonomy policy is invalid or unreadable; ask its owner to correct it');}
    try {team=await new Mailbox(store,login).teamHealth({agent_id:identity.agentId});add('team',true,'Shared coordination state read; see team findings');}
    catch {add('team',false,'Cannot read team health; check mailbox and connectivity');}
  }
  return {ok:checks.every(c=>c.ok),checks,team:team??null,note:'Read-only diagnosis. Scheduler status is self-reported when available, not verified host automation. No credentials or raw command errors are returned.'};
}
if(process.argv[1]===fileURLToPath(import.meta.url)) {
  const result=await diagnose();console.log(JSON.stringify(result,null,2));if(!result.ok)process.exitCode=1;
}
