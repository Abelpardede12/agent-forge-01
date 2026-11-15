// CoreForge REST v3: repositories, branches, commits, contents-as-commits, issues, labels,
// comments and pull requests with real three-way merges. Every reply is JSON and carries
// X-GitHub-Request-Id; a missing token is 401; a foreign owner is 404, never 403.

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  VIEWER,
  VIEWER_LOGIN,
  commitFile,
  createIssue,
  createLabel,
  createPull,
  createRepo,
  deleteFile,
  getRepo,
  issueJson,
  labelJson,
  listCommits,
  listViewerRepos,
  mergePull,
  pullFiles,
  pullJson,
  readPath,
  repoJson,
  resolveCommit,
  store,
  type Repo,
} from './store.ts';
import { isObjectId, parseCommit } from './git.ts';

const JSON_TYPE = 'application/json; charset=utf-8';

function sendJson(res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): void {
  if (status === 204) {
    res.writeHead(204, extra);
    res.end();
    return;
  }
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, { 'content-type': JSON_TYPE, 'content-length': Buffer.byteLength(text), ...extra });
  res.end(text);
}

function notFound(res: ServerResponse): void {
  sendJson(res, 404, { message: 'Not Found' });
}

function badRequest(res: ServerResponse, message: string): void {
  sendJson(res, 400, { message });
}

async function readRawBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

type JsonObject = Record<string, unknown>;

function asObject(value: unknown): JsonObject | null {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) return value as JsonObject;
  return null;
}

function queryOf(url: URL): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of url.searchParams.entries()) out[key] = value;
  return out;
}

/** Paginate a list the GitHub way: per_page/page + a Link header with absolute URLs. */
function paginate<T>(req: IncomingMessage, url: URL, items: readonly T[]): { page: T[]; link: string | null } {
  const query = queryOf(url);
  const perPage = Math.max(1, Math.min(100, Number.parseInt(query.per_page ?? '30', 10) || 30));
  const page = Math.max(1, Number.parseInt(query.page ?? '1', 10) || 1);
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  const totalPages = Math.max(1, Math.ceil(items.length / perPage));
  const base = `http://${req.headers.host ?? 'localhost'}${url.pathname}`;
  const linkFor = (p: number, rel: string): string => {
    const u = new URL(base);
    for (const [key, value] of url.searchParams.entries()) {
      if (key !== 'page') u.searchParams.set(key, value);
    }
    u.searchParams.set('per_page', String(perPage));
    u.searchParams.set('page', String(p));
    return `<${u.toString()}>; rel="${rel}"`;
  };
  const links: string[] = [];
  if (page < totalPages) links.push(linkFor(page + 1, 'next'));
  if (page > 1) links.push(linkFor(page - 1, 'prev'));
  if (totalPages > 1) {
    links.push(linkFor(1, 'first'));
    links.push(linkFor(totalPages, 'last'));
  }
  return { page: [...slice], link: links.length > 0 ? links.join(', ') : null };
}

function linkHeader(req: IncomingMessage, url: URL, total: number): string | null {
  return paginate(req, url, new Array(total).fill(0)).link;
}

/** The repo a route names, or null (missing, foreign owner, or deleted). */
function routeRepo(owner: string, name: string): Repo | null {
  if (owner !== VIEWER_LOGIN) return null;
  return getRepo(store, owner, name) ?? null;
}

function commitJson(repo: Repo, oid: string): Record<string, unknown> {
  const object = repo.objects.get(oid);
  if (object === undefined || object.type !== 'commit') return { sha: oid, commit: { message: '' } };
  const commit = parseCommit(object.data);
  const who = (line: string): Record<string, unknown> => {
    const match = /^(.*) <(.*)> (\d+) ([+-]\d{4})$/.exec(line);
    if (match === null) return { name: line, email: '', date: '' };
    return { name: match[1], email: match[2], date: new Date(Number(match[3]) * 1000).toISOString() };
  };
  return {
    sha: oid,
    commit: { message: commit.message, author: who(commit.author), committer: who(commit.committer) },
    author: { login: VIEWER_LOGIN },
    committer: { login: VIEWER_LOGIN },
    parents: commit.parents.map((parent) => ({ sha: parent })),
    url: `/api/v3/repos/${repo.owner}/${repo.name}/commits/${oid}`,
  };
}

/** Handle a REST v3 request; true when the path is under /api/v3. */
export async function handleRest(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const url = new URL(req.url ?? '/', 'http://entry');
  if (!url.pathname.startsWith('/api/v3')) return false;
  const method = req.method ?? 'GET';
  const segments = url.pathname
    .slice('/api/v3'.length)
    .split('/')
    .filter((part) => part !== '')
    .map((part) => decodeURIComponent(part));

  // --- auth: every /api/v3 call needs the trial bearer token.
  const auth = req.headers.authorization ?? '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  const tokenOk = token !== '' && (store.token === '' || token === store.token);
  if (!tokenOk) {
    sendJson(res, 401, { message: 'Requires authentication' });
    return true;
  }

  // --- body (JSON where one is sent; malformed JSON is a 400).
  let body: unknown = undefined;
  if (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE') {
    const raw = await readRawBody(req);
    if (raw.length > 0) {
      try {
        body = JSON.parse(raw.toString('utf8'));
      } catch {
        badRequest(res, 'Invalid JSON in request body');
        return true;
      }
    } else {
      body = {};
    }
  }
  const input = asObject(body) ?? {};

  try {
    // --- API root
    if (segments.length === 0) {
      if (method !== 'GET') return methodNotAllowed(res);
      sendJson(res, 200, {
        current_user_url: '/api/v3/user',
        rate_limit_url: '/api/v3/rate_limit',
        repository_url: '/api/v3/repos/{owner}/{repo}',
      }, { 'x-oauth-scopes': 'repo, read:org' });
      return true;
    }
    // --- meta
    if (segments.length === 1 && segments[0] === 'meta') {
      if (method !== 'GET') return methodNotAllowed(res);
      sendJson(res, 200, { installed_version: '1.0.0', verifiable_password_authentication: true });
      return true;
    }
    // --- the viewer
    if (segments.length === 1 && segments[0] === 'user') {
      if (method !== 'GET') return methodNotAllowed(res);
      sendJson(res, 200, {
        login: VIEWER_LOGIN,
        id: VIEWER.id,
        node_id: `User:${VIEWER.id}`,
        name: VIEWER.name,
        email: VIEWER.email,
        type: 'User',
      });
      return true;
    }
    // --- POST /user/repos  +  GET /user/repos
    if (segments.length === 2 && segments[0] === 'user' && segments[1] === 'repos') {
      if (method === 'POST') {
        const name = typeof input.name === 'string' ? input.name.trim() : '';
        if (name === '' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(name)) {
          sendJson(res, 422, { message: 'Validation Failed: name is invalid' });
          return true;
        }
        const created = createRepo(store, VIEWER_LOGIN, name, {
          description: typeof input.description === 'string' ? input.description : '',
          isPrivate: input.private === true,
        });
        if (created === null) {
          sendJson(res, 422, { message: `Repository ${VIEWER_LOGIN}/${name} already exists` });
          return true;
        }
        sendJson(res, 201, repoJson(store, created));
        return true;
      }
      if (method === 'GET') {
        const repos = listViewerRepos(store, VIEWER_LOGIN);
        const { page, link } = paginate(req, url, repos.map((repo) => repoJson(store, repo)));
        sendJson(res, 200, page, link === null ? {} : { link });
        return true;
      }
      return methodNotAllowed(res);
    }
    // --- /repos/{owner}/{name}/...
    if (segments.length >= 3 && segments[0] === 'repos') {
      const owner = segments[1];
      const name = segments[2];
      const tail = segments.slice(3);
      const repo = routeRepo(owner, name);
      if (repo === null) {
        notFound(res);
        return true;
      }
      // --- the repository itself
      if (tail.length === 0) {
        if (method === 'GET') {
          sendJson(res, 200, repoJson(store, repo));
          return true;
        }
        if (method === 'PATCH') {
          if (typeof input.description === 'string') repo.description = input.description;
          if (typeof input.private === 'boolean') repo.isPrivate = input.private;
          sendJson(res, 200, repoJson(store, repo));
          return true;
        }
        if (method === 'DELETE') {
          repo.deleted = true;
          sendJson(res, 204, null);
          return true;
        }
        return methodNotAllowed(res);
      }
      // --- branches
      if (tail.length === 1 && tail[0] === 'branches') {
        if (method !== 'GET') return methodNotAllowed(res);
        const branches: Array<Record<string, unknown>> = [];
        for (const ref of [...repo.refs.keys()].filter((key) => key.startsWith('refs/heads/')).sort()) {
          branches.push({
            name: ref.slice('refs/heads/'.length),
            commit: { sha: repo.refs.get(ref) },
            protected: false,
          });
        }
        sendJson(res, 200, branches);
        return true;
      }
      // --- commits
      if (tail.length === 1 && tail[0] === 'commits') {
        if (method !== 'GET') return methodNotAllowed(res);
        const shaParam = queryOf(url).sha ?? repo.defaultBranch;
        const tip = resolveCommit(repo, shaParam);
        if (tip === null) {
          notFound(res);
          return true;
        }
        const commits = listCommits(repo, tip).map((oid) => commitJson(repo, oid));
        const { page, link } = paginate(req, url, commits);
        sendJson(res, 200, page, link === null ? {} : { link });
        return true;
      }
      // --- contents
      if (tail.length >= 1 && tail[0] === 'contents') {
        const path = tail.slice(1).join('/');
        if (method === 'GET') {
          const ref = queryOf(url).ref ?? repo.defaultBranch;
          const read = readPath(repo, ref, path);
          if (read === null) {
            notFound(res);
            return true;
          }
          if (read.kind === 'dir') {
            sendJson(res, 200, read.entries.map((entry) => ({
              type: entry.type,
              name: entry.name,
              path: entry.path,
              sha: entry.oid,
              size: entry.type === 'dir' ? 0 : (repo.objects.get(entry.oid)?.data.length ?? 0),
              url: `/api/v3/repos/${owner}/${name}/contents/${entry.path}`,
            })));
            return true;
          }
          sendJson(res, 200, {
            type: 'file',
            encoding: 'base64',
            content: read.data.toString('base64'),
            sha: read.blobOid,
            size: read.data.length,
            name: path.split('/').pop() ?? path,
            path,
            url: `/api/v3/repos/${owner}/${name}/contents/${path}`,
          });
          return true;
        }
        if (method === 'PUT') {
          const message = typeof input.message === 'string' ? input.message : 'Update file';
          const content = typeof input.content === 'string' ? Buffer.from(input.content.replace(/\s+/g, ''), 'base64') : null;
          if (content === null) {
            sendJson(res, 422, { message: 'Validation Failed: content is required' });
            return true;
          }
          const branch = typeof input.branch === 'string' ? input.branch : undefined;
          const sha = typeof input.sha === 'string' ? input.sha : undefined;
          const result = commitFile(store, repo, { branch, path, content, message, sha });
          if (!result.ok) {
            sendJson(res, result.status, { message: result.message ?? 'error' });
            return true;
          }
          sendJson(res, result.status, {
            content: {
              name: path.split('/').pop() ?? path,
              path,
              sha: result.contentSha,
              size: content.length,
              type: 'file',
              encoding: 'base64',
            },
            commit: { sha: result.commitSha, message },
          });
          return true;
        }
        if (method === 'DELETE') {
          const message = typeof input.message === 'string' ? input.message : 'Delete file';
          const sha = typeof input.sha === 'string' ? input.sha : undefined;
          const branch = typeof input.branch === 'string' ? input.branch : undefined;
          const result = deleteFile(store, repo, { branch, path, message, sha });
          if (!result.ok) {
            sendJson(res, result.status, { message: result.message ?? 'error' });
            return true;
          }
          sendJson(res, 200, { commit: { sha: result.commitSha, message } });
          return true;
        }
        return methodNotAllowed(res);
      }
      // --- git refs (branch create)
      if (tail.length === 2 && tail[0] === 'git' && tail[1] === 'refs') {
        if (method !== 'POST') return methodNotAllowed(res);
        const ref = typeof input.ref === 'string' ? input.ref : '';
        const sha = typeof input.sha === 'string' ? input.sha : '';
        if (!ref.startsWith('refs/') || !isObjectId(sha) || !repo.objects.has(sha)) {
          sendJson(res, 422, { message: 'Validation Failed: ref or sha is invalid' });
          return true;
        }
        if (repo.refs.has(ref)) {
          sendJson(res, 422, { message: `Reference ${ref} already exists` });
          return true;
        }
        repo.refs.set(ref, sha);
        sendJson(res, 201, {
          ref,
          node_id: `Ref:${ref}`,
          url: `/api/v3/repos/${owner}/${name}/git/refs/${encodeURIComponent(ref)}`,
          object: { sha, type: repo.objects.get(sha)?.type ?? 'commit', url: '' },
        });
        return true;
      }
      // --- labels
      if (tail.length === 1 && tail[0] === 'labels') {
        if (method === 'POST') {
          const labelName = typeof input.name === 'string' ? input.name.trim() : '';
          if (labelName === '') {
            sendJson(res, 422, { message: 'Validation Failed: name is required' });
            return true;
          }
          const label = createLabel(store, repo, {
            name: labelName,
            color: typeof input.color === 'string' ? input.color : 'ededed',
            description: typeof input.description === 'string' ? input.description : '',
          });
          if (label === null) {
            sendJson(res, 422, { message: `Label ${labelName} already exists` });
            return true;
          }
          sendJson(res, 201, labelJson(label));
          return true;
        }
        if (method === 'GET') {
          sendJson(res, 200, [...repo.labels.values()].map((label) => labelJson(label)));
          return true;
        }
        return methodNotAllowed(res);
      }
      // --- issues
      if (tail.length >= 1 && tail[0] === 'issues') {
        if (tail.length === 1) {
          if (method === 'GET') {
            const query = queryOf(url);
            const state = query.state ?? 'open';
            const sort = query.sort ?? 'created';
            const direction = query.direction ?? 'desc';
            let issues = repo.issues.filter((issue) => state === 'all' || issue.state === state);
            issues = [...issues].sort((a, b) => {
              const bySeq = sort === 'created' ? a.seq - b.seq : a.number - b.number;
              return direction === 'asc' ? bySeq : -bySeq;
            });
            const { page, link } = paginate(req, url, issues.map((issue) => issueJson(repo, issue)));
            sendJson(res, 200, page, link === null ? {} : { link });
            return true;
          }
          if (method === 'POST') {
            const title = typeof input.title === 'string' ? input.title : '';
            if (title === '') {
              sendJson(res, 422, { message: 'Validation Failed: title is required' });
              return true;
            }
            const labels = Array.isArray(input.labels) ? input.labels.filter((item): item is string => typeof item === 'string') : [];
            const result = createIssue(store, repo, {
              title,
              body: typeof input.body === 'string' ? input.body : '',
              labels,
            });
            if ('error' in result) {
              sendJson(res, 422, { message: `Validation Failed: ${result.error}` });
              return true;
            }
            sendJson(res, 201, issueJson(repo, result.issue));
            return true;
          }
          return methodNotAllowed(res);
        }
        const number = Number.parseInt(tail[1], 10);
        const issue = repo.issues.find((candidate) => candidate.number === number);
        if (issue === undefined) {
          notFound(res);
          return true;
        }
        if (tail.length === 2) {
          if (method === 'GET') {
            sendJson(res, 200, issueJson(repo, issue));
            return true;
          }
          if (method === 'PATCH') {
            if (typeof input.title === 'string') issue.title = input.title;
            if (typeof input.body === 'string') issue.body = input.body;
            if (input.state === 'open' || input.state === 'closed') {
              issue.state = input.state;
              issue.closedAt = input.state === 'closed' ? issue.closedAt ?? new Date((1735689600 + store.seq) * 1000).toISOString() : null;
            }
            if (Array.isArray(input.labels)) {
              const labels = input.labels.filter((item): item is string => typeof item === 'string');
              if (labels.every((name) => repo.labels.has(name))) issue.labels = labels;
              else {
                sendJson(res, 422, { message: 'Validation Failed: an unknown label was supplied' });
                return true;
              }
            }
            const seq = store.seq + 1;
            store.seq = seq;
            issue.updatedAt = new Date((1735689600 + seq) * 1000).toISOString();
            sendJson(res, 200, issueJson(repo, issue));
            return true;
          }
          return methodNotAllowed(res);
        }
        if (tail.length === 3 && tail[2] === 'comments') {
          if (method === 'GET') {
            const { page, link } = paginate(req, url, issue.comments.map((comment) => ({
              id: comment.id,
              node_id: `IssueComment:${comment.id}`,
              body: comment.body,
              user: { login: VIEWER_LOGIN, id: VIEWER.id, type: 'User' },
              created_at: comment.createdAt,
              updated_at: comment.createdAt,
            })));
            sendJson(res, 200, page, link === null ? {} : { link });
            return true;
          }
          if (method === 'POST') {
            const commentBody = typeof input.body === 'string' ? input.body : '';
            if (commentBody === '') {
              sendJson(res, 422, { message: 'Validation Failed: body is required' });
              return true;
            }
            const seq = store.seq + 1;
            store.seq = seq;
            const comment = {
              id: store.nextId,
              body: commentBody,
              userLogin: VIEWER_LOGIN,
              createdAt: new Date((1735689600 + seq) * 1000).toISOString(),
              seq,
            };
            store.nextId += 1;
            issue.comments.push(comment);
            sendJson(res, 201, {
              id: comment.id,
              node_id: `IssueComment:${comment.id}`,
              body: comment.body,
              user: { login: VIEWER_LOGIN, id: VIEWER.id, type: 'User' },
              created_at: comment.createdAt,
              updated_at: comment.createdAt,
            });
            return true;
          }
          return methodNotAllowed(res);
        }
        notFound(res);
        return true;
      }
      // --- pulls
      if (tail.length >= 1 && tail[0] === 'pulls') {
        if (tail.length === 1) {
          if (method === 'GET') {
            const query = queryOf(url);
            const state = query.state ?? 'open';
            let pulls = repo.pulls.filter((pull) => state === 'all' || pull.state === state);
            pulls = [...pulls].sort((a, b) => b.seq - a.seq);
            const { page, link } = paginate(req, url, pulls.map((pull) => pullJson(repo, pull)));
            sendJson(res, 200, page, link === null ? {} : { link });
            return true;
          }
          if (method === 'POST') {
            const title = typeof input.title === 'string' ? input.title : '';
            const head = typeof input.head === 'string' ? input.head : '';
            const base = typeof input.base === 'string' ? input.base : repo.defaultBranch;
            if (title === '' || head === '') {
              sendJson(res, 422, { message: 'Validation Failed: title and head are required' });
              return true;
            }
            const result = createPull(store, repo, {
              title,
              body: typeof input.body === 'string' ? input.body : '',
              head,
              base,
            });
            if ('error' in result) {
              sendJson(res, 422, { message: `Validation Failed: ${result.error}` });
              return true;
            }
            sendJson(res, 201, pullJson(repo, result.pull));
            return true;
          }
          return methodNotAllowed(res);
        }
        const number = Number.parseInt(tail[1], 10);
        const pull = repo.pulls.find((candidate) => candidate.number === number);
        if (pull === undefined) {
          notFound(res);
          return true;
        }
        if (tail.length === 2) {
          if (method !== 'GET') return methodNotAllowed(res);
          sendJson(res, 200, pullJson(repo, pull));
          return true;
        }
        if (tail.length === 3 && tail[2] === 'files') {
          if (method !== 'GET') return methodNotAllowed(res);
          sendJson(res, 200, pullFiles(repo, pull).map((file) => ({
            sha: '',
            filename: file.filename,
            status: file.status,
            additions: file.additions,
            deletions: file.deletions,
            changes: file.changes,
          })));
          return true;
        }
        if (tail.length === 3 && tail[2] === 'merge') {
          if (method !== 'PUT') return methodNotAllowed(res);
          const methodName = typeof input.merge_method === 'string' ? input.merge_method : 'merge';
          if (!['merge', 'squash', 'rebase'].includes(methodName)) {
            sendJson(res, 422, { message: `Validation Failed: unknown merge_method ${methodName}` });
            return true;
          }
          const result = mergePull(store, repo, pull, methodName);
          if (!result.ok) {
            sendJson(res, result.status, { message: result.message ?? 'merge failed' });
            return true;
          }
          sendJson(res, 200, { merged: true, sha: result.sha, message: 'Pull Request successfully merged' });
          return true;
        }
        notFound(res);
        return true;
      }
      notFound(res);
      return true;
    }
    // --- anything else under /api/v3 is a JSON 404.
    notFound(res);
    return true;
  } catch (err) {
    sendJson(res, 500, { message: err instanceof Error ? err.message : 'internal error' });
    return true;
  }
}

function methodNotAllowed(res: ServerResponse): boolean {
  sendJson(res, 405, { message: 'Method Not Allowed' });
  return true;
}
