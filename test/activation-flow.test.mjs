import test from 'node:test';
import assert from 'node:assert/strict';
import { Mailbox } from '../mailbox.mjs';
import { emptyState } from '../github.mjs';
import { call, tools } from '../tools.mjs';

class Store {
  state=emptyState(); revision=0;
  async read() { return {state:structuredClone(this.state),sha:this.revision}; }
  async write(state,sha) {
    if (sha!==this.revision) throw Object.assign(new Error('Conflict'),{status:409});
    this.state=structuredClone(state); this.revision++;
  }
}

test('public dispatcher plans a work segment, retains results until delivery, then surfaces a new decision',async()=>{
  const store=new Store(), now=100000000;
  const policy={allowed_kinds:['implementation'],allowed_paths:['src'],allow_unassigned:false,
    max_active_tasks:2,max_chain_depth:2,max_handoffs:3,max_task_minutes:60,expires_at:new Date(now+3600000).toISOString()};
  const mailbox=new Mailbox(store,'builder',()=>now,async()=>policy);
  const agent=(await call(mailbox,'join_team',{label:'Builder',task:'Headless acceptance fixture'})).id;
  const invoke=(name,args={})=>call(mailbox,name,{agent_id:agent,...args});
  const create=key=>invoke('create_task',{title:key,description:'Implement a scoped change',acceptance:['Tests pass'],
    assignee_id:agent,paths:['src'],kind:'implementation',request_id:key});
  const update=(task,action,summary)=>invoke('update_task',{task_id:task.id,expected_revision:task.revision,
    action,summary,request_id:`${task.id}-${action}-${task.revision}`});

  let task=await create('First change');
  let plan=await invoke('next_actions');
  assert.equal(plan.actions[0].kind,'accept_task');
  assert.equal(plan.actions[0].eligibility.allowed,true);
  assert.equal((await call(mailbox,plan.actions[0].inspect.tool,plan.actions[0].inspect.args)).id,task.id);
  task=await update(task,'accept','Working within approved src scope');
  await invoke('save_checkpoint',{task_id:task.id,expected_revision:0,expected_task_revision:task.revision,
    request_id:'saved-progress',summary:'Implementation prepared',next_steps:['Run tests and verify acceptance'],artifacts:['branch/first-change']});
  const beforeReads=store.revision;
  const firstPage=await invoke('next_actions',{limit:1});
  assert.equal(firstPage.actions[0].kind,'recover_checkpoint');
  assert.equal(firstPage.hasMore,true);
  plan=await invoke('next_actions',{after:firstPage.nextAfter,limit:1});
  assert.equal(plan.actions[0].kind,'continue_task','pagination reaches work beyond persistent recovery suggestions');
  assert.equal(store.revision,beforeReads,'planning does not mutate shared state');

  task=await update(task,'complete','Tests passed; change is ready for human review');
  const first=await invoke('list_notifications'), afterCompletion=store.revision;
  assert.equal(first.notifications.length,1);
  assert.equal(first.notifications[0].kind,'task_completed');
  assert.deepEqual(await invoke('list_notifications'),first);
  assert.equal(store.revision,afterCompletion,'reading does not mark delivery');
  assert.equal((await invoke('next_actions')).actions.length,0,'completed work and its historical checkpoint are absent');
  // A caller records this receipt only after its authorized host channel delivered it.
  await invoke('acknowledge_notification',{notification_id:first.notifications[0].id});
  const deliveredRevision=store.revision;
  await invoke('acknowledge_notification',{notification_id:first.notifications[0].id});
  assert.equal(store.revision,deliveredRevision,'uncertain receipt retry is idempotent');
  assert.deepEqual((await invoke('list_notifications')).notifications,[]);

  let followup=await create('Second change');
  followup=await update(followup,'accept','Starting the next authorized change');
  followup=await update(followup,'block','Need the agreed acceptance fixture');
  const blocked=await invoke('list_notifications');
  assert.equal(blocked.notifications.length,1);
  assert.equal(blocked.notifications[0].kind,'task_blocked');
  assert.notEqual(blocked.notifications[0].id,first.notifications[0].id);
  assert.equal(blocked.notifications[0].summary,'Need the agreed acceptance fixture');
  const blockedPlan=await invoke('next_actions');
  assert.equal(blockedPlan.actions[0].kind,'reassess_blocker');
  assert.equal(blockedPlan.actions[0].status,'blocked');
  await invoke('acknowledge_notification',{notification_id:blocked.notifications[0].id});
  followup=await update(followup,'progress','Still awaiting the same fixture');
  assert.deepEqual((await invoke('list_notifications')).notifications,[],'routine progress does not repeat a delivered blocker');
  followup=await update(followup,'resume','Fixture arrived');
  await update(followup,'block','The new fixture needs a separate ownership decision');
  const renewed=await invoke('list_notifications');
  assert.equal(renewed.notifications.length,1);
  assert.notEqual(renewed.notifications[0].id,blocked.notifications[0].id,'a new blocker episode is a new notification');
  assert.equal(store.state.messages.length,0,'the flow never sends unsolicited agent messages');
});

test('public tool metadata and dispatcher distinguish planning reads from receipt writes',async()=>{
  for (const name of ['next_actions','list_notifications','acknowledge_notification']) {
    const matches=tools.filter(tool=>tool.name===name);
    assert.equal(matches.length,1,name);
    assert.equal(matches[0].annotations.readOnlyHint,name!=='acknowledge_notification',name);
    assert.equal(matches[0].inputSchema.additionalProperties,false);
    assert.ok(matches[0].inputSchema.required.includes('agent_id'));
  }
  const mailbox=new Mailbox(new Store(),'builder');
  const agent=(await call(mailbox,'join_team',{label:'Builder',task:'Schema fixture'})).id;
  await assert.rejects(call(mailbox,'next_actions',{agent_id:agent,execute:true}),/Unknown argument/);
  await assert.rejects(call(mailbox,'list_notifications',{agent_id:agent,limit:0}),/limit/);
  await assert.rejects(call(mailbox,'acknowledge_notification',{agent_id:agent,notification_id:'not-an-event'}),/notification_id/);
});
