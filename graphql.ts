// GraphQL v4: a hand-written tokenizer, parser and executor for the subset
// the suite uses — queries, mutations, variables, aliases, inline fragments,
// input objects, inline enum lists, null variables and batched requests.
// Introspection answers from a small static schema table.

import { decodeGlobalId, globalId, type Issue, type PullRequest, type Repo, type Store } from './store.ts';

// ---------------------------------------------------------------- tokenizer

type TokenKind = 'name' | 'int' | 'float' | 'string' | 'punct' | 'eof';

interface Token {
  readonly kind: TokenKind;
  readonly value: string;
}

const PUNCT = new Set(['!', '$', '(', ')', ':', '=', '@', '[', ']', '{', '}', '|', '&', '.', ',', '...']);

export function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i]!;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',' || ch === '﻿') {
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
    if (PUNCT.has(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    if (ch === '"') {
      if (source.startsWith('"""', i)) {
        const end = source.indexOf('"""', i + 3);
        if (end < 0) throw new Error('unterminated block string');
        tokens.push({ kind: 'string', value: source.slice(i + 3, end) });
        i = end + 3;
        continue;
      }
      let j = i + 1;
      let out = '';
      while (j < source.length && source[j] !== '"') {
        if (source[j] === '\\') {
          const next = source[j + 1];
          if (next === 'n') out += '\n';
          else if (next === 't') out += '\t';
          else if (next === 'r') out += '\r';
          else if (next === '"') out += '"';
          else if (next === '\\') out += '\\';
          else if (next === '/') out += '/';
          else if (next === 'b') out += '\b';
          else if (next === 'f') out += '\f';
          else if (next === 'u') {
            out += String.fromCharCode(Number.parseInt(source.slice(j + 2, j + 6), 16));
            j += 4;
          } else out += next ?? '';
          j += 2;
          continue;
        }
        out += source[j];
        j += 1;
      }
      if (j >= source.length) throw new Error('unterminated string');
      tokens.push({ kind: 'string', value: out });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(ch) && (ch !== '-' || /[0-9]/.test(source[i + 1] ?? ''))) {
      let j = i;
      if (source[j] === '-') j += 1;
      let isFloat = false;
      while (j < source.length && /[0-9]/.test(source[j]!)) j += 1;
      if (source[j] === '.') {
        isFloat = true;
        j += 1;
        while (j < source.length && /[0-9]/.test(source[j]!)) j += 1;
      }
      if (source[j] === 'e' || source[j] === 'E') {
        isFloat = true;
        j += 1;
        if (source[j] === '+' || source[j] === '-') j += 1;
        while (j < source.length && /[0-9]/.test(source[j]!)) j += 1;
      }
      tokens.push({ kind: isFloat ? 'float' : 'int', value: source.slice(i, j) });
      i = j;
      continue;
    }
    if (/[_A-Za-z]/.test(ch)) {
      let j = i;
      while (j < source.length && /[_A-Za-z0-9]/.test(source[j]!)) j += 1;
      tokens.push({ kind: 'name', value: source.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(ch)} in GraphQL source`);
  }
  tokens.push({ kind: 'eof', value: '' });
  return tokens;
}

// ---------------------------------------------------------------- parser

export type ValueNode =
  | { readonly kind: 'variable'; readonly name: string }
  | { readonly kind: 'int'; readonly value: number }
  | { readonly kind: 'float'; readonly value: number }
  | { readonly kind: 'string'; readonly value: string }
  | { readonly kind: 'boolean'; readonly value: boolean }
  | { readonly kind: 'null' }
  | { readonly kind: 'enum'; readonly value: string }
  | { readonly kind: 'list'; readonly values: ValueNode[] }
  | { readonly kind: 'object'; readonly fields: Array<{ readonly name: string; readonly value: ValueNode }> };

export interface FieldNode {
  readonly alias: string | null;
  readonly name: string;
  readonly args: Array<{ readonly name: string; readonly value: ValueNode }>;
  readonly selectionSet: SelectionNode[] | null;
}

export type SelectionNode =
  | { readonly kind: 'field'; readonly field: FieldNode }
  | { readonly kind: 'fragment'; readonly typeCondition: string | null; readonly selectionSet: SelectionNode[] }
  | { readonly kind: 'fragmentSpread'; readonly name: string };

export interface Operation {
  readonly kind: 'query' | 'mutation' | 'subscription';
  readonly name: string | null;
  readonly variableDefinitions: Array<{ name: string; type: string; defaultValue: ValueNode | null }>;
  readonly selectionSet: SelectionNode[];
}

export interface Document {
  readonly operations: Operation[];
  readonly fragments: Map<string, { typeCondition: string | null; selectionSet: SelectionNode[] }>;
}

class Parser {
  readonly tokens: Token[];
  pos = 0;

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  peek(): Token {
    return this.tokens[this.pos]!;
  }

  next(): Token {
    const token = this.tokens[this.pos]!;
    this.pos += 1;
    return token;
  }

  expect(kind: TokenKind, value?: string): Token {
    const token = this.next();
    if (token.kind !== kind || (value !== undefined && token.value !== value)) {
      throw new Error(`expected ${kind}${value === undefined ? '' : ` ${JSON.stringify(value)}`}, got ${token.kind} ${JSON.stringify(token.value)}`);
    }
    return token;
  }

  accept(kind: TokenKind, value?: string): Token | null {
    const token = this.peek();
    if (token.kind === kind && (value === undefined || token.value === value)) {
      this.pos += 1;
      return token;
    }
    return null;
  }

  parseDocument(): Document {
    const operations: Operation[] = [];
    const fragments = new Map<string, { typeCondition: string | null; selectionSet: SelectionNode[] }>();
    while (this.peek().kind !== 'eof') {
      if (this.peek().kind === 'punct' && this.peek().value === '{') {
        operations.push({
          kind: 'query',
          name: null,
          variableDefinitions: [],
          selectionSet: this.parseSelectionSet(),
        });
        continue;
      }
      const keyword = this.expect('name').value;
      if (keyword === 'fragment') {
        const name = this.expect('name').value;
        this.expect('name', 'on');
        const typeCondition = this.expect('name').value;
        fragments.set(name, { typeCondition, selectionSet: this.parseSelectionSet() });
        continue;
      }
      if (keyword !== 'query' && keyword !== 'mutation' && keyword !== 'subscription') {
        throw new Error(`unexpected document keyword ${keyword}`);
      }
      let name: string | null = null;
      if (this.peek().kind === 'name') name = this.next().value;
      const variableDefinitions: Operation['variableDefinitions'] = [];
      if (this.accept('punct', '(')) {
        while (!this.accept('punct', ')')) {
          this.expect('punct', '$');
          const varName = this.expect('name').value;
          this.expect('punct', ':');
          const type = this.parseType();
          let defaultValue: ValueNode | null = null;
          if (this.accept('punct', '=')) defaultValue = this.parseValue();
          variableDefinitions.push({ name: varName, type, defaultValue });
        }
      }
      operations.push({ kind: keyword, name, variableDefinitions, selectionSet: this.parseSelectionSet() });
    }
    return { operations, fragments };
  }

  parseType(): string {
    let type = '';
    if (this.accept('punct', '[')) {
      type = `[${this.parseType()}]`;
    } else {
      type = this.expect('name').value;
    }
    if (this.accept('punct', '!')) type += '!';
    return type;
  }

  parseSelectionSet(): SelectionNode[] {
    this.expect('punct', '{');
    const selections: SelectionNode[] = [];
    while (!this.accept('punct', '}')) {
      if (this.peek().kind === 'eof') throw new Error('unterminated selection set');
      if (this.accept('punct', '...')) {
        if (this.peek().kind === 'name' && this.peek().value === 'on') {
          this.next();
          const typeCondition = this.expect('name').value;
          selections.push({ kind: 'fragment', typeCondition, selectionSet: this.parseSelectionSet() });
        } else if (this.peek().kind === 'name') {
          selections.push({ kind: 'fragmentSpread', name: this.next().value });
        } else {
          selections.push({ kind: 'fragment', typeCondition: null, selectionSet: this.parseSelectionSet() });
        }
        continue;
      }
      const first = this.expect('name').value;
      let alias: string | null = null;
      let name = first;
      if (this.accept('punct', ':')) {
        alias = first;
        name = this.expect('name').value;
      }
      const args: FieldNode['args'] = [];
      if (this.accept('punct', '(')) {
        while (!this.accept('punct', ')')) {
          const argName = this.expect('name').value;
          this.expect('punct', ':');
          args.push({ name: argName, value: this.parseValue() });
        }
      }
      let selectionSet: SelectionNode[] | null = null;
      if (this.peek().kind === 'punct' && this.peek().value === '{') {
        selectionSet = this.parseSelectionSet();
      }
      selections.push({ kind: 'field', field: { alias, name, args, selectionSet } });
    }
    return selections;
  }

  parseValue(): ValueNode {
    const token = this.next();
    switch (token.kind) {
      case 'int':
        return { kind: 'int', value: Number.parseInt(token.value, 10) };
      case 'float':
        return { kind: 'float', value: Number.parseFloat(token.value) };
      case 'string':
        return { kind: 'string', value: token.value };
      case 'name':
        if (token.value === 'true') return { kind: 'boolean', value: true };
        if (token.value === 'false') return { kind: 'boolean', value: false };
        if (token.value === 'null') return { kind: 'null' };
        return { kind: 'enum', value: token.value };
      case 'punct':
        if (token.value === '$') return { kind: 'variable', name: this.expect('name').value };
        if (token.value === '[') {
          const values: ValueNode[] = [];
          while (!this.accept('punct', ']')) values.push(this.parseValue());
          return { kind: 'list', values };
        }
        if (token.value === '{') {
          const fields: Array<{ name: string; value: ValueNode }> = [];
          while (!this.accept('punct', '}')) {
            const name = this.expect('name').value;
            this.expect('punct', ':');
            fields.push({ name, value: this.parseValue() });
          }
          return { kind: 'object', fields };
        }
        throw new Error(`unexpected value punctuation ${token.value}`);
      default:
        throw new Error(`unexpected value token ${token.kind}`);
    }
  }
}

export function parseDocument(source: string): Document {
  return new Parser(tokenize(source)).parseDocument();
}

// ---------------------------------------------------------------- schema table (introspection)

const TYPE_FIELDS: Readonly<Record<string, readonly string[]>> = {
  Query: ['viewer', 'repository', 'node', '__type'],
  User: ['id', 'login', 'name', 'email', 'databaseId'],
  Repository: [
    'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission',
    'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest',
  ],
  RepositoryOwner: ['id', 'login'],
  BranchRef: ['id', 'name'],
  Issue: ['id', 'number', 'title', 'state', 'body'],
  IssueConnection: ['nodes', 'pageInfo', 'totalCount'],
  IssueEdge: ['node', 'cursor'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  PullRequest: ['id', 'number', 'state', 'merged', 'headRefName', 'baseRefName', 'mergeable', 'files', 'title', 'body'],
  PullRequestConnection: ['nodes', 'pageInfo', 'totalCount'],
  PullRequestEdge: ['node', 'cursor'],
  PullRequestFileConnection: ['nodes', 'pageInfo', 'totalCount'],
  PullRequestFile: ['path'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  CreateIssuePayload: ['issue', 'clientMutationId'],
  CloseIssuePayload: ['issue', 'clientMutationId'],
  CreatePullRequestPayload: ['pullRequest', 'clientMutationId'],
  MergePullRequestPayload: ['pullRequest', 'clientMutationId'],
  AddCommentPayload: ['comment', 'commentEdge', 'clientMutationId'],
  IssueComment: ['id', 'body'],
  IssueCommentEdge: ['node', 'cursor'],
};

const ENUM_VALUES: Readonly<Record<string, readonly string[]>> = {
  IssueState: ['OPEN', 'CLOSED'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT'],
  OrderDirection: ['ASC', 'DESC'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  SearchType: ['ISSUE', 'REPOSITORY', 'USER'],
};

function typeInfo(name: string): Record<string, unknown> {
  const fields = TYPE_FIELDS[name];
  const enumValues = ENUM_VALUES[name];
  return {
    kind: enumValues ? 'ENUM' : fields ? 'OBJECT' : 'SCALAR',
    name,
    description: null,
    fields: fields
      ? fields.map((field) => ({
          name: field,
          description: null,
          args: [],
          type: { kind: 'SCALAR', name: 'String', ofType: null },
          isDeprecated: false,
          deprecationReason: null,
        }))
      : null,
    enumValues: enumValues
      ? enumValues.map((value) => ({ name: value, description: null, isDeprecated: false, deprecationReason: null }))
      : null,
    inputFields: null,
    interfaces: [],
    possibleTypes: null,
  };
}

// ---------------------------------------------------------------- execution

interface ExecContext {
  readonly store: Store;
  readonly variables: Record<string, unknown>;
  readonly fragments: Map<string, { typeCondition: string | null; selectionSet: SelectionNode[] }>;
  readonly errors: Array<{ message: string }>;
}

function evalValue(node: ValueNode, ctx: ExecContext): unknown {
  switch (node.kind) {
    case 'variable':
      return ctx.variables[node.name] ?? null;
    case 'int':
    case 'float':
    case 'string':
    case 'boolean':
      return node.value;
    case 'null':
      return null;
    case 'enum':
      return node.value;
    case 'list':
      return node.values.map((value) => evalValue(value, ctx));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of node.fields) out[field.name] = evalValue(field.value, ctx);
      return out;
    }
  }
}

function argMap(field: FieldNode, ctx: ExecContext): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const arg of field.args) out[arg.name] = evalValue(arg.value, ctx);
  return out;
}

type ObjectValue =
  | { readonly __type: 'Query' }
  | { readonly __type: 'User'; readonly login: string; readonly id: number; readonly name: string; readonly email: string }
  | { readonly __type: 'Repository'; readonly repo: Repo }
  | { readonly __type: 'RepositoryOwner'; readonly login: string }
  | { readonly __type: 'BranchRef'; readonly name: string }
  | { readonly __type: 'Issue'; readonly repo: Repo; readonly issue: Issue }
  | { readonly __type: 'IssueConnection'; readonly repo: Repo; readonly issues: Issue[]; readonly hasNextPage: boolean; readonly endCursor: string | null }
  | { readonly __type: 'PullRequest'; readonly repo: Repo; readonly pull: PullRequest }
  | { readonly __type: 'PullRequestConnection'; readonly repo: Repo; readonly pulls: PullRequest[]; readonly hasNextPage: boolean; readonly endCursor: string | null }
  | { readonly __type: 'PullRequestFileConnection'; readonly repo: Repo; readonly pull: PullRequest }
  | { readonly __type: 'PullRequestFile'; readonly path: string }
  | { readonly __type: 'PageInfo'; readonly hasNextPage: boolean; readonly endCursor: string | null }
  | { readonly __type: 'IssueComment'; readonly repo: Repo; readonly id: number; readonly body: string }
  | { readonly __type: 'IssueCommentEdge'; readonly repo: Repo; readonly id: number; readonly body: string }
  | { readonly __type: 'CreateIssuePayload'; readonly repo: Repo; readonly issue: Issue | null }
  | { readonly __type: 'CloseIssuePayload'; readonly repo: Repo; readonly issue: Issue | null }
  | { readonly __type: 'CreatePullRequestPayload'; readonly repo: Repo; readonly pull: PullRequest | null }
  | { readonly __type: 'MergePullRequestPayload'; readonly repo: Repo; readonly pull: PullRequest | null }
  | { readonly __type: 'AddCommentPayload'; readonly repo: Repo; readonly commentId: number | null }
  | { readonly __type: '__Type'; readonly name: string };

const SCALAR_FIELDS: Readonly<Record<string, readonly string[]>> = {
  Query: ['viewer', 'repository', 'node', '__type'],
  User: ['id', 'login', 'name', 'email', 'databaseId'],
  Repository: [
    'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission',
    'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest',
  ],
  RepositoryOwner: ['id', 'login'],
  BranchRef: ['id', 'name'],
  Issue: ['id', 'number', 'title', 'state', 'body'],
  IssueConnection: ['nodes', 'pageInfo', 'totalCount'],
  IssueEdge: ['node', 'cursor'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  PullRequest: ['id', 'number', 'state', 'merged', 'headRefName', 'baseRefName', 'mergeable', 'files', 'title', 'body'],
  PullRequestConnection: ['nodes', 'pageInfo', 'totalCount'],
  PullRequestEdge: ['node', 'cursor'],
  PullRequestFileConnection: ['nodes', 'pageInfo', 'totalCount'],
  PullRequestFile: ['path'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  CreateIssuePayload: ['issue', 'clientMutationId'],
  CloseIssuePayload: ['issue', 'clientMutationId'],
  CreatePullRequestPayload: ['pullRequest', 'clientMutationId'],
  MergePullRequestPayload: ['pullRequest', 'clientMutationId'],
  AddCommentPayload: ['comment', 'commentEdge', 'clientMutationId'],
  IssueComment: ['id', 'body'],
  IssueCommentEdge: ['node', 'cursor'],
  __Type: ['kind', 'name', 'description', 'fields', 'enumValues', 'inputFields', 'interfaces', 'possibleTypes'],
};

function unknownField(ctx: ExecContext, typeName: string, fieldName: string): void {
  ctx.errors.push({ message: `Cannot query field "${fieldName}" on type "${typeName}". Did you mean "noSuchFieldOn${typeName}"?` });
}

function cursorFor(index: number): string {
  return Buffer.from(`cursor:${index}`, 'utf8').toString('base64');
}

function cursorIndex(cursor: unknown): number {
  if (typeof cursor !== 'string') return -1;
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    const match = /^cursor:(\d+)$/.exec(text);
    return match ? Number.parseInt(match[1]!, 10) : -1;
  } catch {
    return -1;
  }
}

function paginateConnection<T>(items: readonly T[], args: Record<string, unknown>): { page: T[]; hasNextPage: boolean; endCursor: string | null } {
  const after = cursorIndex(args.after);
  const start = after + 1;
  const first = typeof args.first === 'number' ? args.first : items.length;
  const page = items.slice(start, start + first);
  const hasNextPage = start + page.length < items.length;
  const endCursor = page.length === 0 ? null : cursorFor(start + page.length - 1);
  return { page, hasNextPage, endCursor };
}

function executeSelections(
  object: ObjectValue,
  selections: SelectionNode[],
  ctx: ExecContext,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'fragment') {
      if (selection.typeCondition !== null && selection.typeCondition !== object.__type) continue;
      Object.assign(out, executeSelections(object, selection.selectionSet, ctx));
      continue;
    }
    if (selection.kind === 'fragmentSpread') {
      const fragment = ctx.fragments.get(selection.name);
      if (!fragment) {
        ctx.errors.push({ message: `Unknown fragment "${selection.name}".` });
        continue;
      }
      if (fragment.typeCondition !== null && fragment.typeCondition !== object.__type) continue;
      Object.assign(out, executeSelections(object, fragment.selectionSet, ctx));
      continue;
    }
    const field = selection.field;
    const key = field.alias ?? field.name;
    const value = resolveField(object, field, ctx);
    if (value === undefined) {
      out[key] = null;
      continue;
    }
    if (value !== null && typeof value === 'object' && '__object' in value) {
      const child = value as { __object: ObjectValue };
      out[key] = field.selectionSet ? executeSelections(child.__object, field.selectionSet, ctx) : null;
    } else if (Array.isArray(value)) {
      out[key] = value.map((item) => {
        if (item !== null && typeof item === 'object' && '__object' in item) {
          const child = item as { __object: ObjectValue };
          return field.selectionSet ? executeSelections(child.__object, field.selectionSet, ctx) : null;
        }
        return item;
      });
    } else {
      out[key] = value;
    }
  }
  return out;
}

function obj(value: ObjectValue): { __object: ObjectValue } {
  return { __object: value };
}

function resolveField(object: ObjectValue, field: FieldNode, ctx: ExecContext): unknown {
  const store = ctx.store;
  const args = argMap(field, ctx);
  const name = field.name;
  const known = SCALAR_FIELDS[object.__type] ?? [];
  if (name === '__typename') return object.__type;
  if (!known.includes(name)) {
    unknownField(ctx, object.__type, name);
    return undefined;
  }

  switch (object.__type) {
    case 'Query': {
      if (name === 'viewer') {
        const viewer = store.viewer;
        return obj({ __type: 'User', login: viewer.login, id: viewer.id, name: viewer.name, email: viewer.email });
      }
      if (name === 'repository') {
        const owner = args.owner as string | undefined;
        const repoName = args.name as string | undefined;
        if (typeof owner !== 'string' || typeof repoName !== 'string') return null;
        const repo = store.getRepo(owner, repoName);
        return repo ? obj({ __type: 'Repository', repo }) : null;
      }
      if (name === 'node') {
        const id = args.id as string | undefined;
        if (typeof id !== 'string') return null;
        return resolveNode(store, id);
      }
      if (name === '__type') {
        const typeName = args.name as string | undefined;
        if (typeof typeName !== 'string') return null;
        return obj({ __type: '__Type', name: typeName });
      }
      return null;
    }
    case 'User': {
      if (name === 'id') return globalId('User', object.id);
      if (name === 'databaseId') return object.id;
      if (name === 'login') return object.login;
      if (name === 'name') return object.name;
      if (name === 'email') return object.email;
      return null;
    }
    case 'Repository': {
      const repo = object.repo;
      if (name === 'id') return globalId('Repository', repo.id);
      if (name === 'databaseId') return repo.id;
      if (name === 'name') return repo.name;
      if (name === 'nameWithOwner') return `${repo.owner}/${repo.name}`;
      if (name === 'owner') return obj({ __type: 'RepositoryOwner', login: repo.owner });
      if (name === 'defaultBranchRef') return obj({ __type: 'BranchRef', name: repo.defaultBranch });
      if (name === 'viewerPermission') return 'ADMIN';
      if (name === 'hasIssuesEnabled') return true;
      if (name === 'issue') {
        const issue = repo.issues.get(args.number as number);
        return issue ? obj({ __type: 'Issue', repo, issue }) : null;
      }
      if (name === 'issues') {
        let issues = [...repo.issues.values()];
        const states = args.states as string[] | undefined;
        if (Array.isArray(states) && states.length > 0) {
          const wanted = new Set(states.map((state) => state.toLowerCase()));
          issues = issues.filter((issue) => wanted.has(issue.state));
        }
        const orderBy = (args.orderBy as { field?: string; direction?: string } | undefined) ?? {};
        const direction = (orderBy.direction ?? 'DESC').toUpperCase();
        const fieldOrder = (orderBy.field ?? 'CREATED_AT').toUpperCase();
        issues.sort((a, b) => {
          const cmp = fieldOrder === 'CREATED_AT' ? a.createdSeq - b.createdSeq : a.number - b.number;
          return direction === 'ASC' ? cmp : -cmp;
        });
        const conn = paginateConnection(issues, args);
        return obj({ __type: 'IssueConnection', repo, issues: conn.page, hasNextPage: conn.hasNextPage, endCursor: conn.endCursor });
      }
      if (name === 'pullRequests') {
        const pulls = [...repo.pulls.values()].sort((a, b) => b.createdSeq - a.createdSeq);
        const conn = paginateConnection(pulls, args);
        return obj({ __type: 'PullRequestConnection', repo, pulls: conn.page, hasNextPage: conn.hasNextPage, endCursor: conn.endCursor });
      }
      if (name === 'pullRequest') {
        const pull = repo.pulls.get(args.number as number);
        return pull ? obj({ __type: 'PullRequest', repo, pull }) : null;
      }
      return null;
    }
    case 'RepositoryOwner': {
      if (name === 'id') return globalId('User', 1000);
      if (name === 'login') return object.login;
      return null;
    }
    case 'BranchRef': {
      if (name === 'id') return globalId('Ref', object.name);
      if (name === 'name') return object.name;
      return null;
    }
    case 'Issue': {
      const issue = object.issue;
      if (name === 'id') return globalId('Issue', object.repo.id, issue.number);
      if (name === 'number') return issue.number;
      if (name === 'title') return issue.title;
      if (name === 'state') return issue.state.toUpperCase();
      if (name === 'body') return issue.body;
      return null;
    }
    case 'IssueConnection': {
      if (name === 'nodes') return object.issues.map((issue) => obj({ __type: 'Issue', repo: object.repo, issue }));
      if (name === 'totalCount') return object.issues.length;
      if (name === 'pageInfo') {
        return obj({ __type: 'PageInfo', hasNextPage: object.hasNextPage, endCursor: object.endCursor });
      }
      return null;
    }
    case 'PullRequest': {
      const pull = object.pull;
      if (name === 'id') return globalId('PullRequest', object.repo.id, pull.number);
      if (name === 'number') return pull.number;
      if (name === 'title') return pull.title;
      if (name === 'body') return pull.body;
      if (name === 'state') return pull.merged ? 'MERGED' : pull.state.toUpperCase();
      if (name === 'merged') return pull.merged;
      if (name === 'headRefName') return pull.headRef;
      if (name === 'baseRefName') return pull.baseRef;
      if (name === 'mergeable') return store.mergeable(object.repo, pull) ? 'MERGEABLE' : 'CONFLICTING';
      if (name === 'files') {
        return obj({ __type: 'PullRequestFileConnection', repo: object.repo, pull });
      }
      return null;
    }
    case 'PullRequestConnection': {
      if (name === 'nodes') return object.pulls.map((pull) => obj({ __type: 'PullRequest', repo: object.repo, pull }));
      if (name === 'totalCount') return object.pulls.length;
      if (name === 'pageInfo') return obj({ __type: 'PageInfo', hasNextPage: object.hasNextPage, endCursor: object.endCursor });
      return null;
    }
    case 'PullRequestFileConnection': {
      if (name === 'nodes') {
        const files = store.pullFiles(object.repo, object.pull);
        return files.map((file) => obj({ __type: 'PullRequestFile', path: file.filename }));
      }
      if (name === 'totalCount') return store.pullFiles(object.repo, object.pull).length;
      if (name === 'pageInfo') return obj({ __type: 'PageInfo', hasNextPage: false, endCursor: null });
      return null;
    }
    case 'PullRequestFile': {
      if (name === 'path') return object.path;
      return null;
    }
    case 'PageInfo': {
      if (name === 'hasNextPage') return object.hasNextPage;
      if (name === 'hasPreviousPage') return false;
      if (name === 'startCursor') return null;
      if (name === 'endCursor') return object.endCursor;
      return null;
    }
    case 'IssueComment': {
      if (name === 'id') return globalId('IssueComment', object.repo.id, object.id);
      if (name === 'body') return object.body;
      return null;
    }
    case 'IssueCommentEdge': {
      if (name === 'node') return obj({ __type: 'IssueComment', repo: object.repo, id: object.id, body: object.body });
      if (name === 'cursor') return cursorFor(object.id);
      return null;
    }
    case 'CreateIssuePayload':
    case 'CloseIssuePayload': {
      if (name === 'issue') {
        const issue = object.issue;
        return issue ? obj({ __type: 'Issue', repo: object.repo, issue }) : null;
      }
      if (name === 'clientMutationId') return null;
      return null;
    }
    case 'CreatePullRequestPayload':
    case 'MergePullRequestPayload': {
      if (name === 'pullRequest') {
        const pull = object.pull;
        return pull ? obj({ __type: 'PullRequest', repo: object.repo, pull }) : null;
      }
      if (name === 'clientMutationId') return null;
      return null;
    }
    case 'AddCommentPayload': {
      if (name === 'comment' || name === 'commentEdge') {
        const comment = findComment(object.repo, object.commentId);
        if (!comment) return null;
        if (name === 'comment') return obj({ __type: 'IssueComment', repo: object.repo, id: comment.id, body: comment.body });
        return obj({ __type: 'IssueCommentEdge', repo: object.repo, id: comment.id, body: comment.body });
      }
      if (name === 'clientMutationId') return null;
      return null;
    }
    case '__Type': {
      const info = typeInfo(object.name);
      if (name === 'kind') return info.kind;
      if (name === 'name') return info.name;
      if (name === 'description') return info.description;
      if (name === 'fields') return info.fields;
      if (name === 'enumValues') return info.enumValues;
      if (name === 'inputFields') return info.inputFields;
      if (name === 'interfaces') return info.interfaces;
      if (name === 'possibleTypes') return info.possibleTypes;
      return null;
    }
    default:
      return null;
  }
}

function findComment(repo: Repo, commentId: number | null): { id: number; body: string } | undefined {
  if (commentId === null) return undefined;
  for (const list of repo.comments.values()) {
    const found = list.find((comment) => comment.id === commentId);
    if (found) return found;
  }
  return undefined;
}

function resolveNode(store: Store, id: string): { __object: ObjectValue } | null {
  const decoded = decodeGlobalId(id);
  if (!decoded) return null;
  const { kind, parts } = decoded;
  if (kind === 'Repository') {
    const repo = store.getRepoById(Number.parseInt(parts[0] ?? '', 10));
    return repo ? obj({ __type: 'Repository', repo }) : null;
  }
  if (kind === 'Issue') {
    const repo = store.getRepoById(Number.parseInt(parts[0] ?? '', 10));
    const issue = repo?.issues.get(Number.parseInt(parts[1] ?? '', 10));
    return repo && issue ? obj({ __type: 'Issue', repo, issue }) : null;
  }
  if (kind === 'PullRequest') {
    const repo = store.getRepoById(Number.parseInt(parts[0] ?? '', 10));
    const pull = repo?.pulls.get(Number.parseInt(parts[1] ?? '', 10));
    return repo && pull ? obj({ __type: 'PullRequest', repo, pull }) : null;
  }
  if (kind === 'IssueComment') {
    const repo = store.getRepoById(Number.parseInt(parts[0] ?? '', 10));
    const comment = repo ? findComment(repo, Number.parseInt(parts[1] ?? '0', 10)) : undefined;
    return repo && comment ? obj({ __type: 'IssueComment', repo, id: comment.id, body: comment.body }) : null;
  }
  if (kind === 'User') {
    const viewer = store.viewer;
    return obj({ __type: 'User', login: viewer.login, id: viewer.id, name: viewer.name, email: viewer.email });
  }
  return null;
}

// ---------------------------------------------------------------- mutations

function executeMutation(store: Store, field: FieldNode, ctx: ExecContext): { __object: ObjectValue } | null {
  const args = argMap(field, ctx);
  const input = (args.input ?? {}) as Record<string, unknown>;
  switch (field.name) {
    case 'createIssue': {
      const repoId = typeof input.repositoryId === 'string' ? decodeGlobalId(input.repositoryId)?.parts[0] : undefined;
      const repo = repoId ? store.getRepoById(Number.parseInt(repoId, 10)) : undefined;
      if (!repo) {
        ctx.errors.push({ message: 'repository not found' });
        return null;
      }
      const issue = store.createIssue(repo, String(input.title ?? ''), String(input.body ?? ''), []);
      return obj({ __type: 'CreateIssuePayload', repo, issue });
    }
    case 'closeIssue': {
      const decoded = typeof input.issueId === 'string' ? decodeGlobalId(input.issueId) : null;
      const repo = decoded ? store.getRepoById(Number.parseInt(decoded.parts[0] ?? '', 10)) : undefined;
      const issue = repo?.issues.get(Number.parseInt(decoded?.parts[1] ?? '', 10));
      if (!repo || !issue) {
        ctx.errors.push({ message: 'issue not found' });
        return null;
      }
      issue.state = 'closed';
      return obj({ __type: 'CloseIssuePayload', repo, issue });
    }
    case 'createPullRequest': {
      const repoId = typeof input.repositoryId === 'string' ? decodeGlobalId(input.repositoryId)?.parts[0] : undefined;
      const repo = repoId ? store.getRepoById(Number.parseInt(repoId, 10)) : undefined;
      if (!repo) {
        ctx.errors.push({ message: 'repository not found' });
        return null;
      }
      const result = store.createPull(repo, {
        title: String(input.title ?? ''),
        body: String(input.body ?? ''),
        head: String(input.headRefName ?? ''),
        base: String(input.baseRefName ?? ''),
      });
      if ('error' in result) {
        // The GraphQL fixture tolerates a duplicate open PR: reuse it.
        const existing = [...repo.pulls.values()].find(
          (pull) => pull.state === 'open' && pull.headRef === String(input.headRefName ?? '') && pull.baseRef === String(input.baseRefName ?? ''),
        );
        if (existing) return obj({ __type: 'CreatePullRequestPayload', repo, pull: existing });
        ctx.errors.push({ message: result.error });
        return null;
      }
      return obj({ __type: 'CreatePullRequestPayload', repo, pull: result });
    }
    case 'mergePullRequest': {
      const decoded = typeof input.pullRequestId === 'string' ? decodeGlobalId(input.pullRequestId) : null;
      const repo = decoded ? store.getRepoById(Number.parseInt(decoded.parts[0] ?? '', 10)) : undefined;
      const pull = repo?.pulls.get(Number.parseInt(decoded?.parts[1] ?? '', 10));
      if (!repo || !pull) {
        ctx.errors.push({ message: 'pull request not found' });
        return null;
      }
      const method = String(input.mergeMethod ?? 'SQUASH');
      const result = store.mergePull(repo, pull, method);
      if ('error' in result) {
        ctx.errors.push({ message: result.error });
        return null;
      }
      return obj({ __type: 'MergePullRequestPayload', repo, pull });
    }
    case 'addComment': {
      const decoded = typeof input.subjectId === 'string' ? decodeGlobalId(input.subjectId) : null;
      const repo = decoded ? store.getRepoById(Number.parseInt(decoded.parts[0] ?? '', 10)) : undefined;
      const issue = repo?.issues.get(Number.parseInt(decoded?.parts[1] ?? '', 10));
      if (!repo || !issue) {
        ctx.errors.push({ message: 'issue not found' });
        return null;
      }
      const comment = store.createComment(repo, issue.number, String(input.body ?? ''));
      return obj({ __type: 'AddCommentPayload', repo, commentId: comment.id });
    }
    default:
      ctx.errors.push({ message: `Unknown mutation "${field.name}".` });
      return null;
  }
}

// ---------------------------------------------------------------- entry point

export interface GraphQLOperationInput {
  readonly query: string;
  readonly variables?: Record<string, unknown> | null;
  readonly operationName?: string | null;
}

export function executeGraphQL(store: Store, input: GraphQLOperationInput): Record<string, unknown> {
  let document: Document;
  try {
    document = parseDocument(input.query);
  } catch (err) {
    return { errors: [{ message: `GraphQL parse error: ${(err as Error).message}` }] };
  }
  const variables: Record<string, unknown> = { ...(input.variables ?? {}) };
  let operation = document.operations[0];
  if (input.operationName) {
    operation = document.operations.find((op) => op.name === input.operationName) ?? operation;
  }
  if (!operation) return { errors: [{ message: 'No operation supplied.' }] };
  for (const def of operation.variableDefinitions) {
    if (!(def.name in variables) && def.defaultValue !== null) {
      variables[def.name] = evalValue(def.defaultValue, { store, variables, fragments: document.fragments, errors: [] });
    }
  }
  const ctx: ExecContext = { store, variables, fragments: document.fragments, errors: [] };
  const data: Record<string, unknown> = {};
  if (operation.kind === 'mutation') {
    for (const selection of operation.selectionSet) {
      if (selection.kind !== 'field') continue;
      const field = selection.field;
      const key = field.alias ?? field.name;
      if (!['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'].includes(field.name)) {
        ctx.errors.push({ message: `Unknown mutation "${field.name}".` });
        data[key] = null;
        continue;
      }
      const payload = executeMutation(store, field, ctx);
      data[key] = payload && field.selectionSet ? executeSelections(payload.__object, field.selectionSet, ctx) : null;
    }
  } else {
    const root: ObjectValue = { __type: 'Query' };
    Object.assign(data, executeSelections(root, operation.selectionSet, ctx));
  }
  const result: Record<string, unknown> = { data };
  if (ctx.errors.length > 0) result.errors = ctx.errors;
  return result;
}

/** Handle one decoded request body: a single operation or a batch array. */
export function handleGraphQL(store: Store, body: unknown): Record<string, unknown> | Array<Record<string, unknown>> {
  if (Array.isArray(body)) {
    return body.map((item) => {
      if (typeof item !== 'object' || item === null || typeof (item as { query?: unknown }).query !== 'string') {
        return { errors: [{ message: 'Each batched operation needs a query string.' }] };
      }
      const op = item as GraphQLOperationInput;
      return executeGraphQL(store, op);
    });
  }
  if (typeof body !== 'object' || body === null || typeof (body as { query?: unknown }).query !== 'string') {
    return { errors: [{ message: 'A query string is required.' }] };
  }
  return executeGraphQL(store, body as GraphQLOperationInput);
}
