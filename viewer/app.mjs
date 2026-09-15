const el = id => document.getElementById(id);
const nodes = new Map();
let messages = [], loaded = false, busy = false, fetchedAt = 0, error = '';

function text(tag, value, className) {
  const node = document.createElement(tag);
  node.textContent = value;
  if (className) node.className = className;
  return node;
}
function date(value) {
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toLocaleString() : 'Unknown time';
}
function makeMessage(message) {
  const details = document.createElement('details');
  const summary = document.createElement('summary');
  const meta = text('span', '', 'meta');
  meta.append(text('span', message.kind.replaceAll('_', ' '), 'kind'), text('span', date(message.createdAt)));
  summary.append(meta, text('span', `${message.fromLabel} → ${message.toLabel}`, 'route'));
  const excerpt = text('span', '', 'excerpt');
  const compact = message.body.replace(/\s+/g, ' ').trim();
  excerpt.append(text('span', 'Excerpt: ', 'excerpt-label'), document.createTextNode(compact.length > 180 ? compact.slice(0,180) + '…' : compact));
  summary.append(excerpt);
  const full = text('div', '', 'full');
  full.append(text('h2', 'Full message'), text('p', message.body, 'body'), text('p', `From: ${message.from}\nTo: ${message.to}\nMessage: ${message.id}${message.replyTo ? '\nReply to: ' + message.replyTo : ''}`, 'ids'));
  details.append(summary, full);
  return details;
}
function render() {
  const query = el('search').value.trim().toLocaleLowerCase();
  const present = new Set(messages.map(m => m.id));
  for (const [id, node] of nodes) if (!present.has(id)) { node.remove(); nodes.delete(id); }
  let shown = 0;
  messages.forEach((message, index) => {
    let node = nodes.get(message.id);
    const signature = JSON.stringify(message);
    if (!node || node.dataset.signature !== signature) {
      const replacement = makeMessage(message);
      replacement.open = node?.open ?? false;
      replacement.dataset.signature = signature;
      if (node) node.replaceWith(replacement);
      node = replacement; nodes.set(message.id, node);
    }
    // Leave existing elements in place so refresh preserves focus and expansion.
    const current = el('messages').children[index];
    if (current !== node) el('messages').insertBefore(node, current || null);
    node.hidden = ![message.fromLabel,message.toLabel,message.from,message.to,message.kind,message.body].join(' ').toLocaleLowerCase().includes(query);
    if (!node.hidden) shown++;
  });
  el('count').textContent = loaded ? `${shown} of ${messages.length} messages · Newest first` : '';
  el('empty').hidden = !loaded || shown > 0;
  el('empty').textContent = messages.length ? 'No messages match your search.' : 'No messages yet. New conversations will appear here after refresh.';
}
function status() {
  const stale = loaded && (error || Date.now() - fetchedAt > 90000);
  el('status').dataset.state = error ? 'error' : stale ? 'stale' : 'ok';
  el('status').textContent = error ? `${loaded ? 'Stale history. ' : ''}${error}${loaded ? ' Last successful read: ' + date(fetchedAt) + '.' : ''}` : loaded ? `${stale ? 'Stale history · ' : ''}Last successful read: ${date(fetchedAt)}${busy ? ' · Refreshing…' : ''}` : 'Loading mailbox…';
}
async function refresh() {
  if (busy) return;
  busy = true; el('refresh').disabled = true; el('messages').setAttribute('aria-busy', 'true'); status();
  try {
    const response = await fetch('/api/messages', {cache:'no-store',signal:AbortSignal.timeout(70000)});
    if (!response.ok) throw new Error('Mailbox unavailable. Check GitHub login and connectivity, then retry.');
    const data = await response.json();
    if (!Array.isArray(data.messages) || !Number.isFinite(new Date(data.fetchedAt).getTime())) throw new Error('Unexpected mailbox response. Restart the viewer and retry.');
    messages = data.messages.slice().sort((a,b) => b.sequence-a.sequence);
    fetchedAt = new Date(data.fetchedAt).getTime(); loaded = true; error = '';
    el('repository').textContent = data.repo;
    render();
  } catch (failure) {
    error = failure.name === 'TimeoutError' ? 'Mailbox request timed out. Check connectivity and retry.' : 'Mailbox unavailable. Check GitHub login and connectivity, then retry.';
  } finally {
    busy = false; el('refresh').disabled = false; el('messages').setAttribute('aria-busy','false'); status();
  }
}
el('search').addEventListener('input', render);
el('refresh').addEventListener('click', refresh);
setInterval(() => { status(); if (el('auto').checked) refresh(); }, 30000);
refresh();
