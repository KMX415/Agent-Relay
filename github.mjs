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
    if (state.version !== 1 || !state.agents || !Array.isArray(state.messages) || !Array.isArray(state.claims) || (state.tasks !== undefined && !Array.isArray(state.tasks))) throw new Error('Unsupported mailbox schema');
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
    catch (error) { if (error.status !== 404) throw error; }
    const tree = await this.api(`repos/${this.repo}/git/trees`, 'POST', {
      tree: [{ path: STORAGE_FILE, mode: '100644', type: 'blob', content: JSON.stringify(emptyState()) }],
    });
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
}
