// mcp.ts — the Model Context Protocol surface: streamable-HTTP JSON-RPC with the six forge
// tools (create_repo, get_repo, create_issue, list_issues, create_pull_request,
// merge_pull_request). Tools act on the same store as REST and GraphQL, and every answer is
// serialized deterministically — two tools/list calls return byte-identical bytes.

import { branchTip, issueJson, mergePull, repoJson } from './rest.ts';
import { forge, VIEWER } from './store.ts';
import type { PullRecord } from './store.ts';

interface ToolSpec {
  readonly name: string;
  readonly description: string;
  readonly properties: Readonly<Record<string, { type: string; description: string }>>;
  readonly required: readonly string[];
}

const str = (description: string): { type: string; description: string } => ({ type: 'string', description });
const bool = (description: string): { type: string; description: string } => ({ type: 'boolean', description });
const num = (description: string): { type: string; description: string } => ({ type: 'number', description });

export const TOOLS: readonly ToolSpec[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the authenticated user.',
    properties: {
      name: str('The repository name.'),
      description: str('A short description of the repository.'),
      private: bool('Whether the repository is private.'),
    },
    required: ['name'],
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    properties: {
      owner: str('The repository owner login.'),
      repo: str('The repository name.'),
    },
    required: ['owner', 'repo'],
  },
  {
    name: 'create_issue',
    description: 'Open a new issue in a repository.',
    properties: {
      owner: str('The repository owner login.'),
      repo: str('The repository name.'),
      title: str('The issue title.'),
      body: str('The issue body.'),
    },
    required: ['owner', 'repo', 'title'],
  },
  {
    name: 'list_issues',
    description: 'List the issues of a repository, optionally filtered by state.',
    properties: {
      owner: str('The repository owner login.'),
      repo: str('The repository name.'),
      state: str('Filter by state: open or closed.'),
    },
    required: ['owner', 'repo'],
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch into a base branch.',
    properties: {
      owner: str('The repository owner login.'),
      repo: str('The repository name.'),
      title: str('The pull request title.'),
      body: str('The pull request body.'),
      head: str('The head branch name.'),
      base: str('The base branch name.'),
    },
    required: ['owner', 'repo', 'title', 'head', 'base'],
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request by number, squashing its commits into the base branch.',
    properties: {
      owner: str('The repository owner login.'),
      repo: str('The repository name.'),
      pull_number: num('The pull request number.'),
    },
    required: ['owner', 'repo', 'pull_number'],
  },
];

function toolListResult(): Record<string, unknown> {
  return {
    tools: TOOLS.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: {
        type: 'object',
        properties: Object.fromEntries(
          Object.entries(tool.properties).map(([key, value]) => [key, { type: value.type, description: value.description }]),
        ),
        required: [...tool.required],
      },
    })),
  };
}

interface ToolOutcome {
  readonly value: unknown;
  readonly isError?: boolean;
}

function needString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== 'string' || value.length === 0) throw new Error(`missing required argument: ${key}`);
  return value;
}

class UnknownToolError extends Error {
  readonly toolName: string;

  constructor(toolName: string) {
    super(`unknown tool: ${toolName}`);
    this.toolName = toolName;
  }
}

function callTool(name: string, args: Record<string, unknown>): ToolOutcome {
  switch (name) {
    case 'create_repo': {
      const repoName = needString(args, 'name');
      if (forge.getRepo(VIEWER.login, repoName)) return { value: { message: 'name already exists' }, isError: true };
      const repo = forge.createRepo(VIEWER.login, repoName);
      if (typeof args.description === 'string') repo.description = args.description;
      if (typeof args.private === 'boolean') repo.isPrivate = args.private;
      return { value: repoJson(repo) };
    }
    case 'get_repo': {
      const repo = forge.getRepo(needString(args, 'owner'), needString(args, 'repo'));
      if (!repo) return { value: { message: 'repository not found' }, isError: true };
      return { value: repoJson(repo) };
    }
    case 'create_issue': {
      const repo = forge.getRepo(needString(args, 'owner'), needString(args, 'repo'));
      if (!repo) return { value: { message: 'repository not found' }, isError: true };
      const now = Date.now();
      const record = {
        number: repo.nextNumber,
        title: needString(args, 'title'),
        body: typeof args.body === 'string' ? args.body : '',
        state: 'open' as const,
        author: VIEWER,
        labels: [] as string[],
        comments: [],
        createdAt: now,
        updatedAt: now,
        isPull: false as const,
      };
      repo.nextNumber += 1;
      repo.issues.set(record.number, record);
      return { value: issueJson(repo, record) };
    }
    case 'list_issues': {
      const repo = forge.getRepo(needString(args, 'owner'), needString(args, 'repo'));
      if (!repo) return { value: { message: 'repository not found' }, isError: true };
      const state = typeof args.state === 'string' ? args.state : undefined;
      const records = [...repo.issues.values()].filter(
        (record) => !record.isPull && (state === undefined || record.state === state),
      );
      return { value: records.map((record) => issueJson(repo, record)) };
    }
    case 'create_pull_request': {
      const repo = forge.getRepo(needString(args, 'owner'), needString(args, 'repo'));
      if (!repo) return { value: { message: 'repository not found' }, isError: true };
      const head = needString(args, 'head');
      const base = needString(args, 'base');
      if (!branchTip(repo, head) || !branchTip(repo, base)) {
        return { value: { message: 'head or base branch not found' }, isError: true };
      }
      const now = Date.now();
      const record: PullRecord = {
        number: repo.nextNumber,
        title: needString(args, 'title'),
        body: typeof args.body === 'string' ? args.body : '',
        state: 'open',
        author: VIEWER,
        labels: [],
        comments: [],
        createdAt: now,
        updatedAt: now,
        isPull: true,
        headRef: head,
        baseRef: base,
        merged: false,
        mergedAt: null,
        mergeCommitSha: null,
        mergeMethod: null,
      };
      repo.nextNumber += 1;
      repo.issues.set(record.number, record);
      return { value: issueJson(repo, record) };
    }
    case 'merge_pull_request': {
      const repo = forge.getRepo(needString(args, 'owner'), needString(args, 'repo'));
      if (!repo) return { value: { message: 'repository not found' }, isError: true };
      const number = typeof args.pull_number === 'number' ? args.pull_number : Number(args.pull_number);
      const record = repo.issues.get(number);
      if (!record || !record.isPull) return { value: { message: 'pull request not found' }, isError: true };
      const outcome = mergePull(repo, record, 'squash');
      if (outcome.kind === 'conflict') return { value: { message: 'pull request is not mergeable' }, isError: true };
      if (outcome.kind === 'not-found') return { value: { message: 'pull request not found' }, isError: true };
      if (outcome.kind === 'already') return { value: { merged: true, sha: record.mergeCommitSha, number: record.number } };
      return { value: { merged: true, sha: outcome.sha, number: record.number } };
    }
    default:
      throw new UnknownToolError(name);
  }
}

export interface McpResponse {
  readonly status: number;
  readonly body: string;
}

function rpcResult(id: unknown, result: unknown): string {
  return JSON.stringify({ jsonrpc: '2.0', id: id ?? null, result });
}

function rpcError(id: unknown, code: number, message: string): string {
  return JSON.stringify({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });
}

/** Handle one JSON-RPC request body (already known to be valid JSON). */
export function handleMcp(rawBody: string): McpResponse {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return { status: 400, body: rpcError(null, -32700, 'Parse error') };
  }
  if (Array.isArray(parsed)) {
    const bodies = parsed.map((item) => handleOne(item)).filter((part) => part !== '');
    return { status: 200, body: bodies.length > 0 ? `[${bodies.join(',')}]` : '' };
  }
  return { status: 200, body: handleOne(parsed) };
}

function handleOne(request: unknown): string {
  if (!request || typeof request !== 'object') return rpcError(null, -32600, 'Invalid Request');
  const message = request as { id?: unknown; method?: unknown; params?: Record<string, unknown> };
  const id = message.id;
  const method = typeof message.method === 'string' ? message.method : '';
  const params = message.params ?? {};
  const isNotification = id === undefined;
  switch (method) {
    case 'initialize': {
      const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '2025-03-26';
      return rpcResult(id, {
        protocolVersion: requested,
        capabilities: { tools: {} },
        serverInfo: { name: 'forge', version: '1.0.0' },
      });
    }
    case 'server/discover': {
      return rpcResult(id, {
        serverInfo: { name: 'forge', version: '1.0.0' },
        capabilities: { tools: {} },
        supportedVersions: ['2025-03-26', '2024-11-05'],
      });
    }
    case 'ping':
      return rpcResult(id, {});
    case 'tools/list':
      return rpcResult(id, toolListResult());
    case 'tools/call': {
      const toolName = typeof params.name === 'string' ? params.name : '';
      const args = (params.arguments && typeof params.arguments === 'object' ? params.arguments : {}) as Record<string, unknown>;
      try {
        const outcome = callTool(toolName, args);
        const result: Record<string, unknown> = {
          content: [{ type: 'text', text: JSON.stringify(outcome.value) }],
          structuredContent: outcome.value,
        };
        if (outcome.isError) result.isError = true;
        return rpcResult(id, result);
      } catch (error) {
        if (error instanceof UnknownToolError) return rpcError(id, -32602, error.message);
        return rpcResult(id, {
          content: [{ type: 'text', text: (error as Error).message }],
          isError: true,
        });
      }
    }
    case 'notifications/initialized':
    case 'notifications/cancelled':
      return '';
    default:
      if (isNotification) return '';
      return rpcError(id, -32601, `Method not found: ${method}`);
  }
}
