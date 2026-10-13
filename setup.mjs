import { fileURLToPath } from 'node:url';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { GitHubStore, run } from './github.mjs';
import { worker, workerPath } from './cli.mjs';
import { configuredRepo, configPath } from './config.mjs';
import { register, serverName } from './register.mjs';
let repo, initialize=false, mcp=true, codex=true, claude=false, cursor=false, hermes=false;
for(let i=2;i<process.argv.length;i++) {
 const arg=process.argv[i];
 if(arg==='--repo' && process.argv[i+1]) repo=process.argv[++i];
 else if(arg==='--initialize') initialize=true;
 else if(arg==='--no-mcp') mcp=false;
 else if(arg==='--claude') claude=true;          // also register with Claude Code
 else if(arg==='--hermes') hermes=true;
 else if(arg==='--cursor') cursor=true;          // also register with Cursor IDE/CLI
 else if(arg==='--no-codex') codex=false;        // skip Codex (e.g. Claude Code only: --claude --no-codex)
 else throw new Error('Usage: node setup.mjs [--repo OWNER/REPO] [--initialize] [--no-mcp] [--claude] [--cursor] [--hermes] [--no-codex]');
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
const clients=mcp?[codex&&'codex',claude&&'claude',cursor&&'cursor',hermes&&'hermes'].filter(Boolean):[];
for(const line of await register(run,clients,{name,repo,node:process.execPath,server})) console.log(line);
console.log(JSON.stringify({repo,login,workerAgentId:saved.agentId,server,mcpName:clients.length?name:null,mcpClients:clients},null,2));
console.log('\nLocal setup saved. Next: verify the connection.');
console.log('1. Restart the selected client’s MCP connection, then run npm run smoke.');
console.log('2. Follow your client guide: docs/DEV-COORDINATION.md (Codex), docs/CLAUDE-CODE.md, docs/CURSOR.md, or docs/HERMES.md.');
console.log('3. Verify an addressed exchange with your peer, then configure authorized wake-ups on each host.');
console.log('Setup does not enable scheduled wakes. The optional viewer is not required for collaboration.');
