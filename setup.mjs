import { fileURLToPath } from 'node:url';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { GitHubStore, run } from './github.mjs';
import { worker, workerPath } from './cli.mjs';
import { configuredRepo, configPath } from './config.mjs';
import { register, serverName } from './register.mjs';
let repo, initialize=false, mcp=true, codex=true, claude=false;
for(let i=2;i<process.argv.length;i++) {
 const arg=process.argv[i];
 if(arg==='--repo' && process.argv[i+1]) repo=process.argv[++i];
 else if(arg==='--initialize') initialize=true;
 else if(arg==='--no-mcp') mcp=false;
 else if(arg==='--claude') claude=true;          // also register with Claude Code
 else if(arg==='--no-codex') codex=false;        // skip Codex (e.g. Claude Code only: --claude --no-codex)
 else throw new Error('Usage: node setup.mjs [--repo OWNER/REPO] [--initialize] [--no-mcp] [--claude] [--no-codex]');
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
const name=serverName(repo);
const clients=mcp?[codex&&'codex',claude&&'claude'].filter(Boolean):[];
for(const line of await register(run,clients,{name,repo,node:process.execPath,server})) console.log(line);
console.log(JSON.stringify({repo,login,workerAgentId:saved.agentId,server,mcpName:clients.length?name:null,mcpClients:clients},null,2));
console.log('Read docs/DEV-COORDINATION.md (Codex heartbeat) or docs/CLAUDE-CODE.md (Claude Code /loop) to enable wake-ups in the target development task. Setup does not enable scheduled wakes.');
