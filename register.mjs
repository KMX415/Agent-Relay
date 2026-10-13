// Codex stays the default; --claude and --cursor add clients explicitly.
// --no-codex skips that default. `run` is injected for command-based clients.

import { registerHermes } from './hermes.mjs';
import { registerCursor } from './cursor.mjs';
export const CLIENTS = ['codex', 'claude', 'cursor', 'hermes'];

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
    // Compare complete fields; unknown or ambiguous output must fail closed.
    const lines = shown.split(/\r?\n/);
    const field = label => {
      const prefix = '  ' + label + ':';
      const values = lines.filter(line => line.startsWith(prefix))
        .map(line => line.slice(prefix.length).trim());
      return values.length === 1 ? values[0] : null;
    };
    const environment = [];
    let inEnvironment = false;
    for (const line of lines) {
      if (line === '  Environment:') { inEnvironment = true; continue; }
      if (inEnvironment && line.trim() && !line.startsWith('    ')) inEnvironment = false;
      if (inEnvironment) {
        const match = line.match(/^    AGENT_MAILBOX_REPO(?:=|:\s*)(.*)$/);
        if (match) environment.push(match[1].trim());
      }
    }
    // Accommodate literal or escaped Windows paths without weakening equality.
    const samePath = (actual, expected) => actual === expected ||
      (expected.includes('\\') && actual === expected.replaceAll('\\', '\\\\'));
    if (!samePath(field('Command'), node) || !samePath(field('Args'), server) ||
        environment.length !== 1 || environment[0] !== repo)
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
    else if (client === 'cursor') {
      const result=await registerCursor(opts,{configPath:opts.cursorConfigPath});
      out.push('Cursor: MCP registration '+(result.status==='matches'?'already matches':'created')+' ('+result.configPath+'). Restart Cursor or reload its MCP servers.');
    }
    else if (client === 'hermes') {
      const result=await registerHermes(opts,{configPath:opts.hermesConfigPath});
      out.push('Hermes: MCP registration '+(result.status==='matches'?'already matches':'created')+' ('+result.configPath+'). Restart the intended Hermes session or reload its MCP servers.');
    }
    else throw new Error('Unknown MCP client ' + client);
  }
  return out;
}
