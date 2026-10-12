// Synthetic in-memory workspace. Never reads GitHub, credentials, or runtime state.
import { Mailbox } from './mailbox.mjs';
import { emptyState } from './github.mjs';
import { listenViewer } from './viewer.mjs';

const store={repo:'demo/agent-relay (synthetic data)',state:emptyState(),
  async read(){return {state:structuredClone(this.state),sha:'demo'};},
  async write(state){this.state=structuredClone(state);}};
let clock=Date.now()-40*60000;
const mailbox=new Mailbox(store,'demo',()=>clock+=60000);
const builder=await mailbox.join({label:'Implementation agent',task:'Shared tasks'});
const reviewer=await mailbox.join({label:'Review agent',task:'Acceptance checks'});
for(const [agent,provider,capabilities] of [[builder,'codex',['javascript','testing']],[reviewer,'claude',['review','documentation']]]) {
  await mailbox.updateAgent({agent_id:agent.id,expected_revision:0,provider,capabilities,paths:['src','docs'],lease_minutes:120});
}
const create=(title,assignee,extra={})=>mailbox.createTask({agent_id:builder.id,title,
  description:'Synthetic example showing how agents coordinate work through Agent Relay.',
  acceptance:['Changes are reviewed','Relevant tests pass'],assignee_id:assignee,
  request_id:title,paths:['src'],...extra});
const update=(task,action,summary,extra={})=>mailbox.updateTask({agent_id:task.assigneeId,task_id:task.id,
  expected_revision:task.revision,request_id:action+'-'+task.revision,action,summary,...extra});
let docs=await create('Document the task workflow',reviewer.id,{kind:'documentation',paths:['docs']});
docs=await update(docs,'accept','Writing the command examples.');
await update(docs,'complete','Examples reviewed; documentation acceptance checks passed.',{artifacts:['docs/SHARED-TASKS.md']});
let handoff=await create('Review the task lifecycle',builder.id);
handoff=await update(handoff,'accept','Implementing lifecycle transitions.');
handoff=await update(handoff,'handoff','Transitions implemented. Ready for independent review.',{
  assignee_id:reviewer.id,artifacts:['branch: feature/shared-tasks'],next_steps:['Review concurrent acceptance','Check retry behavior']});
let running=await create('Add agent capability discovery',builder.id,{depends_on:[docs.id],required_capabilities:['javascript']});
running=await update(running,'accept','Adding profile filters and expiry checks.');
await update(running,'progress','Capability matching works; adding concurrency coverage.',{next_steps:['Run full tests','Request review']});
let blocked=await create('Choose the default autonomy scope',reviewer.id,{kind:'research'});
blocked=await update(blocked,'accept','Inspecting the project scope.');
await update(blocked,'block','Waiting for the owner to choose allowed task categories.',{next_steps:['Confirm scope with the owner']});
await create('Exercise the end-to-end handoff',undefined,{kind:'testing',depends_on:[handoff.id]});
await mailbox.send({agent_id:builder.id,to:reviewer.id,kind:'handoff',body:'The task lifecycle is ready for review. The task record includes the branch and remaining checks.',request_id:'demo-message'});
const server=await listenViewer({store,port:4317});
console.log('Synthetic Agent Relay demo: http://127.0.0.1:'+server.address().port);
