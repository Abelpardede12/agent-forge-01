// MCP (Model Context Protocol), modern era revision 2026-07-28, with the
// legacy initialize handshake kept as a fallback. One static tool list; six
// tools that act on the same store as REST and GraphQL.

import { globalId, type Repo, type Store } from './store.ts';

export interface ToolDef {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: {
    readonly type: 'object';
    readonly properties: Record<string, { type: string; description?: string }>;
    readonly required?: string[];
    readonly additionalProperties?: boolean;
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
        full_name: { type: 'string', description: 'owner/repo, an alternative to owner and repo.' },
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
        full_name: { type: 'string', description: 'owner/repo, an alternative to owner and repo.' },
        title: { type: 'string', description: 'Issue title.' },
        body: { type: 'string', description: 'Optional issue body.' },
      },
      required: ['owner', 'repo', 'title'],
      additionalProperties: true,
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login.' },
        repo: { type: 'string', description: 'Repository name.' },
        full_name: { type: 'string', description: 'owner/repo, an alternative to owner and repo.' },
        state: { type: 'string', description: 'open, closed, or all.' },
      },
      required: ['owner', 'repo'],
      additionalProperties: true,
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login.' },
        repo: { type: 'string', description: 'Repository name.' },
        full_name: { type: 'string', description: 'owner/repo, an alternative to owner and repo.' },
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
    description: 'Merge a pull request in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login.' },
        repo: { type: 'string', description: 'Repository name.' },
        full_name: { type: 'string', description: 'owner/repo, an alternative to owner and repo.' },
        pull_number: { type: 'integer', description: 'Pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
      additionalProperties: true,
    },
  },
];

const LEGACY_REVISIONS = new Set(['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05']);
const MODERN_REVISION = '2026-07-28';

interface JsonRpcRequest {
  readonly jsonrpc?: unknown;
  readonly id?: unknown;
  readonly method?: unknown;
  readonly params?: unknown;
}

function rpcResult(id: unknown, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, result };
}

function rpcError(id: unknown, code: number, message: string, data?: unknown): Record<string, unknown> {
  const error: Record<string, unknown> = { code, message };
  if (data !== undefined) error.data = data;
  return { jsonrpc: '2.0', id: id ?? null, error };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Resolve owner/repo from the argument object (owner+repo, or full_name). */
function resolveRepo(store: Store, args: Record<string, unknown>): { repo: Repo } | { error: string } {
  let owner = typeof args.owner === 'string' ? args.owner : '';
  let repoName = typeof args.repo === 'string' ? args.repo : '';
  if ((owner === '' || repoName === '') && typeof args.full_name === 'string') {
    const parts = args.full_name.split('/');
    if (parts.length === 2) {
      owner = parts[0]!;
      repoName = parts[1]!;
    }
  }
  if (owner === '' || repoName === '') return { error: 'owner and repo are required' };
  const repo = store.getRepo(owner, repoName);
  if (!repo) return { error: `repository ${owner}/${repoName} not found` };
  return { repo };
}

function textResult(payload: unknown): Record<string, unknown> {
  const text = typeof payload === 'string' ? payload : JSON.stringify(payload);
  return { content: [{ type: 'text', text }], structuredContent: isRecord(payload) ? payload : { value: payload } };
}

function errorResult(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function repoPayload(store: Store, repo: Repo): Record<string, unknown> {
  const head = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  return {
    id: repo.id,
    node_id: globalId('Repository', repo.id),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner },
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    head_commit_sha: head ?? null,
  };
}

function callTool(store: Store, name: string, args: Record<string, unknown>): Record<string, unknown> {
  switch (name) {
    case 'create_repo': {
      const repoName = typeof args.name === 'string' ? args.name.trim() : '';
      if (repoName === '') return errorResult('name is required');
      const owner = typeof args.owner === 'string' && args.owner !== '' ? args.owner : store.viewer.login;
      if (store.getRepo(owner, repoName)) return errorResult(`name already exists on this account`);
      const repo = store.createRepo(owner, repoName, {
        description: typeof args.description === 'string' ? args.description : '',
        private: typeof args.private === 'boolean' ? args.private : false,
      });
      return textResult(repoPayload(store, repo));
    }
    case 'get_repo': {
      const resolved = resolveRepo(store, args);
      if ('error' in resolved) return errorResult(resolved.error);
      return textResult(repoPayload(store, resolved.repo));
    }
    case 'create_issue': {
      const resolved = resolveRepo(store, args);
      if ('error' in resolved) return errorResult(resolved.error);
      const title = typeof args.title === 'string' ? args.title.trim() : '';
      if (title === '') return errorResult('title is required');
      const issue = store.createIssue(resolved.repo, title, typeof args.body === 'string' ? args.body : '', []);
      return textResult({
        id: issue.id,
        node_id: globalId('Issue', resolved.repo.id, issue.number),
        number: issue.number,
        title: issue.title,
        body: issue.body,
        state: issue.state,
        repository: `${resolved.repo.owner}/${resolved.repo.name}`,
      });
    }
    case 'list_issues': {
      const resolved = resolveRepo(store, args);
      if ('error' in resolved) return errorResult(resolved.error);
      const state = typeof args.state === 'string' ? args.state : 'open';
      let issues = [...resolved.repo.issues.values()];
      if (state !== 'all') issues = issues.filter((issue) => issue.state === state);
      issues.sort((a, b) => b.createdSeq - a.createdSeq);
      return textResult({
        repository: `${resolved.repo.owner}/${resolved.repo.name}`,
        issues: issues.map((issue) => ({
          id: issue.id,
          node_id: globalId('Issue', resolved.repo.id, issue.number),
          number: issue.number,
          title: issue.title,
          body: issue.body,
          state: issue.state,
        })),
      });
    }
    case 'create_pull_request': {
      const resolved = resolveRepo(store, args);
      if ('error' in resolved) return errorResult(resolved.error);
      const title = typeof args.title === 'string' ? args.title.trim() : '';
      const head = typeof args.head === 'string' ? args.head : '';
      const base = typeof args.base === 'string' && args.base !== '' ? args.base : resolved.repo.defaultBranch;
      if (title === '' || head === '') return errorResult('title and head are required');
      const result = store.createPull(resolved.repo, { title, body: typeof args.body === 'string' ? args.body : '', head, base });
      if ('error' in result) return errorResult(result.error);
      return textResult({
        id: result.id,
        node_id: globalId('PullRequest', resolved.repo.id, result.number),
        number: result.number,
        title: result.title,
        body: result.body,
        state: result.state,
        head: { ref: result.headRef, sha: result.headSha },
        base: { ref: result.baseRef, sha: result.baseSha },
        repository: `${resolved.repo.owner}/${resolved.repo.name}`,
      });
    }
    case 'merge_pull_request': {
      const resolved = resolveRepo(store, args);
      if ('error' in resolved) return errorResult(resolved.error);
      const number = typeof args.pull_number === 'number' ? args.pull_number : Number(args.pull_number);
      if (!Number.isFinite(number)) return errorResult('pull_number is required');
      const pull = resolved.repo.pulls.get(number);
      if (!pull) return errorResult(`pull request ${number} not found`);
      const result = store.mergePull(resolved.repo, pull, 'SQUASH');
      if ('error' in result) return errorResult(result.error);
      return textResult({ number: pull.number, merged: true, sha: result.sha, state: pull.state });
    }
    default:
      return errorResult(`unknown tool ${name}`);
  }
}

function serverInfo(): Record<string, unknown> {
  return {
    supportedVersions: [MODERN_REVISION, '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'],
    capabilities: { tools: {} },
    serverInfo: { name: 'coreforge', version: '1.0.0' },
    instructions: 'GitHub-compatible git forge: repositories, issues, pull requests, GraphQL and MCP over one in-memory store.',
  };
}

function handleOne(store: Store, request: JsonRpcRequest): Record<string, unknown> | null {
  const id = 'id' in request ? request.id : null;
  const method = typeof request.method === 'string' ? request.method : '';
  const params = isRecord(request.params) ? request.params : {};

  if (method === 'server/discover') {
    const info = serverInfo();
    const result: Record<string, unknown> = { ...info };
    result._meta = { 'io.modelcontextprotocol/serverInfo': info.serverInfo };
    return rpcResult(id, result);
  }
  if (method === 'initialize') {
    const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
    const version = LEGACY_REVISIONS.has(requested) ? requested : MODERN_REVISION;
    return rpcResult(id, {
      protocolVersion: version,
      capabilities: { tools: {} },
      serverInfo: { name: 'coreforge', version: '1.0.0' },
    });
  }
  if (method === 'notifications/initialized' || method.startsWith('notifications/')) {
    return null; // Notification: no response.
  }
  if (method === 'ping') {
    return rpcResult(id, {});
  }
  if (method === 'tools/list') {
    // The static list: identical on every call.
    return rpcResult(id, { tools: TOOLS.map((tool) => ({ ...tool, inputSchema: { ...tool.inputSchema } })) });
  }
  if (method === 'tools/call') {
    const toolName = typeof params.name === 'string' ? params.name : '';
    const args = isRecord(params.arguments) ? params.arguments : {};
    const def = TOOLS.find((tool) => tool.name === toolName);
    if (!def) return rpcError(id, -32602, `unknown tool ${toolName}`);
    const required = def.inputSchema.required ?? [];
    const missing = required.filter((field) => args[field] === undefined || args[field] === null || args[field] === '');
    if (missing.length > 0) {
      return rpcResult(id, errorResult(`missing required argument(s): ${missing.join(', ')}`));
    }
    return rpcResult(id, callTool(store, toolName, args));
  }
  return rpcError(id, -32601, `method not found: ${method}`);
}

export interface McpOutcome {
  readonly status: number;
  readonly body: unknown;
}

/** Handle a decoded MCP request body (single object, or a batch array). */
export function handleMcp(store: Store, body: unknown): McpOutcome {
  if (Array.isArray(body)) {
    const results: Array<Record<string, unknown>> = [];
    for (const item of body) {
      if (!isRecord(item)) {
        results.push(rpcError(null, -32600, 'invalid request'));
        continue;
      }
      const result = handleOne(store, item as JsonRpcRequest);
      if (result !== null) results.push(result);
    }
    return { status: 200, body: results };
  }
  if (!isRecord(body)) return { status: 400, body: rpcError(null, -32700, 'parse error') };
  const result = handleOne(store, body as JsonRpcRequest);
  if (result === null) return { status: 202, body: {} };
  return { status: 200, body: result };
}
