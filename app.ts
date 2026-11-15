// HTTP front door: routing, Bearer auth, JSON body parsing, request ids and
// JSON error replies. Surfaces: git smart HTTP, REST v3, GraphQL v4, MCP.

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { Store } from './store.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { restHandlers, type Ctx } from './rest.ts';
import {
  handleInfoRefs,
  handleReceivePack,
  handleUploadPack,
} from './gitserver.ts';

export function createApp(store: Store, token: string): ReturnType<typeof createServer> {
  const server = createServer((req, res) => {
    void handleRequest(store, token, req, res).catch((err: unknown) => {
      if (!res.headersSent) {
        sendJson(res, 500, { message: `internal error: ${(err as Error).message}` });
      } else {
        res.destroy();
      }
    });
  });
  return server;
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const payload = body === null ? '' : JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'X-GitHub-Request-Id': randomUUID(),
    'Content-Length': Buffer.byteLength(payload),
    ...headers,
  });
  res.end(payload);
}

function sendBytes(res: ServerResponse, status: number, contentType: string, body: Buffer): void {
  res.writeHead(status, {
    'Content-Type': contentType,
    'X-GitHub-Request-Id': randomUUID(),
    'Content-Length': body.length,
  });
  res.end(body);
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
      if (Buffer.concat(chunks).length > 64 * 1024 * 1024) {
        reject(new Error('request body too large'));
        req.destroy();
      }
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function bearerToken(req: IncomingMessage): string | null {
  const header = req.headers.authorization;
  if (typeof header !== 'string') return null;
  const match = /^Bearer\s+(.+)$/.exec(header);
  return match ? match[1]!.trim() : null;
}

async function handleRequest(store: Store, token: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  const path = url.pathname;
  const method = req.method ?? 'GET';

  if (path === '/healthz') {
    sendJson(res, 200, { ok: true });
    return;
  }

  // Git smart HTTP lives under /<owner>/<repo>.git/...
  const gitMatch = /^\/([^/]+)\/([^/]+)\.git\/(.+)$/.exec(path);
  if (gitMatch) {
    const owner = decodeURIComponent(gitMatch[1]!);
    const repoName = decodeURIComponent(gitMatch[2]!);
    const suffix = gitMatch[3]!;
    if (bearerToken(req) !== token) {
      sendBytes(res, 401, 'text/plain; charset=utf-8', Buffer.from('unauthorized\n', 'utf8'));
      return;
    }
    if (suffix === 'info/refs' && method === 'GET') {
      const protocol = req.headers['git-protocol'] === 'version=2' ? '2' : '0';
      const result = handleInfoRefs(store, owner, repoName, null, url.searchParams, protocol);
      sendBytes(res, result.status, result.contentType, result.body);
      return;
    }
    if (suffix === 'git-upload-pack' && method === 'POST') {
      const body = await readBody(req);
      const protocol = req.headers['git-protocol'] === 'version=2' ? '2' : '0';
      const result = handleUploadPack(store, owner, repoName, body, protocol);
      sendBytes(res, result.status, result.contentType, result.body);
      return;
    }
    if (suffix === 'git-receive-pack' && method === 'POST') {
      const body = await readBody(req);
      const result = handleReceivePack(store, owner, repoName, body);
      sendBytes(res, result.status, result.contentType, result.body);
      return;
    }
    sendBytes(res, 404, 'text/plain; charset=utf-8', Buffer.from('not found\n', 'utf8'));
    return;
  }

  // Everything else is JSON and needs the bearer token.
  if (bearerToken(req) !== token) {
    sendJson(res, 401, { message: 'Requires authentication' });
    return;
  }

  if (path === '/api/graphql' && method === 'POST') {
    const raw = await readBody(req);
    let body: unknown;
    try {
      body = JSON.parse(raw.toString('utf8'));
    } catch {
      sendJson(res, 400, { errors: [{ message: 'request body is not valid JSON' }] });
      return;
    }
    sendJson(res, 200, handleGraphQL(store, body));
    return;
  }

  if (path === '/mcp' && method === 'POST') {
    const raw = await readBody(req);
    let body: unknown;
    try {
      body = JSON.parse(raw.toString('utf8'));
    } catch {
      sendJson(res, 400, {
        jsonrpc: '2.0',
        id: null,
        error: { code: -32700, message: 'parse error' },
      });
      return;
    }
    const outcome = handleMcp(store, body);
    sendJson(res, outcome.status, outcome.body);
    return;
  }

  if (path.startsWith('/api/v3')) {
    const result = await routeRest(store, req, res, url);
    if (result === 'handled') return;
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }

  sendJson(res, 404, { message: 'Not Found' });
}

type Route = {
  readonly method: string;
  readonly pattern: RegExp;
  readonly handler: keyof typeof restHandlers;
  readonly paramNames: string[];
};

const ROUTES: readonly Route[] = [
  { method: 'GET', pattern: /^\/api\/v3\/?$/, handler: 'root', paramNames: [] },
  { method: 'GET', pattern: /^\/api\/v3\/meta$/, handler: 'meta', paramNames: [] },
  { method: 'GET', pattern: /^\/api\/v3\/user$/, handler: 'user', paramNames: [] },
  { method: 'POST', pattern: /^\/api\/v3\/user\/repos$/, handler: 'createUserRepo', paramNames: [] },
  { method: 'GET', pattern: /^\/api\/v3\/user\/repos$/, handler: 'listUserRepos', paramNames: [] },
  { method: 'GET', pattern: /^\/api\/v3\/repos\/([^/]+)\/([^/]+)$/, handler: 'getRepo', paramNames: ['owner', 'repo'] },
  { method: 'PATCH', pattern: /^\/api\/v3\/repos\/([^/]+)\/([^/]+)$/, handler: 'patchRepo', paramNames: ['owner', 'repo'] },
  { method: 'DELETE', pattern: /^\/api\/v3\/repos\/([^/]+)\/([^/]+)$/, handler: 'deleteRepo', paramNames: ['owner', 'repo'] },
  { method: 'GET', pattern: /^\/api\/v3\/repos\/([^/]+)\/([^/]+)\/branches$/, handler: 'listBranches', paramNames: ['owner', 'repo'] },
  { method: 'GET', pattern: /^\/api\/v3\/repos\/([^/]+)\/([^/]+)\/branches\/([^/]+)$/, handler: 'getBranch', paramNames: ['owner', 'repo', 'branch'] },
  { method: 'POST', pattern: /^\/api\/v3\/repos\/([^/]+)\/([^/]+)\/git\/refs$/, handler: 'createRef', paramNames: ['owner', 'repo'] },
  { method: 'GET', pattern: /^\/api\/v3\/repos\/([^/]+)\/([^/]+)\/git\/refs\/(.+)$/, handler: 'getRef', paramNames: ['owner', 'repo', 'refPath'] },
  { method: 'GET', pattern: /^\/api\/v3\/repos\/([^/]+)\/([^/]+)\/commits$/, handler: 'listCommits', paramNames: ['owner', 'repo'] },
  { method: 'GET', pattern: /^\/api\/v3\/repos\/([^/]+)\/([^/]+)\/contents\/(.+)$/, handler: 'getContents', paramNames: ['owner', 'repo', 'path'] },
  { method: 'PUT', pattern: /^\/api\/v3\/repos\/([^/]+)\/([^/]+)\/contents\/(.+)$/, handler: 'putContents', paramNames: ['owner', 'repo', 'path'] },
  { method: 'DELETE', pattern: /^\/api\/v3\/repos\/([^/]+)\/([^/]+)\/contents\/(.+)$/, handler: 'deleteContents', paramNames: ['owner', 'repo', 'path'] },
  { method: 'POST', pattern: /^\/api\/v3\/repos\/([^/]+)\/([^/]+)\/labels$/, handler: 'createLabel', paramNames: ['owner', 'repo'] },
  { method: 'GET', pattern: /^\/api\/v3\/repos\/([^/]+)\/([^/]+)\/labels$/, handler: 'listLabels', paramNames: ['owner', 'repo'] },
  { method: 'POST', pattern: /^\/api\/v3\/repos\/([^/]+)\/([^/]+)\/issues$/, handler: 'createIssue', paramNames: ['owner', 'repo'] },
  { method: 'GET', pattern: /^\/api\/v3\/repos\/([^/]+)\/([^/]+)\/issues$/, handler: 'listIssues', paramNames: ['owner', 'repo'] },
  { method: 'GET', pattern: /^\/api\/v3\/repos\/([^/]+)\/([^/]+)\/issues\/(\d+)$/, handler: 'getIssue', paramNames: ['owner', 'repo', 'number'] },
  { method: 'PATCH', pattern: /^\/api\/v3\/repos\/([^/]+)\/([^/]+)\/issues\/(\d+)$/, handler: 'patchIssue', paramNames: ['owner', 'repo', 'number'] },
  { method: 'POST', pattern: /^\/api\/v3\/repos\/([^/]+)\/([^/]+)\/issues\/(\d+)\/comments$/, handler: 'createIssueComment', paramNames: ['owner', 'repo', 'number'] },
  { method: 'GET', pattern: /^\/api\/v3\/repos\/([^/]+)\/([^/]+)\/issues\/(\d+)\/comments$/, handler: 'listIssueComments', paramNames: ['owner', 'repo', 'number'] },
  { method: 'POST', pattern: /^\/api\/v3\/repos\/([^/]+)\/([^/]+)\/pulls$/, handler: 'createPull', paramNames: ['owner', 'repo'] },
  { method: 'GET', pattern: /^\/api\/v3\/repos\/([^/]+)\/([^/]+)\/pulls$/, handler: 'listPulls', paramNames: ['owner', 'repo'] },
  { method: 'GET', pattern: /^\/api\/v3\/repos\/([^/]+)\/([^/]+)\/pulls\/(\d+)$/, handler: 'getPull', paramNames: ['owner', 'repo', 'number'] },
  { method: 'GET', pattern: /^\/api\/v3\/repos\/([^/]+)\/([^/]+)\/pulls\/(\d+)\/files$/, handler: 'listPullFiles', paramNames: ['owner', 'repo', 'number'] },
  { method: 'PUT', pattern: /^\/api\/v3\/repos\/([^/]+)\/([^/]+)\/pulls\/(\d+)\/merge$/, handler: 'mergePull', paramNames: ['owner', 'repo', 'number'] },
];

async function routeRest(
  store: Store,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<'handled' | 'unmatched'> {
  const path = url.pathname;
  const method = req.method ?? 'GET';
  for (const route of ROUTES) {
    if (route.method !== method) continue;
    const match = route.pattern.exec(path);
    if (!match) continue;
    const params: Record<string, string> = {};
    route.paramNames.forEach((name, index) => {
      params[name] = decodeURIComponent(match[index + 1]!);
    });
    let body: unknown = undefined;
    if (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE') {
      const raw = await readBody(req);
      if (raw.length > 0) {
        try {
          body = JSON.parse(raw.toString('utf8'));
        } catch {
          sendJson(res, 400, { message: 'request body is not valid JSON' });
          return 'handled';
        }
      }
    }
    const origin = `${url.protocol}//${req.headers.host ?? '127.0.0.1'}`;
    const ctx: Ctx = { store, params, query: url.searchParams, body, origin };
    const result = restHandlers[route.handler](ctx);
    sendJson(res, result.status, result.body, result.headers ?? {});
    return 'handled';
  }
  return 'unmatched';
}
