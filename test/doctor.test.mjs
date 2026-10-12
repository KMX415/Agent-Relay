import test from 'node:test';
import assert from 'node:assert/strict';
import { diagnose } from '../doctor.mjs';
import { emptyState } from '../github.mjs';
test('doctor reports missing configuration and dependencies without raw error disclosure',async()=>{
  const result=await diagnose({execute:async()=>{throw new Error('SECRET');},makeStore:()=>{throw new Error('SECRET');},nodeVersion:'20.0.0'});
  assert.equal(result.ok,false);assert.equal(result.checks.length,4);
  assert.doesNotMatch(JSON.stringify(result),/SECRET/);
});
test('doctor validates saved identity and reads health without changing state or creating workers',async()=>{
  const state=emptyState();state.agents.a={id:'a',owner:'owner',label:'Agent',seenAt:Date.now()};
  const store={repo:'owner/box',verify:async()=>'owner',read:async()=>({state:structuredClone(state)})};
  const result=await diagnose({execute:async()=>'',makeStore:()=>store,readIdentity:async()=>JSON.stringify({repo:store.repo,login:'owner',agentId:'a'}),readPolicy:()=>async()=>null});
  assert.equal(result.ok,true);assert.ok(result.team);assert.equal(Object.keys(state.agents).length,1);
  const wrong=await diagnose({execute:async()=>'',makeStore:()=>store,readIdentity:async()=>JSON.stringify({repo:'other/box',login:'owner',agentId:'a'})});
  assert.equal(wrong.ok,false);assert.equal(wrong.team,null);
});
