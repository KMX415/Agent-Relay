import { randomUUID } from 'node:crypto';
import { taskKinds, relativePath, eligibility } from './coordination.mjs';
import { assertTaskReviewAction } from './review-cycles.mjs';

export const taskStatuses = ['ready', 'in_progress', 'blocked', 'completed', 'cancelled'];
const text = (value, name, max = 4000) => {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error(`Invalid ${name}`);
  return value.trim();
};
const list = (value, name) => {
  if (!Array.isArray(value) || value.length > 30) throw new Error(`Invalid ${name}`);
  return [...new Set(value.map(v => text(v, name, 500)))];
};
const records = state => state.tasks ??= [];
const known = (state, id) => {
  if (!Object.hasOwn(state.agents, id)) throw new Error('Assignee must be an exact registered agent ID');
};

export async function createTask({agent_id, title, description, acceptance, assignee_id, depends_on = [], request_id,
  kind='implementation', paths=[], required_capabilities=[], parent_task_id}) {
  title = text(title, 'title', 200); description = text(description, 'description');
  acceptance = list(acceptance, 'acceptance');
  if (!acceptance.length) throw new Error('Specify acceptance criteria');
  depends_on = list(depends_on, 'dependencies'); request_id = text(request_id, 'request_id', 120);
  if (!taskKinds.includes(kind)) throw new Error('Invalid task category');
  paths=list(paths,'paths').map(relativePath);
  required_capabilities=list(required_capabilities,'capabilities').map(c=>c.toLowerCase());
  const payload = {title, description, acceptance, assigneeId:assignee_id ?? null, dependsOn:depends_on,
    kind,paths,requiredCapabilities:[...new Set(required_capabilities)],parentTaskId:parent_task_id??null};
  const policy=await this.readPolicy();
  const fingerprint = JSON.stringify(payload), id = randomUUID();
  return this.change(state => {
    const actor = this.actor(state, agent_id), tasks = records(state);
    const old = tasks.find(t => t.createdBy === agent_id && t.requestId === request_id);
    if (old) {
      if (old.fingerprint !== fingerprint) throw new Error('request_id already used for different content');
      return old;
    }
    if (tasks.length >= 500) throw new Error('Task registry full; archive deliberately before continuing');
    if (assignee_id !== undefined) known(state, assignee_id);
    if (depends_on.some(dep => !tasks.some(t => t.id === dep))) throw new Error('Unknown dependency');
    const parent=parent_task_id ? tasks.find(t=>t.id===parent_task_id) : null;
    if (parent_task_id && !parent) throw new Error('Parent task not found');
    const chainDepth=parent?(parent.chainDepth??0)+1:0;
    if (policy && chainDepth>policy.max_chain_depth) throw new Error('Task chain depth exceeds policy; ask the user');
    const now = this.now();
    const task = {id, ...payload, createdBy:agent_id, requestId:request_id, fingerprint,
      status:'ready', revision:1, createdAt:now, updatedAt:now, chainDepth,handoffCount:0,history:[]};
    tasks.push(task); actor.seenAt = now; return task;
  });
}

export async function listTasks({agent_id, assignee_id, status, after = 0, limit = 30}) {
  const {state} = await this.store.read(); this.actor(state, agent_id);
  if (status !== undefined && !taskStatuses.includes(status)) throw new Error('Invalid task status');
  if (!Number.isInteger(after) || after < 0 || !Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('Invalid task pagination');
  const tasks = (state.tasks ?? []).filter(t => (!assignee_id || t.assigneeId === assignee_id) && (!status || t.status === status));
  const page = tasks.slice(after, after + limit).map(({history, fingerprint, ...task}) => task);
  return {tasks:page, nextAfter:after + page.length, hasMore:after + page.length < tasks.length};
}

export async function getTask({agent_id, task_id}) {
  const {state} = await this.store.read(); this.actor(state, agent_id);
  const task = (state.tasks ?? []).find(t => t.id === task_id);
  if (!task) throw new Error('Task not found');
  return task;
}

export async function updateTask({agent_id, task_id, expected_revision, request_id, action, summary, assignee_id, artifacts = [], next_steps = []}) {
  request_id = text(request_id, 'request_id', 120); summary = text(summary, 'summary');
  artifacts = list(artifacts, 'artifacts'); next_steps = list(next_steps, 'next_steps');
  if (!['assign', 'accept', 'progress', 'block', 'resume', 'handoff', 'complete', 'cancel'].includes(action)) throw new Error('Invalid task action');
  if (!Number.isInteger(expected_revision) || expected_revision < 1) throw new Error('Invalid expected_revision');
  if (!['assign','handoff'].includes(action) && assignee_id !== undefined) throw new Error('Assignee only allowed for assign or handoff');
  const fingerprint = JSON.stringify({expected_revision, action, summary, assignee_id, artifacts, next_steps});
  const policy=['accept','resume','handoff'].includes(action)?await this.readPolicy():null;
  return this.change(state => {
    const actor = this.actor(state, agent_id), tasks = records(state), task = tasks.find(t => t.id === task_id);
    if (!task) throw new Error('Task not found');
    const old = task.history.find(h => h.actorId === agent_id && h.requestId === request_id);
    if (old) {
      if (old.fingerprint !== fingerprint) throw new Error('request_id already used for different content');
      return task;
    }
    if (task.revision !== expected_revision) throw new Error('Task revision changed; read task before updating');
    assertTaskReviewAction(state,task,action);
    if (['completed','cancelled'].includes(task.status)) throw new Error('Task is terminal');
    if (task.history.length >= 100) throw new Error('Task history full; archive deliberately before continuing');
    const owner = task.assigneeId === agent_id, creator = task.createdBy === agent_id;
    if (action === 'assign') {
      if (!creator || task.status !== 'ready') throw new Error('Only creator can assign a ready task');
      known(state, assignee_id); task.assigneeId = assignee_id;
    } else if (action === 'cancel') {
      if (!creator) throw new Error('Only creator can cancel task');
      task.status = 'cancelled';
    } else {
      if (!owner && !(action === 'accept' && task.assigneeId === null)) throw new Error('Only assigned agent can perform this action');
      const allowed = {accept:['ready'], progress:['in_progress','blocked'], block:['in_progress'], resume:['blocked'], handoff:['in_progress','blocked'], complete:['in_progress']};
      if (!allowed[action].includes(task.status)) throw new Error('Invalid task transition');
      if (['accept','resume'].includes(action)) {
        const decision=eligibility(state,actor,task,policy,this.now());
        if (!decision.allowed) throw new Error(decision.reasons.join('; '));
      }
      if (['accept','resume','complete'].includes(action) && task.dependsOn.some(id => tasks.find(t => t.id === id)?.status !== 'completed')) throw new Error('Dependencies must be completed');
      if (action === 'handoff') {
        if (policy && (task.handoffCount??0)+1>policy.max_handoffs) throw new Error('Handoff count exceeds policy; ask the user');
        known(state, assignee_id);
        if (assignee_id === agent_id || !next_steps.length) throw new Error('Handoff needs another agent and next steps');
        task.assigneeId = assignee_id; task.status = 'ready'; task.handoffCount=(task.handoffCount??0)+1;
      } else if (action === 'accept') { task.assigneeId = agent_id; task.status = 'in_progress'; task.startedAt??=this.now(); }
      else if (action === 'resume') task.status = 'in_progress';
      else if (action === 'block') task.status = 'blocked';
      else if (action === 'complete') task.status = 'completed';
    }
    if (['accept','assign','handoff','cancel','complete'].includes(action)) delete task.routing;
    const now = this.now(); task.revision++; task.updatedAt = now; actor.seenAt = now;
    task.history.push({revision:task.revision, actorId:agent_id, requestId:request_id, fingerprint,
      action, summary, artifacts, nextSteps:next_steps, assigneeId:task.assigneeId, status:task.status, createdAt:now});
    return task;
  });
}
