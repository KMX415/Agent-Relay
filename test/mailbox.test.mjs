import test from 'node:test';
import assert from 'node:assert/strict';
import { Mailbox, normalizedPath } from '../mailbox.mjs';
import { emptyState } from '../github.mjs';
import { call } from '../tools.mjs';
class MemoryStore {
  state=emptyState();revision=0;
  async read(){return {state:structuredClone(this.state),sha:String(this.revision)};}
  async write(state,sha){if(sha!==String(this.revision))throw Object.assign(new Error('Conflict'),{status:409});this.state=structuredClone(state);this.revision++;}
}
async function setup(){
  const store=new MemoryStore();let time=100000;
  const alice=new Mailbox(store,'alice',()=>time),bob=new Mailbox(store,'bob',()=>time);
  const a=await alice.join({label:'Alice',task:'Renderer'}),b=await bob.join({label:'Bob',task:'Hardware'});
  return {store,alice,bob,a,b,advance:()=>time+=121*60000};
}
test('addressed delivery, explicit acknowledgements, and owner enforcement',async()=>{
  const {alice,bob,a,b}=await setup();
  const m=await alice.send({agent_id:a.id,to:'bob',body:'Can you review?',kind:'question',request_id:'q1'});
  assert.equal((await bob.inbox({agent_id:b.id})).messages[0].id,m.id);
  assert.equal((await bob.inbox({agent_id:b.id})).messages.length,1);
  await assert.rejects(alice.acknowledge({agent_id:b.id,message_id:m.id}),/identity/);
  await bob.acknowledge({agent_id:b.id,message_id:m.id});
  assert.equal((await bob.inbox({agent_id:b.id})).messages.length,0);
  assert.equal((await bob.inbox({agent_id:b.id,unread_only:false})).messages.length,1);
});
test('concurrent sends preserve both messages and retry keys do not duplicate',async()=>{
  const {alice,bob,a,b,store}=await setup();
  const input={agent_id:a.id,to:b.id,body:'Review',request_id:'stable'};
  const [m]=await Promise.all([alice.send(input),bob.send({agent_id:b.id,to:a.id,body:'Question',request_id:'b'})]);
  assert.equal(store.state.messages.length,2);
  assert.equal((await alice.send(input)).id,m.id);
  assert.equal(store.state.messages.length,2);
  await assert.rejects(alice.send({...input,body:'Different'}),/different content/);
});
test('concurrent overlapping claims have one winner; unrelated paths can coexist',async()=>{
  const {alice,bob,a,b}=await setup();
  const claim={task:'Fix',branch:'feature/fix'};
  const results=await Promise.all([alice.claim({...claim,agent_id:a.id,paths:['Firmware/src']}),bob.claim({...claim,agent_id:b.id,paths:['firmware\\src\\main.cpp']})]);
  assert.equal(results.filter(r=>r.claimed).length,1);
  assert.equal(results.filter(r=>!r.claimed)[0].conflicts.length,1);
  await bob.claim({...claim,agent_id:b.id,paths:['docs']});
  assert.equal((await alice.status()).claims.length,2);
});
test('claims expire, release is owner-only, and directory prefixes are bounded',async()=>{
  const {alice,bob,a,b,advance}=await setup();
  const input={task:'Fix',branch:'feature/fix',paths:['firmware/src']};
  await alice.claim({...input,agent_id:a.id});
  assert.equal((await bob.claim({...input,agent_id:b.id,paths:['firmware/src-other']})).claimed,true);
  await assert.rejects(bob.release({agent_id:a.id}),/identity/);
  advance();assert.equal((await alice.status()).claims.length,0);
  assert.equal((await bob.claim({...input,agent_id:b.id})).claimed,true);
  await bob.release({agent_id:b.id});assert.equal((await bob.status()).claims.length,0);
});
test('path traversal, invalid fields, and unknown recipients are rejected',async()=>{
  for(const p of ['../x','/tmp','C:\\foo','src/*','src/../x','src//x',''])assert.throws(()=>normalizedPath(p));
  const {alice,a}=await setup();
  await assert.rejects(alice.send({agent_id:a.id,to:'missing',body:'x',request_id:'1'}),/not joined/);
  await assert.rejects(call(alice,'check_inbox',{agent_id:a.id,unread_only:'false'}),/Invalid/);
  await assert.rejects(call(alice,'team_status',{execute:'bad'}),/Unknown argument/);
});
test('inbox pagination preserves unread messages and broadcast does not echo to sender',async()=>{
  const {alice,bob,a,b}=await setup();
  for(let i=0;i<3;i++)await alice.send({agent_id:a.id,to:'team',body:'Update '+i,request_id:String(i)});
  const first=await bob.inbox({agent_id:b.id,limit:2});assert.equal(first.messages.length,2);assert.equal(first.hasMore,true);
  const last=await bob.inbox({agent_id:b.id,after:first.nextAfter});assert.equal(last.messages.length,1);
  assert.equal((await alice.inbox({agent_id:a.id})).messages.length,0);
});
test('reply chains are bounded to prevent endless autonomous conversation',async()=>{
  const {alice,bob,a,b}=await setup();
  let m=await alice.send({agent_id:a.id,to:b.id,body:'Question',kind:'question',request_id:'0'});
  for(let i=1;i<=4;i++){
    const sender=i%2?bob:alice,from=i%2?b:a,to=i%2?a:b;
    m=await sender.send({agent_id:from.id,to:to.id,body:'Reply',kind:'answer',reply_to:m.id,request_id:String(i)});
  }
  await assert.rejects(bob.send({agent_id:b.id,to:a.id,body:'Again',reply_to:m.id,request_id:'5'}),/four reply hops/);
});
