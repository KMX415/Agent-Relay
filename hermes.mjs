import { homedir } from 'node:os';
import { dirname, resolve, parse, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { mkdir, lstat, readFile, open, rename, link, unlink } from 'node:fs/promises';

import { parseDocument, isMap } from 'yaml';

/** Conservative effective-config check; never return administrator content. */
export async function hermesEnvironmentIssue({env=process.env,read=readFile}={}) {
  if(['1','true','yes','on'].includes(String(env.HERMES_SAFE_MODE??'').trim().toLowerCase()))return {status:'disabled',reason:'Hermes safe mode disables MCP servers'};
  // Upstream managed_scope defaults to /etc/hermes on every platform. Managed
  // YAML wins over user settings; its .env may also affect the effective config.
  const managedDir=env.HERMES_MANAGED_DIR?.trim()||'/etc/hermes';
  for(const filename of ['config.yaml','.env']) {
    try {await read(resolve(managedDir,filename),'utf8');}
    catch(error) {
      if(['ENOENT','ENOTDIR'].includes(error.code))continue;
      return {status:'managed',reason:'Hermes managed configuration cannot be inspected; verify effective MCP settings with the administrator'};
    }
    return {status:'managed',reason:'Hermes managed configuration may override local MCP settings; administrator verification is required'};
  }
  return null;
}

export function hermesConfigPath({env=process.env,home=homedir(),platform=process.platform}={}) {
  let base=env.HERMES_HOME?.trim();
  if(base) {
    base=base.replace(/\$\{([^}]+)\}|\$([A-Za-z_][A-Za-z_0-9]*)|%([^%]+)%/g,(full,a,b,c)=>env[a??b??c]??full);
    if(base==='~' || /^~[\\/]/.test(base))base=home+base.slice(1);
  } else {
    const suffix=env.HERMES_DATA_DIR_SUFFIX??'';
    if(/[\\/]/.test(suffix))throw new Error('Invalid Hermes data directory suffix');
    base=platform==='win32'?join(env.LOCALAPPDATA?.trim()||join(home,'AppData','Local'),'hermes'+suffix):join(home,'.hermes'+suffix);
  }
  return resolve(base,'config.yaml');
}
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function options(opts) {
  for (const key of ['name','repo','node','server']) if (typeof opts?.[key] !== 'string' || !opts[key].trim()) throw new Error('Invalid Hermes registration options');
  if (!/^[\w.-]+\/[\w.-]+$/.test(opts.repo) || ['__proto__','prototype','constructor'].includes(opts.name)) throw new Error('Invalid Hermes registration options');
  return opts;
}

/** Pure inspection: never return config content or environment secrets. */
export function inspectHermesEntry(entry, opts) {
  options(opts);
  if (!object(entry)) return 'mismatch';
  if (entry.disabled === true || entry.enabled === false || entry.enabled === 0 || (typeof entry.enabled==='string' && ['false','off','no','0'].includes(entry.enabled.trim().toLowerCase()))) return 'disabled';
  if (entry.command !== opts.node || !Array.isArray(entry.args) || entry.args.length !== 1 || entry.args[0] !== opts.server ||
      !object(entry.env) || entry.env.AGENT_MAILBOX_REPO !== opts.repo ||
      (entry.type !== undefined && entry.type !== 'stdio') || (entry.transport !== undefined && entry.transport !== 'stdio') || entry.url !== undefined || entry.envFile !== undefined) return 'mismatch';
  if(entry.tools!==undefined && entry.tools!==null && (!object(entry.tools) || entry.tools.include!=null || (entry.tools.exclude!=null && (!Array.isArray(entry.tools.exclude) || entry.tools.exclude.length))))return 'filtered';
  return 'matches';
}

// Reject link redirection on the file and every existing directory component.
// This is an accidental-overwrite guard, not an adversarial filesystem sandbox.
async function noLinks(path) {
  const absolute=resolve(path),root=parse(absolute).root;
  let current=root;
  for (const piece of absolute.slice(root.length).split(/[\\/]/).filter(Boolean)) {
    current=join(current,piece);
    try {if ((await lstat(current)).isSymbolicLink()) throw new Error('Hermes configuration paths must not contain symbolic links');}
    catch(error) {if(error.code==='ENOENT')return;throw error;}
  }
}
async function readConfig(path) {
  await noLinks(path);
  let raw;
  try {
    const info=await lstat(path);
    if (!info.isFile() || info.size>1024*1024) throw new Error('Hermes configuration must be a regular YAML file under 1 MiB');
    raw=await readFile(path,'utf8');
  } catch(error) {if(error.code==='ENOENT')return {raw:null,...parseConfig('')};throw error;}
  const {document,config}=parseConfig(raw);
  return {raw,config,document};
}
function parseConfig(raw) {
  // Never include parser excerpts: unrelated settings may contain secrets.
  try {
    const document=parseDocument(raw??'',{uniqueKeys:true,version:'1.1',merge:true});
    if(document.errors.length || document.warnings.length)throw new Error();
    if(document.contents===null)document.contents=document.createNode({});
    if(!isMap(document.contents))throw new Error();
    const config=document.toJS({maxAliasCount:100});
    if(!object(config) || (config.mcp_servers!==undefined && config.mcp_servers!==null && !object(config.mcp_servers)))throw new Error();
    // Editing an inherited/aliased server map could alter another configuration section.
    const servers=document.get('mcp_servers',true);
    if(servers!==undefined && servers?.value!==null && !isMap(servers))throw new Error();
    if(config.mcp_servers!==undefined && servers===undefined)throw new Error();
    if(isMap(servers) && (servers.anchor || servers.items.some(pair=>typeof pair.key?.value==='symbol' || pair.key?.value==='<<')))throw new Error();
    return {document,config};
  } catch {throw new Error('Hermes configuration is not an unambiguous YAML mapping; inspect it before setup');}
}
export function parseHermesConfig(raw) {return parseConfig(raw).config;}

const state = (config,opts) => config.mcp_servers && Object.hasOwn(config.mcp_servers,opts.name) ? inspectHermesEntry(config.mcp_servers[opts.name],opts) : 'missing';
function safeError(error) {
  // Parser and filesystem errors must never echo unrelated config or credentials.
  if(error.code) return new Error('Hermes configuration access failed ('+error.code+'); inspect the file and permissions');
  return error;
}

export async function readHermesRegistration(opts,{env=process.env,read=readFile,configPath=hermesConfigPath({env})}={}) {
  options(opts);configPath=resolve(configPath);
  const issue=await hermesEnvironmentIssue({env,read});
  if(issue)return {...issue,configPath,name:opts.name};
  try {const {config}=await readConfig(configPath);return {status:state(config,opts),configPath,name:opts.name};}
  catch(error){throw safeError(error);}
}

/** Register only when the name is absent; mismatches are never overwritten. */
export async function registerHermes(opts,{env=process.env,read=readFile,configPath=hermesConfigPath({env})}={}) {
  options(opts);configPath=resolve(configPath);
  const issue=await hermesEnvironmentIssue({env,read});
  if(issue)throw new Error(issue.reason);
  const lockPath=configPath+'.agent-relay.lock',tempPath=configPath+'.agent-relay-'+randomUUID()+'.tmp';
  let lock,temporary=false;
  try {
    await noLinks(configPath);
    await mkdir(dirname(configPath),{recursive:true});
    await noLinks(lockPath);
    try {lock=await open(lockPath,'wx',0o600);}
    catch(error){if(error.code==='EEXIST')throw new Error('Hermes configuration is locked by another setup; inspect the lock before retrying');throw error;}
    const original=await readConfig(configPath),status=state(original.config,opts);
    if(status==='matches')return {status,configPath,name:opts.name};
    if(status!=='missing')throw new Error('A different, disabled or filtered Hermes registration exists; inspect it before replacing it');
    const document=original.document;
    if(!isMap(document.get('mcp_servers',true)))document.set('mcp_servers',document.createNode({}));
    document.setIn(['mcp_servers',opts.name],document.createNode({command:opts.node,args:[opts.server],env:{AGENT_MAILBOX_REPO:opts.repo}}));
    const content=document.toString();
    if(Buffer.byteLength(content)>1024*1024)throw new Error('Hermes configuration would exceed 1 MiB');
    const temp=await open(tempPath,'wx',0o600);temporary=true;
    try {await temp.writeFile(content);await temp.sync();} finally {await temp.close();}
    // Other Relay writers respect the lock. Detect ordinary editor changes too;
    // Hermes itself does not participate in this advisory lock protocol.
    const latest=await readConfig(configPath);
    if(latest.raw!==original.raw)throw new Error('Hermes configuration changed during setup; retry after inspecting it');
    const latestIssue=await hermesEnvironmentIssue({env,read});
    if(latestIssue)throw new Error(latestIssue.reason);
    if(original.raw===null)await link(tempPath,configPath); // create-only despite racing external writer
    else await rename(tempPath,configPath);
    return {status:'created',configPath,name:opts.name};
  } catch(error) {throw safeError(error);}
  finally {
    try {if(temporary)await unlink(tempPath).catch(error=>{if(error.code!=='ENOENT')throw safeError(error);});}
    finally {if(lock) {await lock.close();await unlink(lockPath).catch(error=>{if(error.code!=='ENOENT')throw safeError(error);});}}
  }
}
