import { readFileSync } from 'node:fs';
export const configPath = new URL('./runtime/config.json', import.meta.url);
export function configuredRepo(env = process.env, read = () => readFileSync(configPath, 'utf8')) {
  if (env.AGENT_MAILBOX_REPO) return env.AGENT_MAILBOX_REPO;
  try {
    const config = JSON.parse(read());
    if (typeof config.repo !== 'string' || !config.repo) throw new Error('Missing repo in runtime/config.json');
    return config.repo;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    throw new Error('Choose a private mailbox repository: node setup.mjs --repo OWNER/REPO --initialize');
  }
}
