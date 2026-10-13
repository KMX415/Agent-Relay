// Synthetic transport fixture only. Never uses GitHub, credentials, or saved workers.
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { Mailbox } from '../../mailbox.mjs';
import { emptyState } from '../../github.mjs';
import { tools, call } from '../../tools.mjs';
const store={state:emptyState(),revision:0,
  async read(){return {state:structuredClone(this.state),sha:this.revision};},
  async write(state,sha){if(sha!==this.revision)throw Object.assign(new Error('Conflict'),{status:409});this.state=structuredClone(state);this.revision++;}
};
const box=new Mailbox(store,'synthetic-contributor');
const server=new Server({name:'relay-synthetic-acceptance',version:'0.1.0'},{capabilities:{tools:{}}});
server.setRequestHandler(ListToolsRequestSchema,async()=>({tools}));
server.setRequestHandler(CallToolRequestSchema,async request=>{
  try{return {content:[{type:'text',text:JSON.stringify(await call(box,request.params.name,request.params.arguments))}]};}
  catch(error){return {isError:true,content:[{type:'text',text:error.message}]};}
});
await server.connect(new StdioServerTransport());
