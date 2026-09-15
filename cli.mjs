import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { GitHubStore } from './github.mjs';
import { Mailbox } from './mailbox.mjs';
import { call } from './tools.mjs';

export const workerPath=fileURLToPath(new URL('./runtime/mailbox-worker.json',import.meta.url));
export async function worker(store,login) {
  let saved;
  try{saved=JSON.parse(await readFile(workerPath,'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;}
  if(saved) {
    if(saved.repo!==store.repo || saved.login!==login)throw new Error('Worker identity belongs to another repository/account; use a separate checkout');
    return saved;
  }
  const mailbox=new Mailbox(store,login);
  const identity=await mailbox.join({label:login+' development worker',task:'project development coordination'});
  saved={repo:store.repo,login,agentId:identity.id};
  await mkdir(fileURLToPath(new URL('./runtime/',import.meta.url)),{recursive:true});
  await writeFile(workerPath,JSON.stringify(saved,null,2)+'\n',{flag:'wx'});
  return saved;
}
if(process.argv[1]===fileURLToPath(import.meta.url)) {
  try {
    const name=process.argv[2];
    const store=new GitHubStore(process.env.AGENT_MAILBOX_REPO),login=await store.verify();
    const saved=await worker(store,login),mailbox=new Mailbox(store,login);
    let args={};
    if(process.argv[3]) {
      if(process.argv[3]!=='--input'||!process.argv[4]||process.argv.length!==5)throw new Error('Usage: node cli.mjs TOOL [--input JSON_FILE]');
      args=JSON.parse(await readFile(process.argv[4],'utf8'));
    }
    if(name==='worker_identity')console.log(JSON.stringify(saved));
    else {
      if(!['team_status','join_team'].includes(name))args.agent_id??=saved.agentId;
      console.log(JSON.stringify(await call(mailbox,name,args),null,2));
    }
  }catch(error){console.error(error.message);process.exitCode=1;}
}
