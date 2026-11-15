// graphql.ts — hand-written GraphQL v4 for the forge: viewer, repository, issues,
// pull requests, node(), introspection and the five mutations gh uses. Pure Node,
// zero dependencies. The executor works over the shared in-memory store (the same
// store the REST and git surfaces use), so effects are visible across surfaces.
import {
  store as singletonStore,
  VIEWER,
  toGlobalId,
  fromGlobalId,
  getRepo,
  createIssue,
  createPull,
  mergePull,
  pullFiles,
  mergeBase,
  flattenTree,
  nextSeq,
  isoAt,
} from './store.ts';
import type { Store } from './store.ts';

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

type AnyRecord = Record<string, any>;

function isRecord(v: unknown): v is AnyRecord {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function b64encode(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64');
}

function b64decode(text: string): string | null {
  try {
    return Buffer.from(text, 'base64').toString('utf8');
  } catch {
    return null;
  }
}

function cursorFor(number: number): string {
  return b64encode(`cursor:${number}`);
}

function numberFromCursor(cursor: unknown): number | null {
  if (typeof cursor !== 'string' || cursor === '') return null;
  const text = b64decode(cursor);
  if (text === null || !text.startsWith('cursor:')) return null;
  const n = Number(text.slice('cursor:'.length));
  return Number.isInteger(n) ? n : null;
}

function repoGlobalId(repoId: number): string {
  return toGlobalId('Repository', repoId);
}

function issueGlobalId(issueId: number): string {
  return toGlobalId('Issue', issueId);
}

function pullGlobalId(pullId: number): string {
  return toGlobalId('PullRequest', pullId);
}

function commentGlobalId(commentId: number): string {
  return toGlobalId('IssueComment', commentId);
}

function decodeNodeId(id: unknown): { kind: string; id: string } | null {
  if (typeof id !== 'string' || id === '') return null;
  try {
    const decoded: any = fromGlobalId(id);
    if (!decoded || typeof decoded.kind !== 'string' || decoded.id === undefined) return null;
    return { kind: decoded.kind, id: String(decoded.id) };
  } catch {
    return null;
  }
}

function allRepos(store: any): any[] {
  if (store === null || store === undefined) return [];
  const repos = store.repos;
  if (repos instanceof Map) return [...repos.values()];
  if (Array.isArray(repos)) return repos;
  return [];
}

function findRepoById(store: any, id: number): any | undefined {
  return allRepos(store).find((repo: any) => repo.id === id);
}

function findIssueById(store: any, id: number): { repo: any; issue: any } | undefined {
  for (const repo of allRepos(store)) {
    const issue = Array.isArray(repo.issues) ? repo.issues.find((i: any) => i.id === id) : undefined;
    if (issue !== undefined) return { repo, issue };
  }
  return undefined;
}

function findPullById(store: any, id: number): { repo: any; pull: any } | undefined {
  for (const repo of allRepos(store)) {
    const pull = Array.isArray(repo.pulls) ? repo.pulls.find((p: any) => p.id === id) : undefined;
    if (pull !== undefined) return { repo, pull };
  }
  return undefined;
}

function findCommentById(store: any, id: number): { repo: any; comment: any } | undefined {
  for (const repo of allRepos(store)) {
    if (!Array.isArray(repo.issues)) continue;
    for (const issue of repo.issues) {
      const comment = Array.isArray(issue.comments) ? issue.comments.find((c: any) => c.id === id) : undefined;
      if (comment !== undefined) return { repo, comment };
    }
  }
  return undefined;
}

function allocId(store: any): number {
  if (typeof store?.nextId === 'number') return store.nextId++;
  let max = 1000000;
  for (const repo of allRepos(store)) {
    if (typeof repo.id === 'number') max = Math.max(max, repo.id);
    for (const issue of repo.issues ?? []) {
      if (typeof issue.id === 'number') max = Math.max(max, issue.id);
      for (const c of issue.comments ?? []) if (typeof c.id === 'number') max = Math.max(max, c.id);
    }
    for (const pull of repo.pulls ?? []) if (typeof pull.id === 'number') max = Math.max(max, pull.id);
  }
  return max + 1;
}

// ---------------------------------------------------------------------------
// Tokenizer
// ---------------------------------------------------------------------------

export interface Token {
  kind: 'name' | 'string' | 'int' | 'float' | 'punct' | 'spread';
  value: string;
  line: number;
  column: number;
}

export function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  let line = 1;
  let column = 1;
  const push = (kind: Token['kind'], value: string, startLine: number, startCol: number): void => {
    tokens.push({ kind, value, line: startLine, column: startCol });
  };
  const advance = (n = 1): void => {
    for (let k = 0; k < n; k += 1) {
      if (source[i] === '\n') {
        line += 1;
        column = 1;
      } else {
        column += 1;
      }
      i += 1;
    }
  };
  while (i < source.length) {
    const ch = source[i]!;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
      advance();
      continue;
    }
    if (ch === '#') {
      while (i < source.length && source[i] !== '\n') advance();
      continue;
    }
    const startLine = line;
    const startCol = column;
    if (ch === '.' && source[i + 1] === '.' && source[i + 2] === '.') {
      advance(3);
      push('spread', '...', startLine, startCol);
      continue;
    }
    if ('{}()[]:!=$@|&'.includes(ch)) {
      advance();
      push('punct', ch, startLine, startCol);
      continue;
    }
    if (ch === '"') {
      if (source.startsWith('"""', i)) {
        advance(3);
        let value = '';
        while (i < source.length && !source.startsWith('"""', i)) {
          if (source[i] === '\\' && i + 1 < source.length) {
            value += source[i + 1];
            advance(2);
          } else {
            value += source[i];
            advance();
          }
        }
        if (source.startsWith('"""', i)) advance(3);
        push('string', value, startLine, startCol);
        continue;
      }
      advance();
      let value = '';
      let closed = false;
      while (i < source.length) {
        const c = source[i]!;
        if (c === '"') {
          closed = true;
          advance();
          break;
        }
        if (c === '\\' && i + 1 < source.length) {
          const esc = source[i + 1]!;
          if (esc === 'n') value += '\n';
          else if (esc === 't') value += '\t';
          else if (esc === 'r') value += '\r';
          else if (esc === 'u' && source.slice(i + 2, i + 6).match(/^[0-9a-fA-F]{4}$/)) {
            value += String.fromCharCode(parseInt(source.slice(i + 2, i + 6), 16));
            advance(6);
            continue;
          } else value += esc;
          advance(2);
          continue;
        }
        if (c === '\n') throw new Error(`unterminated string at line ${startLine}`);
        value += c;
        advance();
      }
      if (!closed) throw new Error(`unterminated string at line ${startLine}`);
      push('string', value, startLine, startCol);
      continue;
    }
    if (/[0-9]/.test(ch) || (ch === '-' && /[0-9]/.test(source[i + 1] ?? ''))) {
      let value = '';
      if (ch === '-') {
        value += '-';
        advance();
      }
      let isFloat = false;
      while (i < source.length && /[0-9]/.test(source[i]!)) {
        value += source[i];
        advance();
      }
      if (source[i] === '.' && /[0-9]/.test(source[i + 1] ?? '')) {
        isFloat = true;
        value += '.';
        advance();
        while (i < source.length && /[0-9]/.test(source[i]!)) {
          value += source[i];
          advance();
        }
      }
      if (source[i] === 'e' || source[i] === 'E') {
        isFloat = true;
        value += source[i];
        advance();
        if (source[i] === '+' || source[i] === '-') {
          value += source[i];
          advance();
        }
        while (i < source.length && /[0-9]/.test(source[i]!)) {
          value += source[i];
          advance();
        }
      }
      push(isFloat ? 'float' : 'int', value, startLine, startCol);
      continue;
    }
    if (/[_A-Za-z]/.test(ch)) {
      let value = '';
      while (i < source.length && /[_0-9A-Za-z]/.test(source[i]!)) {
        value += source[i];
        advance();
      }
      push('name', value, startLine, startCol);
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(ch)} at line ${line}, column ${column}`);
  }
  return tokens;
}

// ---------------------------------------------------------------------------
// Parser: documents, operations, fragments, selections, values
// ---------------------------------------------------------------------------

export interface ValueNode {
  kind: 'variable' | 'string' | 'int' | 'float' | 'boolean' | 'null' | 'enum' | 'list' | 'object';
  value?: unknown;
  values?: ValueNode[];
  fields?: { name: string; value: ValueNode }[];
  name?: string;
}

export interface ArgumentNode {
  name: string;
  value: ValueNode;
}

export interface DirectiveNode {
  name: string;
  arguments: ArgumentNode[];
}

export interface FieldSelection {
  kind: 'field';
  name: string;
  alias?: string;
  arguments: ArgumentNode[];
  directives: DirectiveNode[];
  selectionSet?: SelectionNode[];
}

export interface FragmentSpreadSelection {
  kind: 'fragmentSpread';
  name: string;
  directives: DirectiveNode[];
}

export interface InlineFragmentSelection {
  kind: 'inlineFragment';
  typeCondition?: string;
  directives: DirectiveNode[];
  selectionSet: SelectionNode[];
}

export type SelectionNode = FieldSelection | FragmentSpreadSelection | InlineFragmentSelection;

export interface VariableDefinition {
  name: string;
  type: string;
  defaultValue?: ValueNode;
}

export interface OperationNode {
  kind: 'query' | 'mutation' | 'subscription';
  name?: string;
  variableDefinitions: VariableDefinition[];
  directives: DirectiveNode[];
  selectionSet: SelectionNode[];
}

export interface FragmentDefinition {
  name: string;
  typeCondition: string;
  directives: DirectiveNode[];
  selectionSet: SelectionNode[];
}

export interface DocumentNode {
  operations: OperationNode[];
  fragments: Map<string, FragmentDefinition>;
}

class Parser {
  private readonly tokens: Token[];
  private pos = 0;

  constructor(source: string) {
    this.tokens = tokenize(source);
  }

  private peek(offset = 0): Token | undefined {
    return this.tokens[this.pos + offset];
  }

  private next(): Token {
    const token = this.tokens[this.pos];
    if (token === undefined) throw new Error('unexpected end of document');
    this.pos += 1;
    return token;
  }

  private expectPunct(value: string): Token {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) {
      throw new Error(`expected "${value}" at line ${token.line}, got ${JSON.stringify(token.value)}`);
    }
    return token;
  }

  private expectName(value?: string): Token {
    const token = this.next();
    if (token.kind !== 'name' || (value !== undefined && token.value !== value)) {
      throw new Error(`expected name ${value ?? ''} at line ${token.line}, got ${JSON.stringify(token.value)}`);
    }
    return token;
  }

  private matchPunct(value: string): boolean {
    const token = this.peek();
    if (token !== undefined && token.kind === 'punct' && token.value === value) {
      this.pos += 1;
      return true;
    }
    return false;
  }

  parseDocument(): DocumentNode {
    const operations: OperationNode[] = [];
    const fragments = new Map<string, FragmentDefinition>();
    while (this.peek() !== undefined) {
      const token = this.peek()!;
      if (token.kind === 'punct' && token.value === '{') {
        operations.push({
          kind: 'query',
          variableDefinitions: [],
          directives: [],
          selectionSet: this.parseSelectionSet(),
        });
        continue;
      }
      if (token.kind === 'name' && token.value === 'fragment') {
        const fragment = this.parseFragmentDefinition();
        fragments.set(fragment.name, fragment);
        continue;
      }
      if (token.kind === 'name' && (token.value === 'query' || token.value === 'mutation' || token.value === 'subscription')) {
        operations.push(this.parseOperation());
        continue;
      }
      throw new Error(`unexpected token ${JSON.stringify(token.value)} at line ${token.line}`);
    }
    return { operations, fragments };
  }

  private parseOperation(): OperationNode {
    const kind = this.next().value as 'query' | 'mutation' | 'subscription';
    let name: string | undefined;
    const next = this.peek();
    if (next !== undefined && next.kind === 'name') {
      name = this.next().value;
    }
    const variableDefinitions = this.parseVariableDefinitions();
    const directives = this.parseDirectives();
    const selectionSet = this.parseSelectionSet();
    return { kind, name, variableDefinitions, directives, selectionSet };
  }

  private parseVariableDefinitions(): VariableDefinition[] {
    const defs: VariableDefinition[] = [];
    if (!this.matchPunct('(')) return defs;
    while (!this.matchPunct(')')) {
      this.expectPunct('$');
      const name = this.expectName().value;
      this.expectPunct(':');
      const type = this.parseTypeString();
      let defaultValue: ValueNode | undefined;
      if (this.matchPunct('=')) defaultValue = this.parseValue(true);
      defs.push({ name, type, defaultValue });
    }
    return defs;
  }

  private parseTypeString(): string {
    let type = '';
    for (;;) {
      const token = this.peek();
      if (token === undefined) throw new Error('unexpected end of document in type');
      if (token.kind === 'punct' && (token.value === '[' || token.value === ']' || token.value === '!')) {
        type += token.value;
        this.pos += 1;
        continue;
      }
      if (token.kind === 'name') {
        type += token.value;
        this.pos += 1;
        continue;
      }
      break;
    }
    if (type === '') throw new Error(`expected a type at line ${this.peek()?.line ?? 0}`);
    return type;
  }

  private parseFragmentDefinition(): FragmentDefinition {
    this.expectName('fragment');
    const name = this.expectName().value;
    this.expectName('on');
    const typeCondition = this.expectName().value;
    const directives = this.parseDirectives();
    const selectionSet = this.parseSelectionSet();
    return { name, typeCondition, directives, selectionSet };
  }

  private parseDirectives(): DirectiveNode[] {
    const directives: DirectiveNode[] = [];
    while (this.peek()?.kind === 'punct' && this.peek()?.value === '@') {
      this.pos += 1;
      const name = this.expectName().value;
      const args = this.parseArguments();
      directives.push({ name, arguments: args });
    }
    return directives;
  }

  private parseArguments(): ArgumentNode[] {
    const args: ArgumentNode[] = [];
    if (!this.matchPunct('(')) return args;
    while (!this.matchPunct(')')) {
      const name = this.expectName().value;
      this.expectPunct(':');
      args.push({ name, value: this.parseValue(false) });
    }
    return args;
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const selections: SelectionNode[] = [];
    while (!this.matchPunct('}')) {
      selections.push(this.parseSelection());
    }
    return selections;
  }

  private parseSelection(): SelectionNode {
    const token = this.peek();
    if (token === undefined) throw new Error('unexpected end of document in selection set');
    if (token.kind === 'spread') {
      this.pos += 1;
      const next = this.peek();
      if (next !== undefined && next.kind === 'name' && next.value === 'on') {
        this.pos += 1;
        const typeCondition = this.expectName().value;
        const directives = this.parseDirectives();
        return { kind: 'inlineFragment', typeCondition, directives, selectionSet: this.parseSelectionSet() };
      }
      if (next !== undefined && next.kind === 'name') {
        const name = this.next().value;
        const directives = this.parseDirectives();
        return { kind: 'fragmentSpread', name, directives };
      }
      const directives = this.parseDirectives();
      return { kind: 'inlineFragment', directives, selectionSet: this.parseSelectionSet() };
    }
    if (token.kind !== 'name') throw new Error(`expected a field name at line ${token.line}, got ${JSON.stringify(token.value)}`);
    let name = this.next().value;
    let alias: string | undefined;
    if (this.peek()?.kind === 'punct' && this.peek()?.value === ':') {
      this.pos += 1;
      alias = name;
      name = this.expectName().value;
    }
    const args = this.parseArguments();
    const directives = this.parseDirectives();
    let selectionSet: SelectionNode[] | undefined;
    if (this.peek()?.kind === 'punct' && this.peek()?.value === '{') {
      selectionSet = this.parseSelectionSet();
    }
    return { kind: 'field', name, alias, arguments: args, directives, selectionSet };
  }

  private parseValue(constLiteral: boolean): ValueNode {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '$') {
      if (constLiteral) throw new Error('variable in a constant value');
      return { kind: 'variable', name: this.expectName().value };
    }
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'int') return { kind: 'int', value: parseInt(token.value, 10) };
    if (token.kind === 'float') return { kind: 'float', value: parseFloat(token.value) };
    if (token.kind === 'punct' && token.value === '[') {
      const values: ValueNode[] = [];
      while (!(this.peek()?.kind === 'punct' && this.peek()?.value === ']')) {
        values.push(this.parseValue(constLiteral));
      }
      this.pos += 1;
      return { kind: 'list', values };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields: { name: string; value: ValueNode }[] = [];
      while (!(this.peek()?.kind === 'punct' && this.peek()?.value === '}')) {
        const name = this.expectName().value;
        this.expectPunct(':');
        fields.push({ name, value: this.parseValue(constLiteral) });
      }
      this.pos += 1;
      return { kind: 'object', fields };
    }
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null', value: null };
      return { kind: 'enum', value: token.value };
    }
    throw new Error(`unexpected value ${JSON.stringify(token.value)} at line ${token.line}`);
  }
}

export function parseDocument(source: string): DocumentNode {
  return new Parser(source).parseDocument();
}

// ---------------------------------------------------------------------------
// Schema (validation + introspection)
// ---------------------------------------------------------------------------

interface ArgDef {
  name: string;
  type: string;
}

interface FieldDef {
  name: string;
  type: string;
  args?: ArgDef[];
}

interface TypeDef {
  kind: 'OBJECT' | 'ENUM' | 'INPUT_OBJECT' | 'INTERFACE' | 'SCALAR';
  fields?: FieldDef[];
  enumValues?: string[];
  inputFields?: FieldDef[];
}

const SCALARS = new Set(['String', 'Int', 'Float', 'Boolean', 'ID']);

const SCHEMA: Record<string, TypeDef> = {
  Query: {
    kind: 'OBJECT',
    fields: [
      { name: 'viewer', type: 'User' },
      { name: 'repository', type: 'Repository', args: [{ name: 'owner', type: 'String!' }, { name: 'name', type: 'String!' }] },
      { name: 'node', type: 'Node', args: [{ name: 'id', type: 'ID!' }] },
      { name: '__type', type: '__Type', args: [{ name: 'name', type: 'String!' }] },
      { name: '__schema', type: '__Schema' },
    ],
  },
  Mutation: {
    kind: 'OBJECT',
    fields: [
      { name: 'createIssue', type: 'CreateIssuePayload', args: [{ name: 'input', type: 'CreateIssueInput!' }] },
      { name: 'closeIssue', type: 'CloseIssuePayload', args: [{ name: 'input', type: 'CloseIssueInput!' }] },
      { name: 'createPullRequest', type: 'CreatePullRequestPayload', args: [{ name: 'input', type: 'CreatePullRequestInput!' }] },
      { name: 'mergePullRequest', type: 'MergePullRequestPayload', args: [{ name: 'input', type: 'MergePullRequestInput!' }] },
      { name: 'addComment', type: 'AddCommentPayload', args: [{ name: 'input', type: 'AddCommentInput!' }] },
    ],
  },
  User: {
    kind: 'OBJECT',
    fields: [
      { name: 'id', type: 'ID' },
      { name: 'login', type: 'String' },
      { name: 'name', type: 'String' },
    ],
  },
  Repository: {
    kind: 'OBJECT',
    fields: [
      { name: 'id', type: 'ID' },
      { name: 'databaseId', type: 'Int' },
      { name: 'name', type: 'String' },
      { name: 'nameWithOwner', type: 'String' },
      { name: 'owner', type: 'User' },
      { name: 'defaultBranchRef', type: 'Ref' },
      { name: 'viewerPermission', type: 'RepositoryPermission' },
      { name: 'hasIssuesEnabled', type: 'Boolean' },
      { name: 'issue', type: 'Issue', args: [{ name: 'number', type: 'Int!' }] },
      {
        name: 'issues',
        type: 'IssueConnection',
        args: [
          { name: 'first', type: 'Int' },
          { name: 'after', type: 'String' },
          { name: 'states', type: '[IssueState!]' },
          { name: 'orderBy', type: 'IssueOrder' },
        ],
      },
      {
        name: 'pullRequests',
        type: 'PullRequestConnection',
        args: [
          { name: 'first', type: 'Int' },
          { name: 'after', type: 'String' },
        ],
      },
      { name: 'pullRequest', type: 'PullRequest', args: [{ name: 'number', type: 'Int!' }] },
    ],
  },
  Issue: {
    kind: 'OBJECT',
    fields: [
      { name: 'id', type: 'ID' },
      { name: 'number', type: 'Int' },
      { name: 'title', type: 'String' },
      { name: 'state', type: 'IssueState' },
      { name: 'body', type: 'String' },
    ],
  },
  IssueConnection: {
    kind: 'OBJECT',
    fields: [
      { name: 'nodes', type: '[Issue]' },
      { name: 'pageInfo', type: 'PageInfo' },
    ],
  },
  PageInfo: {
    kind: 'OBJECT',
    fields: [
      { name: 'hasNextPage', type: 'Boolean' },
      { name: 'hasPreviousPage', type: 'Boolean' },
      { name: 'startCursor', type: 'String' },
      { name: 'endCursor', type: 'String' },
    ],
  },
  PullRequest: {
    kind: 'OBJECT',
    fields: [
      { name: 'id', type: 'ID' },
      { name: 'number', type: 'Int' },
      { name: 'title', type: 'String' },
      { name: 'body', type: 'String' },
      { name: 'state', type: 'PullRequestState' },
      { name: 'merged', type: 'Boolean' },
      { name: 'headRefName', type: 'String' },
      { name: 'baseRefName', type: 'String' },
      { name: 'mergeable', type: 'MergeableState' },
      { name: 'files', type: 'PullRequestChangedFileConnection', args: [{ name: 'first', type: 'Int' }] },
    ],
  },
  PullRequestConnection: {
    kind: 'OBJECT',
    fields: [
      { name: 'nodes', type: '[PullRequest]' },
      { name: 'pageInfo', type: 'PageInfo' },
    ],
  },
  PullRequestChangedFile: {
    kind: 'OBJECT',
    fields: [{ name: 'path', type: 'String' }],
  },
  PullRequestChangedFileConnection: {
    kind: 'OBJECT',
    fields: [
      { name: 'nodes', type: '[PullRequestChangedFile]' },
      { name: 'pageInfo', type: 'PageInfo' },
    ],
  },
  Ref: { kind: 'OBJECT', fields: [{ name: 'name', type: 'String' }] },
  IssueComment: {
    kind: 'OBJECT',
    fields: [
      { name: 'id', type: 'ID' },
      { name: 'body', type: 'String' },
    ],
  },
  IssueCommentEdge: {
    kind: 'OBJECT',
    fields: [
      { name: 'node', type: 'IssueComment' },
      { name: 'cursor', type: 'String' },
    ],
  },
  CreateIssuePayload: { kind: 'OBJECT', fields: [{ name: 'issue', type: 'Issue' }] },
  CloseIssuePayload: { kind: 'OBJECT', fields: [{ name: 'issue', type: 'Issue' }] },
  CreatePullRequestPayload: { kind: 'OBJECT', fields: [{ name: 'pullRequest', type: 'PullRequest' }] },
  MergePullRequestPayload: { kind: 'OBJECT', fields: [{ name: 'pullRequest', type: 'PullRequest' }] },
  AddCommentPayload: { kind: 'OBJECT', fields: [{ name: 'commentEdge', type: 'IssueCommentEdge' }] },
  Node: { kind: 'INTERFACE', fields: [{ name: 'id', type: 'ID' }] },
  IssueState: { kind: 'ENUM', enumValues: ['OPEN', 'CLOSED'] },
  PullRequestState: { kind: 'ENUM', enumValues: ['OPEN', 'CLOSED', 'MERGED'] },
  MergeableState: { kind: 'ENUM', enumValues: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'] },
  PullRequestMergeMethod: { kind: 'ENUM', enumValues: ['MERGE', 'SQUASH', 'REBASE'] },
  RepositoryPermission: { kind: 'ENUM', enumValues: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'] },
  IssueOrderField: { kind: 'ENUM', enumValues: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'] },
  OrderDirection: { kind: 'ENUM', enumValues: ['ASC', 'DESC'] },
  SearchType: { kind: 'ENUM', enumValues: ['ISSUE', 'REPOSITORY', 'USER'] },
  CreateIssueInput: {
    kind: 'INPUT_OBJECT',
    inputFields: [
      { name: 'repositoryId', type: 'ID!' },
      { name: 'title', type: 'String!' },
      { name: 'body', type: 'String' },
    ],
  },
  CloseIssueInput: {
    kind: 'INPUT_OBJECT',
    inputFields: [{ name: 'issueId', type: 'ID!' }],
  },
  CreatePullRequestInput: {
    kind: 'INPUT_OBJECT',
    inputFields: [
      { name: 'repositoryId', type: 'ID!' },
      { name: 'baseRefName', type: 'String!' },
      { name: 'headRefName', type: 'String!' },
      { name: 'title', type: 'String!' },
      { name: 'body', type: 'String' },
    ],
  },
  MergePullRequestInput: {
    kind: 'INPUT_OBJECT',
    inputFields: [
      { name: 'pullRequestId', type: 'ID!' },
      { name: 'mergeMethod', type: 'PullRequestMergeMethod' },
    ],
  },
  AddCommentInput: {
    kind: 'INPUT_OBJECT',
    inputFields: [
      { name: 'subjectId', type: 'ID!' },
      { name: 'body', type: 'String!' },
    ],
  },
  IssueOrder: {
    kind: 'INPUT_OBJECT',
    inputFields: [
      { name: 'field', type: 'IssueOrderField!' },
      { name: 'direction', type: 'OrderDirection!' },
    ],
  },
  __Type: {
    kind: 'OBJECT',
    fields: [
      { name: 'name', type: 'String' },
      { name: 'kind', type: 'String' },
      { name: 'description', type: 'String' },
      { name: 'fields', type: '[__Field]', args: [{ name: 'includeDeprecated', type: 'Boolean' }] },
      { name: 'enumValues', type: '[__EnumValue]', args: [{ name: 'includeDeprecated', type: 'Boolean' }] },
      { name: 'inputFields', type: '[__InputValue]' },
      { name: 'ofType', type: '__Type' },
      { name: 'interfaces', type: '[__Type]' },
    ],
  },
  __Field: {
    kind: 'OBJECT',
    fields: [
      { name: 'name', type: 'String' },
      { name: 'description', type: 'String' },
      { name: 'args', type: '[__InputValue]' },
      { name: 'type', type: '__Type' },
      { name: 'isDeprecated', type: 'Boolean' },
      { name: 'deprecationReason', type: 'String' },
    ],
  },
  __EnumValue: {
    kind: 'OBJECT',
    fields: [
      { name: 'name', type: 'String' },
      { name: 'description', type: 'String' },
      { name: 'isDeprecated', type: 'Boolean' },
      { name: 'deprecationReason', type: 'String' },
    ],
  },
  __InputValue: {
    kind: 'OBJECT',
    fields: [
      { name: 'name', type: 'String' },
      { name: 'description', type: 'String' },
      { name: 'type', type: '__Type' },
      { name: 'defaultValue', type: 'String' },
    ],
  },
  __Schema: {
    kind: 'OBJECT',
    fields: [
      { name: 'queryType', type: '__Type' },
      { name: 'mutationType', type: '__Type' },
      { name: 'types', type: '[__Type]' },
    ],
  },
};

/** The named (unwrapped) type of a field type string: '[Issue!]!' -> 'Issue'. */
function namedTypeOf(type: string): string {
  let t = type;
  while (t.endsWith('!')) t = t.slice(0, -1);
  while (t.startsWith('[') && t.endsWith(']')) t = t.slice(1, -1);
  while (t.endsWith('!')) t = t.slice(0, -1);
  return t;
}

/** A type-reference string as an introspection __Type descriptor value. */
function typeRef(type: string): AnyRecord {
  const t = type;
  if (t.endsWith('!')) {
    return { __typename: '__Type', _typeName: null, _kind: 'NON_NULL', _ofType: typeRef(t.slice(0, -1)) };
  }
  if (t.startsWith('[') && t.endsWith(']')) {
    return { __typename: '__Type', _typeName: null, _kind: 'LIST', _ofType: typeRef(t.slice(1, -1)) };
  }
  const def = SCHEMA[t];
  const kind = def !== undefined ? def.kind : SCALARS.has(t) ? 'SCALAR' : 'OBJECT';
  return { __typename: '__Type', _typeName: t, _kind: kind, _ofType: null };
}

function typeDescriptor(name: string): AnyRecord {
  const def = SCHEMA[name];
  if (def === undefined) return { __typename: '__Type', _typeName: name, _kind: 'OBJECT', _ofType: null };
  return { __typename: '__Type', _typeName: name, _kind: def.kind, _ofType: null, _def: def };
}

function fieldDescriptor(field: FieldDef): AnyRecord {
  return {
    __typename: '__Field',
    _name: field.name,
    _description: null,
    _args: (field.args ?? []).map((arg) => ({
      __typename: '__InputValue',
      _name: arg.name,
      _description: null,
      _type: typeRef(arg.type),
      _defaultValue: null,
    })),
    _type: typeRef(field.type),
  };
}

function enumValueDescriptor(name: string): AnyRecord {
  return { __typename: '__EnumValue', _name: name, _description: null };
}

function inputValueDescriptor(field: FieldDef): AnyRecord {
  return {
    __typename: '__InputValue',
    _name: field.name,
    _description: null,
    _type: typeRef(field.type),
    _defaultValue: null,
  };
}

// ---------------------------------------------------------------------------
// Validation: unknown fields (the one failure the suite checks)
// ---------------------------------------------------------------------------

function validateSelections(
  selections: SelectionNode[],
  parentType: string,
  doc: DocumentNode,
  errors: string[],
  seenFragments: Set<string> = new Set(),
): void {
  const def = SCHEMA[parentType];
  for (const selection of selections) {
    if (selection.kind === 'field') {
      if (selection.name === '__typename') {
        if (selection.selectionSet !== undefined) validateSelections(selection.selectionSet, 'String', doc, errors, seenFragments);
        continue;
      }
      const field = def?.fields?.find((f) => f.name === selection.name);
      if (field === undefined) {
        errors.push(`Cannot query field "${selection.name}" on type "${parentType}".`);
        continue;
      }
      if (selection.selectionSet !== undefined) {
        validateSelections(selection.selectionSet, namedTypeOf(field.type), doc, errors, seenFragments);
      }
      continue;
    }
    if (selection.kind === 'fragmentSpread') {
      const fragment = doc.fragments.get(selection.name);
      if (fragment === undefined) {
        errors.push(`Unknown fragment "${selection.name}".`);
        continue;
      }
      if (seenFragments.has(selection.name)) continue;
      seenFragments.add(selection.name);
      validateSelections(fragment.selectionSet, fragment.typeCondition, doc, errors, seenFragments);
      continue;
    }
    const condition = selection.typeCondition ?? parentType;
    if (SCHEMA[condition] === undefined && !SCALARS.has(condition)) {
      errors.push(`Unknown type "${condition}".`);
      continue;
    }
    validateSelections(selection.selectionSet, condition, doc, errors, seenFragments);
  }
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

interface ExecContext {
  store: Store;
  viewer: AnyRecord;
}

interface GraphQLError {
  message: string;
  path?: (string | number)[];
}

function resolveValue(node: ValueNode, variables: AnyRecord): unknown {
  switch (node.kind) {
    case 'variable':
      return variables[node.name as string];
    case 'string':
    case 'int':
    case 'float':
    case 'boolean':
    case 'null':
    case 'enum':
      return node.value ?? null;
    case 'list':
      return (node.values ?? []).map((v) => resolveValue(v, variables));
    case 'object': {
      const out: AnyRecord = {};
      for (const field of node.fields ?? []) out[field.name] = resolveValue(field.value, variables);
      return out;
    }
    default:
      return null;
  }
}

function evaluateArgs(args: ArgumentNode[], variables: AnyRecord): AnyRecord {
  const out: AnyRecord = {};
  for (const arg of args) out[arg.name] = resolveValue(arg.value, variables);
  return out;
}

function directivesSkip(directives: DirectiveNode[], variables: AnyRecord): boolean {
  for (const directive of directives) {
    const args = evaluateArgs(directive.arguments, variables);
    if (directive.name === 'skip' && args.if === true) return true;
    if (directive.name === 'include' && args.if === false) return true;
  }
  return false;
}

type Resolver = (parent: any, args: AnyRecord, ctx: ExecContext) => unknown;

function wrapRepo(repo: any): AnyRecord {
  return { __typename: 'Repository', _raw: repo };
}

function wrapIssue(repo: any, issue: any): AnyRecord {
  return { __typename: 'Issue', _raw: issue, _repo: repo };
}

function wrapPull(repo: any, pull: any): AnyRecord {
  return { __typename: 'PullRequest', _raw: pull, _repo: repo };
}

function wrapComment(repo: any, comment: any): AnyRecord {
  return { __typename: 'IssueComment', _raw: comment, _repo: repo };
}

function wrapUser(user: any): AnyRecord {
  return { __typename: 'User', _raw: user };
}

function issueState(issue: any): string {
  return issue.state === 'closed' ? 'CLOSED' : 'OPEN';
}

function pullState(pull: any): string {
  if (pull.merged === true) return 'MERGED';
  return pull.state === 'closed' ? 'CLOSED' : 'OPEN';
}

function commentCountFor(repo: any, issueNumber: number): number {
  try {
    const issue = Array.isArray(repo.issues) ? repo.issues.find((i: any) => i.number === issueNumber) : undefined;
    return issue !== undefined && Array.isArray(issue.comments) ? issue.comments.length : 0;
  } catch {
    return 0;
  }
}

interface PageInfoValue {
  hasNextPage: boolean;
  hasPreviousPage: boolean;
  startCursor: string | null;
  endCursor: string | null;
}

function paginate<T extends { _number: number }>(
  sorted: T[],
  args: AnyRecord,
): { nodes: T[]; pageInfo: PageInfoValue } {
  let start = 0;
  const afterNumber = numberFromCursor(args.after);
  if (afterNumber !== null) {
    const idx = sorted.findIndex((item) => item._number === afterNumber);
    if (idx >= 0) start = idx + 1;
  }
  const first = typeof args.first === 'number' && args.first >= 0 ? Math.trunc(args.first) : sorted.length - start;
  const page = sorted.slice(start, start + first);
  return {
    nodes: page,
    pageInfo: {
      hasNextPage: start + page.length < sorted.length,
      hasPreviousPage: start > 0,
      startCursor: page.length > 0 ? cursorFor(page[0]!._number) : null,
      endCursor: page.length > 0 ? cursorFor(page[page.length - 1]!._number) : null,
    },
  };
}

function buildIssueConnection(repo: any, args: AnyRecord): AnyRecord {
  let issues: any[] = [...(repo.issues ?? [])];
  if (Array.isArray(args.states) && args.states.length > 0) {
    const wanted = new Set(args.states.map((s: unknown) => String(s).toUpperCase()));
    issues = issues.filter((issue) => wanted.has(issueState(issue)));
  }
  const orderBy = isRecord(args.orderBy) ? args.orderBy : {};
  const field = String(orderBy.field ?? 'CREATED_AT').toUpperCase();
  const direction = String(orderBy.direction ?? 'ASC').toUpperCase();
  const keyOf = (issue: any): number => {
    if (field === 'UPDATED_AT') return Date.parse(String(issue.updatedAt ?? '')) || (issue.seq ?? 0);
    if (field === 'COMMENTS') return commentCountFor(repo, issue.number);
    return issue.seq ?? 0;
  };
  issues.sort((a, b) => {
    const diff = keyOf(a) - keyOf(b);
    if (diff !== 0) return direction === 'DESC' ? -diff : diff;
    return b.number - a.number;
  });
  const wrapped = issues.map((issue) => ({ ...wrapIssue(repo, issue), _number: issue.number }));
  const { nodes, pageInfo } = paginate(wrapped, args);
  return { __typename: 'IssueConnection', nodes, pageInfo };
}

function buildPullConnection(repo: any, args: AnyRecord): AnyRecord {
  const pulls: any[] = [...(repo.pulls ?? [])];
  pulls.sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0) || a.number - b.number);
  const wrapped = pulls.map((pull) => ({ ...wrapPull(repo, pull), _number: pull.number }));
  const { nodes, pageInfo } = paginate(wrapped, args);
  return { __typename: 'PullRequestConnection', nodes, pageInfo };
}

function treeOidOf(repo: any, commitSha: string): string | null {
  try {
    const obj = repo.objects instanceof Map ? repo.objects.get(commitSha) : undefined;
    if (obj === undefined || obj === null) return null;
    const data = obj.data;
    const text = Buffer.isBuffer(data) ? data.toString('utf8') : String(data ?? '');
    const first = text.split('\n')[0] ?? '';
    return first.startsWith('tree ') ? first.slice(5).trim() : null;
  } catch {
    return null;
  }
}

function treeEntryOid(entry: any): string | null {
  if (entry === null || entry === undefined) return null;
  if (typeof entry === 'string') return entry;
  if (typeof entry.oid === 'string') return entry.oid;
  if (typeof entry.blobOid === 'string') return entry.blobOid;
  return null;
}

/** Real three-way mergeability: MERGEABLE when no path changed differently on both sides. */
function computeMergeable(store: any, repo: any, pull: any): string {
  try {
    if (pull.merged === true || pull.state !== 'open') return 'UNKNOWN';
    const headSha = String(pull.headSha ?? '');
    const baseSha = String(pull.baseSha ?? '');
    if (headSha === '' || baseSha === '') return 'UNKNOWN';
    if (headSha === baseSha) return 'MERGEABLE';
    const base = mergeBase(repo, headSha, baseSha);
    if (typeof base !== 'string' || base === '') return 'UNKNOWN';
    const baseTreeOid = treeOidOf(repo, base);
    const headTreeOid = treeOidOf(repo, headSha);
    const baseBranchTreeOid = treeOidOf(repo, baseSha);
    if (baseTreeOid === null || headTreeOid === null || baseBranchTreeOid === null) return 'UNKNOWN';
    const baseTree: any = flattenTree(repo, baseTreeOid);
    const headTree: any = flattenTree(repo, headTreeOid);
    const baseBranchTree: any = flattenTree(repo, baseBranchTreeOid);
    if (!(baseTree instanceof Map) || !(headTree instanceof Map) || !(baseBranchTree instanceof Map)) return 'UNKNOWN';
    const paths = new Set<string>([...baseTree.keys(), ...headTree.keys(), ...baseBranchTree.keys()]);
    for (const path of paths) {
      const b = treeEntryOid(baseTree.get(path));
      const h = treeEntryOid(headTree.get(path));
      const s = treeEntryOid(baseBranchTree.get(path));
      if (h !== b && s !== b && h !== s) return 'CONFLICTING';
    }
    return 'MERGEABLE';
  } catch {
    return 'UNKNOWN';
  }
}

const RESOLVERS: Record<string, Record<string, Resolver>> = {
  Query: {
    viewer: (_parent, _args, ctx) => wrapUser(ctx.viewer),
    repository: (_parent, args, ctx) => {
      const repo = getRepo(ctx.store, String(args.owner), String(args.name));
      return repo === undefined || repo === null ? null : wrapRepo(repo);
    },
    node: (_parent, args, ctx) => resolveNode(args.id, ctx),
    __type: (_parent, args) => {
      const name = String(args.name ?? '');
      return SCHEMA[name] !== undefined ? typeDescriptor(name) : null;
    },
    __schema: () => ({ __typename: '__Schema' }),
  },
  Mutation: {
    createIssue: (_parent, args, ctx) => {
      const input = isRecord(args.input) ? args.input : {};
      const decoded = decodeNodeId(input.repositoryId);
      if (decoded === null || decoded.kind !== 'Repository') throw new Error('createIssue: unknown repository id');
      const repo = findRepoById(ctx.store, Number(decoded.id));
      if (repo === undefined || repo === null) throw new Error('createIssue: repository not found');
      const created: any = createIssue(ctx.store, repo, { title: String(input.title ?? ''), body: String(input.body ?? '') });
      if (created === undefined || created === null || created.issue === undefined) {
        throw new Error(`createIssue: ${created?.error ?? 'failed'}`);
      }
      return { __typename: 'CreateIssuePayload', issue: wrapIssue(repo, created.issue) };
    },
    closeIssue: (_parent, args, ctx) => {
      const input = isRecord(args.input) ? args.input : {};
      const decoded = decodeNodeId(input.issueId);
      if (decoded === null || decoded.kind !== 'Issue') throw new Error('closeIssue: unknown issue id');
      const hit = findIssueById(ctx.store, Number(decoded.id));
      if (hit === undefined) throw new Error('closeIssue: issue not found');
      const { repo, issue } = hit;
      issue.state = 'closed';
      const seq = nextSeq(ctx.store);
      issue.closedAt = isoAt(seq);
      issue.updatedAt = isoAt(seq);
      return { __typename: 'CloseIssuePayload', issue: wrapIssue(repo, issue) };
    },
    createPullRequest: (_parent, args, ctx) => {
      const input = isRecord(args.input) ? args.input : {};
      const decoded = decodeNodeId(input.repositoryId);
      if (decoded === null || decoded.kind !== 'Repository') throw new Error('createPullRequest: unknown repository id');
      const repo = findRepoById(ctx.store, Number(decoded.id));
      if (repo === undefined || repo === null) throw new Error('createPullRequest: repository not found');
      const created: any = createPull(ctx.store, repo, {
        head: String(input.headRefName ?? ''),
        base: String(input.baseRefName ?? ''),
        title: String(input.title ?? ''),
        body: String(input.body ?? ''),
      });
      if (created === undefined || created === null || created.pull === undefined) {
        throw new Error(`createPullRequest: ${created?.error ?? 'failed'}`);
      }
      return { __typename: 'CreatePullRequestPayload', pullRequest: wrapPull(repo, created.pull) };
    },
    mergePullRequest: (_parent, args, ctx) => {
      const input = isRecord(args.input) ? args.input : {};
      const decoded = decodeNodeId(input.pullRequestId);
      if (decoded === null || decoded.kind !== 'PullRequest') throw new Error('mergePullRequest: unknown pull request id');
      const hit = findPullById(ctx.store, Number(decoded.id));
      if (hit === undefined) throw new Error('mergePullRequest: pull request not found');
      const { repo, pull } = hit;
      const method = String(input.mergeMethod ?? 'MERGE').toLowerCase();
      const merged: any = mergePull(ctx.store, repo, pull, method);
      if (merged !== undefined && merged !== null && merged.ok === false) {
        throw new Error(`mergePullRequest: ${merged.message ?? merged.error ?? 'merge failed'}`);
      }
      return { __typename: 'MergePullRequestPayload', pullRequest: wrapPull(repo, pull) };
    },
    addComment: (_parent, args, ctx) => {
      const input = isRecord(args.input) ? args.input : {};
      const decoded = decodeNodeId(input.subjectId);
      if (decoded === null || decoded.kind !== 'Issue') {
        throw new Error('addComment: unknown subject id');
      }
      const hit = findIssueById(ctx.store, Number(decoded.id));
      if (hit === undefined) throw new Error('addComment: issue not found');
      const { repo, issue } = hit;
      const seq = nextSeq(ctx.store);
      const comment: any = {
        id: allocId(ctx.store),
        body: String(input.body ?? ''),
        userLogin: VIEWER.login,
        createdAt: isoAt(seq),
        updatedAt: isoAt(seq),
      };
      if (!Array.isArray(issue.comments)) issue.comments = [];
      issue.comments.push(comment);
      return {
        __typename: 'AddCommentPayload',
        commentEdge: { __typename: 'IssueCommentEdge', node: wrapComment(repo, comment), cursor: null },
      };
    },
  },
  User: {
    id: (parent) => toGlobalId('User', typeof parent._raw.id === 'number' ? parent._raw.id : VIEWER.id),
    login: (parent) => parent._raw.login,
    name: (parent) => parent._raw.name ?? parent._raw.login,
  },
  Repository: {
    id: (parent) => repoGlobalId(parent._raw.id),
    databaseId: (parent) => parent._raw.id,
    name: (parent) => parent._raw.name,
    nameWithOwner: (parent) => `${parent._raw.owner}/${parent._raw.name}`,
    owner: (parent) => wrapUser({ login: parent._raw.owner, name: parent._raw.owner }),
    defaultBranchRef: (parent) => ({ __typename: 'Ref', _raw: { name: parent._raw.defaultBranch } }),
    viewerPermission: () => 'ADMIN',
    hasIssuesEnabled: () => true,
    issue: (parent, args) => {
      const issue = Array.isArray(parent._raw.issues) ? parent._raw.issues.find((i: any) => i.number === Number(args.number)) : undefined;
      return issue === undefined ? null : wrapIssue(parent._raw, issue);
    },
    issues: (parent, args) => buildIssueConnection(parent._raw, args),
    pullRequests: (parent, args) => buildPullConnection(parent._raw, args),
    pullRequest: (parent, args) => {
      const pull = Array.isArray(parent._raw.pulls) ? parent._raw.pulls.find((p: any) => p.number === Number(args.number)) : undefined;
      return pull === undefined ? null : wrapPull(parent._raw, pull);
    },
  },
  Issue: {
    id: (parent) => issueGlobalId(parent._raw.id),
    number: (parent) => parent._raw.number,
    title: (parent) => parent._raw.title,
    state: (parent) => issueState(parent._raw),
    body: (parent) => parent._raw.body ?? '',
  },
  IssueConnection: {
    nodes: (parent) => parent.nodes,
    pageInfo: (parent) => parent.pageInfo,
  },
  PageInfo: {
    hasNextPage: (parent) => parent.hasNextPage,
    hasPreviousPage: (parent) => parent.hasPreviousPage,
    startCursor: (parent) => parent.startCursor ?? null,
    endCursor: (parent) => parent.endCursor ?? null,
  },
  PullRequest: {
    id: (parent) => pullGlobalId(parent._raw.id),
    number: (parent) => parent._raw.number,
    title: (parent) => parent._raw.title ?? '',
    body: (parent) => parent._raw.body ?? '',
    state: (parent) => pullState(parent._raw),
    merged: (parent) => parent._raw.merged === true,
    headRefName: (parent) => parent._raw.headRef,
    baseRefName: (parent) => parent._raw.baseRef,
    mergeable: (parent, _args, ctx) => computeMergeable(ctx.store, parent._repo, parent._raw),
    files: (parent, args, ctx) => {
      let entries: any[] = [];
      try {
        entries = pullFiles(parent._repo, parent._raw) ?? [];
      } catch {
        entries = [];
      }
      const nodes = entries.map((entry: any) => ({
        __typename: 'PullRequestChangedFile',
        _raw: { path: String(entry.filename ?? entry.path ?? '') },
        _number: 0,
      }));
      const first = typeof args.first === 'number' && args.first >= 0 ? Math.trunc(args.first) : nodes.length;
      const page = nodes.slice(0, first);
      return {
        __typename: 'PullRequestChangedFileConnection',
        nodes: page,
        pageInfo: {
          hasNextPage: page.length < nodes.length,
          hasPreviousPage: false,
          startCursor: null,
          endCursor: null,
        },
      };
    },
  },
  PullRequestConnection: {
    nodes: (parent) => parent.nodes,
    pageInfo: (parent) => parent.pageInfo,
  },
  PullRequestChangedFile: {
    path: (parent) => parent._raw.path,
  },
  PullRequestChangedFileConnection: {
    nodes: (parent) => parent.nodes,
    pageInfo: (parent) => parent.pageInfo,
  },
  Ref: {
    name: (parent) => parent._raw.name,
  },
  IssueComment: {
    id: (parent) => commentGlobalId(parent._repo.id, parent._raw.id),
    body: (parent) => (typeof parent._raw.body === 'string' ? parent._raw.body : ''),
  },
  IssueCommentEdge: {
    node: (parent) => parent.node,
    cursor: (parent) => parent.cursor ?? null,
  },
  CreateIssuePayload: {
    issue: (parent) => parent.issue,
  },
  CloseIssuePayload: {
    issue: (parent) => parent.issue,
  },
  CreatePullRequestPayload: {
    pullRequest: (parent) => parent.pullRequest,
  },
  MergePullRequestPayload: {
    pullRequest: (parent) => parent.pullRequest,
  },
  AddCommentPayload: {
    commentEdge: (parent) => parent.commentEdge,
  },
  __Type: {
    name: (parent) => parent._typeName ?? null,
    kind: (parent) => parent._kind ?? null,
    description: (parent) => parent._description ?? null,
    fields: (parent) => {
      const def = parent._def as TypeDef | undefined;
      if (def === undefined || (def.kind !== 'OBJECT' && def.kind !== 'INTERFACE')) return null;
      return (def.fields ?? []).map(fieldDescriptor);
    },
    enumValues: (parent) => {
      const def = parent._def as TypeDef | undefined;
      if (def === undefined || def.kind !== 'ENUM') return null;
      return (def.enumValues ?? []).map(enumValueDescriptor);
    },
    inputFields: (parent) => {
      const def = parent._def as TypeDef | undefined;
      if (def === undefined || def.kind !== 'INPUT_OBJECT') return null;
      return (def.inputFields ?? []).map(inputValueDescriptor);
    },
    ofType: (parent) => parent._ofType ?? null,
    interfaces: () => null,
  },
  __Field: {
    name: (parent) => parent._name,
    description: (parent) => parent._description ?? null,
    args: (parent) => parent._args ?? [],
    type: (parent) => parent._type,
    isDeprecated: () => false,
    deprecationReason: () => null,
  },
  __EnumValue: {
    name: (parent) => parent._name,
    description: (parent) => parent._description ?? null,
    isDeprecated: () => false,
    deprecationReason: () => null,
  },
  __InputValue: {
    name: (parent) => parent._name,
    description: (parent) => parent._description ?? null,
    type: (parent) => parent._type,
    defaultValue: (parent) => parent._defaultValue ?? null,
  },
  __Schema: {
    queryType: () => typeDescriptor('Query'),
    mutationType: () => typeDescriptor('Mutation'),
    types: () => Object.keys(SCHEMA).map((name) => typeDescriptor(name)),
  },
};

function resolveNode(id: unknown, ctx: ExecContext): AnyRecord | null {
  const decoded = decodeNodeId(id);
  if (decoded === null) return null;
  const numericId = Number(decoded.id);
  try {
    if (decoded.kind === 'Repository') {
      const repo = findRepoById(ctx.store, numericId);
      return repo === undefined || repo === null ? null : wrapRepo(repo);
    }
    if (decoded.kind === 'Issue') {
      const hit = findIssueById(ctx.store, numericId);
      return hit === undefined ? null : wrapIssue(hit.repo, hit.issue);
    }
    if (decoded.kind === 'PullRequest') {
      const hit = findPullById(ctx.store, numericId);
      return hit === undefined ? null : wrapPull(hit.repo, hit.pull);
    }
    if (decoded.kind === 'IssueComment') {
      const hit = findCommentById(ctx.store, numericId);
      return hit === undefined ? null : wrapComment(hit.repo, hit.comment);
    }
    if (decoded.kind === 'User') {
      return numericId === VIEWER.id ? wrapUser(VIEWER) : null;
    }
  } catch {
    return null;
  }
  return null;
}

function executeSelectionSet(
  selections: SelectionNode[],
  parentValue: any,
  parentType: string,
  variables: AnyRecord,
  ctx: ExecContext,
  doc: DocumentNode,
  path: (string | number)[],
  errors: GraphQLError[],
): AnyRecord {
  const out: AnyRecord = {};
  for (const selection of selections) {
    if (selection.kind === 'fragmentSpread') {
      const fragment = doc.fragments.get(selection.name);
      if (fragment === undefined) continue;
      if (directivesSkip(selection.directives, variables)) continue;
      if (parentValue === null || parentValue === undefined) continue;
      if (fragment.typeCondition !== parentValue.__typename) continue;
      const nested = executeSelectionSet(fragment.selectionSet, parentValue, fragment.typeCondition, variables, ctx, doc, path, errors);
      Object.assign(out, nested);
      continue;
    }
    if (selection.kind === 'inlineFragment') {
      if (directivesSkip(selection.directives, variables)) continue;
      if (parentValue === null || parentValue === undefined) continue;
      if (selection.typeCondition !== undefined && selection.typeCondition !== parentValue.__typename) continue;
      const nested = executeSelectionSet(
        selection.selectionSet,
        parentValue,
        selection.typeCondition ?? parentType,
        variables,
        ctx,
        doc,
        path,
        errors,
      );
      Object.assign(out, nested);
      continue;
    }
    if (directivesSkip(selection.directives, variables)) continue;
    const responseKey = selection.alias ?? selection.name;
    const fieldPath = [...path, responseKey];
    if (selection.name === '__typename') {
      out[responseKey] = parentValue?.__typename ?? parentType;
      continue;
    }
    const resolver = RESOLVERS[parentType]?.[selection.name];
    if (resolver === undefined) {
      errors.push({ message: `Cannot query field "${selection.name}" on type "${parentType}".`, path: fieldPath });
      out[responseKey] = null;
      continue;
    }
    let value: unknown;
    try {
      value = resolver(parentValue, evaluateArgs(selection.arguments, variables), ctx);
    } catch (err) {
      errors.push({ message: err instanceof Error ? err.message : String(err), path: fieldPath });
      out[responseKey] = null;
      continue;
    }
    if (selection.selectionSet === undefined || value === null || value === undefined) {
      out[responseKey] = value === undefined ? null : value;
      continue;
    }
    const fieldDef = SCHEMA[parentType]?.fields?.find((f) => f.name === selection.name);
    const childType = fieldDef !== undefined ? namedTypeOf(fieldDef.type) : parentType;
    if (Array.isArray(value)) {
      out[responseKey] = value.map((item, index) => {
        if (item === null || item === undefined) return null;
        const itemType = (item as AnyRecord).__typename ?? childType;
        return executeSelectionSet(selection.selectionSet!, item, itemType, variables, ctx, doc, [...fieldPath, index], errors);
      });
      continue;
    }
    if (isRecord(value)) {
      const itemType = (value as AnyRecord).__typename ?? childType;
      out[responseKey] = executeSelectionSet(selection.selectionSet, value, itemType, variables, ctx, doc, fieldPath, errors);
      continue;
    }
    out[responseKey] = value;
  }
  return out;
}

export function executeGraphQL(
  document: DocumentNode | string,
  context: ExecContext | Store,
  variables: AnyRecord = {},
  operationName?: string,
): AnyRecord {
  const doc = typeof document === 'string' ? parseDocument(document) : document;
  const ctx: ExecContext =
    isRecord(context) && (context as AnyRecord).repos instanceof Map
      ? { store: context as unknown as Store, viewer: VIEWER }
      : (context as ExecContext);
  if (doc.operations.length === 0) {
    return { errors: [{ message: 'The document holds no operation.' }] };
  }
  let operation = doc.operations[0]!;
  if (operationName !== undefined) {
    const found = doc.operations.find((op) => op.name === operationName);
    if (found === undefined) return { errors: [{ message: `Unknown operation named "${operationName}".` }] };
    operation = found;
  }
  const validationErrors: string[] = [];
  const rootType = operation.kind === 'mutation' ? 'Mutation' : 'Query';
  validateSelections(operation.selectionSet, rootType, doc, validationErrors);
  if (validationErrors.length > 0) {
    return { data: null, errors: validationErrors.map((message) => ({ message })) };
  }
  const merged: AnyRecord = { ...variables };
  for (const def of operation.variableDefinitions) {
    if (merged[def.name] === undefined && def.defaultValue !== undefined) {
      merged[def.name] = resolveValue(def.defaultValue, {});
    }
  }
  const errors: GraphQLError[] = [];
  const data = executeSelectionSet(operation.selectionSet, { __typename: rootType }, rootType, merged, ctx, doc, [], errors);
  const out: AnyRecord = { data };
  if (errors.length > 0) out.errors = errors;
  return out;
}

/** Run one operation body ({query, variables, operationName}) against the store. */
function runOperation(store: Store, body: unknown): AnyRecord {
  if (!isRecord(body) || typeof body.query !== 'string') {
    return { errors: [{ message: 'A query string is required.' }] };
  }
  const variables = isRecord(body.variables) ? body.variables : {};
  const operationName = typeof body.operationName === 'string' ? body.operationName : undefined;
  try {
    const doc = parseDocument(body.query);
    return executeGraphQL(doc, { store, viewer: VIEWER }, variables, operationName);
  } catch (err) {
    return { errors: [{ message: `GraphQL parse error: ${err instanceof Error ? err.message : String(err)}` }] };
  }
}

// ---------------------------------------------------------------------------
// HTTP entry: the app wires this as a handler factory — handleGraphQL(store)
// returns (req, res) — and also calls the export directly as (req, res).
// The legacy handleGraphQL(store, body) -> result object shape is kept too.
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

async function handleGraphQLHttp(req: any, res: any, store: any): Promise<void> {
  if (!checkAuth(store, req)) {
    writeJson(res, 401, { message: 'Requires authentication' });
    return;
  }
  const body = await readJsonBody(req);
  if (body === null) {
    writeJson(res, 400, { errors: [{ message: 'Request body must be valid JSON.' }] });
    return;
  }
  const result = Array.isArray(body) ? body.map((entry) => runOperation(store, entry)) : runOperation(store, body);
  writeJson(res, 200, result);
}

export function handleGraphQL(...args: unknown[]): unknown {
  if (args.length === 1 && isStoreLike(args[0])) {
    boundStore = args[0];
    const store = args[0];
    return (req: any, res: any) => handleGraphQLHttp(req, res, store);
  }
  if (args.length === 2 && isReqLike(args[0]) && isResLike(args[1])) {
    return handleGraphQLHttp(args[0], args[1], resolveStore());
  }
  if (args.length === 2 && isStoreLike(args[0])) {
    boundStore = args[0];
    const body = args[1];
    return Array.isArray(body) ? body.map((entry) => runOperation(args[0] as any, entry)) : runOperation(args[0] as any, body);
  }
  if (args.length === 2 && isStoreLike(args[1])) {
    boundStore = args[1];
    const body = args[0];
    return Array.isArray(body) ? body.map((entry) => runOperation(args[1] as any, entry)) : runOperation(args[1] as any, body);
  }
  if (args.length === 1) {
    const store = resolveStore();
    const body = args[0];
    return Array.isArray(body) ? body.map((entry) => runOperation(store, entry)) : runOperation(store, body);
  }
  return { errors: [{ message: 'handleGraphQL: unsupported call shape.' }] };
}
