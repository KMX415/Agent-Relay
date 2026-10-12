import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runDurable, replayOutbox } from '../outbox.mjs';
import { GitHubStore, emptyState } from '../github.mjs';

test('decision outbox retains exact uncertain payloads and separates target identities',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'relay-decision-outbox-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  const args={agent_id:'worker',expected_revision:1,option_id:'one',rationale:'Observed evidence',authorization_evidence:['Authorized scope'],request_id:'answer'};
  for(const decision_id of ['one','two'])await assert.rejects(runDurable({directory,tool:'resolve_decision',args:{...args,decision_id},invoke:async()=>{throw new Error('Unknown outcome');}}));
  const seen=[];await replayOutbox({directory,agentId:'worker',invoke:async(name,input)=>seen.push({name,input})});
  assert.deepEqual(seen.map(x=>x.input.decision_id).sort(),['one','two']);
  for(const {name,input} of seen){assert.equal(name,'resolve_decision');assert.deepEqual(input,{...args,decision_id:input.decision_id});}
  assert.deepEqual((await replayOutbox({directory,agentId:'worker',invoke:async()=>assert.fail('duplicate')})).operations,[]);
});

test('mailbox rejects malformed optional decision collection',async()=>{
  const store=new GitHubStore('fixture/mailbox');
  store.api=async path=>path==='repos/fixture/mailbox'?{private:true}:{encoding:'base64',size:100,content:Buffer.from(JSON.stringify({...emptyState(),decisions:{}})).toString('base64')};
  await assert.rejects(store.read(),/schema/);
});
