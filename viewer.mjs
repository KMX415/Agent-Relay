import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { GitHubStore } from './github.mjs';
import { dashboard } from './dashboard.mjs';

const DEFAULT_PORT = 4315;
const DEFAULT_CACHE_MS = 15_000;
const DEFAULT_FAILURE_CACHE_MS = 2_000;
const VIEWER_DIRECTORY = join(dirname(fileURLToPath(import.meta.url)), 'viewer');
const ASSETS = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ['/app.mjs', ['app.mjs', 'text/javascript; charset=utf-8']],
  ['/style.css', ['style.css', 'text/css; charset=utf-8']],
  ['/dashboard.mjs', ['dashboard.mjs', 'text/javascript; charset=utf-8']],
]);

const SECURITY_HEADERS = {
  'Cache-Control': 'no-store',
  'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
};

const unavailable = () => ({ error: 'Mailbox unavailable. Check GitHub CLI authentication and network connectivity, then retry.' });

function displayLabel(state, value) {
  if (value === 'team') return 'Team';
  const agents = Object.values(state.agents ?? {});
  const agent = agents.find(candidate => candidate?.id === value);
  if (!agent && typeof value === 'string') {
    const owner = agents.find(candidate => typeof candidate?.owner === 'string' && candidate.owner.toLowerCase() === value.toLowerCase())?.owner;
    if (owner) return `${owner} (all registered workers)`;
  }
  if (!agent) return typeof value === 'string' ? value : 'Unknown';
  const label = typeof agent.label === 'string' && agent.label.trim() ? agent.label.trim() : 'Agent';
  const owner = typeof agent.owner === 'string' && agent.owner.trim() ? agent.owner.trim() : '';
  return owner ? `${label} (${owner})` : label;
}

function publicHistory(repo, state, fetchedAt) {
  for (const message of state.messages) {
    const valid = message
      && ['id', 'from', 'to', 'kind', 'body'].every(field => typeof message[field] === 'string')
      && Number.isSafeInteger(message.sequence)
      && (Number.isFinite(message.createdAt)
        || (typeof message.createdAt === 'string' && Number.isFinite(Date.parse(message.createdAt))));
    if (!valid) throw new Error('Malformed mailbox message');
  }
  return {
    repo: typeof repo === 'string' ? repo : 'unknown',
    fetchedAt: new Date(fetchedAt).toISOString(),
    messages: state.messages.map(message => ({
      id: message.id,
      sequence: message.sequence,
      from: message.from,
      to: message.to,
      kind: message.kind,
      body: message.body,
      createdAt: message.createdAt,
      replyTo: typeof message.replyTo === 'string' ? message.replyTo : null,
      fromLabel: displayLabel(state, message.from),
      toLabel: displayLabel(state, message.to),
    })),
  };
}

function sendJson(response, status, value) {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    ...SECURITY_HEADERS,
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  response.end(body);
}

function sendText(response, status, text) {
  response.writeHead(status, {
    ...SECURITY_HEADERS,
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
  });
  response.end(text);
}

export function createViewer({
  store,
  assetDirectory = VIEWER_DIRECTORY,
  cacheMs = DEFAULT_CACHE_MS,
  failureCacheMs = DEFAULT_FAILURE_CACHE_MS,
  now = Date.now,
} = {}) {
  if (!store || typeof store.read !== 'function') throw new TypeError('A mailbox store with read() is required');
  if (!Number.isFinite(cacheMs) || cacheMs < 0 || !Number.isFinite(failureCacheMs) || failureCacheMs < 0) {
    throw new TypeError('Cache durations must be non-negative numbers');
  }

  let cached;
  let pending;
  let failedUntil = 0;

  const history = async () => {
    const timestamp = now();
    if (cached && timestamp < cached.expiresAt) return cached.value;
    if (timestamp < failedUntil) throw new Error('temporarily unavailable');
    if (pending) return pending;

    pending = (async () => {
      try {
        const { state } = await store.read();
        const fetchedAt = now();
        const value = {state,fetchedAt};
        cached = { value, expiresAt: fetchedAt + cacheMs };
        failedUntil = 0;
        return value;
      } catch {
        cached = undefined;
        failedUntil = now() + failureCacheMs;
        throw new Error('temporarily unavailable');
      } finally {
        pending = undefined;
      }
    })();
    return pending;
  };

  const server = createServer(async (request, response) => {
    const address = server.address();
    const port = address && typeof address === 'object' ? address.port : undefined;
    const expectedHost = `127.0.0.1:${port}`;
    const expectedOrigin = `http://${expectedHost}`;

    if (request.headers.host !== expectedHost) {
      sendText(response, 403, 'Forbidden');
      return;
    }
    if ((request.headers.origin && request.headers.origin !== expectedOrigin)
      || request.headers['sec-fetch-site']?.toLowerCase() === 'cross-site') {
      sendText(response, 403, 'Forbidden');
      return;
    }
    if (request.method !== 'GET') {
      response.setHeader('Allow', 'GET');
      sendText(response, 405, 'Method Not Allowed');
      return;
    }
    if (typeof request.url !== 'string' || !request.url.startsWith('/') || request.url.startsWith('//') || request.url.includes('\\')) {
      sendText(response, 400, 'Bad Request');
      return;
    }

    let url;
    try {
      url = new URL(request.url, expectedOrigin);
    } catch {
      sendText(response, 400, 'Bad Request');
      return;
    }

    if (url.pathname === '/api/messages' || url.pathname === '/api/dashboard') {
      try {
        const {state,fetchedAt}=await history();
        const project=url.pathname==='/api/messages'?publicHistory:dashboard;
        sendJson(response, 200, project(store.repo ?? 'unknown',state,fetchedAt));
      } catch {
        sendJson(response, 503, unavailable());
      }
      return;
    }

    const asset = ASSETS.get(url.pathname);
    if (!asset) {
      sendText(response, 404, 'Not Found');
      return;
    }
    try {
      const body = await readFile(join(assetDirectory, asset[0]));
      response.writeHead(200, {
        ...SECURITY_HEADERS,
        'Content-Type': asset[1],
        'Content-Length': body.length,
      });
      response.end(body);
    } catch {
      sendText(response, 404, 'Not Found');
    }
  });

  return server;
}

export async function listenViewer({ port = DEFAULT_PORT, host = '127.0.0.1', ...options } = {}) {
  if (host !== '127.0.0.1') throw new Error('Viewer host must be 127.0.0.1');
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Port must be an integer from 0 through 65535');
  const server = createViewer(options);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve();
    });
  });
  return server;
}

function cliPort(args) {
  let port = DEFAULT_PORT;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    const value = argument === '--port' ? args[++index] : argument.startsWith('--port=') ? argument.slice(7) : undefined;
    if (value === undefined) throw new Error(`Unknown argument: ${argument}`);
    if (!/^\d+$/.test(value)) throw new Error('Port must be an integer from 0 through 65535');
    port = Number(value);
    if (port > 65535) throw new Error('Port must be an integer from 0 through 65535');
  }
  return port;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const port = cliPort(process.argv.slice(2));
  const store = new GitHubStore();
  const server = await listenViewer({ store, port });
  const actualPort = server.address().port;
  process.stdout.write(`Dead Drop workspace\nOpen http://127.0.0.1:${actualPort}\n\nRead-only view. Closing it does not stop configured agent wake schedules.\nPress Ctrl+C to stop this viewer.\n`);
}
