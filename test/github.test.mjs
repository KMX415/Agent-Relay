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
  store.api=async path=>path==='user'?{login:'owner'}:{private:true,permissions:{push:false}};
  await assert.rejects(store.verify(),/write access/);
});

test('integration credentials fail before initialization writes even when repository access exists',async()=>{
  const store=new GitHubStore('example/private');
  const calls=[];
  store.api=async(path,method='GET')=>{
    calls.push([path,method]);
    if(path==='user')throw Object.assign(new Error('Resource not accessible by integration (HTTP 403)'),{status:403});
    return {private:true,permissions:{push:false}};
  };
  await assert.rejects(store.initialize(),{code:'RELAY_USER_REQUIRED'});
  assert.deepEqual(calls,[['repos/example/private','GET'],['user','GET']]);
});

test('verification requires a login and confirmed write access without misclassifying other failures',async()=>{
  const store=new GitHubStore('example/private');
  for(const permissions of [undefined,{push:false},{push:'true'}]) {
    store.api=async path=>path==='user'?{login:'owner'}:{private:true,permissions};
    await assert.rejects(store.verify(),{code:'RELAY_WRITE_REQUIRED'});
  }
  for(const login of [undefined,'','owner/name']) {
    store.api=async path=>path==='user'?{login}:{private:true,permissions:{push:true}};
    await assert.rejects(store.verify(),{code:'RELAY_IDENTITY_INVALID'});
  }
  for(const status of [401,403,429]) {
    const failure=Object.assign(new Error('Other API failure'),{status});
    store.api=async path=>{if(path==='user')throw failure;return {private:true};};
    await assert.rejects(store.verify(),error=>error===failure);
  }
  store.api=async()=>({private:false});
  await assert.rejects(store.verify(),{code:'RELAY_PRIVATE_REQUIRED'});
});
