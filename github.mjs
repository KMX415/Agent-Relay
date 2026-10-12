import { configuredRepo } from './config.mjs';
import { spawn } from 'node:child_process';

export const STORAGE_BRANCH = 'dev-agent-mailbox';
export const STORAGE_FILE = 'mailbox.json';
export const emptyState = () => ({ version: 1, agents: {}, messages: [], claims: [] });

export function run(command, args, input) {
  return new Promise((resolve, reject) => {
    // No shell interpolation, no token copied out of the user's gh credential store.
    const child = spawn(command, args, { windowsHide: true, stdio: ['pipe','pipe','pipe'] });
    let out = '', err = '', size = 0;
    const timer = setTimeout(() => { child.kill(); reject(new Error('Command timed out; check connectivity before retrying')); }, 30000);
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.stdout.on('data', data => { size += data.length; if (size > 3000000) child.kill(); else out += data; });
    child.stderr.on('data', data => { if (err.length < 4000) err += data; });
    child.on('close', code => {
      clearTimeout(timer);
      if (code === 0 && size <= 3000000) resolve(out);
      else {
        const error = new Error(err.trim() || `Command failed (${code})`);
        error.status = Number(err.match(/HTTP (\d{3})/)?.[1]) || 0;
        reject(error);
      }
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

export class GitHubStore {
  constructor(repo = configuredRepo()) {
    if (typeof repo !== 'string' || !/^[\w.-]+\/[\w.-]+$/.test(repo) || repo.split('/').some(part => part === '.' || part === '..')) throw new Error('Repository must be owner/name');
    this.repo = repo;
  }
  async api(path, method = 'GET', body) {
    const args = ['api', '--hostname', 'github.com', '--method', method, '-H', 'Accept: application/vnd.github+json', path];
    if (body !== undefined) args.push('--input', '-');
    return JSON.parse(await run('gh', args, body === undefined ? undefined : JSON.stringify(body)));
  }
  async verify() {
    const repo = await this.api(`repos/${this.repo}`);
    if (!repo.private) throw new Error('Development mailbox requires a PRIVATE repository');
    if (!repo.permissions?.push) throw new Error('GitHub account needs write access to this private repository');
    return (await this.api('user')).login;
  }
  async read() {
    // Check visibility on every read, including writes' read-before-CAS. Never silently
    // continue using the mailbox after someone makes the repository public.
    const repo = await this.api(`repos/${this.repo}`);
    if (!repo.private) throw new Error('Mailbox disabled: repository is no longer private');
    const file = await this.api(`repos/${this.repo}/contents/${STORAGE_FILE}?ref=${STORAGE_BRANCH}`);
    if (file.encoding !== 'base64' || file.size > 750000) throw new Error('Unsupported or oversized mailbox state');
    const state = JSON.parse(Buffer.from(file.content, 'base64').toString('utf8'));
    if (['reviewCycles','checkpoints','skillImprovements','notificationReceipts'].some(key => state[key] !== undefined && !Array.isArray(state[key]))) throw new Error('Unsupported mailbox schema');
    if (state.version !== 1 || !state.agents || !Array.isArray(state.messages) || !Array.isArray(state.claims) || (state.tasks !== undefined && !Array.isArray(state.tasks)) || (state.skills !== undefined && !Array.isArray(state.skills))) throw new Error('Unsupported mailbox schema');
    return { state, sha: file.sha };
  }
  async write(state, sha) {
    const json = JSON.stringify(state);
    if (Buffer.byteLength(json) > 750000) throw new Error('Mailbox full; archive it before adding more data');
    await this.api(`repos/${this.repo}/contents/${STORAGE_FILE}`, 'PUT', {
      message: 'Update development mailbox [skip ci]', branch: STORAGE_BRANCH, sha,
      content: Buffer.from(json).toString('base64'),
    });
  }
  async initialize() {
    await this.verify();
    try { await this.read(); return { created: false }; }
    catch (error) {
      if (error.status !== 404 && error.status !== 409) throw error;
      // GitHub's Git database API cannot create the first reference in an empty
      // repository. Only explicit initialization may seed it through Contents.
      // A 409 alone is not evidence of an empty repository.
      if (error.status === 409) await this.seedEmptyRepository(error);
    }
    const treeInput = {
      tree: [{ path: STORAGE_FILE, mode: '100644', type: 'blob', content: JSON.stringify(emptyState()) }],
    };
    let tree;
    try {tree=await this.api(`repos/${this.repo}/git/trees`,'POST',treeInput);}
    catch(error) {
      // Contents may report a missing ref as 404 even for an empty repository;
      // the first Git database write then reports 409. Use the same guarded
      // bootstrap, retrying this object creation only once.
      if(error.status!==409)throw error;
      await this.seedEmptyRepository(error);
      tree=await this.api(`repos/${this.repo}/git/trees`,'POST',treeInput);
    }
    const commit = await this.api(`repos/${this.repo}/git/commits`, 'POST', {
      message: 'Initialize private development mailbox [skip ci]', tree: tree.sha, parents: [],
    });
    try {
      await this.api(`repos/${this.repo}/git/refs`, 'POST', { ref: `refs/heads/${STORAGE_BRANCH}`, sha: commit.sha });
    } catch (error) {
      // Another setup may have created it. Never overwrite an existing branch.
      if (error.status !== 422) throw error;
      await this.read();
      return { created: false };
    }
    return { created: true };
  }
  async seedEmptyRepository(originalError) {
    const base=`repos/${this.repo}`,repo=await this.api(base);
    if(!repo.private || !repo.permissions?.push || repo.size!==0 ||
       typeof repo.default_branch!=='string' || !repo.default_branch || repo.default_branch===STORAGE_BRANCH) throw originalError;
    const branches=await this.api(base+'/branches?per_page=1');
    const tags=await this.api(base+'/tags?per_page=1');
    if(!Array.isArray(branches)||branches.length||!Array.isArray(tags)||tags.length)throw originalError;
    let empty=false;
    try {await this.api(base+'/commits?per_page=1');}
    catch(error){if(error.status!==409)throw error;empty=true;}
    if(!empty)throw originalError;
    try {
      // No sha means create-only: a concurrent initializer's README is never
      // replaced. Mailbox data remains exclusively on the separate orphan ref.
      await this.api(base+'/contents/README.md','PUT',{
        message:'Initialize private coordination repository [skip ci]',branch:repo.default_branch,
        content:Buffer.from('# Private Agent Relay mailbox\n\nCoordination data lives on the separate dev-agent-mailbox branch. Keep this repository private. Never merge that branch into a code branch.\n').toString('base64')
      });
    }catch(error){
      if(![409,422].includes(error.status))throw error;
      // A raced create is acceptable only if a branch now actually exists.
      const current=await this.api(base+'/branches?per_page=1');
      if(!Array.isArray(current)||current.length===0)throw error;
    }
    // Recheck privacy/access before constructing mailbox objects after a race.
    await this.verify();
  }
}
