import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, mkdir, rm, symlink, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerCursor,readCursorRegistration,inspectCursorEntry } from '../cursor.mjs';
import { register,CLIENTS } from '../register.mjs';

const opts={name:'dead-drop-owner--box',repo:'owner/box',node:'C:\\Node\\node.exe',server:'C:\\Dead Drop\\server.mjs'};
const entry=()=>({type:'stdio',command:opts.node,args:[opts.server],env:{AGENT_MAILBOX_REPO:opts.repo}});
async function fixture(t) {
  const directory=await mkdtemp(join(tmpdir(),'relay-cursor-'));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  return {directory,configPath:join(directory,'cursor','mcp.json')};
}
async function save(configPath,content) {await mkdir(join(configPath,'..'),{recursive:true});await writeFile(configPath,typeof content==='string'?content:JSON.stringify(content));}

test('Cursor registration preserves other servers and top-level fields without leaking config',async t=>{
  const {configPath}=await fixture(t);
  const unrelated={other:{command:'other-tool',env:{SECRET:'do-not-print'}}};
  await save(configPath,{mcpServers:unrelated,custom:{setting:true}});
  const result=await registerCursor(opts,{configPath});
  assert.equal(result.status,'created');assert.equal(JSON.stringify(result).includes('do-not-print'),false);
  const config=JSON.parse(await readFile(configPath,'utf8'));
  assert.deepEqual(config.mcpServers.other,unrelated.other);assert.deepEqual(config.custom,{setting:true});
  assert.deepEqual(config.mcpServers[opts.name],entry());
  const before=await readFile(configPath,'utf8');
  assert.equal((await registerCursor(opts,{configPath})).status,'matches');
  assert.equal(await readFile(configPath,'utf8'),before);
  await assert.rejects(lstat(configPath+'.dead-drop.lock'),e=>e.code==='ENOENT');
});

test('Cursor exact registration rejects executable, extra args, mailbox prefix and disabled entries',async t=>{
  const {configPath}=await fixture(t);
  for(const different of [
    {...entry(),command:'wrong-node'},
    {...entry(),args:[opts.server,'--other']},
    {...entry(),args:['prefix'+opts.server]},
    {...entry(),env:{AGENT_MAILBOX_REPO:'owner/box-other'}},
    {...entry(),disabled:true},
    {...entry(),enabled:false},
    {...entry(),envFile:'.env'},
    {...entry(),url:'https://example.invalid'},
  ]) {
    await save(configPath,{mcpServers:{[opts.name]:different}});
    const before=await readFile(configPath,'utf8');
    await assert.rejects(registerCursor(opts,{configPath}),/different or disabled/);
    assert.equal(await readFile(configPath,'utf8'),before);
  }
  assert.equal(inspectCursorEntry({...entry(),type:undefined},opts),'matches');
});

test('Cursor accepts a single UTF-8 BOM and preserves unrelated configuration',async t=>{
  const {configPath}=await fixture(t);
  const config={mcpServers:{existing:{command:'other',args:['server.js']}},custom:{enabled:true}};
  await save(configPath,'\uFEFF'+JSON.stringify(config));
  assert.equal((await readCursorRegistration(opts,{configPath})).status,'missing');
  assert.equal((await registerCursor(opts,{configPath})).status,'created');
  const updated=JSON.parse(await readFile(configPath,'utf8'));
  assert.deepEqual(updated.mcpServers.existing,config.mcpServers.existing);
  assert.deepEqual(updated.custom,config.custom);
  assert.deepEqual(updated.mcpServers[opts.name],entry());
  const matching='\uFEFF'+JSON.stringify(updated);
  await writeFile(configPath,matching);
  assert.equal((await registerCursor(opts,{configPath})).status,'matches');
  assert.equal(await readFile(configPath,'utf8'),matching);
});

test('Cursor reader is read-only and malformed or nonobject JSON is never overwritten',async t=>{
  const {configPath}=await fixture(t);
  assert.equal((await readCursorRegistration(opts,{configPath})).status,'missing');
  await assert.rejects(lstat(join(configPath,'..')),e=>e.code==='ENOENT');
  for(const content of ['{ "SECRET": "never echo me", broken','[]','{"mcpServers":[]}','{"mcpServers":null}']) {
    await save(configPath,content);
    await assert.rejects(registerCursor(opts,{configPath}),e=>!e.message.includes('never echo me') && /configuration/.test(e.message));
    assert.equal(await readFile(configPath,'utf8'),content);
  }
});

test('Cursor lock prevents concurrent mutation and is not removed by nonowner',async t=>{
  const {configPath}=await fixture(t);
  await save(configPath,{});
  const lockPath=configPath+'.dead-drop.lock';
  await writeFile(lockPath,'existing writer');
  await assert.rejects(registerCursor(opts,{configPath}),/locked/);
  assert.equal(await readFile(lockPath,'utf8'),'existing writer');
  assert.deepEqual(JSON.parse(await readFile(configPath,'utf8')),{});
  await rm(lockPath);
  const results=await Promise.allSettled([registerCursor(opts,{configPath}),registerCursor({...opts,name:'dead-drop-second--box',repo:'second/box'},{configPath})]);
  assert.ok(results.some(r=>r.status==='fulfilled'));
  for(const r of results)if(r.status==='rejected')assert.match(r.reason.message,/locked/);
  // Retrying the competing writer preserves the first entry.
  await registerCursor(opts,{configPath});await registerCursor({...opts,name:'dead-drop-second--box',repo:'second/box'},{configPath});
  assert.equal(Object.keys(JSON.parse(await readFile(configPath,'utf8')).mcpServers).length,2);
});

test('Cursor refuses symlink files or directory redirection',async t=>{
  const {directory,configPath}=await fixture(t),target=join(directory,'target');
  await mkdir(target);
  await symlink(target,join(directory,'cursor'),process.platform==='win32'?'junction':'dir');
  await assert.rejects(registerCursor(opts,{configPath}),/symbolic links/);
  await assert.rejects(readCursorRegistration(opts,{configPath}),/symbolic links/);
  await assert.rejects(lstat(join(target,'mcp.json')),e=>e.code==='ENOENT');
});

test('register dispatch supports Cursor without invoking a provider CLI',async t=>{
  const {configPath}=await fixture(t);
  assert.ok(CLIENTS.includes('cursor'));
  const result=await register(()=>{throw new Error('Unexpected CLI');},['cursor'],{...opts,cursorConfigPath:configPath});
  assert.match(result[0],/^Cursor: MCP registration created/);
  assert.equal((await readCursorRegistration(opts,{configPath})).status,'matches');
});
