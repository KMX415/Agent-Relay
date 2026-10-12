import test from 'node:test';
import assert from 'node:assert/strict';
import { GitHubStore, emptyState, STORAGE_BRANCH } from '../github.mjs';

const http=status=>Object.assign(new Error('HTTP '+status),{status});
function fixture({size=0,branches=[],tags=[],commitsError=409,readError=409,seedRace=false,privacy=true,treeRequiresSeed=false}={}) {
  const store=new GitHubStore('owner/box'),calls=[];let seeded=false,mailbox=false;
  store.api=async(url,method='GET',body)=>{
    calls.push({url,method,body});
    if(url==='user')return {login:'owner'};
    if(url==='repos/owner/box')return {private:privacy,permissions:{push:true},size,default_branch:'main'};
    if(url.includes('/contents/mailbox.json')) {
      if(!mailbox)throw http(readError);
      return {encoding:'base64',size:100,sha:'mailbox',content:Buffer.from(JSON.stringify(emptyState())).toString('base64')};
    }
    if(url.includes('/branches?'))return seeded?[{name:'main'}]:branches;
    if(url.includes('/tags?'))return tags;
    if(url.includes('/commits?')) {if(commitsError)throw http(commitsError);return [{sha:'existing'}];}
    if(url.endsWith('/contents/README.md')) {seeded=true;if(seedRace)throw http(422);return {commit:{sha:'seed'}};}
    if(url.endsWith('/git/trees')) {if(treeRequiresSeed&&!seeded)throw http(409);return {sha:'tree'};}
    if(url.endsWith('/git/commits'))return {sha:'orphan'};
    if(url.endsWith('/git/refs')) {mailbox=true;return {};}
    throw new Error('Unexpected call '+url);
  };
  return {store,calls};
}

test('explicit initialization bootstraps a proven empty private repository then creates orphan mailbox',async()=>{
  const {store,calls}=fixture();
  assert.deepEqual(await store.initialize(),{created:true});
  const seed=calls.find(c=>c.method==='PUT');
  assert.equal(seed.url,'repos/owner/box/contents/README.md');assert.equal(seed.body.branch,'main');assert.equal(seed.body.sha,undefined);
  const content=Buffer.from(seed.body.content,'base64').toString();assert.doesNotMatch(content,/agents|messages|credentials/);
  const commit=calls.find(c=>c.url.endsWith('/git/commits'));
  assert.deepEqual(commit.body.parents,[]);
  assert.deepEqual(calls.find(c=>c.url.endsWith('/git/refs')).body,{ref:'refs/heads/'+STORAGE_BRANCH,sha:'orphan'});
  const count=calls.filter(c=>c.method!=='GET').length;
  assert.deepEqual(await store.initialize(),{created:false});assert.equal(calls.filter(c=>c.method!=='GET').length,count);
});
test('409 from a nonempty or uncertain repository never seeds or mutates it',async()=>{
  for(const options of [{size:1},{branches:[{name:'other'}]},{tags:[{name:'v1'}]},{commitsError:0},{commitsError:403}]) {
    const {store,calls}=fixture(options);await assert.rejects(store.initialize());
    assert.equal(calls.filter(c=>c.method!=='GET').length,0);
  }
});
test('missing Contents ref404 followed by empty Git tree409 bootstraps and retries once',async()=>{
  const {store,calls}=fixture({readError:404,treeRequiresSeed:true});
  assert.deepEqual(await store.initialize(),{created:true});
  assert.equal(calls.filter(c=>c.url.endsWith('/git/trees')).length,2);
  assert.equal(calls.filter(c=>c.method==='PUT').length,1);
  assert.deepEqual(calls.find(c=>c.url.endsWith('/git/commits')).body.parents,[]);
});
test('ordinary missing mailbox creates orphan without seeding default branch; read alone never seeds',async()=>{
  const {store,calls}=fixture({readError:404,size:15,branches:[{name:'main'}]});
  assert.deepEqual(await store.initialize(),{created:true});assert.equal(calls.some(c=>c.method==='PUT'),false);
  const empty=fixture();await assert.rejects(empty.store.read());assert.equal(empty.calls.some(c=>c.method!=='GET'),false);
});
test('concurrent seed create collision preserves existing contents and continues without update',async()=>{
  const {store,calls}=fixture({seedRace:true});assert.deepEqual(await store.initialize(),{created:true});
  assert.equal(calls.filter(c=>c.method==='PUT').length,1);assert.equal(calls.some(c=>c.method==='PATCH'||c.method==='DELETE'),false);
});
test('public repositories cannot initialize',async()=>{
  const {store,calls}=fixture({privacy:false});await assert.rejects(store.initialize(),/PRIVATE/);assert.equal(calls.some(c=>c.method!=='GET'),false);
});
