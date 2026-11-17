// mcp.ts — Model Context Protocol over streamable HTTP (JSON-RPC 2.0, plain-JSON answers).
// Pure Node, zero dependencies. Erasable TypeScript only.
// Six canonical tools, deterministic tools/list, cross-surface effects via the shared store.
import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { VIEWER, createStore } from './store.ts';

type Store = ReturnType<typeof createStore>;
type Json = Record<string, unknown>;

const JSON_CT = 'application/json; charset=utf-8';
const SERVER_NAME = 'coreforge';
const SERVER_VERSION = '1.0.0';
const FALLBACK_REVISION = '2025-11-25';
const REVISION_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_BODY = 10 * 1024 * 1024;

const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const INTERNAL_ERROR = -32603;
const UNAUTHORIZED = -32001;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': JSON_CT, 'content-length': Buffer.byteLength(text), ...headers });
  res.end(text);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

// ---- JSON shapes (same fields the REST surface returns) ----

function ownerJson(login: string): Json {
  if (login === VIEWER.login) return { login, id: VIEWER.id, type: 'User' };
  return { login, id: 0, type: 'User' };
}

function userJson(login: string): Json {
  const base = ownerJson(login);
  const out: Json = { ...base, node_id: `U_${base.id}`, avatar_url: '', gravatar_id: '', url: '', html_url: '', site_admin: false };
  if (login === VIEWER.login) {
    out.name = VIEWER.name;
    out.email = VIEWER.email;
  }
  return out;
}

function repoJson(repo: NonNullable<ReturnType<Store['getRepo']>>): Json {
  return {
    id: repo.id,
    node_id: `R_${repo.id}`,
    name: repo.name,
    full_name: repo.full_name,
    owner: ownerJson(repo.owner),
    private: repo.private,
    description: repo.description,
    fork: false,
    created_at: repo.created_at,
    updated_at: repo.updated_at,
    pushed_at: repo.pushed_at,
    size: 0,
    stargazers_count: 0,
    watchers_count: 0,
    language: null,
    has_issues: true,
    forks_count: 0,
    open_issues_count: repo.issues.size,
    license: null,
    topics: [],
    default_branch: repo.default_branch,
  };
}

function issueJson(repo: NonNullable<ReturnType<Store['getRepo']>>, issue: NonNullable<ReturnType<Store['getIssue']>>): Json {
  return {
    id: issue.id,
    node_id: `I_${repo.id}_${issue.number}`,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    locked: false,
    user: userJson(issue.user.login),
    labels: issue.labels.map((name) => ({ id: 0, name, color: 'ededed', description: '' })),
    assignee: null,
    assignees: [],
    comments: issue.comments.length,
    created_at: issue.created_at,
    updated_at: issue.updated_at,
    closed_at: issue.state === 'closed' ? issue.updated_at : null,
    author_association: 'OWNER',
  };
}

function pullJson(repo: NonNullable<ReturnType<Store['getRepo']>>, pull: NonNullable<ReturnType<Store['getPull']>>): Json {
  const headSha = pull.head.sha || store_getRef(repo, pull.head.ref);
  const baseSha = pull.base.sha || store_getRef(repo, pull.base.ref);
  return {
    id: pull.id,
    node_id: `P_${repo.id}_${pull.number}`,
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

function store_getRef(repo: NonNullable<ReturnType<Store['getRepo']>>, ref: string): string {
  return repo.refs.get(`refs/heads/${ref}`) ?? '';
}

// ---- tools/list (fixed order, byte-identical every call) ----

type ToolDef = { name: string; description: string; inputSchema: Json };

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the viewer.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner login of the new repository.' },
        name: { type: 'string', description: 'Repository name.' },
        description: { type: 'string', description: 'Repository description.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner login.' },
        repo: { type: 'string', description: 'Repository name.' },
        full_name: { type: 'string', description: 'Full repository name "owner/repo" (alternative to owner and repo).' },
      },
      required: ['owner', 'repo'],
      additionalProperties: false,
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner login.' },
        repo: { type: 'string', description: 'Repository name.' },
        full_name: { type: 'string', description: 'Full repository name "owner/repo" (alternative to owner and repo).' },
        title: { type: 'string', description: 'Issue title.' },
        body: { type: 'string', description: 'Issue body.' },
      },
      required: ['owner', 'repo', 'title'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner login.' },
        repo: { type: 'string', description: 'Repository name.' },
        full_name: { type: 'string', description: 'Full repository name "owner/repo" (alternative to owner and repo).' },
        state: { type: 'string', description: 'Issue state filter: open, closed, or all.', enum: ['open', 'closed', 'all'] },
      },
      required: ['owner', 'repo'],
      additionalProperties: false,
    },
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner login.' },
        repo: { type: 'string', description: 'Repository name.' },
        full_name: { type: 'string', description: 'Full repository name "owner/repo" (alternative to owner and repo).' },
        title: { type: 'string', description: 'Pull request title.' },
        body: { type: 'string', description: 'Pull request body.' },
        head: { type: 'string', description: 'Head branch name.' },
        base: { type: 'string', description: 'Base branch name.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
      additionalProperties: false,
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner login.' },
        repo: { type: 'string', description: 'Repository name.' },
        full_name: { type: 'string', description: 'Full repository name "owner/repo" (alternative to owner and repo).' },
        pull_number: { type: 'integer', description: 'Pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
      additionalProperties: false,
    },
  },
];

// ---- argument resolution (canonical names + documented aliases) ----

const OWNER_KEYS = ['owner', 'owner_login', 'org', 'organization', 'organisation', 'user', 'user_login', 'login', 'account', 'namespace', 'owner_name'];
const REPO_KEYS = ['repo', 'repository', 'repository_name', 'repo_name', 'repo_slug', 'project', 'project_name'];
const FULL_NAME_KEYS = ['full_name', 'repo_full_name', 'repository_full_name', 'fullName'];
const TITLE_KEYS = ['title', 'issue_title', 'pr_title', 'pull_request_title', 'subject'];
const BODY_KEYS = ['body', 'issue_body', 'description', 'content', 'text', 'comment'];
const HEAD_KEYS = ['head', 'head_ref', 'head_branch', 'pull_request_head', 'pr_head', 'source', 'source_ref', 'source_branch', 'from', 'from_branch', 'branch'];
const BASE_KEYS = ['base', 'base_ref', 'base_branch', 'pull_request_base', 'pr_base', 'target', 'target_ref', 'target_branch', 'into', 'into_branch'];
const NUMBER_KEYS = ['pull_number', 'pull_request_number', 'pr_number', 'number', 'issue_number', 'index'];
const NAME_KEYS = ['name', 'repo', 'repository', 'repository_name', 'repo_name'];
const PRIVATE_KEYS = ['private', 'is_private'];
const STATE_KEYS = ['state', 'status'];

function pickString(args: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = args[key];
    if (typeof value === 'string' && value !== '') return value;
  }
  return undefined;
}

function pickValue(args: Record<string, unknown>, keys: string[]): unknown {
  for (const key of keys) {
    const value = args[key];
    if (value !== undefined) return value;
  }
  return undefined;
}

/** Resolve owner/repo from canonical names, aliases, or a "owner/repo" full_name. */
function resolveRepoRef(args: Record<string, unknown>): { owner: string; repo: string } | null {
  let owner = pickString(args, OWNER_KEYS);
  let repo = pickString(args, REPO_KEYS);
  if ((owner === undefined || repo === undefined)) {
    const full = pickString(args, FULL_NAME_KEYS);
    if (full !== undefined) {
      const slash = full.indexOf('/');
      if (slash > 0 && slash < full.length - 1) {
        owner = owner ?? full.slice(0, slash);
        repo = repo ?? full.slice(slash + 1);
      }
    }
  }
  if (owner === undefined || repo === undefined) return null;
  return { owner, repo };
}

function toolOk(result: Json): Json {
  return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
}

function toolFail(message: string): Json {
  return { content: [{ type: 'text', text: JSON.stringify({ error: message }) }], isError: true };
}

export function createMcpHandlers(store: Store, token: string): (req: IncomingMessage, res: ServerResponse) => Promise<boolean> {
  const sessions = new Set<string>();

  function authed(req: IncomingMessage): boolean {
    if (token === '') return true;
    return req.headers.authorization === `Bearer ${token}`;
  }

  function sessionHeaders(req: IncomingMessage): Record<string, string> {
    const incoming = req.headers['mcp-session-id'];
    const id = typeof incoming === 'string' && incoming !== '' ? incoming : randomUUID();
    sessions.add(id);
    return { 'mcp-session-id': id };
  }

  function rpcError(res: ServerResponse, status: number, id: unknown, code: number, message: string, extraHeaders: Record<string, string> = {}): void {
    sendJson(res, status, { jsonrpc: '2.0', id: id ?? null, error: { code, message } }, extraHeaders);
  }

  function rpcResult(res: ServerResponse, id: unknown, result: unknown, extraHeaders: Record<string, string> = {}): void {
    sendJson(res, 200, { jsonrpc: '2.0', id, result }, extraHeaders);
  }

  /** Dispatch one tools/call; never throws (failures become isError results). */
  function callTool(name: string, args: Record<string, unknown>): Json {
    switch (name) {
      case 'create_repo': {
        const repoName = pickString(args, NAME_KEYS);
        if (repoName === undefined) return toolFail('create_repo requires "name"');
        const owner = pickString(args, OWNER_KEYS) ?? VIEWER.login;
        const created = store.createRepo(owner, repoName, {
          description: typeof pickValue(args, ['description', 'about', 'summary', 'body']) === 'string' ? (pickValue(args, ['description', 'about', 'summary', 'body']) as string) : undefined,
          private: pickValue(args, PRIVATE_KEYS) === true,
        });
        if (created === null) return toolFail(`repository ${owner}/${repoName} already exists`);
        return toolOk(repoJson(created));
      }
      case 'get_repo': {
        const ref = resolveRepoRef(args);
        if (ref === null) return toolFail('get_repo requires "owner" and "repo"');
        const repo = store.getRepo(ref.owner, ref.repo);
        if (repo === undefined) return toolFail(`repository ${ref.owner}/${ref.repo} not found`);
        return toolOk(repoJson(repo));
      }
      case 'create_issue': {
        const ref = resolveRepoRef(args);
        const title = pickString(args, TITLE_KEYS);
        if (ref === null || title === undefined) return toolFail('create_issue requires "owner", "repo" and "title"');
        const repo = store.getRepo(ref.owner, ref.repo);
        if (repo === undefined) return toolFail(`repository ${ref.owner}/${ref.repo} not found`);
        const body = pickValue(args, BODY_KEYS);
        const issue = store.createIssue(repo, { title, body: typeof body === 'string' ? body : undefined });
        return toolOk(issueJson(repo, issue));
      }
      case 'list_issues': {
        const ref = resolveRepoRef(args);
        if (ref === null) return toolFail('list_issues requires "owner" and "repo"');
        const repo = store.getRepo(ref.owner, ref.repo);
        if (repo === undefined) return toolFail(`repository ${ref.owner}/${ref.repo} not found`);
        const state = pickString(args, STATE_KEYS);
        const issues = store.listIssues(repo, { state: state === 'all' || state === undefined ? undefined : state });
        return toolOk({ issues: issues.map((issue) => issueJson(repo, issue)) });
      }
      case 'create_pull_request': {
        const ref = resolveRepoRef(args);
        const title = pickString(args, TITLE_KEYS);
        const head = pickString(args, HEAD_KEYS);
        const base = pickString(args, BASE_KEYS);
        if (ref === null || title === undefined || head === undefined || base === undefined) {
          return toolFail('create_pull_request requires "owner", "repo", "title", "head" and "base"');
        }
        const repo = store.getRepo(ref.owner, ref.repo);
        if (repo === undefined) return toolFail(`repository ${ref.owner}/${ref.repo} not found`);
        if (store.getRef(repo, `refs/heads/${head}`) === undefined) return toolFail(`head branch "${head}" not found`);
        if (store.getRef(repo, `refs/heads/${base}`) === undefined) return toolFail(`base branch "${base}" not found`);
        const body = pickValue(args, BODY_KEYS);
        const pull = store.createPull(repo, { title, body: typeof body === 'string' ? body : undefined, head, base });
        return toolOk(pullJson(repo, pull));
      }
      case 'merge_pull_request': {
        const ref = resolveRepoRef(args);
        const rawNumber = pickValue(args, NUMBER_KEYS);
        const pullNumber = typeof rawNumber === 'number' ? rawNumber : typeof rawNumber === 'string' && /^\d+$/.test(rawNumber) ? Number(rawNumber) : undefined;
        if (ref === null || pullNumber === undefined) return toolFail('merge_pull_request requires "owner", "repo" and "pull_number"');
        const repo = store.getRepo(ref.owner, ref.repo);
        if (repo === undefined) return toolFail(`repository ${ref.owner}/${ref.repo} not found`);
        const pull = store.getPull(repo, pullNumber);
        if (pull === undefined) return toolFail(`pull request #${pullNumber} not found`);
        const merged = store.mergePull(repo, pullNumber, 'merge');
        if (!merged.merged) return toolFail(merged.message ?? `could not merge pull request #${pullNumber}`);
        return toolOk({ merged: true, sha: merged.sha ?? null, pull_number: pullNumber });
      }
      default:
        return toolFail(`unknown tool "${name}"`);
    }
  }

  return async function handleMcp(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (req.method !== 'POST' || url.pathname !== '/mcp') return false;

      // Auth first: a missing/wrong bearer token is HTTP 401, before any JSON parsing.
      if (!authed(req)) {
        rpcError(res, 401, null, UNAUTHORIZED, 'Unauthorized');
        return true;
      }

      let text: string;
      try {
        text = await readBody(req);
      } catch {
        rpcError(res, 400, null, PARSE_ERROR, 'Parse error');
        return true;
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        rpcError(res, 400, null, PARSE_ERROR, 'Parse error');
        return true;
      }

      if (!isRecord(parsed) || parsed.jsonrpc !== '2.0' || typeof parsed.method !== 'string') {
        rpcError(res, 400, isRecord(parsed) ? parsed.id : null, INVALID_REQUEST, 'Invalid Request');
        return true;
      }

      const id = parsed.id;
      const isNotification = id === undefined || id === null;
      const method = parsed.method;
      const params = isRecord(parsed.params) ? parsed.params : {};
      const headers = sessionHeaders(req);

      // Notifications carry no id and get an empty 202.
      if (isNotification) {
        res.writeHead(202, { ...headers });
        res.end();
        return true;
      }

      switch (method) {
        case 'initialize': {
          const offered = typeof params.protocolVersion === 'string' && REVISION_RE.test(params.protocolVersion) ? params.protocolVersion : FALLBACK_REVISION;
          rpcResult(res, id, {
            protocolVersion: offered,
            capabilities: { tools: {} },
            serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
          }, headers);
          return true;
        }
        case 'tools/list': {
          rpcResult(res, id, { tools: TOOLS }, headers);
          return true;
        }
        case 'tools/call': {
          const toolName = typeof params.name === 'string' ? params.name : undefined;
          const args = isRecord(params.arguments) ? params.arguments : undefined;
          if (toolName === undefined || args === undefined) {
            rpcError(res, 200, id, INVALID_PARAMS, 'tools/call requires "name" and "arguments"', headers);
            return true;
          }
          const known = TOOLS.some((tool) => tool.name === toolName);
          if (!known) {
            rpcError(res, 200, id, INVALID_PARAMS, `unknown tool "${toolName}"`, headers);
            return true;
          }
          let result: Json;
          try {
            result = callTool(toolName, args);
          } catch (error) {
            result = toolFail(error instanceof Error ? error.message : String(error));
          }
          rpcResult(res, id, result, headers);
          return true;
        }
        default: {
          rpcError(res, 200, id, METHOD_NOT_FOUND, `Method not found: ${method}`, headers);
          return true;
        }
      }
    } catch {
      try {
        rpcError(res, 200, null, INTERNAL_ERROR, 'Internal error');
      } catch {
        // response already gone; nothing left to do
      }
      return true;
    }
  };
}
