// MCP registration for the agent clients Agent Relay supports. Codex stays the default; Claude Code is added on request
// (--claude), never instead of Codex unless --no-codex is also given. `run` is injected so tests need neither CLI.

export const CLIENTS = ['codex', 'claude'];

export function serverName(repo) {
  return 'agent-relay-' + repo.toLowerCase().replace('/', '--');
}

// Codex: `codex mcp list --json` gives structured entries, so a mismatch is detected exactly.
async function registerCodex(run, { name, repo, node, server }) {
  const existing = JSON.parse(await run('codex', ['mcp', 'list', '--json'])).find(s => s.name === name);
  if (existing) {
    if (existing.transport?.command !== node || !existing.transport?.args?.includes(server) ||
        existing.transport?.env?.AGENT_MAILBOX_REPO !== repo || !existing.enabled)
      throw new Error('A different/disabled Codex registration exists for ' + name + '. Inspect it before replacing it.');
    return 'Codex: MCP registration already matches.';
  }
  return 'Codex: ' + (await run('codex', ['mcp', 'add', name, '--env', `AGENT_MAILBOX_REPO=${repo}`, '--', node, server])).trim();
}

// Claude Code: `claude mcp get NAME` fails when the server is unknown and prints its command, args and env when known.
// Registered at user scope, so every Claude Code session on this computer can reach this mailbox's server.
async function registerClaude(run, { name, repo, node, server }) {
  let shown = null;
  try { shown = await run('claude', ['mcp', 'get', name]); } catch { shown = null; }
  if (shown !== null) {
    const text = shown.split('\\\\').join('\\');                       // Windows paths may print with doubled backslashes
    if (!text.includes(server) || !text.includes(repo))
      throw new Error('A different Claude Code registration exists for ' + name + '. Inspect it (claude mcp get ' + name + ') before replacing it.');
    return 'Claude Code: MCP registration already matches.';
  }
  return 'Claude Code: ' + (await run('claude', ['mcp', 'add', name, '--scope', 'user', '--env', `AGENT_MAILBOX_REPO=${repo}`, '--', node, server])).trim();
}

export async function register(run, clients, opts) {
  const out = [];
  for (const client of clients) {
    if (client === 'codex') out.push(await registerCodex(run, opts));
    else if (client === 'claude') out.push(await registerClaude(run, opts));
    else throw new Error('Unknown MCP client ' + client);
  }
  return out;
}
