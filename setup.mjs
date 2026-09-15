import { fileURLToPath } from 'node:url';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { GitHubStore, run } from './github.mjs';
import { worker, workerPath } from './cli.mjs';
import { configuredRepo, configPath } from './config.mjs';
let repo, initialize=false, register=true;
for(let i=2;i<process.argv.length;i++) {
 const arg=process.argv[i];
 if(arg==='--repo' && process.argv[i+1]) repo=process.argv[++i];
 else if(arg==='--initialize') initialize=true;
 else if(arg==='--no-mcp') register=false;
 else throw new Error('Usage: node setup.mjs [--repo OWNER/REPO] [--initialize] [--no-mcp]');
}
repo ??= configuredRepo();
const store=new GitHubStore(repo), login=await store.verify();
try {
 const saved=JSON.parse(await readFile(workerPath,'utf8'));
 if(saved.repo!==repo || saved.login!==login) throw new Error('This checkout belongs to another mailbox/account. Use a separate clone.');
} catch(error) { if(error.code!=='ENOENT') throw error; }
if(initialize) console.log(await store.initialize()); else await store.read();
const saved=await worker(store,login);
await mkdir(new URL('./runtime/',import.meta.url),{recursive:true});
await writeFile(configPath,JSON.stringify({repo},null,2)+'\n');
const server=fileURLToPath(new URL('./server.mjs',import.meta.url));
const name='agent-relay-'+repo.toLowerCase().replace('/', '--');
if(register) {
 const existing=JSON.parse(await run('codex',['mcp','list','--json'])).find(s=>s.name===name);
 if(existing) {
  if(existing.transport?.command!==process.execPath || !existing.transport?.args?.includes(server) || existing.transport?.env?.AGENT_MAILBOX_REPO!==repo || !existing.enabled) throw new Error('A different/disabled registration exists for '+name+'. Inspect it before replacing it.');
  console.log('MCP registration already matches.');
 } else console.log((await run('codex',['mcp','add',name,'--env',`AGENT_MAILBOX_REPO=${repo}`,'--',process.execPath,server])).trim());
}
console.log(JSON.stringify({repo,login,workerAgentId:saved.agentId,server,mcpName:register?name:null},null,2));
console.log('Read docs/DEV-COORDINATION.md to enable a heartbeat in the target development task. Setup does not enable scheduled wakes.');
