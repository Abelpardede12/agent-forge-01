// rest.ts — GitHub REST v3 handlers over the in-memory store.
// Pure Node, zero dependencies. Erasable TypeScript only.
import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { EMPTY_TREE_OID, ORG, STRANGER, TEAMMATE, VIEWER, createStore } from './store.ts';

type Store = ReturnType<typeof createStore>;
type Json = Record<string, unknown>;
type AuthorIn = { name: string; email: string; epoch: number };

const JSON_CT = 'application/json; charset=utf-8';

function viewerAuthor(): AuthorIn {
  return { name: VIEWER.name, email: VIEWER.email, epoch: Math.floor(Date.now() / 1000) };
}

function isoDate(epoch: number): string {
  return new Date(epoch * 1000).toISOString();
}

function err(status: number, message: string): { status: number; message: string } {
  return { status, message };
}

// ---- local helpers ----

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const payload = body === null || body === undefined ? '' : JSON.stringify(body);
  res.writeHead(status, { 'content-type': JSON_CT, ...headers });
  res.end(payload);
}

function sendEmpty(res: ServerResponse, headers: Record<string, string> = {}): void {
  res.writeHead(204, { 'content-type': JSON_CT, ...headers });
  res.end();
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJson(req: IncomingMessage): Promise<Json> {
  const raw = await readBody(req);
  const text = raw.toString('utf8').trim();
  if (text === '') return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw err(400, 'Problems parsing JSON');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw err(400, 'Problems parsing JSON');
  }
  return parsed as Json;
}

function authed(req: IncomingMessage, token: string): boolean {
  if (token === '') return true;
  const header = req.headers.authorization;
  return header === `Bearer ${token}`;
}

function parseQuery(req: IncomingMessage): URLSearchParams {
  const raw = req.url ?? '/';
  const base = `http://${req.headers.host ?? 'localhost'}`;
  return new URL(raw, base).searchParams;
}

function paginate(list: unknown[], req: IncomingMessage): { page: number; items: unknown[]; linkHeader: string | null } {
  const q = parseQuery(req);
  const perPageRaw = Number(q.get('per_page') ?? '30');
  const perPage = Number.isFinite(perPageRaw) ? Math.min(100, Math.max(1, Math.floor(perPageRaw))) : 30;
  const pageRaw = Number(q.get('page') ?? '1');
  const page = Number.isFinite(pageRaw) ? Math.max(1, Math.floor(pageRaw)) : 1;
  const total = list.length;
  const totalPages = Math.max(1, Math.ceil(total / perPage));
  const start = (page - 1) * perPage;
  const items = list.slice(start, start + perPage);
  if (totalPages <= 1) return { page, items, linkHeader: null };
  const base = `http://${req.headers.host ?? 'localhost'}`;
  const makeUrl = (p: number): string => {
    const u = new URL(req.url ?? '/', base);
    u.searchParams.set('page', String(p));
    u.searchParams.set('per_page', String(perPage));
    return u.toString();
  };
  const parts: string[] = [];
  if (page < totalPages) parts.push(`<${makeUrl(page + 1)}>; rel="next"`);
  if (page > 1) parts.push(`<${makeUrl(page - 1)}>; rel="prev"`);
  parts.push(`<${makeUrl(1)}>; rel="first"`);
  parts.push(`<${makeUrl(totalPages)}>; rel="last"`);
  return { page, items, linkHeader: parts.join(', ') };
}

// ---- JSON shapes ----

function ownerJson(login: string): Json {
  if (login === VIEWER.login) return { login, id: VIEWER.id, type: 'User' };
  if (login === TEAMMATE.login) return { login, id: TEAMMATE.id, type: 'User' };
  if (login === STRANGER.login) return { login, id: STRANGER.id, type: 'User' };
  if (login === ORG) return { login, id: 0, type: 'Organization' };
  return { login, id: 0, type: 'User' };
}

function repoJson(store: Store, repo: ReturnType<Store['getRepo']> & object, host: string): Json {
  const r = repo as NonNullable<ReturnType<Store['getRepo']>>;
  const base = `http://${host}`;
  return {
    id: r.id,
    node_id: `R_${r.id}`,
    name: r.name,
    full_name: r.full_name,
    owner: ownerJson(r.owner),
    private: r.private,
    html_url: `${base}/${r.full_name}`,
    description: r.description,
    fork: false,
    url: `${base}/api/v3/repos/${r.full_name}`,
    created_at: r.created_at,
    updated_at: r.updated_at,
    pushed_at: r.pushed_at,
    git_url: `git://${host}/${r.full_name}.git`,
    ssh_url: `git@github.example.invalid:${r.full_name}.git`,
    clone_url: `${base}/${r.full_name}.git`,
    homepage: '',
    size: 0,
    stargazers_count: 0,
    watchers_count: 0,
    language: null,
    has_issues: true,
    has_projects: true,
    has_downloads: true,
    has_wiki: true,
    has_pages: false,
    forks_count: 0,
    open_issues_count: r.issues.size,
    license: null,
    topics: [],
    default_branch: r.default_branch,
  };
}

function userJson(login: string): Json {
  const base = ownerJson(login);
  const out: Json = { ...base, node_id: `U_${base.id}`, avatar_url: '', gravatar_id: '', url: '', html_url: '', followers_url: '', following_url: '', gists_url: '', starred_url: '', subscriptions_url: '', organizations_url: '', repos_url: '', events_url: '', received_events_url: '', site_admin: false };
  if (login === VIEWER.login) {
    out.name = VIEWER.name;
    out.email = VIEWER.email;
  }
  return out;
}

function labelJson(store: Store, repo: NonNullable<ReturnType<Store['getRepo']>>, label: { name: string; color: string; description: string }): Json {
  const labels = store.listLabels(repo);
  const id = labels.findIndex((l) => l.name === label.name) + 1;
  return { id, node_id: `L_${repo.id}_${id}`, url: '', name: label.name, color: label.color, description: label.description, default: false };
}

function issueJson(store: Store, repo: NonNullable<ReturnType<Store['getRepo']>>, issue: NonNullable<ReturnType<Store['getIssue']>>): Json {
  return {
    id: issue.id,
    node_id: `I_${repo.id}_${issue.number}`,
    url: '',
    html_url: '',
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    locked: false,
    user: userJson(issue.user.login),
    labels: issue.labels.map((name) => {
      const l = store.getLabel(repo, name);
      return l ? labelJson(store, repo, l) : { id: 0, name, color: 'ededed', description: '' };
    }),
    assignee: null,
    assignees: [],
    comments: issue.comments.length,
    created_at: issue.created_at,
    updated_at: issue.updated_at,
    closed_at: issue.state === 'closed' ? issue.updated_at : null,
    author_association: 'OWNER',
  };
}

function commentJson(comment: { id: number; body: string; created_at: string; user: { login: string; id: number; type: string } }): Json {
  return {
    id: comment.id,
    node_id: `C_${comment.id}`,
    url: '',
    html_url: '',
    body: comment.body,
    user: userJson(comment.user.login),
    created_at: comment.created_at,
    updated_at: comment.created_at,
    author_association: 'OWNER',
  };
}

function commitJson(store: Store, repo: NonNullable<ReturnType<Store['getRepo']>>, oid: string): Json | null {
  const c = store.getCommit(repo, oid);
  if (!c) return null;
  const person = (a: { name: string; email: string; epoch: number }): Json => ({ name: a.name, email: a.email, date: isoDate(a.epoch) });
  return {
    sha: oid,
    node_id: `C_${oid}`,
    commit: { author: person(c.author), committer: person(c.committer), message: c.message, tree: { sha: c.tree }, url: '', comment_count: 0, verification: { verified: false, reason: 'unsigned', signature: null, payload: null } },
    url: '',
    html_url: '',
    author: userJson(VIEWER.login),
    committer: userJson(VIEWER.login),
    parents: c.parents.map((p) => ({ sha: p, url: '', html_url: '' })),
  };
}

function pullJson(store: Store, repo: NonNullable<ReturnType<Store['getRepo']>>, pull: NonNullable<ReturnType<Store['getPull']>>): Json {
  const headSha = pull.head.sha || store.getRef(repo, `refs/heads/${pull.head.ref}`) || '';
  const baseSha = pull.base.sha || store.getRef(repo, `refs/heads/${pull.base.ref}`) || '';
  return {
    id: pull.id,
    node_id: `P_${repo.id}_${pull.number}`,
    url: '',
    html_url: '',
    number: pull.number,
    state: pull.state,
    locked: false,
    title: pull.title,
    body: pull.body,
    user: userJson(pull.user.login),
    labels: [],
    created_at: pull.created_at,
    updated_at: pull.updated_at,
    closed_at: pull.state === 'closed' ? pull.updated_at : null,
    merged_at: pull.merged_at ?? null,
    merge_commit_sha: pull.merged ? baseSha : null,
    head: { label: `${repo.owner}:${pull.head.ref}`, ref: pull.head.ref, sha: headSha, user: userJson(repo.owner), repo: null },
    base: { label: `${repo.owner}:${pull.base.ref}`, ref: pull.base.ref, sha: baseSha, user: userJson(repo.owner), repo: null },
    merged: pull.merged,
    mergeable: pull.mergeable,
    mergeable_state: pull.mergeable ? 'clean' : 'dirty',
    merged_by: pull.merged ? userJson(VIEWER.login) : null,
    comments: 0,
    review_comments: 0,
    commits: pull.commits.length,
    additions: pull.files.reduce((n, f) => n + f.additions, 0),
    deletions: pull.files.reduce((n, f) => n + f.deletions, 0),
    changed_files: pull.files.length,
    author_association: 'OWNER',
  };
}

// ---- tree helpers (for the unborn-repo first commit) ----

function treeEntriesAt(store: Store, repo: NonNullable<ReturnType<Store['getRepo']>>, treeOid: string | undefined): { mode: string; name: string; oid: string }[] {
  if (!treeOid || treeOid === EMPTY_TREE_OID) return [];
  const obj = store.getObject(repo, treeOid);
  if (!obj || obj.type !== 'tree') return [];
  return store.parseTree(obj.data);
}

function buildTreeWithFile(store: Store, repo: NonNullable<ReturnType<Store['getRepo']>>, treeOid: string | undefined, parts: string[], blobOid: string | null): string {
  const entries = treeEntriesAt(store, repo, treeOid);
  const [head, ...rest] = parts;
  const idx = entries.findIndex((e) => e.name === head);
  if (rest.length === 0) {
    if (blobOid === null) {
      if (idx !== -1) entries.splice(idx, 1);
    } else if (idx !== -1) {
      entries[idx] = { mode: '100644', name: head, oid: blobOid };
    } else {
      entries.push({ mode: '100644', name: head, oid: blobOid });
    }
  } else {
    const sub = idx !== -1 && entries[idx].mode === '40000' ? entries[idx].oid : undefined;
    const newSub = buildTreeWithFile(store, repo, sub, rest, blobOid);
    const subEntries = treeEntriesAt(store, repo, newSub);
    if (subEntries.length === 0) {
      if (idx !== -1) entries.splice(idx, 1);
    } else if (idx !== -1) {
      entries[idx] = { mode: '40000', name: head, oid: newSub };
    } else {
      entries.push({ mode: '40000', name: head, oid: newSub });
    }
  }
  return store.putObject(repo, 'tree', store.buildTree(entries));
}

function resolveCommitRef(store: Store, repo: NonNullable<ReturnType<Store['getRepo']>>, ref: string | undefined): string | undefined {
  if (ref === undefined || ref === '') return store.resolveRef(repo, 'HEAD');
  if (/^[0-9a-f]{40}$/i.test(ref)) {
    return store.getCommit(repo, ref.toLowerCase()) ? ref.toLowerCase() : undefined;
  }
  const direct = store.resolveRef(repo, ref);
  if (direct) return direct;
  const headed = store.resolveRef(repo, `refs/heads/${ref}`);
  if (headed) return headed;
  const tagged = store.resolveRef(repo, `refs/tags/${ref}`);
  if (tagged) return tagged;
  return undefined;
}

type Lookup = { kind: 'file'; oid: string; data: Buffer } | { kind: 'dir'; treeOid: string } | undefined;

function lookupPath(store: Store, repo: NonNullable<ReturnType<Store['getRepo']>>, commitOid: string, parts: string[]): Lookup {
  const commit = store.getCommit(repo, commitOid);
  if (!commit) return undefined;
  let treeOid = commit.tree;
  for (let i = 0; i < parts.length; i++) {
    const entries = treeEntriesAt(store, repo, treeOid);
    const entry = entries.find((e) => e.name === parts[i]);
    if (!entry) return undefined;
    if (i === parts.length - 1) {
      if (entry.mode === '40000') return { kind: 'dir', treeOid: entry.oid };
      const obj = store.getObject(repo, entry.oid);
      if (!obj) return undefined;
      return { kind: 'file', oid: entry.oid, data: obj.data };
    }
    if (entry.mode !== '40000') return undefined;
    treeOid = entry.oid;
  }
  return { kind: 'dir', treeOid };
}

function dirListing(store: Store, repo: NonNullable<ReturnType<Store['getRepo']>>, treeOid: string, prefix: string, host: string): Json[] {
  const out: Json[] = [];
  for (const e of treeEntriesAt(store, repo, treeOid)) {
    const path = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.mode === '40000') {
      out.push({ type: 'dir', size: 0, name: e.name, path, sha: e.oid, url: '', html_url: '', git_url: '', download_url: null, _links: { self: '', git: '', html: '' } });
    } else {
      const obj = store.getObject(repo, e.oid);
      out.push({ type: 'file', size: obj ? obj.data.length : 0, name: e.name, path, sha: e.oid, url: '', html_url: '', git_url: '', download_url: null, _links: { self: '', git: '', html: '' } });
    }
  }
  void host;
  return out;
}

// ---- the handler factory ----

export function createRestHandlers(store: Store, token: string): (req: IncomingMessage, res: ServerResponse) => Promise<boolean> {
  return async (req, res): Promise<boolean> => {
    const rawUrl = req.url ?? '/';
    const host = req.headers.host ?? 'localhost';
    const base = `http://${host}`;
    let pathname = '/';
    try {
      pathname = new URL(rawUrl, base).pathname;
    } catch {
      pathname = rawUrl.split('?')[0] ?? '/';
    }
    if (!pathname.startsWith('/api/v3/')) return false;
    if (pathname === '/api/v3/' || pathname === '/api/v3') return false;

    const requestId = randomUUID();
    const headers: Record<string, string> = { 'x-github-request-id': requestId };
    const method = (req.method ?? 'GET').toUpperCase();
    const segments = pathname.split('/').filter((s) => s.length > 0).slice(2).map((s) => {
      try { return decodeURIComponent(s); } catch { return s; }
    });

    const fail = (status: number, message: string): void => {
      sendJson(res, status, { message, documentation_url: '' }, headers);
    };

    try {
      if (!authed(req, token)) {
        fail(401, 'Bad credentials');
        return true;
      }

      const needsBody = method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE';
      let body: Json = {};
      if (needsBody) body = await readJson(req);

      // ---- /api/v3/meta, /api/v3/rate_limit ----
      if (segments.length === 1 && segments[0] === 'meta' && method === 'GET') {
        sendJson(res, 200, { installed_version: '1.0.0' }, headers);
        return true;
      }
      if (segments.length === 1 && segments[0] === 'rate_limit' && method === 'GET') {
        const reset = Math.floor(Date.now() / 1000) + 3600;
        sendJson(res, 200, { resources: { core: { limit: 5000, remaining: 4999, reset, used: 1 }, search: { limit: 30, remaining: 30, reset, used: 0 }, graphql: { limit: 5000, remaining: 4999, reset, used: 1 }, code_scanning_upload: { limit: 500, remaining: 500, reset, used: 0 } }, rate: { limit: 5000, remaining: 4999, reset, used: 1 } }, headers);
        return true;
      }

      // ---- /api/v3/user ----
      if (segments[0] === 'user') {
        if (segments.length === 1 && method === 'GET') {
          sendJson(res, 200, { ...userJson(VIEWER.login), public_repos: store.listRepos(VIEWER.login).length, followers: 0, following: 0 }, headers);
          return true;
        }
        if (segments.length === 2 && segments[1] === 'repos') {
          if (method === 'GET') {
            const { items, linkHeader } = paginate(store.listRepos(VIEWER.login).map((r) => repoJson(store, r, host)), req);
            const h = { ...headers, ...(linkHeader ? { link: linkHeader } : {}) };
            sendJson(res, 200, items, h);
            return true;
          }
          if (method === 'POST') {
            const name = typeof body.name === 'string' ? body.name.trim() : '';
            if (name === '') { fail(422, 'Validation Failed: name is required'); return true; }
            const created = store.createRepo(VIEWER.login, name, {
              description: typeof body.description === 'string' ? body.description : undefined,
              private: typeof body.private === 'boolean' ? body.private : undefined,
              defaultBranch: typeof body.default_branch === 'string' ? body.default_branch : undefined,
            });
            if (!created) { fail(422, 'Repository creation failed. Name already exists on this account.'); return true; }
            sendJson(res, 201, repoJson(store, created, host), headers);
            return true;
          }
        }
        fail(404, 'Not Found');
        return true;
      }

      // ---- /api/v3/users/:login/repos ----
      if (segments[0] === 'users' && segments.length === 3 && segments[2] === 'repos' && method === 'GET') {
        const login = segments[1];
        const { items, linkHeader } = paginate(store.listRepos(login).map((r) => repoJson(store, r, host)), req);
        const h = { ...headers, ...(linkHeader ? { link: linkHeader } : {}) };
        sendJson(res, 200, items, h);
        return true;
      }

      // ---- /api/v3/orgs/:org/repos ----
      if (segments[0] === 'orgs' && segments.length === 3 && segments[2] === 'repos' && method === 'GET') {
        const org = segments[1];
        if (org !== ORG) { fail(404, 'Not Found'); return true; }
        const { items, linkHeader } = paginate(store.listRepos(org).map((r) => repoJson(store, r, host)), req);
        const h = { ...headers, ...(linkHeader ? { link: linkHeader } : {}) };
        sendJson(res, 200, items, h);
        return true;
      }

      // ---- /api/v3/repos/:owner/:repo/... ----
      if (segments[0] === 'repos' && segments.length >= 3) {
        const owner = segments[1];
        const name = segments[2];
        const repo = store.getRepo(owner, name);
        if (!repo) { fail(404, 'Not Found'); return true; }
        const rest = segments.slice(3);

        // repo itself
        if (rest.length === 0) {
          if (method === 'GET') { sendJson(res, 200, repoJson(store, repo, host), headers); return true; }
          if (method === 'PATCH') {
            if (typeof body.description === 'string') repo.description = body.description;
            if (typeof body.private === 'boolean') repo.private = body.private;
            if (typeof body.default_branch === 'string' && body.default_branch !== '') {
              repo.default_branch = body.default_branch;
              repo.head = `refs/heads/${body.default_branch}`;
            }
            if (typeof body.homepage === 'string') { /* stored nowhere; ignored */ }
            repo.updated_at = new Date().toISOString();
            sendJson(res, 200, repoJson(store, repo, host), headers);
            return true;
          }
          if (method === 'DELETE') {
            store.deleteRepo(owner, name);
            sendEmpty(res, headers);
            return true;
          }
          fail(404, 'Not Found');
          return true;
        }

        // branches
        if (rest[0] === 'branches') {
          if (rest.length === 1 && method === 'GET') {
            sendJson(res, 200, store.listBranches(repo).map((b) => ({ name: b.name, commit: { sha: b.sha, url: '' }, protected: false })), headers);
            return true;
          }
          if (rest.length >= 2 && method === 'GET') {
            const branchName = rest.slice(1).join('/');
            const sha = store.getRef(repo, `refs/heads/${branchName}`);
            if (!sha) { fail(404, 'Not Found'); return true; }
            sendJson(res, 200, { name: branchName, commit: { sha, url: '' }, protected: false }, headers);
            return true;
          }
          fail(404, 'Not Found');
          return true;
        }

        // commits
        if (rest[0] === 'commits') {
          if (rest.length === 1 && method === 'GET') {
            const q = parseQuery(req);
            const shaParam = q.get('sha') ?? undefined;
            const pathParam = q.get('path') ?? undefined;
            let start: string | undefined;
            if (shaParam !== undefined) {
              start = resolveCommitRef(store, repo, shaParam);
              if (!start) { sendJson(res, 200, [], headers); return true; }
            }
            const oids = store.listCommits(repo, { ...(start ? { sha: start } : {}), ...(pathParam ? { path: pathParam } : {}) });
            const { items, linkHeader } = paginate(oids.map((oid) => commitJson(store, repo, oid)).filter((c): c is Json => c !== null), req);
            const h = { ...headers, ...(linkHeader ? { link: linkHeader } : {}) };
            sendJson(res, 200, items, h);
            return true;
          }
          if (rest.length === 2 && method === 'GET') {
            const oid = /^[0-9a-f]{40}$/i.test(rest[1]) ? rest[1].toLowerCase() : resolveCommitRef(store, repo, rest[1]);
            const c = oid ? commitJson(store, repo, oid) : null;
            if (!c) { fail(404, 'Not Found'); return true; }
            sendJson(res, 200, c, headers);
            return true;
          }
          fail(404, 'Not Found');
          return true;
        }

        // contents
        if (rest[0] === 'contents') {
          const parts = rest.slice(1);
          const q = parseQuery(req);
          if (method === 'GET') {
            const commitOid = resolveCommitRef(store, repo, q.get('ref') ?? undefined);
            if (!commitOid) { fail(404, 'Not Found'); return true; }
            if (parts.length === 0) {
              const commit = store.getCommit(repo, commitOid);
              if (!commit) { fail(404, 'Not Found'); return true; }
              sendJson(res, 200, dirListing(store, repo, commit.tree, '', host), headers);
              return true;
            }
            const found = lookupPath(store, repo, commitOid, parts);
            if (!found) { fail(404, 'Not Found'); return true; }
            if (found.kind === 'dir') {
              sendJson(res, 200, dirListing(store, repo, found.treeOid, parts.join('/'), host), headers);
              return true;
            }
            sendJson(res, 200, {
              type: 'file', encoding: 'base64', size: found.data.length,
              name: parts[parts.length - 1], path: parts.join('/'),
              content: found.data.toString('base64'), sha: found.oid,
              url: '', html_url: '', git_url: '', download_url: null,
              _links: { self: '', git: '', html: '' },
            }, headers);
            return true;
          }
          if (method === 'PUT') {
            if (parts.length === 0) { fail(422, 'Validation Failed: path is required'); return true; }
            const message = typeof body.message === 'string' ? body.message : 'Update file';
            const contentB64 = typeof body.content === 'string' ? body.content : '';
            if (contentB64 === '') { fail(422, 'Validation Failed: content is required'); return true; }
            const branch = typeof body.branch === 'string' && body.branch !== '' ? body.branch : repo.default_branch;
            const baseCommit = store.getRef(repo, `refs/heads/${branch}`);
            const blobData = Buffer.from(contentB64, 'base64');
            const blobOid = store.putObject(repo, 'blob', blobData);
            const author = viewerAuthor();
            if (!baseCommit) {
              if (repo.refs.size > 0) { fail(404, 'Not Found'); return true; }
              // unborn repository: root commit
              const treeOid = buildTreeWithFile(store, repo, undefined, parts, blobOid);
              const commitBuf = store.buildCommit({ tree: treeOid, parents: [], author, committer: author, message });
              const commitOid = store.putObject(repo, 'commit', commitBuf);
              store.setRef(repo, `refs/heads/${branch}`, commitOid);
              sendJson(res, 201, {
                content: { name: parts[parts.length - 1], path: parts.join('/'), sha: blobOid, size: blobData.length, url: '', html_url: '', git_url: '', download_url: null, type: 'file', encoding: 'base64', content: contentB64, _links: { self: '', git: '', html: '' } },
                commit: { sha: commitOid, message, author: { name: author.name, email: author.email, date: isoDate(author.epoch) }, committer: { name: author.name, email: author.email, date: isoDate(author.epoch) }, url: '' },
              }, headers);
              return true;
            }
            const current = store.getBlobAtPath(repo, baseCommit, parts.join('/'));
            const isUpdate = current !== undefined;
            if (isUpdate && typeof body.sha === 'string' && body.sha !== '' && body.sha.toLowerCase() !== current.oid.toLowerCase()) {
              fail(409, 'Conflict: sha does not match the current blob');
              return true;
            }
            const commitOid = store.setPath(repo, baseCommit, parts.join('/'), blobOid, message, author);
            store.setRef(repo, `refs/heads/${branch}`, commitOid);
            sendJson(res, isUpdate ? 200 : 201, {
              content: { name: parts[parts.length - 1], path: parts.join('/'), sha: blobOid, size: blobData.length, url: '', html_url: '', git_url: '', download_url: null, type: 'file', encoding: 'base64', content: contentB64, _links: { self: '', git: '', html: '' } },
              commit: { sha: commitOid, message, author: { name: author.name, email: author.email, date: isoDate(author.epoch) }, committer: { name: author.name, email: author.email, date: isoDate(author.epoch) }, url: '' },
            }, headers);
            return true;
          }
          if (method === 'DELETE') {
            if (parts.length === 0) { fail(422, 'Validation Failed: path is required'); return true; }
            const message = typeof body.message === 'string' ? body.message : 'Delete file';
            const branch = typeof body.branch === 'string' && body.branch !== '' ? body.branch : repo.default_branch;
            const baseCommit = store.getRef(repo, `refs/heads/${branch}`);
            if (!baseCommit) { fail(404, 'Not Found'); return true; }
            const current = store.getBlobAtPath(repo, baseCommit, parts.join('/'));
            if (!current) { fail(404, 'Not Found'); return true; }
            if (typeof body.sha === 'string' && body.sha !== '' && body.sha.toLowerCase() !== current.oid.toLowerCase()) {
              fail(409, 'Conflict: sha does not match the current blob');
              return true;
            }
            const author = viewerAuthor();
            const commitOid = store.setPath(repo, baseCommit, parts.join('/'), null, message, author);
            store.setRef(repo, `refs/heads/${branch}`, commitOid);
            sendJson(res, 200, {
              content: null,
              commit: { sha: commitOid, message, author: { name: author.name, email: author.email, date: isoDate(author.epoch) }, committer: { name: author.name, email: author.email, date: isoDate(author.epoch) }, url: '' },
            }, headers);
            return true;
          }
          fail(404, 'Not Found');
          return true;
        }

        // git refs
        if (rest[0] === 'git' && rest[1] === 'refs') {
          const refParts = rest.slice(2);
          if (method === 'GET' && refParts.length === 0) {
            sendJson(res, 200, store.listRefs(repo).map((r) => ({ ref: r.ref, node_id: '', url: '', object: { sha: r.oid, type: 'commit', url: '' } })), headers);
            return true;
          }
          if (method === 'POST' && refParts.length === 0) {
            const ref = typeof body.ref === 'string' ? body.ref : '';
            const sha = typeof body.sha === 'string' ? body.sha.toLowerCase() : '';
            if (ref === '' || sha === '') { fail(422, 'Validation Failed: ref and sha are required'); return true; }
            if (!store.getCommit(repo, sha)) { fail(422, 'Validation Failed: sha is not a commit'); return true; }
            if (store.getRef(repo, ref) !== undefined) { fail(422, 'Reference already exists'); return true; }
            store.setRef(repo, ref, sha);
            sendJson(res, 201, { ref, node_id: '', url: '', object: { sha, type: 'commit', url: '' } }, headers);
            return true;
          }
          if (refParts.length >= 1) {
            const wanted = refParts.join('/');
            const full = wanted.startsWith('refs/') ? wanted : `refs/${wanted}`;
            if (method === 'GET') {
              const sha = store.getRef(repo, full);
              if (sha !== undefined) {
                sendJson(res, 200, { ref: full, node_id: '', url: '', object: { sha, type: 'commit', url: '' } }, headers);
                return true;
              }
              const prefixed = store.listRefs(repo).filter((r) => r.ref.startsWith(`${full}/`) || r.ref === full);
              if (prefixed.length > 0) {
                sendJson(res, 200, prefixed.map((r) => ({ ref: r.ref, node_id: '', url: '', object: { sha: r.oid, type: 'commit', url: '' } })), headers);
                return true;
              }
              fail(404, 'Not Found');
              return true;
            }
            if (method === 'PATCH') {
              const old = store.getRef(repo, full);
              if (old === undefined) { fail(404, 'Not Found'); return true; }
              const sha = typeof body.sha === 'string' ? body.sha.toLowerCase() : '';
              if (sha === '' || !store.getCommit(repo, sha)) { fail(422, 'Validation Failed: sha is not a commit'); return true; }
              const force = body.force === true;
              if (!force && sha !== old && !store.isAncestor(repo, old, sha)) {
                fail(422, 'Update is not a fast forward');
                return true;
              }
              store.setRef(repo, full, sha);
              sendJson(res, 200, { ref: full, node_id: '', url: '', object: { sha, type: 'commit', url: '' } }, headers);
              return true;
            }
            if (method === 'DELETE') {
              if (!store.deleteRef(repo, full)) { fail(404, 'Not Found'); return true; }
              sendEmpty(res, headers);
              return true;
            }
          }
          fail(404, 'Not Found');
          return true;
        }

        // issues
        if (rest[0] === 'issues') {
          if (rest.length === 1) {
            if (method === 'GET') {
              const q = parseQuery(req);
              const state = q.get('state') ?? 'open';
              const sort = q.get('sort') ?? 'created';
              const direction = q.get('direction') ?? 'desc';
              const labelsParam = [...q.getAll('labels')].flatMap((v) => v.split(',').map((s) => s.trim()).filter((s) => s !== ''));
              let list = store.listIssues(repo, { ...(state === 'all' ? {} : { state }), ...(labelsParam.length > 0 ? { labels: labelsParam } : {}) });
              if (sort === 'created') {
                list = [...list].sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
              }
              const { items, linkHeader } = paginate(list.map((i) => issueJson(store, repo, i)), req);
              const h = { ...headers, ...(linkHeader ? { link: linkHeader } : {}) };
              sendJson(res, 200, items, h);
              return true;
            }
            if (method === 'POST') {
              const title = typeof body.title === 'string' ? body.title : '';
              if (title === '') { fail(422, 'Validation Failed: title is required'); return true; }
              const rawLabels = Array.isArray(body.labels) ? body.labels : [];
              const labelNames: string[] = [];
              for (const l of rawLabels) {
                const n = typeof l === 'string' ? l : (l as Json)?.name;
                if (typeof n === 'string') labelNames.push(n);
              }
              for (const n of labelNames) {
                if (!store.getLabel(repo, n)) { fail(422, `Validation Failed: label "${n}" does not exist`); return true; }
              }
              const issue = store.createIssue(repo, { title, body: typeof body.body === 'string' ? body.body : '', labels: labelNames });
              sendJson(res, 201, issueJson(store, repo, issue), headers);
              return true;
            }
            fail(404, 'Not Found');
            return true;
          }
          const num = Number(rest[1]);
          if (rest.length >= 2 && Number.isInteger(num) && num > 0) {
            if (rest.length === 2) {
              const issue = store.getIssue(repo, num);
              if (!issue) { fail(404, 'Not Found'); return true; }
              if (method === 'GET') { sendJson(res, 200, issueJson(store, repo, issue), headers); return true; }
              if (method === 'PATCH') {
                const patch: { title?: string; body?: string; state?: string; labels?: string[] } = {};
                if (typeof body.title === 'string') patch.title = body.title;
                if (typeof body.body === 'string') patch.body = body.body;
                if (typeof body.state === 'string') patch.state = body.state;
                if (Array.isArray(body.labels)) {
                  const names: string[] = [];
                  for (const l of body.labels) {
                    const n = typeof l === 'string' ? l : (l as Json)?.name;
                    if (typeof n === 'string') names.push(n);
                  }
                  for (const n of names) {
                    if (!store.getLabel(repo, n)) { fail(422, `Validation Failed: label "${n}" does not exist`); return true; }
                  }
                  patch.labels = names;
                }
                const updated = store.updateIssue(repo, num, patch);
                if (!updated) { fail(404, 'Not Found'); return true; }
                sendJson(res, 200, issueJson(store, repo, updated), headers);
                return true;
              }
              fail(404, 'Not Found');
              return true;
            }
            if (rest.length === 3 && rest[2] === 'comments') {
              const issue = store.getIssue(repo, num);
              if (!issue) { fail(404, 'Not Found'); return true; }
              if (method === 'GET') {
                const { items, linkHeader } = paginate(store.listComments(repo, num).map(commentJson), req);
                const h = { ...headers, ...(linkHeader ? { link: linkHeader } : {}) };
                sendJson(res, 200, items, h);
                return true;
              }
              if (method === 'POST') {
                const text = typeof body.body === 'string' ? body.body : '';
                if (text === '') { fail(422, 'Validation Failed: body is required'); return true; }
                const comment = store.createComment(repo, num, text);
                if (!comment) { fail(404, 'Not Found'); return true; }
                sendJson(res, 201, commentJson(comment), headers);
                return true;
              }
              fail(404, 'Not Found');
              return true;
            }
          }
          fail(404, 'Not Found');
          return true;
        }

        // labels
        if (rest[0] === 'labels') {
          if (rest.length === 1) {
            if (method === 'GET') {
              sendJson(res, 200, store.listLabels(repo).map((l) => labelJson(store, repo, l)), headers);
              return true;
            }
            if (method === 'POST') {
              const name = typeof body.name === 'string' ? body.name.trim() : '';
              if (name === '') { fail(422, 'Validation Failed: name is required'); return true; }
              const existing = store.getLabel(repo, name);
              if (existing) {
                if (typeof body.color === 'string') existing.color = body.color;
                if (typeof body.description === 'string') existing.description = body.description;
                sendJson(res, 201, labelJson(store, repo, existing), headers);
                return true;
              }
              const label = store.createLabel(repo, { name, color: typeof body.color === 'string' ? body.color : undefined, description: typeof body.description === 'string' ? body.description : undefined });
              sendJson(res, 201, labelJson(store, repo, label), headers);
              return true;
            }
            fail(404, 'Not Found');
            return true;
          }
          if (rest.length >= 2) {
            const labelName = rest.slice(1).join('/');
            const label = store.getLabel(repo, labelName);
            if (!label) { fail(404, 'Not Found'); return true; }
            if (method === 'GET') { sendJson(res, 200, labelJson(store, repo, label), headers); return true; }
            if (method === 'PATCH') {
              const updated = store.updateLabel(repo, labelName, {
                ...(typeof body.name === 'string' ? { name: body.name } : {}),
                ...(typeof body.color === 'string' ? { color: body.color } : {}),
                ...(typeof body.description === 'string' ? { description: body.description } : {}),
              });
              if (!updated) { fail(404, 'Not Found'); return true; }
              sendJson(res, 200, labelJson(store, repo, updated), headers);
              return true;
            }
            if (method === 'DELETE') {
              store.deleteLabel(repo, labelName);
              sendEmpty(res, headers);
              return true;
            }
            fail(404, 'Not Found');
            return true;
          }
          fail(404, 'Not Found');
          return true;
        }

        // pulls
        if (rest[0] === 'pulls') {
          if (rest.length === 1) {
            if (method === 'GET') {
              const q = parseQuery(req);
              const state = q.get('state') ?? 'open';
              const list = store.listPulls(repo, { ...(state === 'all' ? {} : { state }) });
              const { items, linkHeader } = paginate(list.map((p) => pullJson(store, repo, p)), req);
              const h = { ...headers, ...(linkHeader ? { link: linkHeader } : {}) };
              sendJson(res, 200, items, h);
              return true;
            }
            if (method === 'POST') {
              const title = typeof body.title === 'string' ? body.title : '';
              const headRaw = typeof body.head === 'string' ? body.head : '';
              const baseRaw = typeof body.base === 'string' ? body.base : '';
              if (title === '' || headRaw === '' || baseRaw === '') { fail(422, 'Validation Failed: title, head and base are required'); return true; }
              const head = headRaw.includes(':') ? headRaw.slice(headRaw.lastIndexOf(':') + 1) : headRaw;
              const base = baseRaw.includes(':') ? baseRaw.slice(baseRaw.lastIndexOf(':') + 1) : baseRaw;
              if (store.getRef(repo, `refs/heads/${head}`) === undefined) { fail(422, `Validation Failed: head branch "${head}" does not exist`); return true; }
              if (store.getRef(repo, `refs/heads/${base}`) === undefined) { fail(422, `Validation Failed: base branch "${base}" does not exist`); return true; }
              const pull = store.createPull(repo, { title, body: typeof body.body === 'string' ? body.body : '', head, base });
              sendJson(res, 201, pullJson(store, repo, pull), headers);
              return true;
            }
            fail(404, 'Not Found');
            return true;
          }
          const num = Number(rest[1]);
          if (rest.length >= 2 && Number.isInteger(num) && num > 0) {
            const pull = store.getPull(repo, num);
            if (rest.length === 2) {
              if (!pull) { fail(404, 'Not Found'); return true; }
              if (method === 'GET') { sendJson(res, 200, pullJson(store, repo, pull), headers); return true; }
              fail(404, 'Not Found');
              return true;
            }
            if (rest.length === 3 && rest[2] === 'files' && method === 'GET') {
              if (!pull) { fail(404, 'Not Found'); return true; }
              const files = store.listPullFiles(repo, num).map((f) => ({ filename: f.filename, status: f.status, additions: f.additions, deletions: f.deletions, changes: f.additions + f.deletions, blob_url: '', raw_url: '', contents_url: '', patch: f.patch }));
              sendJson(res, 200, files, headers);
              return true;
            }
            if (rest.length === 3 && rest[2] === 'commits' && method === 'GET') {
              if (!pull) { fail(404, 'Not Found'); return true; }
              const commits = store.listPullCommits(repo, num).map((oid) => commitJson(store, repo, oid)).filter((c): c is Json => c !== null);
              sendJson(res, 200, commits, headers);
              return true;
            }
            if (rest.length === 3 && rest[2] === 'merge') {
              if (method === 'GET') {
                if (!pull || !pull.merged) { fail(404, 'Not Found'); return true; }
                sendEmpty(res, headers);
                return true;
              }
              if (method === 'PUT') {
                if (!pull) { fail(404, 'Not Found'); return true; }
                const mergeMethod = typeof body.merge_method === 'string' ? body.merge_method : 'merge';
                if (mergeMethod !== 'merge' && mergeMethod !== 'squash' && mergeMethod !== 'rebase') {
                  fail(422, 'Validation Failed: merge_method must be merge, squash or rebase');
                  return true;
                }
                const result = store.mergePull(repo, num, mergeMethod);
                if (result.merged && result.sha) {
                  sendJson(res, 200, { sha: result.sha, merged: true, message: 'Pull Request successfully merged' }, headers);
                  return true;
                }
                if (result.conflict) { fail(405, result.message ?? 'Merge conflict'); return true; }
                fail(405, result.message ?? 'Pull request cannot be merged');
                return true;
              }
              fail(404, 'Not Found');
              return true;
            }
          }
          fail(404, 'Not Found');
          return true;
        }

        fail(404, 'Not Found');
        return true;
      }

      fail(404, 'Not Found');
      return true;
    } catch (e) {
      if (e !== null && typeof e === 'object' && 'status' in e && typeof (e as { status: unknown }).status === 'number') {
        const thrown = e as { status: number; message: string };
        fail(thrown.status, thrown.message);
        return true;
      }
      fail(500, e instanceof Error ? e.message : 'Internal Server Error');
      return true;
    }
  };
}
