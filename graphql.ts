// graphql.ts — a miniature GraphQL engine for the forge: a tokenizer, a parser for the query
// language subset clients actually send (fields, arguments, variables, aliases, inline
// fragments, input objects, enums), and an executor over the same store the REST surface uses.
// The schema is the slice of GitHub's the forge can honestly answer: viewer, repository,
// issues, pull requests, search types, and the five mutations.

import { branchTip, diffFiles, issueJson, mergePull, pullMergeable, repoJson } from './rest.ts';
import {
  commentNodeId,
  decodeGlobalId,
  encodeGlobalId,
  forge,
  issueNodeId,
  pullNodeId,
  repoNodeId,
  userNodeId,
  VIEWER,
} from './store.ts';
import type { NumberedRecord, Repo, UserRecord } from './store.ts';

// ------------------------------------------------------------------ tokenizer and parser

type Token =
  | { readonly kind: 'name'; readonly value: string }
  | { readonly kind: 'string'; readonly value: string }
  | { readonly kind: 'number'; readonly value: number }
  | { readonly kind: 'punct'; readonly value: string };

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (source.startsWith('...', i)) {
      tokens.push({ kind: 'punct', value: '...' });
      i += 3;
      continue;
    }
    if ('{}()[]:$!@'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    if (ch === '"') {
      if (source.startsWith('"""', i)) {
        const end = source.indexOf('"""', i + 3);
        tokens.push({ kind: 'string', value: source.slice(i + 3, end < 0 ? source.length : end) });
        i = end < 0 ? source.length : end + 3;
        continue;
      }
      let value = '';
      i += 1;
      while (i < source.length && source[i] !== '"') {
        if (source[i] === '\\' && i + 1 < source.length) {
          const escaped = source[i + 1];
          value += escaped === 'n' ? '\n' : escaped === 't' ? '\t' : escaped === 'r' ? '\r' : escaped;
          i += 2;
        } else {
          value += source[i];
          i += 1;
        }
      }
      i += 1;
      tokens.push({ kind: 'string', value });
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let text = '';
      while (i < source.length && /[0-9.eE+-]/.test(source[i])) {
        text += source[i];
        i += 1;
      }
      tokens.push({ kind: 'number', value: Number(text) });
      continue;
    }
    if (/[_A-Za-z]/.test(ch)) {
      let text = '';
      while (i < source.length && /[_0-9A-Za-z]/.test(source[i])) {
        text += source[i];
        i += 1;
      }
      tokens.push({ kind: 'name', value: text });
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(ch)}`);
  }
  return tokens;
}

type Value =
  | { readonly kind: 'string'; readonly value: string }
  | { readonly kind: 'number'; readonly value: number }
  | { readonly kind: 'boolean'; readonly value: boolean }
  | { readonly kind: 'enum'; readonly value: string }
  | { readonly kind: 'variable'; readonly value: string }
  | { readonly kind: 'list'; readonly value: readonly Value[] }
  | { readonly kind: 'object'; readonly value: ReadonlyMap<string, Value> }
  | { readonly kind: 'null' };

interface FieldNode {
  readonly name: string;
  readonly alias?: string;
  readonly args: ReadonlyMap<string, Value>;
  readonly selections: readonly SelectionNode[];
}

type SelectionNode =
  | { readonly kind: 'field'; readonly field: FieldNode }
  | { readonly kind: 'fragment'; readonly typeCondition?: string; readonly selections: readonly SelectionNode[] };

interface OperationNode {
  readonly type: 'query' | 'mutation';
  readonly name?: string;
  readonly selections: readonly SelectionNode[];
}

class Parser {
  private tokens: Token[];
  private pos = 0;

  constructor(source: string) {
    this.tokens = tokenize(source);
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  private next(): Token {
    const token = this.tokens[this.pos];
    this.pos += 1;
    if (!token) throw new Error('unexpected end of document');
    return token;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) throw new Error(`expected '${value}'`);
  }

  private atPunct(value: string): boolean {
    const token = this.peek();
    return token !== undefined && token.kind === 'punct' && token.value === value;
  }

  parseDocument(): OperationNode[] {
    const operations: OperationNode[] = [];
    while (this.pos < this.tokens.length) {
      const token = this.peek()!;
      if (token.kind === 'punct' && token.value === '{') {
        operations.push({ type: 'query', selections: this.parseSelectionSet() });
        continue;
      }
      if (token.kind === 'name' && (token.value === 'query' || token.value === 'mutation')) {
        this.next();
        let name: string | undefined;
        const maybeName = this.peek();
        if (maybeName && maybeName.kind === 'name') name = this.next().value as string;
        if (this.atPunct('(')) this.skipBalanced();
        operations.push({ type: token.value, name, selections: this.parseSelectionSet() });
        continue;
      }
      if (token.kind === 'name' && token.value === 'fragment') {
        // Named fragments are outside the subset; skip their definitions.
        while (this.pos < this.tokens.length && !this.atPunct('{')) this.pos += 1;
        this.skipBalanced();
        continue;
      }
      throw new Error('expected an operation');
    }
    return operations;
  }

  private skipBalanced(): void {
    let depth = 0;
    do {
      const token = this.next();
      if (token.kind === 'punct' && (token.value === '{' || token.value === '(' || token.value === '[')) depth += 1;
      if (token.kind === 'punct' && (token.value === '}' || token.value === ')' || token.value === ']')) depth -= 1;
    } while (depth > 0 && this.pos < this.tokens.length);
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const selections: SelectionNode[] = [];
    while (!this.atPunct('}')) {
      if (this.atPunct('...')) {
        this.next();
        let typeCondition: string | undefined;
        const on = this.peek();
        if (on && on.kind === 'name' && on.value === 'on') {
          this.next();
          typeCondition = this.next().value as string;
        }
        selections.push({ kind: 'fragment', typeCondition, selections: this.parseSelectionSet() });
        continue;
      }
      selections.push({ kind: 'field', field: this.parseField() });
    }
    this.expectPunct('}');
    return selections;
  }

  private parseField(): FieldNode {
    const first = this.next();
    if (first.kind !== 'name') throw new Error('expected a field name');
    let name = first.value;
    let alias: string | undefined;
    if (this.atPunct(':')) {
      this.next();
      alias = name;
      const second = this.next();
      if (second.kind !== 'name') throw new Error('expected a field name after alias');
      name = second.value;
    }
    const args = new Map<string, Value>();
    if (this.atPunct('(')) {
      this.next();
      while (!this.atPunct(')')) {
        const argName = this.next();
        if (argName.kind !== 'name') throw new Error('expected an argument name');
        this.expectPunct(':');
        args.set(argName.value, this.parseValue());
      }
      this.expectPunct(')');
    }
    let selections: SelectionNode[] = [];
    if (this.atPunct('{')) selections = this.parseSelectionSet();
    return { name, alias, args, selections };
  }

  private parseValue(): Value {
    const token = this.next();
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'number') return { kind: 'number', value: token.value };
    if (token.kind === 'punct' && token.value === '$') {
      const name = this.next();
      return { kind: 'variable', value: name.value as string };
    }
    if (token.kind === 'punct' && token.value === '[') {
      const items: Value[] = [];
      while (!this.atPunct(']')) items.push(this.parseValue());
      this.expectPunct(']');
      return { kind: 'list', value: items };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const entries = new Map<string, Value>();
      while (!this.atPunct('}')) {
        const key = this.next();
        if (key.kind !== 'name') throw new Error('expected an input field name');
        this.expectPunct(':');
        entries.set(key.value, this.parseValue());
      }
      this.expectPunct('}');
      return { kind: 'object', value: entries };
    }
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    throw new Error('expected a value');
  }
}

/** Resolve a parsed Value against the operation's variables into plain JS data. */
function resolveValue(value: Value, variables: Record<string, unknown>): unknown {
  switch (value.kind) {
    case 'string':
    case 'number':
    case 'boolean':
    case 'enum':
      return value.value;
    case 'null':
      return null;
    case 'variable':
      return variables[value.value];
    case 'list':
      return value.value.map((item) => resolveValue(item, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [key, item] of value.value) out[key] = resolveValue(item, variables);
      return out;
    }
  }
}

// ------------------------------------------------------------------ schema and execution

interface Ctx {
  readonly variables: Record<string, unknown>;
  readonly errors: { message: string }[];
}

interface Node {
  readonly __type: string;
  readonly repo?: Repo;
  readonly record?: NumberedRecord;
  readonly user?: UserRecord;
  readonly commentId?: number;
  readonly commentBody?: string;
  readonly filePath?: string;
}

const ISSUE_FIELDS = ['id', 'number', 'title', 'state', 'body', 'author', 'labels', 'createdAt', 'updatedAt', 'url'];
const PULL_FIELDS = [
  'id', 'number', 'title', 'state', 'body', 'author', 'headRefName', 'baseRefName',
  'mergeable', 'merged', 'mergedAt', 'mergeCommit', 'files', 'createdAt', 'updatedAt', 'url',
];
const REPO_FIELDS = [
  'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'description', 'isPrivate',
  'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues',
  'pullRequest', 'pullRequests', 'createdAt', 'updatedAt', 'url',
];
const TYPE_FIELDS: Readonly<Record<string, readonly string[]>> = {
  Issue: ISSUE_FIELDS,
  PullRequest: PULL_FIELDS,
  Repository: REPO_FIELDS,
  User: ['id', 'login', 'name', 'email'],
  Organization: ['id', 'login', 'name', 'email'],
  Label: ['id', 'name', 'color', 'description'],
  IssueComment: ['id', 'body', 'author', 'createdAt'],
  Ref: ['id', 'name', 'target'],
  Commit: ['id', 'oid', 'message', 'committedDate'],
  PullRequestChangedFile: ['path', 'additions', 'deletions', 'changeType'],
};

function argValue(field: FieldNode, ctx: Ctx, name: string): unknown {
  const raw = field.args.get(name);
  return raw ? resolveValue(raw, ctx.variables) : undefined;
}

function argString(field: FieldNode, ctx: Ctx, name: string): string {
  const value = argValue(field, ctx, name);
  return typeof value === 'string' ? value : '';
}

function argNumber(field: FieldNode, ctx: Ctx, name: string): number {
  const value = argValue(field, ctx, name);
  return typeof value === 'number' ? value : 0;
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

/** Sort comparator for issue/pull connections, honoring orderBy {field, direction}. */
function orderBySorter(field: FieldNode, ctx: Ctx): (a: NumberedRecord, b: NumberedRecord) => number {
  const orderBy = argValue(field, ctx, 'orderBy') as { field?: string; direction?: string } | undefined;
  const key = orderBy?.field === 'UPDATED_AT' ? 'updatedAt' : 'createdAt';
  const sign = orderBy?.direction === 'DESC' ? -1 : 1;
  return (a, b) => sign * (a[key] - b[key] || a.number - b.number);
}

/** Execute one field against one parent node; returns raw values, Nodes, or lists of either. */
function executeField(parent: Node | null, field: FieldNode, ctx: Ctx): unknown {
  const name = field.name;
  if (name === '__type') {
    const typeName = argString(field, ctx, 'name');
    const fields = TYPE_FIELDS[typeName];
    return {
      __type: '__Type',
      name: typeName,
      fields: fields?.map((fieldName) => ({ __type: '__Field', name: fieldName })),
    };
  }
  if (name === '__schema') {
    return { __type: '__Schema' };
  }
  const parentType = parent?.__type ?? 'Query';

  if (parentType === 'Query' || parentType === 'Mutation') {
    switch (name) {
      case 'viewer':
        return { __type: 'User', user: VIEWER } satisfies Node;
      case 'repository': {
        const repo = forge.getRepo(argString(field, ctx, 'owner'), argString(field, ctx, 'name'));
        return repo ? ({ __type: 'Repository', repo } satisfies Node) : null;
      }
      case 'node': {
        return nodeByGlobalId(argString(field, ctx, 'id'));
      }
      case 'rateLimit':
        return { __type: 'RateLimit', limit: 5000, remaining: 4999, used: 1 };
      case 'createIssue':
        return mutationCreateIssue(field, ctx);
      case 'closeIssue':
        return mutationSetIssueState(field, ctx, 'closed');
      case 'reopenIssue':
        return mutationSetIssueState(field, ctx, 'open');
      case 'createPullRequest':
        return mutationCreatePull(field, ctx);
      case 'mergePullRequest':
        return mutationMergePull(field, ctx);
      case 'addComment':
        return mutationAddComment(field, ctx);
      default:
        ctx.errors.push({ message: `Field '${name}' doesn't exist on type '${parentType}'` });
        return null;
    }
  }

  if (parentType === '__Type') {
    const view = parent as unknown as { name: string; fields?: { name: string }[] };
    if (name === 'name') return view.name;
    if (name === 'kind') return view.name === 'SearchType' ? 'ENUM' : 'OBJECT';
    if (name === 'fields') return view.fields ?? null;
    if (name === 'enumValues') {
      const values = ['ISSUE', 'REPOSITORY', 'USER'].map((value) => ({ __type: '__EnumValue', name: value }));
      return view.name === 'SearchType' ? values : null;
    }
    return null;
  }
  if (parentType === '__Field') {
    const view = parent as unknown as { name: string };
    if (name === 'name') return view.name;
    if (name === 'type') return { __type: '__Type', name: 'String' };
    return null;
  }
  if (parentType === '__EnumValue') {
    const view = parent as unknown as { name: string };
    if (name === 'name') return view.name;
    return null;
  }

  if (!parent) {
    ctx.errors.push({ message: `Field '${name}' doesn't exist on type '${parentType}'` });
    return null;
  }
  return executeNodeField(parent, field, ctx);
}

function nodeByGlobalId(id: string): Node | null {
  const decoded = decodeGlobalId(id);
  if (!decoded) return null;
  if (decoded.type === 'Repository') {
    const repo = forge.getRepoById(Number(decoded.payload));
    return repo ? { __type: 'Repository', repo } : null;
  }
  if (decoded.type === 'Issue' || decoded.type === 'PullRequest') {
    const [repoId, number] = decoded.payload.split(':').map(Number);
    const repo = forge.getRepoById(repoId);
    const record = repo?.issues.get(number);
    if (!repo || !record) return null;
    return { __type: record.isPull ? 'PullRequest' : 'Issue', repo, record };
  }
  if (decoded.type === 'User') {
    return { __type: 'User', user: VIEWER };
  }
  return null;
}

function repoFromGlobalId(id: string): Repo | undefined {
  const decoded = decodeGlobalId(id);
  if (!decoded || decoded.type !== 'Repository') return undefined;
  return forge.getRepoById(Number(decoded.payload));
}

function recordFromGlobalId(id: string): { repo: Repo; record: NumberedRecord } | undefined {
  const decoded = decodeGlobalId(id);
  if (!decoded) return undefined;
  if (decoded.type === 'Issue' || decoded.type === 'PullRequest') {
    const [repoId, number] = decoded.payload.split(':').map(Number);
    const repo = forge.getRepoById(repoId);
    const record = repo?.issues.get(number);
    return repo && record ? { repo, record } : undefined;
  }
  if (decoded.type === 'Repository') return undefined;
  // A bare numeric payload is also accepted, in case a client kept the REST id.
  return undefined;
}

function connection(items: readonly unknown[], field: FieldNode, ctx: Ctx): Record<string, unknown> {
  const first = Math.max(0, argNumber(field, ctx, 'first') || items.length);
  const after = argString(field, ctx, 'after');
  let start = 0;
  if (after) {
    const decoded = Number(Buffer.from(after, 'base64').toString('utf8').replace(/^cursor:/, ''));
    if (Number.isFinite(decoded)) start = decoded + 1;
  }
  const slice = items.slice(start, start + first);
  const nodes = slice.map((item, index) => {
    void index;
    return item;
  });
  const edges = slice.map((item, index) => ({
    __type: '__Edge',
    node: item,
    cursor: Buffer.from(`cursor:${start + index}`, 'utf8').toString('base64'),
  }));
  return {
    __type: '__Connection',
    nodes,
    edges,
    pageInfo: {
      __type: '__PageInfo',
      hasNextPage: start + slice.length < items.length,
      hasPreviousPage: start > 0,
      startCursor: edges.length > 0 ? edges[0].cursor : null,
      endCursor: edges.length > 0 ? edges[edges.length - 1].cursor : null,
    },
    totalCount: items.length,
  };
}

function executeNodeField(parent: Node, field: FieldNode, ctx: Ctx): unknown {
  const name = field.name;
  const { repo, record, user } = parent;
  switch (parent.__type) {
    case 'User':
    case 'Organization': {
      const record2 = user!;
      if (name === 'id') return userNodeId(record2);
      if (name === 'login') return record2.login;
      if (name === 'name') return record2.name;
      if (name === 'email') return record2.email;
      if (name === 'databaseId') return record2.id;
      break;
    }
    case 'Repository': {
      const r = repo!;
      switch (name) {
        case 'id': return repoNodeId(r);
        case 'databaseId': return r.id;
        case 'name': return r.name;
        case 'nameWithOwner': return r.fullName;
        case 'description': return r.description;
        case 'isPrivate': return r.isPrivate;
        case 'url': return `https://forge.example/${r.fullName}`;
        case 'createdAt': return iso(r.createdAt);
        case 'updatedAt': return iso(r.createdAt);
        case 'viewerPermission': return 'ADMIN';
        case 'hasIssuesEnabled': return true;
        case 'owner': {
          const ownerLogin = r.owner;
          const ownerUser = [VIEWER].find((candidate) => candidate.login === ownerLogin) ?? VIEWER;
          return { __type: 'User', user: ownerUser } satisfies Node;
        }
        case 'defaultBranchRef': {
          const tip = r.headCommit();
          return { __type: 'Ref', repo: r, filePath: r.defaultBranch, commentBody: tip ?? '' } satisfies Node;
        }
        case 'issue': {
          const found = r.issues.get(argNumber(field, ctx, 'number'));
          return found && !found.isPull ? ({ __type: 'Issue', repo: r, record: found } satisfies Node) : null;
        }
        case 'issues': {
          const states = (argValue(field, ctx, 'states') as unknown[] | undefined) ?? ['OPEN'];
          const wanted = states.map((state) => String(state).toLowerCase());
          const list = [...r.issues.values()]
            .filter((item) => !item.isPull && wanted.includes(item.state))
            .sort(orderBySorter(field, ctx))
            .map((item) => ({ __type: 'Issue', repo: r, record: item }) satisfies Node);
          return connection(list, field, ctx);
        }
        case 'pullRequest': {
          const found = r.issues.get(argNumber(field, ctx, 'number'));
          return found && found.isPull ? ({ __type: 'PullRequest', repo: r, record: found } satisfies Node) : null;
        }
        case 'pullRequests': {
          const states = (argValue(field, ctx, 'states') as unknown[] | undefined) ?? ['OPEN'];
          const wanted = states.map((state) => String(state).toLowerCase());
          const list = [...r.issues.values()]
            .filter((item) => item.isPull && wanted.includes(item.state === 'closed' && item.merged ? 'merged' : item.state))
            .sort(orderBySorter(field, ctx))
            .map((item) => ({ __type: 'PullRequest', repo: r, record: item }) satisfies Node);
          return connection(list, field, ctx);
        }
        default:
          break;
      }
      break;
    }
    case 'Issue':
    case 'PullRequest': {
      const r = repo!;
      const item = record!;
      switch (name) {
        case 'id': return item.isPull ? pullNodeId(r, item.number) : issueNodeId(r, item.number);
        case 'databaseId': return r.id * 100000 + item.number;
        case 'number': return item.number;
        case 'title': return item.title;
        case 'body': return item.body;
        case 'state': return item.merged ? 'MERGED' : item.state.toUpperCase();
        case 'author': return { __type: 'User', user: item.author } satisfies Node;
        case 'createdAt': return iso(item.createdAt);
        case 'updatedAt': return iso(item.updatedAt);
        case 'url': return `https://forge.example/${r.fullName}/issues/${item.number}`;
        case 'labels': {
          const list = item.labels.map((labelName) => ({
            __type: 'Label',
            repo: r,
            filePath: labelName,
          }) satisfies Node);
          return connection(list, field, ctx);
        }
        case 'comments': {
          const list = item.comments.map((comment) => ({
            __type: 'IssueComment',
            repo: r,
            record: item,
            commentId: comment.id,
            commentBody: comment.body,
            user: comment.author,
          }) satisfies Node);
          return connection(list, field, ctx);
        }
        case 'repository': return { __type: 'Repository', repo: r } satisfies Node;
        default:
          break;
      }
      if (item.isPull) {
        switch (name) {
          case 'headRefName': return item.headRef;
          case 'baseRefName': return item.baseRef;
          case 'merged': return item.merged;
          case 'mergedAt': return item.mergedAt ? iso(item.mergedAt) : null;
          case 'mergeable': return pullMergeable(r, item) ? 'MERGEABLE' : 'CONFLICTING';
          case 'mergeCommit': {
            return item.mergeCommitSha ? ({ __type: 'Commit', repo: r, filePath: item.mergeCommitSha } satisfies Node) : null;
          }
          case 'headRefOid': return branchTip(r, item.headRef) ?? null;
          case 'baseRefOid': return branchTip(r, item.baseRef) ?? null;
          case 'files': {
            const base = branchTip(r, item.baseRef);
            const head = branchTip(r, item.headRef);
            const files = base && head
              ? diffFiles(r, base, head).map((file) => ({
                  __type: 'PullRequestChangedFile',
                  repo: r,
                  filePath: file.filename,
                  commentId: file.additions,
                  commentBody: String(file.deletions),
                }) satisfies Node)
              : [];
            return connection(files, field, ctx);
          }
          default:
            break;
        }
      }
      break;
    }
    case 'Label': {
      const label = repo!.labels.get(parent.filePath ?? '');
      if (name === 'id') return encodeGlobalId('Label', `${repo!.id}:${parent.filePath}`);
      if (name === 'name') return parent.filePath ?? '';
      if (name === 'color') return label?.color ?? 'ededed';
      if (name === 'description') return label?.description ?? '';
      break;
    }
    case 'IssueComment': {
      if (name === 'id') return commentNodeId({ id: parent.commentId ?? 0, body: '', author: VIEWER, createdAt: 0 });
      if (name === 'body') return parent.commentBody ?? '';
      if (name === 'author') return { __type: 'User', user: parent.user ?? VIEWER } satisfies Node;
      if (name === 'createdAt') {
        const comment = record?.comments.find((candidate) => candidate.id === parent.commentId);
        return comment ? iso(comment.createdAt) : iso(0);
      }
      break;
    }
    case 'Ref': {
      if (name === 'name') return parent.filePath ?? '';
      if (name === 'id') return encodeGlobalId('Ref', `${repo!.id}:${parent.filePath}`);
      if (name === 'target') {
        return parent.commentBody ? ({ __type: 'Commit', repo, filePath: parent.commentBody } satisfies Node) : null;
      }
      if (name === 'prefix') return 'refs/heads/';
      break;
    }
    case 'Commit': {
      if (name === 'id' || name === 'oid') return parent.filePath ?? '';
      if (name === 'message') return '';
      if (name === 'committedDate') return iso(0);
      break;
    }
    case 'PullRequestChangedFile': {
      if (name === 'path') return parent.filePath ?? '';
      if (name === 'additions') return parent.commentId ?? 0;
      if (name === 'deletions') return Number(parent.commentBody ?? '0') || 0;
      if (name === 'changeType') return 'MODIFIED';
      break;
    }
    default:
      break;
  }
  ctx.errors.push({ message: `Field '${name}' doesn't exist on type '${parent.__type}'` });
  return null;
}

// ------------------------------------------------------------------ mutations

function inputOf(field: FieldNode, ctx: Ctx): Record<string, unknown> {
  const raw = field.args.get('input');
  if (!raw) return {};
  const resolved = resolveValue(raw, ctx.variables);
  return resolved && typeof resolved === 'object' ? (resolved as Record<string, unknown>) : {};
}

function payloadNode(type: string, repo?: Repo, record?: NumberedRecord, comment?: { id: number; body: string }): Node {
  return { __type: type, repo, record, commentId: comment?.id, commentBody: comment?.body };
}

function mutationCreateIssue(field: FieldNode, ctx: Ctx): Node | null {
  const input = inputOf(field, ctx);
  const repo = repoFromGlobalId(String(input.repositoryId ?? ''));
  if (!repo) {
    ctx.errors.push({ message: 'repository not found' });
    return null;
  }
  const now = Date.now();
  const record: NumberedRecord = {
    number: repo.nextNumber,
    title: String(input.title ?? ''),
    body: String(input.body ?? ''),
    state: 'open',
    author: VIEWER,
    labels: [],
    comments: [],
    createdAt: now,
    updatedAt: now,
    isPull: false,
  };
  repo.nextNumber += 1;
  repo.issues.set(record.number, record);
  return payloadNode('CreateIssuePayload', repo, record);
}

function mutationSetIssueState(field: FieldNode, ctx: Ctx, state: 'open' | 'closed'): Node | null {
  const input = inputOf(field, ctx);
  const found = recordFromGlobalId(String(input.id ?? input.issueId ?? ''));
  if (!found) {
    ctx.errors.push({ message: 'issue not found' });
    return null;
  }
  found.record.state = state;
  found.record.updatedAt = Math.max(found.record.updatedAt + 1, Date.now());
  return payloadNode('CloseIssuePayload', found.repo, found.record);
}

function mutationCreatePull(field: FieldNode, ctx: Ctx): Node | null {
  const input = inputOf(field, ctx);
  const repo = repoFromGlobalId(String(input.repositoryId ?? ''));
  if (!repo) {
    ctx.errors.push({ message: 'repository not found' });
    return null;
  }
  const headRefName = String(input.headRefName ?? input.head ?? '');
  const baseRefName = String(input.baseRefName ?? input.base ?? '');
  if (!branchTip(repo, headRefName) || !branchTip(repo, baseRefName)) {
    ctx.errors.push({ message: 'head or base branch not found' });
    return null;
  }
  const now = Date.now();
  const record: NumberedRecord = {
    number: repo.nextNumber,
    title: String(input.title ?? ''),
    body: String(input.body ?? ''),
    state: 'open',
    author: VIEWER,
    labels: [],
    comments: [],
    createdAt: now,
    updatedAt: now,
    isPull: true,
    headRef: headRefName,
    baseRef: baseRefName,
    merged: false,
    mergedAt: null,
    mergeCommitSha: null,
    mergeMethod: null,
  };
  repo.nextNumber += 1;
  repo.issues.set(record.number, record);
  return payloadNode('CreatePullRequestPayload', repo, record);
}

function mutationMergePull(field: FieldNode, ctx: Ctx): Node | null {
  const input = inputOf(field, ctx);
  const found = recordFromGlobalId(String(input.pullRequestId ?? input.id ?? ''));
  if (!found || !found.record.isPull) {
    ctx.errors.push({ message: 'pull request not found' });
    return null;
  }
  const methodRaw = String(input.mergeMethod ?? 'MERGE').toUpperCase();
  const method = methodRaw === 'SQUASH' ? 'squash' : methodRaw === 'REBASE' ? 'rebase' : 'merge';
  const outcome = mergePull(found.repo, found.record, method);
  if (outcome.kind === 'conflict' || outcome.kind === 'not-found') {
    ctx.errors.push({ message: 'pull request is not mergeable' });
    return payloadNode('MergePullRequestPayload', found.repo, found.record);
  }
  return payloadNode('MergePullRequestPayload', found.repo, found.record);
}

function mutationAddComment(field: FieldNode, ctx: Ctx): Node | null {
  const input = inputOf(field, ctx);
  const found = recordFromGlobalId(String(input.subjectId ?? input.id ?? ''));
  if (!found) {
    ctx.errors.push({ message: 'subject not found' });
    return null;
  }
  const comment = found.repo.addComment(found.record, String(input.body ?? ''), VIEWER);
  const node = payloadNode('AddCommentPayload', found.repo, found.record, comment);
  return node;
}

// ------------------------------------------------------------------ selection application

/** Payload wrappers expose their inner record under the conventional field names. */
const PAYLOAD_FIELDS: Readonly<Record<string, string>> = {
  CreateIssuePayload: 'issue',
  CloseIssuePayload: 'issue',
  CreatePullRequestPayload: 'pullRequest',
  MergePullRequestPayload: 'pullRequest',
  AddCommentPayload: 'commentEdge',
};

function applySelections(value: unknown, selections: readonly SelectionNode[], ctx: Ctx): unknown {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map((item) => applySelections(item, selections, ctx));
  if (typeof value !== 'object') return value;
  const node = value as Node & Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'fragment') {
      if (!selection.typeCondition || selection.typeCondition === node.__type) {
        const merged = applySelections(value, selection.selections, ctx) as Record<string, unknown>;
        Object.assign(out, merged);
      }
      continue;
    }
    const field = selection.field;
    const key = field.alias ?? field.name;
    out[key] = applyFieldSelection(node, field, ctx);
  }
  return out;
}

function applyFieldSelection(node: Node & Record<string, unknown>, field: FieldNode, ctx: Ctx): unknown {
  const name = field.name;
  // Connection, edge, page-info, and introspection leaf objects resolve by stored property.
  if (node.__type === '__Connection' || node.__type === '__Edge' || node.__type === '__PageInfo' || node.__type === 'RateLimit') {
    const raw = (node as Record<string, unknown>)[name];
    return field.selections.length > 0 ? applySelections(raw, field.selections, ctx) : raw ?? null;
  }
  if (node.__type === '__Field' || node.__type === '__EnumValue') {
    const raw = (node as Record<string, unknown>)[name];
    return field.selections.length > 0 ? applySelections(raw, field.selections, ctx) : raw ?? null;
  }
  if (PAYLOAD_FIELDS[node.__type]) {
    if (name === 'clientMutationId') return null;
    if (name === PAYLOAD_FIELDS[node.__type]) {
      if (node.__type === 'AddCommentPayload') {
        const edge = {
          __type: '__Edge',
          node: {
            __type: 'IssueComment',
            repo: node.repo,
            record: node.record,
            commentId: node.commentId,
            commentBody: node.commentBody,
            user: VIEWER,
          } satisfies Node,
          cursor: Buffer.from(`cursor:${node.commentId ?? 0}`, 'utf8').toString('base64'),
        };
        return applySelections(edge, field.selections, ctx);
      }
      const inner: Node = {
        __type: node.record?.isPull ? 'PullRequest' : 'Issue',
        repo: node.repo,
        record: node.record,
      };
      return applySelections(inner, field.selections, ctx);
    }
    if (name === 'issue' || name === 'pullRequest') {
      const inner: Node = {
        __type: node.record?.isPull ? 'PullRequest' : 'Issue',
        repo: node.repo,
        record: node.record,
      };
      return applySelections(inner, field.selections, ctx);
    }
    ctx.errors.push({ message: `Field '${name}' doesn't exist on type '${node.__type}'` });
    return null;
  }
  const raw = executeField(node.__type === 'Query' || node.__type === 'Mutation' ? node : node, field, ctx);
  if (field.selections.length === 0) return raw ?? null;
  return applySelections(raw, field.selections, ctx);
}

// ------------------------------------------------------------------ entry point

export interface GraphQLRequest {
  readonly query: string;
  readonly variables?: Record<string, unknown>;
  readonly operationName?: string;
}

export function executeGraphQL(request: GraphQLRequest): { data: Record<string, unknown>; errors?: { message: string }[] } {
  const ctx: Ctx = { variables: request.variables ?? {}, errors: [] };
  let operations: OperationNode[];
  try {
    operations = new Parser(request.query).parseDocument();
  } catch (error) {
    return { data: {}, errors: [{ message: (error as Error).message }] };
  }
  const operation = request.operationName
    ? operations.find((candidate) => candidate.name === request.operationName) ?? operations[0]
    : operations[0];
  if (!operation) return { data: {}, errors: [{ message: 'no operation found' }] };
  const root: Node = { __type: operation.type === 'mutation' ? 'Mutation' : 'Query' };
  const data = applySelections(root, operation.selections, ctx) as Record<string, unknown>;
  return ctx.errors.length > 0 ? { data, errors: ctx.errors } : { data };
}

/** A batched request (a JSON array of operations) answers with an array of results, in order. */
export function executeGraphQLBatch(requests: readonly GraphQLRequest[]): { data: Record<string, unknown>; errors?: { message: string }[] }[] {
  return requests.map((request) => executeGraphQL(request));
}

export { issueJson };
