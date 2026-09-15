import test from 'node:test';
import assert from 'node:assert/strict';
import { GitHubStore, emptyState } from '../github.mjs';

test('a repository made public stops reads before mailbox contents are fetched', async()=>{
  const store=new GitHubStore('example/private');
  const calls=[];
  store.api=async path=>{calls.push(path);return {private:false};};
  await assert.rejects(store.read(),/no longer private/);
  assert.equal(calls.length,1);
});

test('writes preserve the branch and expected SHA; oversized writes never reach GitHub',async()=>{
  const store=new GitHubStore('example/private');
  const calls=[];
  store.api=async(...args)=>{calls.push(args);return {};};
  await store.write(emptyState(),'expected-sha');
  assert.equal(calls[0][1],'PUT');
  assert.equal(calls[0][2].sha,'expected-sha');
  assert.equal(calls[0][2].branch,'dev-agent-mailbox');
  assert.deepEqual(JSON.parse(Buffer.from(calls[0][2].content,'base64')),emptyState());
  await assert.rejects(store.write({data:'x'.repeat(750001)},'sha'),/Mailbox full/);
  assert.equal(calls.length,1);
});

test('initialization preserves an existing mailbox and checks write permission',async()=>{
  const store=new GitHubStore('example/private');
  store.api=async path=>path==='user'?{login:'owner'}:{private:true,permissions:{push:true}};
  store.read=async()=>({state:emptyState(),sha:'existing'});
  assert.deepEqual(await store.initialize(),{created:false});
  store.api=async()=>({private:true,permissions:{push:false}});
  await assert.rejects(store.verify(),/write access/);
});
