// REST v3 surface (GitHub API shape) over the shared store. All routes live
// under /api/v3. A handler returns a status, a JSON body and optional headers;
// routing/auth live in app.ts.

import { globalId, type PullRequest, type Repo, type Store } from './store.ts';
import { hashObject, parseCommit } from './git.ts';

export interface RestResult {
  readonly status: number;
  readonly body: unknown;
  readonly headers?: Record<string, string>;
}

export type Ctx = {
  readonly store: Store;
  readonly params: Record<string, string>;
  readonly query: URLSearchParams;
  readonly body: unknown;
  readonly origin: string;
};

function json(status: number, body: unknown, headers?: Record<string, string>): RestResult {
  return { status, body, headers };
}

function message(status: number, text: string): RestResult {
  return { status, body: { message: text } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function bodyField(body: unknown, name: string): unknown {
  return isRecord(body) ? body[name] : undefined;
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function asBool(value: unknown, fallback = false): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function asNumber(value: unknown, fallback: number): number {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function pageOf(query: URLSearchParams): { page: number; perPage: number } {
  const page = Math.max(1, asNumber(query.get('page'), 1));
  const perPage = Math.min(100, Math.max(1, asNumber(query.get('per_page'), 30)));
  return { page, perPage };
}

function paginate<T>(items: readonly T[], query: URLSearchParams, origin: string, path: string): { page: T[]; link: string | null } {
  const { page, perPage } = pageOf(query);
  const start = (page - 1) * perPage;
  const pageItems = items.slice(start, start + perPage);
  const links: string[] = [];
  const base = new URL(path, origin);
  const params = new URLSearchParams(query);
  if (start + perPage < items.length) {
    params.set('page', String(page + 1));
    params.set('per_page', String(perPage));
    base.search = params.toString();
    links.push(`<${base.toString()}>; rel="next"`);
  }
  if (page > 1) {
    params.set('page', String(page - 1));
    params.set('per_page', String(perPage));
    base.search = params.toString();
    links.push(`<${base.toString()}>; rel="prev"`);
    params.set('page', '1');
    base.search = params.toString();
    links.push(`<${base.toString()}>; rel="first"`);
  }
  return { page: [...pageItems], link: links.length > 0 ? links.join(', ') : null };
}

function repoView(store: Store, repo: Repo): Record<string, unknown> {
  const head = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  return {
    id: repo.id,
    node_id: globalId('Repository', repo.id),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: repo.id === 1 ? store.viewer.id : 1000 + repo.id, type: 'User' },
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    html_url: `https://example.invalid/${repo.owner}/${repo.name}`,
    clone_url: `https://example.invalid/${repo.owner}/${repo.name}.git`,
    git_url: `git://example.invalid/${repo.owner}/${repo.name}.git`,
    ssh_url: `git@example.invalid:${repo.owner}/${repo.name}.git`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    homepage: '',
    language: null,
    forks_count: 0,
    stargazers_count: 0,
    watchers_count: 0,
    open_issues_count: [...repo.issues.values()].filter((issue) => issue.state === 'open').length,
    has_issues: true,
    has_projects: true,
    has_wiki: true,
    has_pages: false,
    archived: false,
    disabled: false,
    license: null,
    topics: [],
    visibility: repo.private ? 'private' : 'public',
    permissions: { admin: true, maintain: true, push: true, triage: true, pull: true },
    head_commit_sha: head ?? null,
  };
}

function issueView(repo: Repo, issue: { id: number; number: number; title: string; body: string; state: string; labels: string[]; createdSeq: number; updatedSeq: number; userLogin: string }): Record<string, unknown> {
  const at = new Date(Date.now()).toISOString();
  return {
    id: issue.id,
    node_id: globalId('Issue', repo.id, issue.number),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => {
      const label = repo.labels.get(name);
      return { id: 0, node_id: globalId('Label', repo.id, name), name, color: label?.color ?? 'ededed', description: label?.description ?? '', url: '' };
    }),
    user: { login: issue.userLogin, id: 1000, type: 'User' },
    created_at: at,
    updated_at: at,
    closed_at: issue.state === 'closed' ? at : null,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}/issues/${issue.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
    comments: (repo.comments.get(issue.number) ?? []).length,
    comments_url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}/comments`,
    assignee: null,
    assignees: [],
    locked: false,
    milestone: null,
    author_association: 'OWNER',
  };
}

function commentView(repo: Repo, issueNumber: number, comment: { id: number; body: string; userLogin: string }): Record<string, unknown> {
  return {
    id: comment.id,
    node_id: globalId('IssueComment', repo.id, comment.id),
    body: comment.body,
    user: { login: comment.userLogin, id: 1000, type: 'User' },
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    html_url: `https://example.invalid/${repo.owner}/${repo.name}/issues/${issueNumber}#issuecomment-${comment.id}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issueNumber}/comments/${comment.id}`,
    issue_url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issueNumber}`,
    author_association: 'OWNER',
  };
}

function pullView(store: Store, repo: Repo, pull: PullRequest): Record<string, unknown> {
  const at = new Date().toISOString();
  const headSha = store.resolveCommit(repo, pull.headRef) ?? pull.headSha;
  const baseSha = store.resolveCommit(repo, pull.baseRef) ?? pull.baseSha;
  return {
    id: pull.id,
    node_id: globalId('PullRequest', repo.id, pull.number),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    mergeable: pull.state === 'open' ? store.mergeable(repo, pull) : null,
    mergeable_state: pull.state === 'open' ? (store.mergeable(repo, pull) ? 'clean' : 'dirty') : 'unknown',
    head: { label: `${repo.owner}:${pull.headRef}`, ref: pull.headRef, sha: headSha, repo: repoView(store, repo), user: { login: repo.owner, id: 1000, type: 'User' } },
    base: { label: `${repo.owner}:${pull.baseRef}`, ref: pull.baseRef, sha: baseSha, repo: repoView(store, repo), user: { login: repo.owner, id: 1000, type: 'User' } },
    user: { login: pull.userLogin, id: 1000, type: 'User' },
    created_at: at,
    updated_at: at,
    closed_at: pull.state === 'open' ? null : at,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}/pull/${pull.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
    diff_url: `https://example.invalid/${repo.owner}/${repo.name}/pull/${pull.number}.diff`,
    patch_url: `https://example.invalid/${repo.owner}/${repo.name}/pull/${pull.number}.patch`,
    comments: 0,
    review_comments: 0,
    commits: 0,
    additions: 0,
    deletions: 0,
    changed_files: 0,
    draft: false,
    locked: false,
    author_association: 'OWNER',
  };
}

function repoOr404(ctx: Ctx): Repo | RestResult {
  const repo = ctx.store.getRepo(ctx.params.owner!, ctx.params.repo!);
  if (!repo) return message(404, `Repository ${ctx.params.owner}/${ctx.params.repo} not found`);
  return repo;
}

function b64decode(text: string): Buffer | null {
  try {
    const cleaned = text.replace(/\s+/g, '');
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(cleaned)) return null;
    return Buffer.from(cleaned, 'base64');
  } catch {
    return null;
  }
}

export const restHandlers: Readonly<Record<string, (ctx: Ctx) => RestResult>> = {
  // -- root / meta / user -------------------------------------------------
  root(ctx) {
    return json(200, {
      current_user_url: '/api/v3/user',
      repository_url: '/api/v3/repos/{owner}/{repo}',
      user_repositories_url: '/api/v3/user/repos',
      rate_limit_url: '/api/v3/rate_limit',
      meta_url: '/api/v3/meta',
    }, { 'X-OAuth-Scopes': 'repo, read:org' });
  },

  meta() {
    return json(200, { installed_version: '1.0.0', verifiable_password_authentication: true, github_services_sha: 'coreforge' });
  },

  user(ctx) {
    const viewer = ctx.store.viewer;
    return json(200, {
      login: viewer.login,
      id: viewer.id,
      node_id: globalId('User', viewer.id),
      name: viewer.name,
      email: viewer.email,
      type: 'User',
      site_admin: false,
      html_url: `https://example.invalid/${viewer.login}`,
      url: '/api/v3/user',
      avatar_url: '',
      public_repos: ctx.store.listViewerRepos().length,
    });
  },

  // -- repositories --------------------------------------------------------
  createUserRepo(ctx) {
    const name = asString(bodyField(ctx.body, 'name')).trim();
    if (name === '') return message(422, 'name is required');
    if (!/^[A-Za-z0-9._-]+$/.test(name)) return message(422, 'name is invalid');
    const owner = ctx.store.viewer.login;
    if (ctx.store.getRepo(owner, name)) return message(422, `name already exists on this account`);
    const repo = ctx.store.createRepo(owner, name, {
      description: asString(bodyField(ctx.body, 'description')),
      private: asBool(bodyField(ctx.body, 'private'), false),
    });
    return json(201, repoView(ctx.store, repo));
  },

  listUserRepos(ctx) {
    const repos = ctx.store.listViewerRepos();
    const { page, link } = paginate(repos, ctx.query, ctx.origin, '/api/v3/user/repos');
    return json(200, page.map((repo) => repoView(ctx.store, repo)), link ? { Link: link } : undefined);
  },

  getRepo(ctx) {
    const repo = repoOr404(ctx);
    if ('status' in repo) return repo;
    return json(200, repoView(ctx.store, repo));
  },

  patchRepo(ctx) {
    const repo = repoOr404(ctx);
    if ('status' in repo) return repo;
    const description = bodyField(ctx.body, 'description');
    if (typeof description === 'string') repo.description = description;
    const defBranch = bodyField(ctx.body, 'default_branch');
    if (typeof defBranch === 'string' && defBranch !== '') repo.defaultBranch = defBranch;
    const isPrivate = bodyField(ctx.body, 'private');
    if (typeof isPrivate === 'boolean') repo.private = isPrivate;
    return json(200, repoView(ctx.store, repo));
  },

  deleteRepo(ctx) {
    const repo = repoOr404(ctx);
    if ('status' in repo) return repo;
    ctx.store.deleteRepo(ctx.params.owner!, ctx.params.repo!);
    return json(204, null);
  },

  // -- branches / refs ------------------------------------------------------
  listBranches(ctx) {
    const repo = repoOr404(ctx);
    if ('status' in repo) return repo;
    const out: Array<Record<string, unknown>> = [];
    for (const [ref, sha] of [...repo.refs.entries()].sort()) {
      if (!ref.startsWith('refs/heads/')) continue;
      const name = ref.slice('refs/heads/'.length);
      out.push({
        name,
        commit: { sha, url: `/api/v3/repos/${repo.owner}/${repo.name}/commits/${sha}` },
        protected: false,
      });
    }
    return json(200, out);
  },

  getBranch(ctx) {
    const repo = repoOr404(ctx);
    if ('status' in repo) return repo;
    const branch = ctx.params.branch!;
    const sha = repo.refs.get(`refs/heads/${branch}`);
    if (!sha) return message(404, `Branch ${branch} not found`);
    return json(200, {
      name: branch,
      commit: { sha, url: `/api/v3/repos/${repo.owner}/${repo.name}/commits/${sha}` },
      protected: false,
    });
  },

  createRef(ctx) {
    const repo = repoOr404(ctx);
    if ('status' in repo) return repo;
    const ref = asString(bodyField(ctx.body, 'ref'));
    const sha = asString(bodyField(ctx.body, 'sha'));
    if (!ref.startsWith('refs/') || sha === '') return message(422, 'ref and sha are required');
    if (!/^[0-9a-f]{40}$/.test(sha) || !repo.objects.has(sha)) return message(422, 'sha does not exist');
    if (repo.refs.has(ref)) return message(422, 'Reference already exists');
    repo.refs.set(ref, sha);
    return json(201, { ref, node_id: globalId('Ref', repo.id, ref), url: `/api/v3/repos/${repo.owner}/${repo.name}/git/refs/${ref.replace(/^refs\//, '')}`, object: { sha, type: 'commit', url: '' } });
  },

  getRef(ctx) {
    const repo = repoOr404(ctx);
    if ('status' in repo) return repo;
    const ref = `refs/${ctx.params.refPath!}`;
    const sha = repo.refs.get(ref);
    if (!sha) return message(404, `Reference ${ref} not found`);
    return json(200, { ref, node_id: globalId('Ref', repo.id, ref), url: `/api/v3/repos/${repo.owner}/${repo.name}/git/refs/${ref.replace(/^refs\//, '')}`, object: { sha, type: 'commit', url: '' } });
  },

  // -- commits --------------------------------------------------------------
  listCommits(ctx) {
    const repo = repoOr404(ctx);
    if ('status' in repo) return repo;
    const ref = ctx.query.get('sha') ?? repo.defaultBranch;
    const tip = ctx.store.resolveCommit(repo, ref);
    if (tip === null) return json(200, []);
    const commits = ctx.store.listCommits(repo, tip);
    const out = commits.map((oid) => {
      const object = repo.objects.get(oid)!;
      const parsed = parseCommit(object.data);
      return {
        sha: oid,
        node_id: globalId('Commit', repo.id, oid),
        commit: {
          message: parsed.message.replace(/\n$/, ''),
          author: { name: parsed.author.split(' <')[0] ?? '', email: '', date: new Date().toISOString() },
          committer: { name: parsed.committer.split(' <')[0] ?? '', email: '', date: new Date().toISOString() },
          tree: { sha: parsed.tree, url: '' },
        },
        parents: parsed.parents.map((parent: string) => ({ sha: parent, url: '' })),
        url: `/api/v3/repos/${repo.owner}/${repo.name}/commits/${oid}`,
        html_url: `https://example.invalid/${repo.owner}/${repo.name}/commit/${oid}`,
      };
    });
    return json(200, out);
  },

  // -- contents ---------------------------------------------------------------
  getContents(ctx) {
    const repo = repoOr404(ctx);
    if ('status' in repo) return repo;
    const path = ctx.params.path!;
    const ref = ctx.query.get('ref') ?? repo.defaultBranch;
    const tip = ctx.store.resolveCommit(repo, ref);
    if (tip === null) return message(404, 'Not Found');
    const treeOid = ctx.store.treeOf(repo, tip);
    if (treeOid === null) return message(404, 'Not Found');
    const flat = ctx.store.flattenTree(repo, treeOid);
    const entry = flat.get(path);
    if (entry) {
      const object = repo.objects.get(entry.oid);
      const content = object ? object.data.toString('base64') : '';
      return json(200, {
        type: 'file',
        encoding: 'base64',
        size: object ? object.data.length : 0,
        name: path.split('/').pop() ?? path,
        path,
        content,
        sha: entry.oid,
        url: `/api/v3/repos/${repo.owner}/${repo.name}/contents/${path}`,
        html_url: `https://example.invalid/${repo.owner}/${repo.name}/blob/${ref}/${path}`,
        git_url: '',
        download_url: '',
        _links: { self: '', git: '', html: '' },
      });
    }
    // Directory listing: entries directly under this path.
    const prefix = `${path}/`;
    const children = new Map<string, { type: string; name: string; path: string; sha: string }>();
    for (const [filePath, fileEntry] of flat) {
      if (!filePath.startsWith(prefix)) continue;
      const rest = filePath.slice(prefix.length);
      const first = rest.split('/')[0]!;
      if (rest.includes('/')) {
        if (!children.has(first)) {
          children.set(first, { type: 'dir', name: first, path: `${path}/${first}`, sha: '' });
        }
      } else {
        children.set(first, { type: 'file', name: first, path: filePath, sha: fileEntry.oid });
      }
    }
    if (children.size === 0) return message(404, 'Not Found');
    return json(200, [...children.values()].sort((a, b) => a.name.localeCompare(b.name)));
  },

  putContents(ctx) {
    const repo = repoOr404(ctx);
    if ('status' in repo) return repo;
    const path = ctx.params.path!;
    const contentB64 = asString(bodyField(ctx.body, 'content'));
    const messageText = asString(bodyField(ctx.body, 'message'), `Update ${path}`);
    const branch = asString(bodyField(ctx.body, 'branch'), repo.defaultBranch);
    const sha = asString(bodyField(ctx.body, 'sha'));
    const decoded = b64decode(contentB64);
    if (decoded === null) return message(422, 'content is not valid base64');
    let tip = ctx.store.resolveCommit(repo, branch);
    if (tip === null) {
      if (branch !== repo.defaultBranch && ctx.store.resolveCommit(repo, repo.defaultBranch) !== null) {
        return message(422, `branch ${branch} does not exist`);
      }
      if (branch !== repo.defaultBranch) {
        // New branch from the default tip; the default tip is unborn here only
        // when the repo has no commits at all.
        const defaultTip = ctx.store.resolveCommit(repo, repo.defaultBranch);
        if (defaultTip === null) {
          tip = null;
        } else {
          repo.refs.set(`refs/heads/${branch}`, defaultTip);
          tip = defaultTip;
        }
      }
    }
    if (sha !== '') {
      const existing = ctx.store.blobAt(repo, tip ?? '', path);
      if (existing !== sha) return message(409, 'sha does not match the current file');
    }
    const blobOid = ctx.store.putObject(repo, 'blob', decoded);
    const existed = tip === null ? null : ctx.store.blobAt(repo, tip, path);
    const treeOid = ctx.store.setPath(repo, tip, path, blobOid);
    const parents = tip === null ? [] : [tip];
    const commitOid = ctx.store.makeCommit(repo, treeOid, parents, messageText);
    repo.refs.set(`refs/heads/${branch}`, commitOid);
    const isCreate = existed === null;
    return json(isCreate ? 201 : 200, {
      content: { name: path.split('/').pop() ?? path, path, sha: blobOid, size: decoded.length, type: 'file', encoding: 'base64', content: contentB64 },
      commit: { sha: commitOid, message: messageText, url: '', html_url: '' },
    });
  },

  deleteContents(ctx) {
    const repo = repoOr404(ctx);
    if ('status' in repo) return repo;
    const path = ctx.params.path!;
    const messageText = asString(bodyField(ctx.body, 'message'), `Delete ${path}`);
    const branch = asString(bodyField(ctx.body, 'branch'), repo.defaultBranch);
    const sha = asString(bodyField(ctx.body, 'sha'));
    const tip = ctx.store.resolveCommit(repo, branch);
    if (tip === null) return message(404, 'Not Found');
    const existing = ctx.store.blobAt(repo, tip, path);
    if (existing === null) return message(404, 'Not Found');
    if (sha !== '' && existing !== sha) return message(409, 'sha does not match the current file');
    const treeOid = ctx.store.setPath(repo, tip, path, null);
    const commitOid = ctx.store.makeCommit(repo, treeOid, [tip], messageText);
    repo.refs.set(`refs/heads/${branch}`, commitOid);
    return json(200, { commit: { sha: commitOid, message: messageText, url: '', html_url: '' } });
  },

  // -- labels ------------------------------------------------------------------
  createLabel(ctx) {
    const repo = repoOr404(ctx);
    if ('status' in repo) return repo;
    const name = asString(bodyField(ctx.body, 'name')).trim();
    if (name === '') return message(422, 'name is required');
    const color = asString(bodyField(ctx.body, 'color'), 'ededed').replace(/^#/, '');
    const label = ctx.store.createLabel(repo, name, color);
    return json(201, { id: 0, node_id: globalId('Label', repo.id, name), name: label.name, color: label.color, description: label.description, url: '' });
  },

  listLabels(ctx) {
    const repo = repoOr404(ctx);
    if ('status' in repo) return repo;
    return json(200, [...repo.labels.values()].map((label) => ({ id: 0, node_id: globalId('Label', repo.id, label.name), name: label.name, color: label.color, description: label.description, url: '' })));
  },

  // -- issues --------------------------------------------------------------------
  createIssue(ctx) {
    const repo = repoOr404(ctx);
    if ('status' in repo) return repo;
    const title = asString(bodyField(ctx.body, 'title')).trim();
    if (title === '') return message(422, 'title is required');
    const labels = Array.isArray(bodyField(ctx.body, 'labels'))
      ? (bodyField(ctx.body, 'labels') as unknown[]).map((label) => String(label))
      : [];
    for (const label of labels) {
      if (!repo.labels.has(label)) return message(422, `label ${label} does not exist`);
    }
    const issue = ctx.store.createIssue(repo, title, asString(bodyField(ctx.body, 'body')), labels);
    return json(201, issueView(repo, issue));
  },

  listIssues(ctx) {
    const repo = repoOr404(ctx);
    if ('status' in repo) return repo;
    const state = ctx.query.get('state') ?? 'open';
    const sort = ctx.query.get('sort') ?? 'created';
    const direction = ctx.query.get('direction') ?? 'desc';
    let issues = [...repo.issues.values()];
    if (state !== 'all') issues = issues.filter((issue) => issue.state === state);
    issues.sort((a, b) => {
      const byCreated = sort === 'created' ? a.createdSeq - b.createdSeq : a.number - b.number;
      return direction === 'asc' ? byCreated : -byCreated;
    });
    const { page, link } = paginate(issues, ctx.query, ctx.origin, `/api/v3/repos/${ctx.params.owner}/${ctx.params.repo}/issues`);
    return json(200, page.map((issue) => issueView(repo, issue)), link ? { Link: link } : undefined);
  },

  getIssue(ctx) {
    const repo = repoOr404(ctx);
    if ('status' in repo) return repo;
    const number = asNumber(ctx.params.number, 0);
    const issue = repo.issues.get(number);
    if (!issue) return message(404, `Issue ${number} not found`);
    return json(200, issueView(repo, issue));
  },

  patchIssue(ctx) {
    const repo = repoOr404(ctx);
    if ('status' in repo) return repo;
    const number = asNumber(ctx.params.number, 0);
    const issue = repo.issues.get(number);
    if (!issue) return message(404, `Issue ${number} not found`);
    const title = bodyField(ctx.body, 'title');
    if (typeof title === 'string') issue.title = title;
    const bodyText = bodyField(ctx.body, 'body');
    if (typeof bodyText === 'string') issue.body = bodyText;
    const state = bodyField(ctx.body, 'state');
    if (state === 'open' || state === 'closed') issue.state = state;
    return json(200, issueView(repo, issue));
  },

  createIssueComment(ctx) {
    const repo = repoOr404(ctx);
    if ('status' in repo) return repo;
    const number = asNumber(ctx.params.number, 0);
    if (!repo.issues.has(number)) return message(404, `Issue ${number} not found`);
    const bodyText = asString(bodyField(ctx.body, 'body'));
    if (bodyText === '') return message(422, 'body is required');
    const comment = ctx.store.createComment(repo, number, bodyText);
    return json(201, commentView(repo, number, comment));
  },

  listIssueComments(ctx) {
    const repo = repoOr404(ctx);
    if ('status' in repo) return repo;
    const number = asNumber(ctx.params.number, 0);
    if (!repo.issues.has(number)) return message(404, `Issue ${number} not found`);
    return json(200, (repo.comments.get(number) ?? []).map((comment) => commentView(repo, number, comment)));
  },

  // -- pull requests ---------------------------------------------------------------
  createPull(ctx) {
    const repo = repoOr404(ctx);
    if ('status' in repo) return repo;
    const title = asString(bodyField(ctx.body, 'title')).trim();
    const head = asString(bodyField(ctx.body, 'head'));
    const base = asString(bodyField(ctx.body, 'base'), repo.defaultBranch);
    if (title === '' || head === '') return message(422, 'title and head are required');
    const result = ctx.store.createPull(repo, { title, body: asString(bodyField(ctx.body, 'body')), head, base });
    if ('error' in result) return message(422, result.error);
    return json(201, pullView(ctx.store, repo, result));
  },

  listPulls(ctx) {
    const repo = repoOr404(ctx);
    if ('status' in repo) return repo;
    const state = ctx.query.get('state') ?? 'open';
    let pulls = [...repo.pulls.values()];
    if (state !== 'all') pulls = pulls.filter((pull) => pull.state === state);
    pulls.sort((a, b) => b.createdSeq - a.createdSeq);
    return json(200, pulls.map((pull) => pullView(ctx.store, repo, pull)));
  },

  getPull(ctx) {
    const repo = repoOr404(ctx);
    if ('status' in repo) return repo;
    const number = asNumber(ctx.params.number, 0);
    const pull = repo.pulls.get(number);
    if (!pull) return message(404, `Pull request ${number} not found`);
    return json(200, pullView(ctx.store, repo, pull));
  },

  listPullFiles(ctx) {
    const repo = repoOr404(ctx);
    if ('status' in repo) return repo;
    const number = asNumber(ctx.params.number, 0);
    const pull = repo.pulls.get(number);
    if (!pull) return message(404, `Pull request ${number} not found`);
    const files = ctx.store.pullFiles(repo, pull);
    return json(200, files.map((file) => ({
      sha: hashObject('blob', Buffer.from(file.filename, 'utf8')),
      filename: file.filename,
      status: file.status,
      additions: file.additions,
      deletions: file.deletions,
      changes: file.changes,
      blob_url: '',
      raw_url: '',
      contents_url: '',
      patch: '',
    })));
  },

  mergePull(ctx) {
    const repo = repoOr404(ctx);
    if ('status' in repo) return repo;
    const number = asNumber(ctx.params.number, 0);
    const pull = repo.pulls.get(number);
    if (!pull) return message(404, `Pull request ${number} not found`);
    const method = asString(bodyField(ctx.body, 'merge_method'), 'merge');
    const result = ctx.store.mergePull(repo, pull, method);
    if ('error' in result) return message(result.status, result.error);
    return json(200, { sha: result.sha, merged: true, message: `Pull request #${number} merged` });
  },
};
