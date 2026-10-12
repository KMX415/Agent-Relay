import { createHash } from 'node:crypto';

const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const active = task => ['ready', 'in_progress', 'blocked'].includes(task.status);
const related = (task, agentId) => task.createdBy === agentId || task.assigneeId === agentId || task.routing?.requestedBy === agentId;
const lastAction = (task, actions) => task.history?.findLast(entry => actions.includes(entry.action));
const receiptLimit = 5000;

// Derive current meaningful conditions, not a second event log. Polling never writes.
export function notificationEvents(state, agentId, now) {
  const events = [];
  const add = (kind, source, episode, fields) => {
    const sourceKey = `${kind}:${source}`;
    events.push({ id: digest({ agentId, sourceKey, episode }), kind, sourceKey, ...fields });
  };
  for(const goal of state.goals??[]) {
    if(!goal.participants.includes(agentId))continue;
    const expired=goal.status==='active'&&now>=Date.parse(goal.deadline);
    const accounted=(goal.reservations??[]).reduce((n,r)=>n+(r.status==='reserved'?r.units:r.actualUnits),0);
    const exhausted=goal.status==='active'&&goal.maxUsageUnits!==null&&accounted>=goal.maxUsageUnits;
    if(expired||exhausted||['completed','paused','cancelled'].includes(goal.status))add('goal_'+(expired?'expired':exhausted?'usage_limit':goal.status),goal.id,goal.revision,{priority:goal.status==='completed'?'result':'decision',goalId:goal.id,title:goal.title,summary:'Inspect goal acceptance evidence and fixed limits before further work.',observedAt:goal.updatedAt});
  }
  for(const help of state.peerHelp??[]) {
    if(help.requesterId!==agentId)continue;
    const expired=!['resolved','escalated'].includes(help.phase)&&now>=Date.parse(help.deadline);
    if(expired||['responded','escalated'].includes(help.phase))add('peer_help_'+(expired?'expired':help.phase),help.id,help.revision,{priority:expired||help.phase==='escalated'?'decision':'result',helpId:help.id,taskId:help.taskId,title:'Peer assistance',summary:'Inspect peer evidence; advice does not authorize resuming or expanding scope.',observedAt:help.updatedAt});
  }
  for (const n of state.negotiations??[]) {
    if (![n.requesterId,n.recipientId].includes(agentId)) continue;
    const expired=['proposed','deferred'].includes(n.status) && now>=Date.parse(n.deadline);
    if (expired || n.status==='declined' || n.status==='cancelled') {
      add('negotiation_'+(expired?'expired':n.status),n.id,n.revision,{
        priority:n.status==='cancelled'?'result':'decision',negotiationId:n.id,title:n.terms.title,
        summary:expired?'Negotiation deadline expired; do not reset the work budget.':`Negotiation ${n.status}: ${n.history.at(-1)?.summary??''}`,
        observedAt:expired?Date.parse(n.deadline):n.updatedAt
      });
    }
  }
  for (const task of state.tasks ?? []) {
    if (!related(task, agentId)) continue;
    if (['completed', 'blocked'].includes(task.status)) {
      const transition = lastAction(task, [task.status === 'completed' ? 'complete' : 'block']);
      add(`task_${task.status}`, task.id, transition?.revision ?? task.revision, {
        priority: task.status === 'blocked' ? 'decision' : 'result', taskId: task.id,
        title: task.title, summary: transition?.summary ?? `Task is ${task.status}`,
        artifacts: transition?.artifacts ?? [], observedAt: transition?.createdAt ?? task.updatedAt
      });
      continue;
    }
    if (!active(task)) continue;
    const assignment = lastAction(task, ['assign', 'handoff', 'route', 'accept']);
    if (task.assigneeId && !Object.hasOwn(state.agents, task.assigneeId)) {
      add('orphan_assignee', task.id, [task.assigneeId, assignment?.revision ?? 1], {
        priority: 'decision', taskId: task.id, title: task.title,
        summary: 'The assigned worker is no longer registered.', observedAt: assignment?.createdAt ?? task.createdAt
      });
      continue;
    }
    const route = task.routing;
    if (task.status === 'ready' && route && now >= route.acceptBy && route.attempted.length >= route.maxAttempts) {
      add('routing_exhausted', task.id, [route.acceptBy, route.attempted], {
        priority: 'decision', taskId: task.id, title: task.title,
        summary: 'Unaccepted delivery reached its attempt limit; a human decision is needed.', observedAt: route.acceptBy
      });
    } else if (task.status !== 'ready' && now - task.updatedAt >= 30 * 60000) {
      add('task_stalled', task.id, task.updatedAt, {
        priority: 'health', taskId: task.id, title: task.title,
        summary: 'The active task has no recorded progress for at least 30 minutes. Check before intervening.', observedAt: task.updatedAt
      });
    }
  }
  for (const cycle of state.reviewCycles ?? []) {
    if (![cycle.builderId, cycle.reviewerId].includes(agentId) || !['exhausted', 'cancelled'].includes(cycle.phase)) continue;
    const task = (state.tasks ?? []).find(task => task.id === cycle.taskId);
    if (!task || !active(task)) continue;
    add(`review_${cycle.phase}`, cycle.id, cycle.revision, {
      priority: 'decision', cycleId: cycle.id, taskId: cycle.taskId, title: task.title,
      summary: `Review is ${cycle.phase}; task completion needs an explicit decision.`, observedAt: cycle.updatedAt
    });
  }
  const report = state.agents[agentId]?.health;
  if (report?.schedulerStatus === 'enabled' && now - report.observedAt >= Math.max(30, 2 * (report.expectedIntervalMinutes ?? 0)) * 60000) {
    add('worker_report_stale', agentId, report.observedAt, {
      priority: 'health', agentId, summary: 'Your scheduler health report is stale. Verify the host schedule; mailbox records do not prove a host is offline.', observedAt: report.observedAt
    });
  }
  const rank = { decision: 0, result: 1, health: 2 };
  return events.sort((a, b) => rank[a.priority] - rank[b.priority] || a.id.localeCompare(b.id));
}

export async function listNotifications({ agent_id, limit = 30 }) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('Invalid notification limit');
  const { state } = await this.store.read();
  this.actor(state, agent_id);
  const acknowledged = new Set((state.notificationReceipts ?? []).filter(receipt => receipt.agentId === agent_id).map(receipt => receipt.notificationId));
  const pending = notificationEvents(state, agent_id, this.now()).filter(event => !acknowledged.has(event.id));
  return {
    notifications: pending.slice(0, limit), hasMore: pending.length > limit,
    note: 'Current meaningful conditions for this worker, not a complete event history. Reading never acknowledges or sends. Deliver useful results through an authorized host channel, then acknowledge their exact IDs. Repeated polling is deduplicated per worker; delivery is not exactly-once across crashes or different workers.'
  };
}

export async function acknowledgeNotification({ agent_id, notification_id }) {
  if (typeof notification_id !== 'string' || !/^[a-f0-9]{64}$/.test(notification_id)) throw new Error('Invalid notification_id');
  return this.change(state => {
    this.actor(state, agent_id);
    const receipts = state.notificationReceipts ?? [];
    const existing = receipts.find(receipt => receipt.agentId === agent_id && receipt.notificationId === notification_id);
    if (existing) return { acknowledged: true, notification_id };
    const event = notificationEvents(state, agent_id, this.now()).find(event => event.id === notification_id);
    if (!event) throw new Error('Notification is no longer current or is not addressed to this worker; list notifications again');
    const previous = receipts.find(receipt => receipt.agentId === agent_id && receipt.sourceKey === event.sourceKey);
    if (!previous && receipts.length >= receiptLimit) throw new Error('Notification receipts full; archive deliberately before continuing');
    const receipt = { agentId: agent_id, sourceKey: event.sourceKey, notificationId: notification_id, acknowledgedAt: this.now() };
    if (previous) Object.assign(previous, receipt);
    else receipts.push(receipt);
    state.notificationReceipts = receipts;
    return { acknowledged: true, notification_id };
  });
}

const string = { type: 'string', minLength: 1 };
const tool = (name, description, properties, required, readOnly) => ({ name, description,
  inputSchema: { type: 'object', properties, required, additionalProperties: false },
  annotations: { readOnlyHint: readOnly, destructiveHint: false, openWorldHint: true } });
export const notificationTools = [
  tool('list_notifications', 'Read pending useful results, decisions and relevant stale health conditions. Does not send or acknowledge; acknowledge only after delivering through an authorized host channel.',
    { agent_id: string, limit: { type: 'integer', minimum: 1, maximum: 100 } }, ['agent_id'], true),
  tool('acknowledge_notification', 'Acknowledge an exact current notification after delivery. Idempotent per worker; does not send a notification or acknowledge an inbox message.',
    { agent_id: string, notification_id: { ...string, minLength: 64, maxLength: 64 } }, ['agent_id', 'notification_id'], false)
];
export const notificationMethods = { list_notifications: 'listNotifications', acknowledge_notification: 'acknowledgeNotification' };
