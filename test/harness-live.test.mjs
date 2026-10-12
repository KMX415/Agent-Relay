import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBroker,evaluateRules,runProvider,runLive,verifyLiveEvidence } from '../harness/live.mjs';
import { workerTools } from '../harness/worker-server.mjs';
import { createTeam } from '../harness/core.mjs';

test('live fixture evaluator checks normalization ordering without evaluating code',()=>{
  assert.equal(evaluateRules({trim:true,lowercase:true,dropEmpty:true,deduplicate:true}).passed,true);
  for (const key of ['trim','lowercase','dropEmpty','deduplicate']) {
    assert.equal(evaluateRules({...{trim:true,lowercase:true,dropEmpty:true,deduplicate:true},[key]:false}).passed,false);
  }
  assert.throws(()=>evaluateRules({trim:'process.exit()'}));
  assert.equal(workerTools.some(t=>t.name==='join_team'),false);
  assert.equal(workerTools.some(t=>t.inputSchema.properties.agent_id),false);
});

test('live broker binds capability to identity and isolates fixtures',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'relay-live-'));
  const calls=[];
  const team={workers:{a1:{directory:join(directory,'a1')},b1:{directory:join(directory,'b1')}},call:async(...args)=>{calls.push(args);return {ok:true};}};
  const broker=await createBroker(team);
  const invoke=(key,name,args={},token=broker.tokens[key])=>fetch(`http://127.0.0.1:${broker.port}/call`,{method:'POST',headers:{authorization:'Bearer '+token},body:JSON.stringify({name,args})});
  try {
    assert.equal((await invoke('a1','team_status',{},'wrong')).status,401);
    assert.equal((await invoke('a1','join_team')).status,400);
    assert.equal((await invoke('a1','check_inbox',{agent_id:'other'})).status,400);
    assert.equal((await invoke('a1','check_inbox')).status,200);
    assert.deepEqual(calls,[['a1','check_inbox',{}]]);
    assert.equal((await invoke('a1','write_fixture',{rules:{trim:true,lowercase:true,dropEmpty:true,deduplicate:true}})).status,200);
    assert.equal((await (await invoke('a1','test_fixture')).json()).passed,true);
    assert.equal((await invoke('b1','read_fixture')).status,400);
    assert.equal((await invoke('b1','read_fixture',{path:'../a1'})).status,400);
    assert.equal((await invoke('a1','send_message',{body:'x'.repeat(33000)})).status,413);
  } finally {await broker.close();await rm(directory,{recursive:true,force:true});}
});

test('provider absence and timeout return honest failed results',async()=>{
  assert.equal((await runProvider({command:'relay-nonexistent-provider',args:[],env:process.env,timeoutMs:1000})).ok,false);
  const result=await runProvider({command:process.execPath,args:['-e','setTimeout(()=>{},10000)'],env:process.env,timeoutMs:25});
  assert.equal(result.ok,false);assert.equal(result.reason,'timeout');assert.equal(result.usage,null);
});

test('six successful provider exits cannot substitute for observed collaboration',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'relay-live-idle-'));
  try {
    const team=await createTeam({directory});
    let sessions=0;
    const result=await runLive(team,{provider:async({args,env})=>{
      sessions++;
      assert.ok(args.includes('--strict-mcp-config'));
      assert.ok(!args.includes('--dangerously-skip-permissions'));
      assert.equal(env.RELAY_HARNESS_TOKEN.length,64);
      return {ok:true,elapsedMs:1,usage:null,output:'No actual tools used'};
    }});
    assert.equal(sessions,6);assert.equal(result.passed,false);assert.equal(result.activityVerified,false);assert.equal(result.skillPublished,false);
  } finally {await rm(directory,{recursive:true,force:true});}
});

test('live evidence requires linked acknowledged review and passing identical artifact tests',()=>{
  const team={workers:Object.fromEntries(['a1','a2','b1','b2','c1','c2'].map(key=>[key,{id:key}]))};
  const state={messages:[{id:'request',from:'a1',to:'b2',kind:'review_request',acknowledgedBy:['b2']},{from:'b2',to:'a1',kind:'answer',replyTo:'request'}],skills:[]};
  const audit=['a1','a2','b2','c2'].map(worker=>({worker,tool:'test_fixture',ok:true,passed:true,artifactDigest:'same'}));
  assert.equal(verifyLiveEvidence(team,state,audit).artifactReviewsVerified,true);
  assert.equal(verifyLiveEvidence(team,state,audit).linkedReviewVerified,true);
  audit[2].passed=false;
  assert.equal(verifyLiveEvidence(team,state,audit).artifactReviewsVerified,false);
  audit[2].passed=true;audit[2].artifactDigest='different';
  assert.equal(verifyLiveEvidence(team,state,audit).artifactReviewsVerified,false);
  state.messages[1].replyTo='unrelated';
  assert.equal(verifyLiveEvidence(team,state,audit).linkedReviewVerified,false);
  state.messages[1].replyTo='request';state.messages[0].acknowledgedBy=[];
  assert.equal(verifyLiveEvidence(team,state,audit).linkedReviewVerified,false);
});
