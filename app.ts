// app.ts — the HTTP wiring: one node:http server that routes the git smart-HTTP protocol,
// the REST v3 API, the GraphQL endpoint, and the MCP endpoint onto the shared forge store.
// Auth is a single bearer token (MAKEFUN_SHOP_TOKEN); every surface except /healthz demands
// it, and every REST answer carries the GitHub-flavoured headers clients look for.

import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { handleInfoRefs, handleReceivePack, handleUploadPackV0, handleV2 } from './gitserver.ts';
import {
  addLabels,
  createComment,
  createIssue,
  createLabel,
  createPull,
  createRef,
  createRepo,
  deleteContents,
  deleteRepo,
  getContents,
  getIssue,
  getRepo,
  listBranches,
  listComments,
  listCommits,
  listIssues,
  listLabels,
  listPullFiles,
  listUserRepos,
  mergePullRest,
  notFound,
  pageCount,
  patchIssue,
  patchRepo,
  putContents,
  unprocessable,
} from './rest.ts';
import type { RestResult } from './rest.ts';
import { executeGraphQL, executeGraphQLBatch } from './graphql.ts';
import type { GraphQLRequest } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { forge, VIEWER } from './store.ts';

const MAX_BODY = 512 * 1024 * 1024;

export function expectedToken(): string {
  return process.env.MAKEFUN_SHOP_TOKEN ?? '';
}

function isAuthorized(req: IncomingMessage): boolean {
  const token = expectedToken();
  if (!token) return false;
  const header = req.headers.authorization ?? '';
  return header === `Bearer ${token}`;
}

function requestId(): string {
  return `forge-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e9).toString(36)}`;
}

function sendJson(res: ServerResponse, status: number, body: unknown, extraHeaders: Record<string, string> = {}): void {
  const text = body === null || body === undefined ? '' : JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'X-GitHub-Request-Id': requestId(),
    'X-OAuth-Scopes': 'repo, read:org',
    ...extraHeaders,
  });
  res.end(text);
}

function sendRest(res: ServerResponse, result: RestResult, linkHeader?: string): void {
  const headers: Record<string, string> = {};
  if (linkHeader) headers.Link = linkHeader;
  sendJson(res, result.status, result.body, headers);
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const parts: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      parts.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(parts)));
    req.on('error', reject);
  });
}

async function readJsonBody(req: IncomingMessage): Promise<{ value: Record<string, unknown> | unknown[] | null; malformed: boolean }> {
  const raw = await readBody(req);
  if (raw.length === 0) return { value: {}, malformed: false };
  try {
    const parsed = JSON.parse(raw.toString('utf8')) as Record<string, unknown> | unknown[];
    return { value: parsed, malformed: false };
  } catch {
    return { value: null, malformed: true };
  }
}

function paginationLink(req: IncomingMessage, total: number): string | undefined {
  const url = new URL(req.url ?? '/', 'http://forge.local');
  const query = url.searchParams;
  const pages = pageCount(total, query);
  const page = Math.max(1, Number(query.get('page') ?? '1') || 1);
  if (page >= pages) return undefined;
  const origin = `http://${req.headers.host ?? 'forge.local'}`;
  const build = (target: number): string => {
    const params = new URLSearchParams(query);
    params.set('page', String(target));
    return `${origin}${url.pathname}?${params.toString()}`;
  };
  return `<${build(page + 1)}>; rel="next", <${build(pages)}>; rel="last"`;
}

export function createForgeServer(): Server {
  const server = createServer((req, res) => {
    handleRequest(req, res).catch(() => {
      if (!res.headersSent) sendJson(res, 500, { message: 'Internal Server Error' });
      else res.end();
    });
  });
  server.headersTimeout = 30_000;
  server.requestTimeout = 0;
  return server;
}

async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://forge.local');
  const path = url.pathname;
  const method = req.method ?? 'GET';

  if (path === '/healthz' && method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{"ok":true}');
    return;
  }

  // The git protocol lives at /{owner}/{repo}.git/... and speaks its own content types.
  const gitMatch = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(path);
  if (gitMatch) {
    if (!isAuthorized(req)) {
      sendJson(res, 401, { message: 'Requires authentication' });
      return;
    }
    const [, owner, name, action] = gitMatch;
    const repo = forge.getRepo(owner, name);
    if (!repo) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('repository not found\n');
      return;
    }
    if (action === 'info/refs' && method === 'GET') {
      const service = url.searchParams.get('service') ?? '';
      const protocolV2 = (req.headers['git-protocol'] ?? '').toString().includes('version=2');
      const result = handleInfoRefs(repo, service, protocolV2);
      res.writeHead(result.status, { 'Content-Type': result.contentType });
      res.end(result.body);
      return;
    }
    if (action === 'git-upload-pack' && method === 'POST') {
      const body = await readBody(req);
      const protocolV2 = (req.headers['git-protocol'] ?? '').toString().includes('version=2');
      const result = protocolV2
        ? handleV2(repo, body)
        : handleUploadPackV0(repo, body);
      res.writeHead(result.status, { 'Content-Type': result.contentType });
      res.end(result.body);
      return;
    }
    if (action === 'git-receive-pack' && method === 'POST') {
      const body = await readBody(req);
      try {
        const result = handleReceivePack(repo, body);
        res.writeHead(result.status, { 'Content-Type': result.contentType });
        res.end(result.body);
      } catch {
        res.writeHead(400, { 'Content-Type': 'text/plain' });
        res.end('bad request\n');
      }
      return;
    }
    res.writeHead(405, { 'Content-Type': 'text/plain' });
    res.end('method not allowed\n');
    return;
  }

  if (!isAuthorized(req)) {
    sendJson(res, 401, { message: 'Requires authentication' });
    return;
  }

  if (path === '/mcp') {
    if (method === 'GET') {
      res.writeHead(405, { 'Content-Type': 'application/json', Allow: 'POST' });
      res.end(JSON.stringify({ message: 'Method Not Allowed' }));
      return;
    }
    if (method === 'DELETE') {
      res.writeHead(405, { 'Content-Type': 'application/json', Allow: 'POST' });
      res.end(JSON.stringify({ message: 'Method Not Allowed' }));
      return;
    }
    const raw = (await readBody(req)).toString('utf8');
    const result = handleMcp(raw);
    res.writeHead(result.status, { 'Content-Type': 'application/json' });
    res.end(result.body);
    return;
  }

  if (path === '/api/graphql' && method === 'POST') {
    const { value, malformed } = await readJsonBody(req);
    if (malformed) {
      sendJson(res, 400, { message: 'Problems parsing JSON' });
      return;
    }
    if (Array.isArray(value)) {
      const results = executeGraphQLBatch(value as GraphQLRequest[]);
      sendJson(res, 200, results);
      return;
    }
    const result = executeGraphQL((value ?? {}) as unknown as GraphQLRequest);
    sendJson(res, 200, result);
    return;
  }

  if (path === '/api/v3' || path === '/api/v3/') {
    if (method === 'GET') {
      sendJson(res, 200, {
        current_user_url: '/api/v3/user',
        repository_url: '/api/v3/repos/{owner}/{repo}',
        issue_url: '/api/v3/repos/{owner}/{repo}/issues/{number}',
      });
      return;
    }
  }
  if (path === '/api/v3/meta' && method === 'GET') {
    sendJson(res, 200, { installed_version: '1.0.0-forge', hooks: [], github_services_sha: 'forge' });
    return;
  }
  if (path === '/api/v3/user' && method === 'GET') {
    sendJson(res, 200, { login: VIEWER.login, id: VIEWER.id, type: 'User', name: VIEWER.name, email: VIEWER.email });
    return;
  }
  if (path === '/api/v3/user/repos') {
    if (method === 'POST') {
      const { value, malformed } = await readJsonBody(req);
      if (malformed) return sendRest(res, { status: 400, body: { message: 'Problems parsing JSON' } });
      return sendRest(res, createRepo((value ?? {}) as Record<string, unknown>));
    }
    if (method === 'GET') {
      const total = forge.reposOf(VIEWER.login).length;
      return sendRest(res, listUserRepos(url.searchParams), paginationLink(req, total));
    }
  }

  const repoMatch = /^\/api\/v3\/repos\/([^/]+)\/([^/]+)(?:\/(.*))?$/.exec(path);
  if (repoMatch) {
    const [, owner, name, rest] = repoMatch;
    const tail = rest ?? '';
    if (tail === '' ) {
      if (method === 'GET') return sendRest(res, getRepo(owner, name));
      if (method === 'PATCH') {
        const { value, malformed } = await readJsonBody(req);
        if (malformed) return sendRest(res, { status: 400, body: { message: 'Problems parsing JSON' } });
        return sendRest(res, patchRepo(owner, name, (value ?? {}) as Record<string, unknown>));
      }
      if (method === 'DELETE') return sendRest(res, deleteRepo(owner, name));
    }
    const repo = forge.getRepo(owner, name);
    if (!repo) return sendRest(res, notFound());
    return routeRepoTail(req, res, repo, tail, method, url);
  }

  return sendRest(res, notFound());
}

async function routeRepoTail(
  req: IncomingMessage,
  res: ServerResponse,
  repo: ReturnType<typeof forge.getRepo> & object,
  tail: string,
  method: string,
  url: URL,
): Promise<void> {
  const json = async (): Promise<Record<string, unknown> | null> => {
    const { value, malformed } = await readJsonBody(req);
    if (malformed) {
      sendRest(res, { status: 400, body: { message: 'Problems parsing JSON' } });
      return null;
    }
    return (value ?? {}) as Record<string, unknown>;
  };
  const segments = tail.split('/').filter(Boolean);

  if (tail === 'branches' && method === 'GET') return sendRest(res, listBranches(repo));
  if (tail === 'git/refs' && method === 'POST') {
    const body = await json();
    if (body) sendRest(res, createRef(repo, body));
    return;
  }
  if (tail === 'commits' && method === 'GET') return sendRest(res, listCommits(repo, url.searchParams));
  if (segments[0] === 'contents') {
    const contentPath = segments.slice(1).map(decodeURIComponent).join('/');
    if (method === 'GET') return sendRest(res, getContents(repo, contentPath, url.searchParams));
    if (method === 'PUT') {
      const body = await json();
      if (body) {
        // The branch may ride in the query string instead of the body.
        const branch = url.searchParams.get('branch');
        if (branch && typeof body.branch !== 'string') body.branch = branch;
        sendRest(res, putContents(repo, contentPath, body));
      }
      return;
    }
    if (method === 'DELETE') {
      const body = await json();
      if (body) {
        const branch = url.searchParams.get('branch');
        if (branch && typeof body.branch !== 'string') body.branch = branch;
        sendRest(res, deleteContents(repo, contentPath, body));
      }
      return;
    }
  }
  if (tail === 'labels' && method === 'GET') return sendRest(res, listLabels(repo));
  if (tail === 'labels' && method === 'POST') {
    const body = await json();
    if (body) sendRest(res, createLabel(repo, body));
    return;
  }
  if (tail === 'issues' && method === 'POST') {
    const body = await json();
    if (body) sendRest(res, createIssue(repo, body));
    return;
  }
  if (tail === 'issues' && method === 'GET') {
    const total = [...repo.issues.values()].filter((record) => !record.isPull).length;
    return sendRest(res, listIssues(repo, url.searchParams, false), paginationLinkFor(req, url, total));
  }
  if (tail === 'pulls' && method === 'POST') {
    const body = await json();
    if (body) sendRest(res, createPull(repo, body));
    return;
  }
  if (tail === 'pulls' && method === 'GET') {
    const total = [...repo.issues.values()].filter((record) => record.isPull).length;
    return sendRest(res, listIssues(repo, url.searchParams, true), paginationLinkFor(req, url, total));
  }
  const issueMatch = /^issues\/(\d+)$/.exec(tail);
  if (issueMatch) {
    const number = Number(issueMatch[1]);
    if (method === 'GET') return sendRest(res, getIssue(repo, number));
    if (method === 'PATCH') {
      const body = await json();
      if (body) sendRest(res, patchIssue(repo, number, body));
      return;
    }
  }
  const labelsMatch = /^issues\/(\d+)\/labels$/.exec(tail);
  if (labelsMatch && method === 'POST') {
    const body = await json();
    if (body) sendRest(res, addLabels(repo, Number(labelsMatch[1]), body));
    return;
  }
  const commentsMatch = /^issues\/(\d+)\/comments$/.exec(tail);
  if (commentsMatch) {
    const number = Number(commentsMatch[1]);
    if (method === 'POST') {
      const body = await json();
      if (body) sendRest(res, createComment(repo, number, body));
      return;
    }
    if (method === 'GET') return sendRest(res, listComments(repo, number));
  }
  const pullMatch = /^pulls\/(\d+)$/.exec(tail);
  if (pullMatch) {
    const number = Number(pullMatch[1]);
    if (method === 'GET') return sendRest(res, getIssue(repo, number));
    if (method === 'PATCH') {
      const body = await json();
      if (body) sendRest(res, patchIssue(repo, number, body));
      return;
    }
  }
  const pullFilesMatch = /^pulls\/(\d+)\/files$/.exec(tail);
  if (pullFilesMatch && method === 'GET') return sendRest(res, listPullFiles(repo, Number(pullFilesMatch[1])));
  const pullMergeMatch = /^pulls\/(\d+)\/merge$/.exec(tail);
  if (pullMergeMatch && method === 'PUT') {
    const body = await json();
    if (body) sendRest(res, mergePullRest(repo, Number(pullMergeMatch[1]), body));
    return;
  }
  void unprocessable;
  return sendRest(res, notFound());
}

function paginationLinkFor(req: IncomingMessage, url: URL, total: number): string | undefined {
  const pages = pageCount(total, url.searchParams);
  const page = Math.max(1, Number(url.searchParams.get('page') ?? '1') || 1);
  if (page >= pages) return undefined;
  const origin = `http://${req.headers.host ?? 'forge.local'}`;
  const next = new URLSearchParams(url.searchParams);
  next.set('page', String(page + 1));
  return `<${origin}${url.pathname}?${next.toString()}>; rel="next"`;
}
