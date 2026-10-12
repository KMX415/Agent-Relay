import { homedir } from 'node:os';
import { dirname, resolve, parse, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { mkdir, lstat, readFile, open, rename, link, unlink } from 'node:fs/promises';

export const cursorConfigPath = () => join(homedir(), '.cursor', 'mcp.json');
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function options(opts) {
  for (const key of ['name','repo','node','server']) if (typeof opts?.[key] !== 'string' || !opts[key].trim()) throw new Error('Invalid Cursor registration options');
  if (!/^[\w.-]+\/[\w.-]+$/.test(opts.repo) || ['__proto__','prototype','constructor'].includes(opts.name)) throw new Error('Invalid Cursor registration options');
  return opts;
}

/** Pure inspection: never return config content or environment secrets. */
export function inspectCursorEntry(entry, opts) {
  options(opts);
  if (!object(entry)) return 'mismatch';
  if (entry.disabled === true || entry.enabled === false) return 'disabled';
  if (entry.command !== opts.node || !Array.isArray(entry.args) || entry.args.length !== 1 || entry.args[0] !== opts.server ||
      !object(entry.env) || entry.env.AGENT_MAILBOX_REPO !== opts.repo ||
      (entry.type !== undefined && entry.type !== 'stdio') || entry.url !== undefined || entry.envFile !== undefined) return 'mismatch';
  return 'matches';
}

// Reject link redirection on the file and every existing directory component.
// This is an accidental-overwrite guard, not an adversarial filesystem sandbox.
async function noLinks(path) {
  const absolute=resolve(path),root=parse(absolute).root;
  let current=root;
  for (const piece of absolute.slice(root.length).split(/[\\/]/).filter(Boolean)) {
    current=join(current,piece);
    try {if ((await lstat(current)).isSymbolicLink()) throw new Error('Cursor configuration paths must not contain symbolic links');}
    catch(error) {if(error.code==='ENOENT')return;throw error;}
  }
}
async function readConfig(path) {
  await noLinks(path);
  let raw;
  try {
    const info=await lstat(path);
    if (!info.isFile() || info.size>1024*1024) throw new Error('Cursor configuration must be a regular JSON file under 1 MiB');
    raw=await readFile(path,'utf8');
  } catch(error) {if(error.code==='ENOENT')return {raw:null,config:{}};throw error;}
  let config;
  try {config=JSON.parse(raw.startsWith('\uFEFF')?raw.slice(1):raw);} catch {throw new Error('Cursor configuration is not valid JSON; inspect it before setup');}
  if(!object(config) || (config.mcpServers!==undefined && !object(config.mcpServers))) throw new Error('Cursor configuration has an invalid object structure');
  return {raw,config};
}
const state = (config,opts) => config.mcpServers && Object.hasOwn(config.mcpServers,opts.name) ? inspectCursorEntry(config.mcpServers[opts.name],opts) : 'missing';
function safeError(error) {
  // JSON and filesystem errors must never echo unrelated config or credentials.
  if(error.code) return new Error('Cursor configuration access failed ('+error.code+'); inspect the file and permissions');
  return error;
}

export async function readCursorRegistration(opts,{configPath=cursorConfigPath()}={}) {
  options(opts);configPath=resolve(configPath);
  try {const {config}=await readConfig(configPath);return {status:state(config,opts),configPath,name:opts.name};}
  catch(error){throw safeError(error);}
}

/** Register only when the name is absent; mismatches are never overwritten. */
export async function registerCursor(opts,{configPath=cursorConfigPath()}={}) {
  options(opts);configPath=resolve(configPath);
  const lockPath=configPath+'.agent-relay.lock',tempPath=configPath+'.agent-relay-'+randomUUID()+'.tmp';
  let lock,temporary=false;
  try {
    await noLinks(configPath);
    await mkdir(dirname(configPath),{recursive:true});
    await noLinks(lockPath);
    try {lock=await open(lockPath,'wx',0o600);}
    catch(error){if(error.code==='EEXIST')throw new Error('Cursor configuration is locked by another setup; inspect the lock before retrying');throw error;}
    const original=await readConfig(configPath),status=state(original.config,opts);
    if(status==='matches')return {status,configPath,name:opts.name};
    if(status!=='missing')throw new Error('A different or disabled Cursor registration exists; inspect it before replacing it');
    const config=original.config;
    config.mcpServers??={};
    config.mcpServers[opts.name]={type:'stdio',command:opts.node,args:[opts.server],env:{AGENT_MAILBOX_REPO:opts.repo}};
    const content=JSON.stringify(config,null,2)+'\n';
    if(Buffer.byteLength(content)>1024*1024)throw new Error('Cursor configuration would exceed 1 MiB');
    const temp=await open(tempPath,'wx',0o600);temporary=true;
    try {await temp.writeFile(content);await temp.sync();} finally {await temp.close();}
    // Other Relay writers respect the lock. Detect ordinary editor changes too;
    // Cursor itself does not participate in this advisory lock protocol.
    const latest=await readConfig(configPath);
    if(latest.raw!==original.raw)throw new Error('Cursor configuration changed during setup; retry after inspecting it');
    if(original.raw===null)await link(tempPath,configPath); // create-only despite racing external writer
    else await rename(tempPath,configPath);
    return {status:'created',configPath,name:opts.name};
  } catch(error) {throw safeError(error);}
  finally {
    try {if(temporary)await unlink(tempPath).catch(error=>{if(error.code!=='ENOENT')throw safeError(error);});}
    finally {if(lock) {await lock.close();await unlink(lockPath).catch(error=>{if(error.code!=='ENOENT')throw safeError(error);});}}
  }
}
