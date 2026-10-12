import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { tools } from '../tools.mjs';
import { pathToFileURL } from 'node:url';

export const fixtureTools = ['read_fixture', 'write_fixture', 'test_fixture'].map(name => ({
  name, description: name === 'write_fixture' ? 'Save your bounded declarative normalization configuration. This is data, never executable code.' : 'Read or independently test your own normalization fixture.',
  inputSchema: {type:'object',properties:name === 'write_fixture' ? {rules:{type:'object',properties:Object.fromEntries(['trim','lowercase','deduplicate','dropEmpty'].map(k => [k,{type:'boolean'}])),required:['trim','lowercase','deduplicate','dropEmpty'],additionalProperties:false}} : {},required:name === 'write_fixture' ? ['rules'] : [],additionalProperties:false},
}));
export const workerTools = [...tools.filter(t => t.name !== 'join_team').map(t => {
  const copy = structuredClone(t); delete copy.inputSchema.properties.agent_id;
  copy.inputSchema.required = copy.inputSchema.required.filter(k => k !== 'agent_id'); return copy;
}), ...fixtureTools];

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.RELAY_HARNESS_PORT), token = process.env.RELAY_HARNESS_TOKEN;
  if (!Number.isInteger(port) || port < 1 || port > 65535 || !/^[a-f0-9]{64}$/.test(token || '')) throw new Error('Invalid harness capability');
  const server = new Server({name:'relay-harness',version:'1.0.0'},{capabilities:{tools:{}}});
  server.setRequestHandler(ListToolsRequestSchema, async () => ({tools:workerTools}));
  server.setRequestHandler(CallToolRequestSchema, async request => {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/call`, {method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify({name:request.params.name,args:request.params.arguments || {}}),signal:AbortSignal.timeout(30000)});
      const result = await response.json();
      return {isError:!response.ok,content:[{type:'text',text:JSON.stringify(result)}]};
    } catch { return {isError:true,content:[{type:'text',text:'Harness call failed; inspect state before retrying with the same stable key.'}]}; }
  });
  await server.connect(new StdioServerTransport());
}
