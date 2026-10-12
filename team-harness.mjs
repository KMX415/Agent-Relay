import { mkdir, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createTeam } from './harness/core.mjs';
import { runScenarios } from './harness/scenarios.mjs';

// This entry point never selects the configured GitHub mailbox or saved worker.
export async function runHarness({live=false,directory}={}) {
  const started=Date.now();
  directory??=fileURLToPath(new URL('./runtime/team-harness/'+randomUUID()+'/',import.meta.url));
  await mkdir(directory,{recursive:true});
  const team=await createTeam({directory:path.join(directory,'scripted')});
  const scripted=await runScenarios(team);
  let liveResult=null;
  if(live) {
    const {runLive}=await import('./harness/live.mjs');
    const liveTeam=await createTeam({directory:path.join(directory,'live')});
    try {liveResult=await runLive(liveTeam);}
    catch(error) {liveResult={status:'failed',error:String(error.message).slice(0,1000)};}
  }
  const report={version:1,startedAt:new Date(started).toISOString(),finishedAt:new Date().toISOString(),elapsedMs:Date.now()-started,
    contributors:3,workers:6,maxConcurrency:3,
    evidenceBoundary:'Contributor accounts and permissions are simulated. This does not validate independent humans, GitHub credentials, OS isolation, or provider diversity. Scripted workers are not model sessions.',
    scripted,live:liveResult};
  await writeFile(path.join(directory,'report.json'),JSON.stringify(report,null,2)+'\n',{flag:'wx'});
  return {directory,report};
}

if(process.argv[1]===fileURLToPath(import.meta.url)) {
  const args=process.argv.slice(2);
  if(args.length===1&&args[0]==='--help') console.log('Usage: node team-harness.mjs [--live]\nDefault: deterministic local scenarios with six scripted workers. --live additionally invokes six real Claude sessions using existing local authentication. Reports and synthetic state stay under ignored runtime/team-harness/.');
  else if(args.some(arg=>arg!=='--live')||args.length>1) {console.error('Usage: node team-harness.mjs [--live]');process.exitCode=1;}
  else {
    try {
      const result=await runHarness({live:args.includes('--live')});
      console.log(JSON.stringify(result,null,2));
      if(result.report.scripted.status==='failed'||result.report.scripted.scenarios?.some(s=>s.status==='failed')||(result.report.live&&result.report.live.status!=='passed'))process.exitCode=1;
    }catch(error){console.error('Team harness failed: '+String(error.message).slice(0,1000));process.exitCode=1;}
  }
}
