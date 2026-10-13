import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, readdir, mkdir, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { hermesConfigPath, hermesEnvironmentIssue, inspectHermesEntry, parseHermesConfig, readHermesRegistration, registerHermes } from '../hermes.mjs';

const opts={name:'agent-relay-owner--box',repo:'owner/box',node:process.execPath,server:resolve('server.mjs')};
const entry=()=>({command:opts.node,args:[opts.server],env:{AGENT_MAILBOX_REPO:opts.repo}});
async function fixture(t) {
  const root=await mkdtemp(join(tmpdir(),'relay-hermes-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  return {root,configPath:join(root,'config.yaml'),env:{HERMES_MANAGED_DIR:join(root,'managed')}};
}

test('Hermes paths honor explicit homes, expansion and native defaults without reading real configuration',()=>{
  const home=resolve('runtime/test-home');
  assert.equal(hermesConfigPath({env:{},home,platform:'linux'}),join(home,'.hermes','config.yaml'));
  assert.equal(hermesConfigPath({env:{},home,platform:'win32'}),join(home,'AppData','Local','hermes','config.yaml'));
  assert.equal(hermesConfigPath({env:{LOCALAPPDATA:home,HERMES_DATA_DIR_SUFFIX:'-test'},home,platform:'win32'}),join(home,'hermes-test','config.yaml'));
  assert.equal(hermesConfigPath({env:{HERMES_HOME:'~/isolated'},home}),join(home,'isolated','config.yaml'));
  assert.equal(hermesConfigPath({env:{HERMES_HOME:'${TEST_ROOT}/profile',TEST_ROOT:home},home}),join(home,'profile','config.yaml'));
});

test('Hermes registration creates only a temporary fixture and retries without rewriting it',async t=>{
  const config=await fixture(t);
  assert.equal((await readHermesRegistration(opts,config)).status,'missing');
  assert.equal((await registerHermes(opts,config)).status,'created');
  const raw=await readFile(config.configPath,'utf8');
  assert.deepEqual(parseHermesConfig(raw).mcp_servers[opts.name],entry());
  assert.equal((await registerHermes(opts,config)).status,'matches');
  assert.equal(await readFile(config.configPath,'utf8'),raw);
  assert.deepEqual(await readdir(config.root),['config.yaml']);
});

test('Hermes YAML editing preserves comments, unrelated values, multiline prompts and servers',async t=>{
  const config=await fixture(t);
  const raw='# Personal settings\nmodel: "my-model" # keep this\nprompt: |\n  Be helpful.\n  Keep this line.\nmcp_servers:\n  existing:\n    command: other\n    env:\n      PRIVATE_TOKEN: fixture-secret\n';
  await writeFile(config.configPath,raw);
  await registerHermes(opts,config);
  const after=await readFile(config.configPath,'utf8'),parsed=parseHermesConfig(after),before=parseHermesConfig(raw);
  assert.match(after,/# Personal settings/);
  assert.match(after,/# keep this/);
  assert.equal(parsed.prompt,before.prompt);
  assert.equal(parsed.model,before.model);
  assert.deepEqual(parsed.mcp_servers.existing,before.mcp_servers.existing);
});

test('Hermes exact entry comparison rejects wrong executables, mailbox prefixes and transport overrides',()=>{
  assert.equal(inspectHermesEntry(entry(),opts),'matches');
  for(const patch of [{command:'other-node'},{args:[opts.server,'extra']},{args:[opts.server+'-other']},{env:{AGENT_MAILBOX_REPO:'owner/box-other'}},{url:'https://invalid.example'},{transport:'sse'},{envFile:'.env'}])assert.equal(inspectHermesEntry({...entry(),...patch},opts),'mismatch');
  for(const enabled of [false,0,'false','OFF','no','0'])assert.equal(inspectHermesEntry({...entry(),enabled},opts),'disabled');
  for(const tools of [{include:[]},{include:['*']},{exclude:['send_message']},'broken'])assert.equal(inspectHermesEntry({...entry(),tools},opts),'filtered');
  assert.equal(inspectHermesEntry({...entry(),tools:{exclude:[]}},opts),'matches');
});

test('Hermes preserves conflicting, disabled and filtered registrations byte for byte',async t=>{
  const config=await fixture(t);
  for(const patch of [{command:'different'}, {enabled:false},{tools:{include:[]}}]) {
    const raw=JSON.stringify({mcp_servers:{[opts.name]:{...entry(),...patch}}});
    await writeFile(config.configPath,raw);
    await assert.rejects(registerHermes(opts,config),/different, disabled or filtered/);
    assert.equal(await readFile(config.configPath,'utf8'),raw);
  }
});

test('Hermes refuses malformed, duplicate, aliased and inherited server maps without exposing source text',async t=>{
  const config=await fixture(t);
  for(const raw of ['secret: [fixture-secret','[]','model: first\nmodel: fixture-secret','mcp_servers: []','defaults: &servers {}\nmcp_servers: *servers','mcp_servers: &servers {}','defaults: &root\n  mcp_servers: {}\n<<: *root','mcp_servers:\n  <<: {}']) {
    await writeFile(config.configPath,raw);
    await assert.rejects(registerHermes(opts,config),error=>/unambiguous YAML/.test(error.message)&&!error.message.includes('fixture-secret'));
    assert.equal(await readFile(config.configPath,'utf8'),raw);
  }
});

test('Hermes respects setup lock and rejects nonregular configuration targets',async t=>{
  const config=await fixture(t);
  await writeFile(config.configPath+'.agent-relay.lock','other writer');
  await assert.rejects(registerHermes(opts,config),/locked/);
  await rm(config.configPath+'.agent-relay.lock');
  await mkdir(config.configPath);
  await assert.rejects(registerHermes(opts,config),/regular YAML/);
});

test('Hermes refuses linked configuration directories',async t=>{
  const config=await fixture(t),target=join(config.root,'real'),linked=join(config.root,'linked');
  await mkdir(target);
  await symlink(target,linked,process.platform==='win32'?'junction':'dir');
  await assert.rejects(registerHermes(opts,{...config,configPath:join(linked,'config.yaml')}),/symbolic links/);
  assert.deepEqual(await readdir(target),[]);
});

test('Hermes effective configuration refuses safe mode and administrator overlays before writing',async t=>{
  const config=await fixture(t);
  const safe={...config,env:{...config.env,HERMES_SAFE_MODE:'true'}};
  assert.equal((await readHermesRegistration(opts,safe)).status,'disabled');
  await assert.rejects(registerHermes(opts,safe),/safe mode/);
  assert.deepEqual(await readdir(config.root),[]);
  await mkdir(config.env.HERMES_MANAGED_DIR);
  await writeFile(join(config.env.HERMES_MANAGED_DIR,'config.yaml'),'mcp_servers: {}');
  assert.equal((await readHermesRegistration(opts,config)).status,'managed');
  await assert.rejects(registerHermes(opts,config),/managed configuration/);
  await assert.rejects(readFile(config.configPath),{code:'ENOENT'});
  await rm(join(config.env.HERMES_MANAGED_DIR,'config.yaml'));
  await writeFile(join(config.env.HERMES_MANAGED_DIR,'.env'),'HERMES_SAFE_MODE=true');
  assert.equal((await readHermesRegistration(opts,config)).status,'managed');
});

test('Hermes managed inspection fails closed on unreadable configuration and uses upstream default',async()=>{
  const paths=[];
  const absent=async path=>{paths.push(path);throw Object.assign(new Error('absent'),{code:'ENOENT'});};
  assert.equal(await hermesEnvironmentIssue({env:{},read:absent}),null);
  assert.deepEqual(paths,[resolve('/etc/hermes/config.yaml'),resolve('/etc/hermes/.env')]);
  const issue=await hermesEnvironmentIssue({env:{},read:async()=>{throw Object.assign(new Error('private-content'),{code:'EACCES'});}});
  assert.equal(issue.status,'managed');
  assert.doesNotMatch(issue.reason,/private-content/);
});
