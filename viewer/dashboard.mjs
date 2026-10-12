const el=id=>document.getElementById(id);
const taskNodes=new Map(), agentNodes=new Map();
function text(tag,value,className) {
  const node=document.createElement(tag); node.textContent=value;
  if(className) node.className=className;
  return node;
}
const date=value=>value===null?'Not reported':new Date(value).toLocaleString();
const status=value=>value.replaceAll('_',' ');
function section(parent,title,items) {
  if (!items.length) return;
  parent.append(text('h3',title));
  const list=document.createElement('ul');
  for(const item of items) list.append(text('li',item));
  parent.append(list);
}
function makeTask(task) {
  const details=document.createElement('details'), summary=document.createElement('summary');
  const meta=text('span','','meta');
  const badge=text('span',status(task.status),'kind'); badge.dataset.status=task.status;
  meta.append(badge,text('span',task.kind));
  summary.append(meta,text('span',task.title,'route'),text('span',task.assigneeLabel,'excerpt'));
  const pending=task.dependencies.filter(d=>d.status!=='completed');
  if(pending.length) summary.append(text('span',pending.length+' unfinished dependencies','dependency-warning'));
  const latest=task.history.at(-1);
  if(latest) summary.append(text('span',latest.summary,'excerpt'));
  const full=text('div','','full');
  full.append(text('p',task.description,'body'));
  section(full,'Acceptance criteria',task.acceptance);
  section(full,'Paths',task.paths);
  section(full,'Required capabilities',task.requiredCapabilities);
  section(full,'Dependencies',task.dependencies.map(d=>d.title+' — '+status(d.status)));
  if(task.parentTaskId) full.append(text('p','Follow-up to '+task.parentTaskId+' · Depth '+task.chainDepth,'ids'));
  full.append(text('h3','Progress & handoffs'));
  if(!task.history.length) full.append(text('p','Awaiting acceptance. Assignment does not mean work has started.','excerpt'));
  for(const entry of task.history) {
    const event=text('article','','event');
    event.append(text('p',status(entry.action)+' · '+entry.actorLabel+' · '+date(entry.createdAt),'meta'),
      text('p',entry.summary,'body'));
    section(event,'Artifacts',entry.artifacts);
    section(event,'Next steps',entry.nextSteps);
    full.append(event);
  }
  if(task.status==='completed') full.append(text('p','Completion reported by the agent; this is not human approval.','excerpt'));
  full.append(text('p','Task '+task.id+'\nRevision '+task.revision+' · Created by '+task.creatorLabel+'\nUpdated '+date(task.updatedAt),'ids'));
  details.append(summary,full); return details;
}
function makeAgent(agent) {
  const details=document.createElement('details'), summary=document.createElement('summary'), p=agent.profile;
  const meta=text('span','','meta');
  meta.append(text('span',p.availability,'kind'),text('span',p.provider));
  summary.append(meta,text('span',agent.label,'route'),text('span',agent.owner,'excerpt'));
  const full=text('div','','full');
  section(full,'Capabilities',p.capabilities);
  section(full,'Reported path coverage',p.paths);
  full.append(text('p','Availability reported: '+date(p.reportedAt)+'\nExpires: '+date(p.availableUntil)+'\nLast mailbox activity: '+date(agent.seenAt),'ids'),
    text('p','Self-reported availability and capabilities. These do not prove live presence or access.','excerpt'),
    text('p',agent.id,'ids'));
  details.append(summary,full); return details;
}
function reconcile(container,records,nodes,make,filter) {
  const ids=new Set(records.map(r=>r.id));
  for(const [id,node] of nodes) if(!ids.has(id)){node.remove();nodes.delete(id);}
  let shown=0;
  records.forEach((record,index)=>{
    let node=nodes.get(record.id), signature=JSON.stringify(record);
    if(!node||node.dataset.signature!==signature) {
      const replacement=make(record); replacement.open=node?.open??false; replacement.dataset.signature=signature;
      if(node) node.replaceWith(replacement);
      node=replacement;nodes.set(record.id,node);
    }
    const current=container.children[index];if(current!==node)container.insertBefore(node,current??null);
    node.hidden=!filter(record);if(!node.hidden)shown++;
  });
  return shown;
}
export function renderDashboard(data,view,query) {
  const owner=el('task-owner'), previous=owner.value;
  const signature=JSON.stringify(data.agents.map(a=>[a.id,a.label]));
  if(owner.dataset.signature!==signature) {
    owner.replaceChildren(new Option('All agents',''),new Option('Unassigned','unassigned'),
      ...data.agents.map(a=>new Option(a.label+' ('+a.owner+')',a.id)));
    owner.value=[...owner.options].some(o=>o.value===previous)?previous:'';
    owner.dataset.signature=signature;
  }
  el('overview').replaceChildren(...Object.entries(data.counts).map(([key,value])=>{
    const node=text('div','','metric');
    node.append(text('strong',String(value)),text('span',status(key)));return node;
  }));
  const matches=record=>JSON.stringify(record).toLocaleLowerCase().includes(query);
  const tasks=[...data.tasks].sort((a,b)=>b.updatedAt-a.updatedAt);
  const taskCount=reconcile(el('tasks'),tasks,taskNodes,makeTask,t=>
    (!el('task-status').value||t.status===el('task-status').value) &&
    (!owner.value||(owner.value==='unassigned'?t.assigneeId===null:t.assigneeId===owner.value)) && matches(t));
  const agentCount=reconcile(el('agents'),data.agents,agentNodes,makeAgent,matches);
  const count=view==='tasks'?taskCount:agentCount, total=view==='tasks'?tasks.length:data.agents.length;
  return {count,total};
}
