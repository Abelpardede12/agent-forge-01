// mcp.ts — Model Context Protocol endpoint for the forge: JSON-RPC over POST /mcp,
// the 2026-07-28 modern era (server/discover, no handshake) with the legacy
// initialize fallback. Six tools over the same shared in-memory store the REST
// and GraphQL surfaces use, so effects are visible across surfaces.
import {
  store as singletonStore,
  VIEWER,
  toGlobalId,
  getRepo,
  createRepo,
  createIssue,
  createPull,
  mergePull,
  refTip,
  resolveRef,
} from './store.ts';
import type { Store } from './store.ts';

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

type AnyRecord = Record<string, any>;

function isRecord(v: unknown): v is AnyRecord {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

const SERVER_NAME = 'coreforge';
const SERVER_VERSION = '1.0.0';
const SUPPORTED_VERSIONS: readonly string[] = [
  '2026-07-28',
  '2025-11-25',
  '2025-06-18',
  '2025-03-26',
  '2024-11-05',
];

function serverInfo(): AnyRecord {
  return { name: SERVER_NAME, version: SERVER_VERSION };
}

function capabilities(): AnyRecord {
  return { tools: {} };
}

// ---------------------------------------------------------------------------
// The six tools
// ---------------------------------------------------------------------------

interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, AnyRecord>;
    required: string[];
    additionalProperties: boolean;
  };
}

const TOOLS: readonly ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository for the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Repository name.' },
        description: { type: 'string', description: 'Optional short description.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
        owner: { type: 'string', description: 'Optional owner login; defaults to the authenticated user.' },
      },
      required: ['name'],
      additionalProperties: true,
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login.' },
        repo: { type: 'string', description: 'Repository name.' },
        full_name: { type: 'string', description: 'Full repository name, "owner/repo".' },
      },
      required: ['owner', 'repo'],
      additionalProperties: true,
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login.' },
        repo: { type: 'string', description: 'Repository name.' },
        full_name: { type: 'string', description: 'Full repository name, "owner/repo".' },
        title: { type: 'string', description: 'Issue title.' },
        body: { type: 'string', description: 'Optional issue body.' },
      },
      required: ['owner', 'repo', 'title'],
      additionalProperties: true,
    },
  },
  {
    name: 'list_issues',
    description: 'List the issues of a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login.' },
        repo: { type: 'string', description: 'Repository name.' },
        full_name: { type: 'string', description: 'Full repository name, "owner/repo".' },
        state: { type: 'string', description: 'Issue state filter: open, closed or all.' },
      },
      required: ['owner', 'repo'],
      additionalProperties: true,
    },
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login.' },
        repo: { type: 'string', description: 'Repository name.' },
        full_name: { type: 'string', description: 'Full repository name, "owner/repo".' },
        title: { type: 'string', description: 'Pull request title.' },
        body: { type: 'string', description: 'Optional pull request body.' },
        head: { type: 'string', description: 'Head branch name.' },
        base: { type: 'string', description: 'Base branch name.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
      additionalProperties: true,
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login.' },
        repo: { type: 'string', description: 'Repository name.' },
        full_name: { type: 'string', description: 'Full repository name, "owner/repo".' },
        pull_number: { type: 'integer', description: 'Pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
      additionalProperties: true,
    },
  },
];

const TOOL_MAP: ReadonlyMap<string, ToolDef> = new Map(TOOLS.map((tool) => [tool.name, tool]));

// ---------------------------------------------------------------------------
// Store-backed tool implementations
// ---------------------------------------------------------------------------

function viewerLogin(): string {
  return String(VIEWER.login);
}

function headShaOf(store: Store, repo: any): string | null {
  try {
    const sha = refTip(repo, String(repo.defaultBranch ?? 'main'));
    if (typeof sha === 'string' && sha !== '') return sha;
  } catch {
    // fall through
  }
  try {
    const sha = refTip(repo, 'main');
    if (typeof sha === 'string' && sha !== '') return sha;
  } catch {
    // fall through
  }
  return null;
}

function repoResult(store: Store, repo: any): AnyRecord {
  return {
    id: repo.id,
    node_id: toGlobalId('Repository', repo.id),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner },
    private: repo.isPrivate === true,
    description: repo.description ?? '',
    default_branch: repo.defaultBranch ?? 'main',
    head_commit_sha: headShaOf(store, repo),
  };
}

function issueResult(repo: any, issue: any): AnyRecord {
  return {
    id: issue.id,
    node_id: toGlobalId('Issue', issue.id),
    number: issue.number,
    title: issue.title,
    body: issue.body ?? '',
    state: issue.state ?? 'open',
    labels: Array.isArray(issue.labels) ? issue.labels : [],
    user: { login: issue.userLogin ?? viewerLogin() },
  };
}

function pullResult(repo: any, pull: any): AnyRecord {
  return {
    id: pull.id,
    node_id: toGlobalId('PullRequest', pull.id),
    number: pull.number,
    title: pull.title,
    body: pull.body ?? '',
    state: pull.state ?? 'open',
    merged: pull.merged === true,
    head: { ref: pull.headRef, sha: pull.headSha ?? null },
    base: { ref: pull.baseRef, sha: pull.baseSha ?? null },
    merge_commit_sha: pull.mergeCommitSha ?? null,
  };
}

/** owner + repo out of the arguments (full_name split when the parts are absent). */
function resolveOwnerRepo(args: AnyRecord): { owner: string; repo: string } {
  let owner = typeof args.owner === 'string' && args.owner !== '' ? args.owner : '';
  let repo = typeof args.repo === 'string' && args.repo !== '' ? args.repo : '';
  if ((owner === '' || repo === '') && typeof args.full_name === 'string' && args.full_name.includes('/')) {
    const [o, r] = args.full_name.split('/', 2);
    if (owner === '' && o !== undefined && o !== '') owner = o;
    if (repo === '' && r !== undefined && r !== '') repo = r;
  }
  if (owner === '') owner = viewerLogin();
  return { owner, repo };
}

function requireRepo(store: Store, args: AnyRecord): any {
  const { owner, repo } = resolveOwnerRepo(args);
  if (repo === '') throw new Error('a repository name is required');
  const found = getRepo(store, owner, repo);
  if (found === undefined || found === null) throw new Error(`Repository not found: ${owner}/${repo}`);
  return found;
}

function findPull(repo: any, number: number): any | undefined {
  const pulls = repo.pulls;
  if (pulls instanceof Map) {
    const direct = pulls.get(number);
    if (direct !== undefined) return direct;
    for (const pull of pulls.values()) {
      if (pull.number === number) return pull;
    }
    return undefined;
  }
  if (Array.isArray(pulls)) return pulls.find((pull: any) => pull.number === number);
  if (isRecord(pulls)) return (pulls as AnyRecord)[String(number)];
  return undefined;
}

type ToolFn = (store: Store, args: AnyRecord) => unknown;

const TOOL_IMPLEMENTATIONS: Record<string, ToolFn> = {
  create_repo: (store, args) => {
    const name = String(args.name ?? '');
    if (name === '') throw new Error('a repository name is required');
    const owner = typeof args.owner === 'string' && args.owner !== '' ? args.owner : viewerLogin();
    const existing = getRepo(store, owner, name);
    if (existing !== undefined && existing !== null) return repoResult(store, existing);
    const repo = createRepo(store, owner, name, {
      private: args.private === true,
      description: typeof args.description === 'string' ? args.description : '',
    });
    return repoResult(store, repo);
  },
  get_repo: (store, args) => {
    const repo = requireRepo(store, args);
    return repoResult(store, repo);
  },
  create_issue: (store, args) => {
    const repo = requireRepo(store, args);
    const created: any = createIssue(store, repo, { title: String(args.title ?? ''), body: String(args.body ?? '') });
    if (created === undefined || created === null || created.issue === undefined) {
      throw new Error(`createIssue: ${created?.error ?? 'failed'}`);
    }
    return issueResult(repo, created.issue);
  },
  list_issues: (store, args) => {
    const repo = requireRepo(store, args);
    const wanted = typeof args.state === 'string' ? args.state.toLowerCase() : 'open';
    let issues: any[] = [...(repo.issues ?? [])];
    if (wanted === 'open') issues = issues.filter((issue) => issue.state !== 'closed');
    else if (wanted === 'closed') issues = issues.filter((issue) => issue.state === 'closed');
    issues.sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0) || a.number - b.number);
    return issues.map((issue) => issueResult(repo, issue));
  },
  create_pull_request: (store, args) => {
    const repo = requireRepo(store, args);
    const head = String(args.head ?? '');
    const base = String(args.base ?? '');
    if (head === '' || base === '') throw new Error('head and base branches are required');
    let headRef: unknown;
    try { headRef = resolveRef(repo, `refs/heads/${head}`); } catch { headRef = undefined; }
    if (headRef === undefined || headRef === null) throw new Error(`head branch ${head} does not exist`);
    let baseRef: unknown;
    try { baseRef = resolveRef(repo, `refs/heads/${base}`); } catch { baseRef = undefined; }
    if (baseRef === undefined || baseRef === null) throw new Error(`base branch ${base} does not exist`);
    const created: any = createPull(store, repo, {
      head,
      base,
      title: String(args.title ?? ''),
      body: String(args.body ?? ''),
    });
    if (created === undefined || created === null || created.pull === undefined) {
      throw new Error(`createPullRequest: ${created?.error ?? 'failed'}`);
    }
    return pullResult(repo, created.pull);
  },
  merge_pull_request: (store, args) => {
    const repo = requireRepo(store, args);
    const number = Number(args.pull_number);
    if (!Number.isInteger(number)) throw new Error('a pull request number is required');
    const pull = findPull(repo, number);
    if (pull === undefined) throw new Error(`Pull request #${number} not found`);
    const merged: any = mergePull(store, repo, pull, 'merge');
    if (merged !== undefined && merged !== null && merged.ok === false) {
      throw new Error(`mergePullRequest: ${merged.message ?? merged.error ?? 'merge failed'}`);
    }
    return {
      number: pull.number,
      merged: true,
      state: 'closed',
      merge_commit_sha: pull.mergeCommitSha ?? null,
      sha: pull.mergeCommitSha ?? null,
    };
  },
};

// ---------------------------------------------------------------------------
// JSON-RPC dispatch
// ---------------------------------------------------------------------------

interface RpcResponse {
  status: number;
  body: unknown;
}

function rpcResult(id: unknown, result: unknown): RpcResponse {
  return { status: 200, body: { jsonrpc: '2.0', id: id ?? null, result } };
}

function rpcError(id: unknown, code: number, message: string, status = 200): RpcResponse {
  return { status, body: { jsonrpc: '2.0', id: id ?? null, error: { code, message } } };
}

function parseError(): RpcResponse {
  return rpcError(null, -32700, 'parse error', 400);
}

function toolResult(result: unknown): AnyRecord {
  return {
    content: [{ type: 'text', text: JSON.stringify(result) }],
    structuredContent: result,
  };
}

function toolError(message: string): AnyRecord {
  return {
    content: [{ type: 'text', text: message }],
    isError: true,
  };
}

function dispatchCall(store: Store, request: AnyRecord): RpcResponse {
  const id = request.id ?? null;
  const method = typeof request.method === 'string' ? request.method : '';
  const params = isRecord(request.params) ? request.params : {};

  if (method === 'server/discover') {
    const info = serverInfo();
    return rpcResult(id, {
      supportedVersions: [...SUPPORTED_VERSIONS],
      capabilities: capabilities(),
      serverInfo: info,
      instructions:
        'GitHub-compatible git forge: repositories, issues, pull requests, GraphQL and MCP over one in-memory store.',
      _meta: { 'io.modelcontextprotocol/serverInfo': info },
    });
  }

  if (method === 'initialize') {
    const offered = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
    const negotiated = (SUPPORTED_VERSIONS as readonly string[]).includes(offered) ? offered : '2025-11-25';
    return rpcResult(id, {
      protocolVersion: negotiated,
      capabilities: capabilities(),
      serverInfo: serverInfo(),
    });
  }

  if (method.startsWith('notifications/')) {
    return { status: 202, body: {} };
  }

  if (method === 'ping') {
    return rpcResult(id, {});
  }

  if (method === 'tools/list') {
    return rpcResult(id, { tools: TOOLS });
  }

  if (method === 'tools/call') {
    const name = typeof params.name === 'string' ? params.name : '';
    const tool = TOOL_MAP.get(name);
    if (tool === undefined) {
      return rpcError(id, -32602, `unknown tool ${name}`);
    }
    const args = isRecord(params.arguments) ? params.arguments : {};
    const missing = tool.inputSchema.required.filter((key) => args[key] === undefined || args[key] === null);
    if (missing.length > 0) {
      return rpcResult(id, toolError(`missing required argument(s): ${missing.join(', ')}`));
    }
    try {
      const result = TOOL_IMPLEMENTATIONS[name]!(store, args);
      return rpcResult(id, toolResult(result));
    } catch (err) {
      return rpcResult(id, toolError(err instanceof Error ? err.message : String(err)));
    }
  }

  return rpcError(id, -32601, `method not found: ${method}`);
}

// ---------------------------------------------------------------------------
// HTTP entry: the app wires this as a handler factory — handleMcp(store)
// returns (req, res) — and also calls the export directly as (req, res).
// The legacy handleMcp(store, body) -> {status, body} shape is kept too.
// ---------------------------------------------------------------------------

let boundStore: any = null;

function isStoreLike(v: unknown): boolean {
  return isRecord(v) && (v as AnyRecord).repos instanceof Map;
}

function isReqLike(v: unknown): boolean {
  return isRecord(v) && typeof (v as AnyRecord).method === 'string' && typeof (v as AnyRecord).on === 'function';
}

function isResLike(v: unknown): boolean {
  return isRecord(v) && typeof (v as AnyRecord).writeHead === 'function' && typeof (v as AnyRecord).end === 'function';
}

function resolveStore(candidate?: unknown): any {
  if (isStoreLike(candidate)) return candidate;
  if (boundStore !== null) return boundStore;
  return singletonStore;
}

async function readJsonBody(req: any): Promise<unknown> {
  if (isRecord(req.body)) return req.body;
  if (typeof req.body === 'string') {
    try { return JSON.parse(req.body); } catch { return null; }
  }
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as any));
  const text = Buffer.concat(chunks).toString('utf8');
  if (text === '') return null;
  try { return JSON.parse(text); } catch { return null; }
}

function writeJson(res: any, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

function checkAuth(store: any, req: any): boolean {
  const token = typeof store?.token === 'string' ? store.token : '';
  if (token === '') return true;
  const header = req.headers?.authorization ?? req.headers?.Authorization ?? '';
  return header === `Bearer ${token}`;
}

function handleMcpLegacy(store: Store, body: unknown): RpcResponse {
  if (Array.isArray(body)) {
    const responses = body.map((entry) => {
      if (!isRecord(entry)) return parseError().body;
      return dispatchCall(store, entry).body;
    });
    return { status: 200, body: responses };
  }
  if (!isRecord(body)) return parseError();
  return dispatchCall(store, body);
}

async function handleMcpHttp(req: any, res: any, store: any): Promise<void> {
  if (!checkAuth(store, req)) {
    writeJson(res, 401, { message: 'Requires authentication' });
    return;
  }
  const body = await readJsonBody(req);
  if (body === null) {
    writeJson(res, 400, parseError().body);
    return;
  }
  const result = handleMcpLegacy(store, body);
  writeJson(res, result.status, result.body);
}

export function handleMcp(...args: unknown[]): unknown {
  if (args.length === 1 && isStoreLike(args[0])) {
    boundStore = args[0];
    const store = args[0];
    return (req: any, res: any) => handleMcpHttp(req, res, store);
  }
  if (args.length === 2 && isReqLike(args[0]) && isResLike(args[1])) {
    return handleMcpHttp(args[0], args[1], resolveStore());
  }
  if (args.length === 2 && isStoreLike(args[0])) {
    boundStore = args[0];
    return handleMcpLegacy(args[0] as any, args[1]);
  }
  if (args.length === 2 && isStoreLike(args[1])) {
    boundStore = args[1];
    return handleMcpLegacy(args[1] as any, args[0]);
  }
  if (args.length === 1) {
    return handleMcpLegacy(resolveStore(), args[0]);
  }
  return parseError();
}
