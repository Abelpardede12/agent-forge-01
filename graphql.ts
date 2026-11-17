// graphql.ts — hand-written GraphQL v4 (tokenizer + parser + executor) over the in-memory store.
// Pure Node, zero dependencies. Erasable TypeScript only (type-stripped by Node 24).
import type { IncomingMessage, ServerResponse } from 'node:http';
import { ORG, STRANGER, TEAMMATE, VIEWER } from './store.ts';
import type { Comment, Issue, Label, Pull, Repo, createStore } from './store.ts';

type Store = ReturnType<typeof createStore>;
type Json = Record<string, unknown>;

// ---------------------------------------------------------------------------------------------------------
// Tokenizer
// ---------------------------------------------------------------------------------------------------------

type Tok = { kind: string; value: string; line: number; col: number };

function tokenize(src: string): Tok[] {
  const toks: Tok[] = [];
  let i = 0;
  let line = 1;
  let col = 1;
  function adv(n: number): void {
    for (let k = 0; k < n; k++) {
      if (src[i] === '\n') { line++; col = 1; } else { col++; }
      i++;
    }
  }
  while (i < src.length) {
    const ch = src[i]!;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') { adv(1); continue; }
    if (ch === '#') { while (i < src.length && src[i] !== '\n') adv(1); continue; }
    const startLine = line;
    const startCol = col;
    if (ch === '"' && src.slice(i, i + 3) === '"""') {
      let j = i + 3;
      let raw = '';
      while (j < src.length && src.slice(j, j + 3) !== '"""') { raw += src[j]; j++; }
      if (j >= src.length) throw new Error('Unterminated block string');
      raw = raw.replace(/^\r?\n/, '').replace(/\r?\n$/, '');
      adv(j + 3 - i);
      toks.push({ kind: 'string', value: raw, line: startLine, col: startCol });
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      let out = '';
      let closed = false;
      while (j < src.length) {
        const c = src[j]!;
        if (c === '"') { closed = true; break; }
        if (c === '\n') break;
        if (c === '\\') {
          const e = src[j + 1] ?? '';
          if (e === 'u') { out += String.fromCharCode(parseInt(src.slice(j + 2, j + 6), 16)); j += 6; continue; }
          const esc: Record<string, string> = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };
          out += esc[e] ?? e;
          j += 2;
          continue;
        }
        out += c;
        j++;
      }
      if (!closed) throw new Error('Unterminated string');
      adv(j + 1 - i);
      toks.push({ kind: 'string', value: out, line: startLine, col: startCol });
      continue;
    }
    if (/[0-9]/.test(ch) || (ch === '-' && /[0-9]/.test(src[i + 1] ?? ''))) {
      let j = i;
      if (src[j] === '-') j++;
      while (/[0-9]/.test(src[j] ?? '')) j++;
      let isFloat = false;
      if (src[j] === '.' && /[0-9]/.test(src[j + 1] ?? '')) {
        isFloat = true;
        j++;
        while (/[0-9]/.test(src[j] ?? '')) j++;
      }
      if (src[j] === 'e' || src[j] === 'E') {
        isFloat = true;
        j++;
        if (src[j] === '+' || src[j] === '-') j++;
        while (/[0-9]/.test(src[j] ?? '')) j++;
      }
      const raw = src.slice(i, j);
      adv(j - i);
      toks.push({ kind: isFloat ? 'float' : 'int', value: raw, line: startLine, col: startCol });
      continue;
    }
    if (/[_A-Za-z]/.test(ch)) {
      let j = i;
      while (/[_0-9A-Za-z]/.test(src[j] ?? '')) j++;
      const raw = src.slice(i, j);
      adv(j - i);
      toks.push({ kind: 'name', value: raw, line: startLine, col: startCol });
      continue;
    }
    if (src.slice(i, i + 3) === '...') {
      adv(3);
      toks.push({ kind: 'punct', value: '...', line: startLine, col: startCol });
      continue;
    }
    if ('!$&():=@[]{|}'.includes(ch)) {
      adv(1);
      toks.push({ kind: 'punct', value: ch, line: startLine, col: startCol });
      continue;
    }
    throw new Error(`Unexpected character ${JSON.stringify(ch)} at ${line}:${col}`);
  }
  toks.push({ kind: 'eof', value: '', line, col });
  return toks;
}

// ---------------------------------------------------------------------------------------------------------
// Parser (AST is plain data; all node types are erased interfaces)
// ---------------------------------------------------------------------------------------------------------

type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'int'; value: string }
  | { kind: 'float'; value: string }
  | { kind: 'string'; value: string }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: ValueNode[] }
  | { kind: 'object'; fields: { name: string; value: ValueNode }[] };

type TypeNode = { kind: string; name?: string; ofType?: TypeNode };
type VarDef = { name: string; type: TypeNode; defaultValue?: ValueNode };
type DirectiveNode = { name: string; args: { name: string; value: ValueNode }[] };
type FieldNode = {
  kind: 'field'; name: string; alias?: string;
  args: { name: string; value: ValueNode }[]; directives: DirectiveNode[]; selectionSet?: SelectionNode[];
};
type FragmentSpreadNode = { kind: 'spread'; name: string; directives: DirectiveNode[] };
type InlineFragmentNode = { kind: 'inline'; typeCondition?: string; directives: DirectiveNode[]; selectionSet: SelectionNode[] };
type SelectionNode = FieldNode | FragmentSpreadNode | InlineFragmentNode;
type OperationNode = { kind: 'operation'; op: string; name?: string; varDefs: VarDef[]; directives: DirectiveNode[]; selectionSet: SelectionNode[] };
type FragmentNode = { kind: 'fragment'; name: string; typeCondition: string; directives: DirectiveNode[]; selectionSet: SelectionNode[] };
type DefinitionNode = OperationNode | FragmentNode;

class Parser {
  toks: Tok[];
  pos = 0;
  constructor(toks: Tok[]) { this.toks = toks; }
  peek(): Tok { return this.toks[this.pos]!; }
  next(): Tok { return this.toks[this.pos++]!; }
  atPunct(v: string): boolean { const t = this.peek(); return t.kind === 'punct' && t.value === v; }
  atName(v?: string): boolean { const t = this.peek(); return t.kind === 'name' && (v === undefined || t.value === v); }
  describe(t: Tok): string { return t.kind === 'eof' ? 'end of document' : JSON.stringify(t.value); }
  expectPunct(v: string): Tok {
    if (!this.atPunct(v)) throw new Error(`Syntax error: expected "${v}" but got ${this.describe(this.peek())}`);
    return this.next();
  }
  expectName(what = 'a name'): string {
    const t = this.peek();
    if (t.kind !== 'name') throw new Error(`Syntax error: expected ${what} but got ${this.describe(t)}`);
    this.pos++;
    return t.value;
  }

  parseDocument(): DefinitionNode[] {
    const defs: DefinitionNode[] = [];
    while (this.peek().kind !== 'eof') defs.push(this.parseDefinition());
    return defs;
  }

  parseDefinition(): DefinitionNode {
    if (this.atName('fragment')) return this.parseFragment();
    if (this.atPunct('{')) return { kind: 'operation', op: 'query', varDefs: [], directives: [], selectionSet: this.parseSelectionSet() };
    if (this.atName('query') || this.atName('mutation') || this.atName('subscription')) {
      const op = this.next().value;
      let name: string | undefined;
      if (this.peek().kind === 'name') name = this.next().value;
      const varDefs = this.parseVarDefs();
      const directives = this.parseDirectives();
      return { kind: 'operation', op, name, varDefs, directives, selectionSet: this.parseSelectionSet() };
    }
    throw new Error(`Syntax error: unexpected ${this.describe(this.peek())} at the start of a definition`);
  }

  parseFragment(): FragmentNode {
    this.expectName('"fragment"');
    const name = this.expectName('a fragment name');
    this.expectName('"on"');
    const typeCondition = this.expectName('a type name');
    const directives = this.parseDirectives();
    return { kind: 'fragment', name, typeCondition, directives, selectionSet: this.parseSelectionSet() };
  }

  parseVarDefs(): VarDef[] {
    if (!this.atPunct('(')) return [];
    this.next();
    const defs: VarDef[] = [];
    while (!this.atPunct(')')) {
      this.expectPunct('$');
      const name = this.expectName('a variable name');
      this.expectPunct(':');
      const type = this.parseType();
      let defaultValue: ValueNode | undefined;
      if (this.atPunct('=')) { this.next(); defaultValue = this.parseValue(); }
      defs.push({ name, type, defaultValue });
    }
    this.expectPunct(')');
    return defs;
  }

  parseType(): TypeNode {
    let type: TypeNode;
    if (this.atPunct('[')) {
      this.next();
      const inner = this.parseType();
      this.expectPunct(']');
      type = { kind: 'list', ofType: inner };
    } else {
      type = { kind: 'named', name: this.expectName('a type name') };
    }
    if (this.atPunct('!')) { this.next(); type = { kind: 'nonnull', ofType: type }; }
    return type;
  }

  parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const sels: SelectionNode[] = [];
    while (!this.atPunct('}')) sels.push(this.parseSelection());
    this.expectPunct('}');
    return sels;
  }

  parseSelection(): SelectionNode {
    if (this.atPunct('...')) {
      this.next();
      if (this.atName('on')) {
        this.next();
        const typeCondition = this.expectName('a type name');
        const directives = this.parseDirectives();
        return { kind: 'inline', typeCondition, directives, selectionSet: this.parseSelectionSet() };
      }
      if (this.peek().kind === 'name') {
        const name = this.next().value;
        const directives = this.parseDirectives();
        return { kind: 'spread', name, directives };
      }
      const directives = this.parseDirectives();
      return { kind: 'inline', directives, selectionSet: this.parseSelectionSet() };
    }
    const first = this.expectName('a field name');
    let name = first;
    let alias: string | undefined;
    if (this.atPunct(':')) {
      this.next();
      alias = first;
      name = this.expectName('a field name');
    }
    const args = this.parseArguments();
    const directives = this.parseDirectives();
    let selectionSet: SelectionNode[] | undefined;
    if (this.atPunct('{')) selectionSet = this.parseSelectionSet();
    return { kind: 'field', name, alias, args, directives, selectionSet };
  }

  parseArguments(): { name: string; value: ValueNode }[] {
    if (!this.atPunct('(')) return [];
    this.next();
    const args: { name: string; value: ValueNode }[] = [];
    while (!this.atPunct(')')) {
      const name = this.expectName('an argument name');
      this.expectPunct(':');
      args.push({ name, value: this.parseValue() });
    }
    this.expectPunct(')');
    return args;
  }

  parseDirectives(): DirectiveNode[] {
    const dirs: DirectiveNode[] = [];
    while (this.atPunct('@')) {
      this.next();
      const name = this.expectName('a directive name');
      dirs.push({ name, args: this.parseArguments() });
    }
    return dirs;
  }

  parseValue(): ValueNode {
    const t = this.peek();
    if (this.atPunct('$')) {
      this.next();
      return { kind: 'variable', name: this.expectName('a variable name') };
    }
    if (this.atPunct('[')) {
      this.next();
      const values: ValueNode[] = [];
      while (!this.atPunct(']')) values.push(this.parseValue());
      this.expectPunct(']');
      return { kind: 'list', values };
    }
    if (this.atPunct('{')) {
      this.next();
      const fields: { name: string; value: ValueNode }[] = [];
      while (!this.atPunct('}')) {
        const name = this.expectName('an object field name');
        this.expectPunct(':');
        fields.push({ name, value: this.parseValue() });
      }
      this.expectPunct('}');
      return { kind: 'object', fields };
    }
    if (t.kind === 'int') { this.next(); return { kind: 'int', value: t.value }; }
    if (t.kind === 'float') { this.next(); return { kind: 'float', value: t.value }; }
    if (t.kind === 'string') { this.next(); return { kind: 'string', value: t.value }; }
    if (t.kind === 'name') {
      this.next();
      if (t.value === 'true') return { kind: 'boolean', value: true };
      if (t.value === 'false') return { kind: 'boolean', value: false };
      if (t.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: t.value };
    }
    throw new Error(`Syntax error: unexpected ${this.describe(t)} as a value`);
  }
}

// ---------------------------------------------------------------------------------------------------------
// Schema tables (drives validation, introspection, and the field resolvers below)
// ---------------------------------------------------------------------------------------------------------

const TYPE_FIELDS: Record<string, string[]> = {
  Query: ['viewer', 'repository', 'node', 'user', 'organization', '__schema', '__type'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'description', 'isPrivate', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'createdAt', 'updatedAt', 'url', 'issue', 'issues', 'pullRequest', 'pullRequests', 'labels'],
  Issue: ['id', 'databaseId', 'number', 'title', 'body', 'state', 'author', 'labels', 'comments', 'createdAt', 'updatedAt', 'url'],
  PullRequest: ['id', 'databaseId', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName', 'author', 'createdAt', 'updatedAt', 'url', 'files'],
  User: ['login', 'id', 'name', 'email'],
  Organization: ['login', 'id', 'name'],
  Ref: ['name'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  IssueConnection: ['edges', 'nodes', 'totalCount', 'pageInfo'],
  IssueEdge: ['cursor', 'node'],
  PullRequestConnection: ['edges', 'nodes', 'totalCount', 'pageInfo'],
  PullRequestEdge: ['cursor', 'node'],
  IssueCommentConnection: ['edges', 'nodes', 'totalCount', 'pageInfo'],
  IssueCommentEdge: ['cursor', 'node'],
  IssueComment: ['id', 'databaseId', 'body', 'author', 'createdAt', 'updatedAt', 'url'],
  Label: ['id', 'name', 'color', 'description'],
  LabelConnection: ['edges', 'nodes', 'totalCount', 'pageInfo'],
  LabelEdge: ['cursor', 'node'],
  PullRequestChangedFile: ['path', 'additions', 'deletions', 'changeType'],
  PullRequestChangedFileConnection: ['edges', 'nodes', 'totalCount', 'pageInfo'],
  PullRequestChangedFileEdge: ['cursor', 'node'],
  CreateIssuePayload: ['issue', 'clientMutationId'],
  CloseIssuePayload: ['issue', 'clientMutationId'],
  CreatePullRequestPayload: ['pullRequest', 'clientMutationId'],
  MergePullRequestPayload: ['pullRequest', 'clientMutationId'],
  AddCommentPayload: ['commentEdge', 'clientMutationId'],
  __Schema: ['queryType', 'mutationType', 'subscriptionType', 'types', 'directives'],
  __Type: ['name', 'kind', 'description', 'fields', 'enumValues', 'inputFields', 'interfaces', 'possibleTypes'],
  __Field: ['name', 'description', 'args', 'type', 'isDeprecated', 'deprecationReason'],
  __EnumValue: ['name', 'description', 'isDeprecated', 'deprecationReason'],
  __InputValue: ['name', 'description', 'type', 'defaultValue'],
};

const TYPE_KIND: Record<string, string> = {
  Query: 'OBJECT', Mutation: 'OBJECT', Repository: 'OBJECT', Issue: 'OBJECT', PullRequest: 'OBJECT',
  User: 'OBJECT', Organization: 'OBJECT', Ref: 'OBJECT', PageInfo: 'OBJECT',
  IssueConnection: 'OBJECT', IssueEdge: 'OBJECT', PullRequestConnection: 'OBJECT', PullRequestEdge: 'OBJECT',
  IssueCommentConnection: 'OBJECT', IssueCommentEdge: 'OBJECT', IssueComment: 'OBJECT',
  Label: 'OBJECT', LabelConnection: 'OBJECT', LabelEdge: 'OBJECT',
  PullRequestChangedFile: 'OBJECT', PullRequestChangedFileConnection: 'OBJECT', PullRequestChangedFileEdge: 'OBJECT',
  CreateIssuePayload: 'OBJECT', CloseIssuePayload: 'OBJECT', CreatePullRequestPayload: 'OBJECT',
  MergePullRequestPayload: 'OBJECT', AddCommentPayload: 'OBJECT',
  __Schema: 'OBJECT', __Type: 'OBJECT', __Field: 'OBJECT', __EnumValue: 'OBJECT', __InputValue: 'OBJECT',
  IssueState: 'ENUM', PullRequestState: 'ENUM', MergeableState: 'ENUM', OrderDirection: 'ENUM',
  IssueOrderField: 'ENUM', PullRequestOrderField: 'ENUM', SearchType: 'ENUM',
  RepositoryPermission: 'ENUM', PullRequestMergeMethod: 'ENUM',
  String: 'SCALAR', Int: 'SCALAR', Float: 'SCALAR', Boolean: 'SCALAR', ID: 'SCALAR',
  CreateIssueInput: 'INPUT_OBJECT', CloseIssueInput: 'INPUT_OBJECT', CreatePullRequestInput: 'INPUT_OBJECT',
  MergePullRequestInput: 'INPUT_OBJECT', AddCommentInput: 'INPUT_OBJECT',
};

const ENUM_VALUES: Record<string, string[]> = {
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  OrderDirection: ['ASC', 'DESC'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'NUMBER', 'COMMENTS'],
  PullRequestOrderField: ['CREATED_AT', 'UPDATED_AT'],
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'ORGANIZATION', 'CODE', 'DISCUSSION', 'COMMIT'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
};

const FIELD_ARGS: Record<string, string[]> = {
  'Query.repository': ['owner', 'name'],
  'Query.node': ['id'],
  'Query.user': ['login'],
  'Query.organization': ['login'],
  'Query.__type': ['name'],
  'Repository.issue': ['number'],
  'Repository.issues': ['first', 'after', 'states', 'orderBy', 'last', 'before'],
  'Repository.pullRequest': ['number'],
  'Repository.pullRequests': ['first', 'after', 'states', 'orderBy', 'last', 'before'],
  'Repository.labels': ['first', 'after'],
  'Issue.labels': ['first', 'after'],
  'Issue.comments': ['first', 'after'],
  'PullRequest.files': ['first', 'after'],
  'Mutation.createIssue': ['input'],
  'Mutation.closeIssue': ['input'],
  'Mutation.createPullRequest': ['input'],
  'Mutation.mergePullRequest': ['input'],
  'Mutation.addComment': ['input'],
  '__Type.fields': ['includeDeprecated'],
  '__Type.enumValues': ['includeDeprecated'],
};

const NODE_TYPES = ['Repository', 'Issue', 'PullRequest', 'User', 'IssueComment'];
const CONNECTION_TYPES: Record<string, string> = {
  IssueConnection: 'IssueEdge',
  PullRequestConnection: 'PullRequestEdge',
  IssueCommentConnection: 'IssueCommentEdge',
  LabelConnection: 'LabelEdge',
  PullRequestChangedFileConnection: 'PullRequestChangedFileEdge',
};

// ---------------------------------------------------------------------------------------------------------
// Global ids, cursors, pagination
// ---------------------------------------------------------------------------------------------------------

function gid(type: string, dbid: number | string): string {
  return Buffer.from(`${type}:${dbid}`).toString('base64');
}

function parseGid(id: unknown): { type: string; dbid: string } | null {
  if (typeof id !== 'string' || id === '') return null;
  let raw = '';
  try { raw = Buffer.from(id, 'base64').toString('utf8'); } catch { return null; }
  const m = /^([A-Za-z]+):(.+)$/.exec(raw);
  if (!m) return null;
  return { type: m[1]!, dbid: m[2]! };
}

function cursorOf(index: number): string {
  return Buffer.from(String(index)).toString('base64');
}

function parseCursor(c: unknown): number | null {
  if (typeof c !== 'string' || c === '') return null;
  let raw = '';
  try { raw = Buffer.from(c, 'base64').toString('utf8'); } catch { return null; }
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : null;
}

type Page<T> = {
  slice: T[]; cursors: string[]; total: number;
  hasNextPage: boolean; hasPreviousPage: boolean; startCursor: string | null; endCursor: string | null;
};

function paginate<T>(items: T[], args: Record<string, unknown>): Page<T> {
  const total = items.length;
  let start = 0;
  const after = parseCursor(args.after);
  if (after !== null) start = Math.min(after + 1, total);
  let end = total;
  if (typeof args.first === 'number' && Number.isFinite(args.first)) end = Math.min(total, start + Math.max(0, Math.floor(args.first)));
  if (typeof args.last === 'number' && Number.isFinite(args.last)) start = Math.max(start, end - Math.max(0, Math.floor(args.last)));
  const slice = items.slice(start, end);
  const cursors = slice.map((_, k) => cursorOf(start + k));
  return {
    slice, cursors, total,
    hasNextPage: end < total,
    hasPreviousPage: start > 0,
    startCursor: cursors.length > 0 ? cursors[0]! : null,
    endCursor: cursors.length > 0 ? cursors[cursors.length - 1]! : null,
  };
}

// ---------------------------------------------------------------------------------------------------------
// Executor
// ---------------------------------------------------------------------------------------------------------

type Obj = { __type: string; [k: string]: unknown };
type GqlError = { message: string; path: (string | number)[] };
type Ctx = {
  store: Store;
  vars: Record<string, unknown>;
  errors: GqlError[];
  fragments: Map<string, FragmentNode>;
};

function typeMatches(parentType: string, condition: string): boolean {
  if (parentType === condition) return true;
  if (condition === 'Node') return NODE_TYPES.includes(parentType);
  return false;
}

function resolveValue(node: ValueNode, vars: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'variable': return vars[node.name];
    case 'int': return parseInt(node.value, 10);
    case 'float': return parseFloat(node.value);
    case 'string': return node.value;
    case 'boolean': return node.value;
    case 'null': return null;
    case 'enum': return node.value;
    case 'list': return node.values.map((v) => resolveValue(v, vars));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const f of node.fields) out[f.name] = resolveValue(f.value, vars);
      return out;
    }
  }
}

function directiveActive(directives: DirectiveNode[], ctx: Ctx): boolean {
  for (const d of directives) {
    if (d.name !== 'skip' && d.name !== 'include') continue;
    const arg = d.args.find((a) => a.name === 'if');
    const value = arg ? resolveValue(arg.value, ctx.vars) : undefined;
    if (d.name === 'skip' && value === true) return false;
    if (d.name === 'include' && value === false) return false;
  }
  return true;
}

type Resolver = (ctx: Ctx, parent: Obj, args: Record<string, unknown>) => unknown;

function execField(field: FieldNode, parent: Obj, ctx: Ctx, path: (string | number)[]): unknown {
  const key = field.alias ?? field.name;
  const fieldPath = [...path, key];
  if (field.name === '__typename') return parent.__type;
  const resolvers = RESOLVERS[parent.__type];
  const resolve = resolvers ? resolvers[field.name] : undefined;
  if (!resolve) {
    ctx.errors.push({ message: `Cannot query field "${field.name}" on type "${parent.__type}".`, path: fieldPath });
    return null;
  }
  const allowed = FIELD_ARGS[`${parent.__type}.${field.name}`] ?? [];
  for (const a of field.args) {
    if (!allowed.includes(a.name)) {
      ctx.errors.push({ message: `Unknown argument "${a.name}" on field "${parent.__type}.${field.name}".`, path: fieldPath });
      return null;
    }
  }
  const args: Record<string, unknown> = {};
  for (const a of field.args) args[a.name] = resolveValue(a.value, ctx.vars);
  let value: unknown;
  try {
    value = resolve(ctx, parent, args);
  } catch (e) {
    ctx.errors.push({ message: e instanceof Error ? e.message : String(e), path: fieldPath });
    return null;
  }
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) {
    return value.map((entry, idx) => {
      if (entry !== null && typeof entry === 'object' && '__type' in (entry as Record<string, unknown>)) {
        if (!field.selectionSet) {
          ctx.errors.push({ message: `Field "${field.name}" of type "${parent.__type}" must have a selection of subfields.`, path: [...fieldPath, idx] });
          return null;
        }
        return execSel(field.selectionSet, entry as Obj, ctx, [...fieldPath, idx]);
      }
      return entry;
    });
  }
  if (typeof value === 'object' && '__type' in (value as Record<string, unknown>)) {
    if (!field.selectionSet) {
      ctx.errors.push({ message: `Field "${field.name}" of type "${parent.__type}" must have a selection of subfields.`, path: fieldPath });
      return null;
    }
    return execSel(field.selectionSet, value as Obj, ctx, fieldPath);
  }
  return value;
}

function execSel(selections: SelectionNode[], parent: Obj, ctx: Ctx, path: (string | number)[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const sel of selections) {
    if (sel.kind === 'field') {
      if (!directiveActive(sel.directives, ctx)) continue;
      out[sel.alias ?? sel.name] = execField(sel, parent, ctx, path);
    } else if (sel.kind === 'spread') {
      if (!directiveActive(sel.directives, ctx)) continue;
      const frag = ctx.fragments.get(sel.name);
      if (!frag) { ctx.errors.push({ message: `Unknown fragment "${sel.name}".`, path }); continue; }
      if (!typeMatches(parent.__type, frag.typeCondition)) continue;
      Object.assign(out, execSel(frag.selectionSet, parent, ctx, path));
    } else {
      if (!directiveActive(sel.directives, ctx)) continue;
      if (sel.typeCondition && !typeMatches(parent.__type, sel.typeCondition)) continue;
      Object.assign(out, execSel(sel.selectionSet, parent, ctx, path));
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------
// Object wrappers + store lookups
// ---------------------------------------------------------------------------------------------------------

function userObj(login: string, id: number, name?: string, email?: string): Obj {
  return { __type: 'User', _login: login, _id: id, _name: name ?? login, _email: email ?? '' };
}

function viewerObj(): Obj {
  return userObj(VIEWER.login, VIEWER.id, VIEWER.name, VIEWER.email);
}

function repoObj(repo: Repo): Obj {
  return { __type: 'Repository', _repo: repo };
}

function issueObj(repo: Repo, issue: Issue): Obj {
  return { __type: 'Issue', _repo: repo, _issue: issue };
}

function pullObj(repo: Repo, pull: Pull): Obj {
  return { __type: 'PullRequest', _repo: repo, _pull: pull };
}

function commentObj(repo: Repo, issue: Issue, comment: Comment): Obj {
  return { __type: 'IssueComment', _repo: repo, _issue: issue, _comment: comment };
}

function labelObj(repo: Repo, label: Label): Obj {
  return { __type: 'Label', _repo: repo, _label: label };
}

function typeObj(name: string): Obj {
  return {
    __type: '__Type', _name: name, _kind: TYPE_KIND[name] ?? 'OBJECT',
    _fields: TYPE_FIELDS[name] ?? null, _enumValues: ENUM_VALUES[name] ?? null,
  };
}

function findRepoByDbId(store: Store, dbid: string): Repo | undefined {
  const id = Number(dbid);
  if (!Number.isInteger(id)) return undefined;
  return store.listRepos().find((r) => r.id === id);
}

function findIssueByDbId(store: Store, dbid: string): { repo: Repo; issue: Issue } | undefined {
  const id = Number(dbid);
  if (!Number.isInteger(id)) return undefined;
  for (const repo of store.listRepos()) {
    const issue = store.getIssue(repo, id);
    if (issue) return { repo, issue };
  }
  return undefined;
}

function findPullByDbId(store: Store, dbid: string): { repo: Repo; pull: Pull } | undefined {
  const id = Number(dbid);
  if (!Number.isInteger(id)) return undefined;
  for (const repo of store.listRepos()) {
    const pull = store.getPull(repo, id);
    if (pull) return { repo, pull };
  }
  return undefined;
}

function findCommentByDbId(store: Store, dbid: string): { repo: Repo; issue: Issue; comment: Comment } | undefined {
  const id = Number(dbid);
  if (!Number.isInteger(id)) return undefined;
  for (const repo of store.listRepos()) {
    for (const issue of store.listIssues(repo)) {
      const comment = issue.comments.find((c) => c.id === id);
      if (comment) return { repo, issue, comment };
    }
  }
  return undefined;
}

function issueState(issue: Issue): string {
  return issue.state === 'closed' ? 'CLOSED' : 'OPEN';
}

function pullState(pull: Pull): string {
  if (pull.merged) return 'MERGED';
  return pull.state === 'closed' ? 'CLOSED' : 'OPEN';
}

function sortBy<T>(items: T[], orderBy: unknown, keyFn: (item: T, field: string) => number | string, tieFn: (a: T, b: T) => number): T[] {
  const ob = orderBy && typeof orderBy === 'object' ? orderBy as Record<string, unknown> : {};
  const field = typeof ob.field === 'string' ? ob.field : 'CREATED_AT';
  const dir = ob.direction === 'ASC' ? 1 : -1;
  return [...items].sort((a, b) => {
    const ka = keyFn(a, field);
    const kb = keyFn(b, field);
    if (ka < kb) return -1 * dir;
    if (ka > kb) return 1 * dir;
    return tieFn(a, b) * dir;
  });
}

function connectionObj(type: string, items: Obj[], page: Page<Obj>): Obj {
  return {
    __type: type, _items: page.slice, _cursors: page.cursors, _total: page.total,
    _hasNextPage: page.hasNextPage, _hasPreviousPage: page.hasPreviousPage,
    _startCursor: page.startCursor, _endCursor: page.endCursor,
  };
}

function connectionResolvers(): Record<string, Resolver> {
  return {
    nodes: (_ctx, parent) => parent._items as Obj[],
    edges: (_ctx, parent) => {
      const items = parent._items as Obj[];
      const cursors = parent._cursors as string[];
      const edgeType = CONNECTION_TYPES[parent.__type] ?? 'IssueEdge';
      return items.map((node, idx) => ({ __type: edgeType, _cursor: cursors[idx], _node: node }));
    },
    totalCount: (_ctx, parent) => parent._total as number,
    pageInfo: (_ctx, parent) => ({
      __type: 'PageInfo',
      _hasNextPage: parent._hasNextPage as boolean,
      _hasPreviousPage: parent._hasPreviousPage as boolean,
      _startCursor: parent._startCursor as string | null,
      _endCursor: parent._endCursor as string | null,
    }),
  };
}

// ---------------------------------------------------------------------------------------------------------
// Field resolvers
// ---------------------------------------------------------------------------------------------------------

function clientMutationIdOf(input: Record<string, unknown>): string | null {
  return typeof input.clientMutationId === 'string' ? input.clientMutationId : null;
}

function inputObject(args: Record<string, unknown>): Record<string, unknown> {
  const input = args.input;
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('This mutation requires an input object');
  return input as Record<string, unknown>;
}

const RESOLVERS: Record<string, Record<string, Resolver>> = {
  Query: {
    viewer: () => viewerObj(),
    repository: (ctx, _parent, args) => {
      if (typeof args.owner !== 'string' || typeof args.name !== 'string') throw new Error('repository requires owner and name arguments');
      const repo = ctx.store.getRepo(args.owner, args.name);
      return repo ? repoObj(repo) : null;
    },
    node: (ctx, _parent, args) => {
      const parsed = parseGid(args.id);
      if (!parsed) return null;
      if (parsed.type === 'Repository') {
        const repo = findRepoByDbId(ctx.store, parsed.dbid);
        return repo ? repoObj(repo) : null;
      }
      if (parsed.type === 'Issue') {
        const found = findIssueByDbId(ctx.store, parsed.dbid);
        return found ? issueObj(found.repo, found.issue) : null;
      }
      if (parsed.type === 'PullRequest') {
        const found = findPullByDbId(ctx.store, parsed.dbid);
        return found ? pullObj(found.repo, found.pull) : null;
      }
      if (parsed.type === 'User') {
        const id = Number(parsed.dbid);
        if (id === VIEWER.id) return viewerObj();
        if (id === TEAMMATE.id) return userObj(TEAMMATE.login, TEAMMATE.id);
        if (id === STRANGER.id) return userObj(STRANGER.login, STRANGER.id);
        return null;
      }
      if (parsed.type === 'IssueComment') {
        const found = findCommentByDbId(ctx.store, parsed.dbid);
        return found ? commentObj(found.repo, found.issue, found.comment) : null;
      }
      return null;
    },
    user: (_ctx, _parent, args) => {
      if (typeof args.login !== 'string') throw new Error('user requires a login argument');
      if (args.login === VIEWER.login) return viewerObj();
      if (args.login === TEAMMATE.login) return userObj(TEAMMATE.login, TEAMMATE.id);
      if (args.login === STRANGER.login) return userObj(STRANGER.login, STRANGER.id);
      return null;
    },
    organization: (_ctx, _parent, args) => {
      if (typeof args.login !== 'string') throw new Error('organization requires a login argument');
      if (args.login === ORG) return { __type: 'Organization', _login: ORG, _id: 2000, _name: ORG };
      return null;
    },
    __type: (_ctx, _parent, args) => {
      if (typeof args.name !== 'string') throw new Error('__type requires a name argument');
      return TYPE_FIELDS[args.name] || ENUM_VALUES[args.name] ? typeObj(args.name) : null;
    },
    __schema: () => ({ __type: '__Schema' }),
  },

  Mutation: {
    createIssue: (ctx, _parent, args) => {
      const input = inputObject(args);
      const parsed = parseGid(input.repositoryId);
      const repo = parsed ? findRepoByDbId(ctx.store, parsed.dbid) : undefined;
      if (!repo) throw new Error('Repository not found');
      if (typeof input.title !== 'string' || input.title === '') throw new Error('createIssue requires a title');
      const issue = ctx.store.createIssue(repo, {
        title: input.title,
        body: typeof input.body === 'string' ? input.body : undefined,
      });
      return { __type: 'CreateIssuePayload', _issue: issueObj(repo, issue), _clientMutationId: clientMutationIdOf(input) };
    },
    closeIssue: (ctx, _parent, args) => {
      const input = inputObject(args);
      const parsed = parseGid(input.issueId);
      const found = parsed && parsed.type === 'Issue' ? findIssueByDbId(ctx.store, parsed.dbid) : undefined;
      if (!found) throw new Error('Issue not found');
      const closed = ctx.store.updateIssue(found.repo, found.issue.number, { state: 'closed' });
      if (!closed) throw new Error('Issue not found');
      return { __type: 'CloseIssuePayload', _issue: issueObj(found.repo, closed), _clientMutationId: clientMutationIdOf(input) };
    },
    createPullRequest: (ctx, _parent, args) => {
      const input = inputObject(args);
      const parsed = parseGid(input.repositoryId);
      const repo = parsed ? findRepoByDbId(ctx.store, parsed.dbid) : undefined;
      if (!repo) throw new Error('Repository not found');
      if (typeof input.title !== 'string' || input.title === '') throw new Error('createPullRequest requires a title');
      if (typeof input.baseRefName !== 'string' || typeof input.headRefName !== 'string') {
        throw new Error('createPullRequest requires baseRefName and headRefName');
      }
      const pull = ctx.store.createPull(repo, {
        title: input.title,
        body: typeof input.body === 'string' ? input.body : undefined,
        head: input.headRefName,
        base: input.baseRefName,
      });
      return { __type: 'CreatePullRequestPayload', _pull: pullObj(repo, pull), _clientMutationId: clientMutationIdOf(input) };
    },
    mergePullRequest: (ctx, _parent, args) => {
      const input = inputObject(args);
      const parsed = parseGid(input.pullRequestId);
      const found = parsed && parsed.type === 'PullRequest' ? findPullByDbId(ctx.store, parsed.dbid) : undefined;
      if (!found) throw new Error('Pull request not found');
      const methodRaw = typeof input.mergeMethod === 'string' ? input.mergeMethod.toLowerCase() : 'merge';
      const method = methodRaw === 'squash' ? 'squash' : methodRaw === 'rebase' ? 'rebase' : 'merge';
      ctx.store.mergePull(found.repo, found.pull.number, method);
      const pull = ctx.store.getPull(found.repo, found.pull.number);
      if (!pull) throw new Error('Pull request not found');
      return { __type: 'MergePullRequestPayload', _pull: pullObj(found.repo, pull), _clientMutationId: clientMutationIdOf(input) };
    },
    addComment: (ctx, _parent, args) => {
      const input = inputObject(args);
      const parsed = parseGid(input.subjectId);
      if (typeof input.body !== 'string' || input.body === '') throw new Error('addComment requires a body');
      let target: { repo: Repo; issue: Issue } | undefined;
      if (parsed && parsed.type === 'Issue') target = findIssueByDbId(ctx.store, parsed.dbid);
      if (!target && parsed && parsed.type === 'PullRequest') {
        const found = findPullByDbId(ctx.store, parsed.dbid);
        if (found) {
          const issue = ctx.store.getIssue(found.repo, found.pull.number);
          if (issue) target = { repo: found.repo, issue };
        }
      }
      if (!target) throw new Error('Subject not found');
      const comment = ctx.store.createComment(target.repo, target.issue.number, input.body);
      if (!comment) throw new Error('Subject not found');
      const node = commentObj(target.repo, target.issue, comment);
      return {
        __type: 'AddCommentPayload',
        _edge: { __type: 'IssueCommentEdge', _cursor: cursorOf(0), _node: node },
        _clientMutationId: clientMutationIdOf(input),
      };
    },
  },

  Repository: {
    id: (_ctx, parent) => gid('Repository', (parent._repo as Repo).id),
    databaseId: (_ctx, parent) => (parent._repo as Repo).id,
    name: (_ctx, parent) => (parent._repo as Repo).name,
    nameWithOwner: (_ctx, parent) => (parent._repo as Repo).full_name,
    owner: (_ctx, parent) => {
      const repo = parent._repo as Repo;
      if (repo.owner === VIEWER.login) return viewerObj();
      if (repo.owner === ORG) return userObj(ORG, 2000, ORG);
      return userObj(repo.owner, 0);
    },
    description: (_ctx, parent) => (parent._repo as Repo).description,
    isPrivate: (_ctx, parent) => (parent._repo as Repo).private,
    defaultBranchRef: (_ctx, parent) => ({ __type: 'Ref', _name: (parent._repo as Repo).default_branch }),
    viewerPermission: () => 'ADMIN',
    hasIssuesEnabled: () => true,
    createdAt: (_ctx, parent) => (parent._repo as Repo).created_at,
    updatedAt: (_ctx, parent) => (parent._repo as Repo).updated_at,
    url: (_ctx, parent) => `https://github.com/${(parent._repo as Repo).full_name}`,
    issue: (ctx, parent, args) => {
      const repo = parent._repo as Repo;
      if (typeof args.number !== 'number') throw new Error('issue requires a number argument');
      const issue = ctx.store.getIssue(repo, args.number);
      return issue ? issueObj(repo, issue) : null;
    },
    issues: (ctx, parent, args) => {
      const repo = parent._repo as Repo;
      let list = ctx.store.listIssues(repo);
      if (Array.isArray(args.states)) {
        const want = new Set(args.states.map((s) => String(s).toLowerCase()));
        list = list.filter((i) => want.has(i.state));
      }
      list = sortBy(list, args.orderBy, (i, f) => (f === 'NUMBER' ? i.number : f === 'UPDATED_AT' ? i.updated_at : f === 'COMMENTS' ? i.comments.length : i.created_at), (a, b) => a.number - b.number);
      const page = paginate(list.map((i) => issueObj(repo, i)), args);
      return connectionObj('IssueConnection', page.slice, page);
    },
    pullRequest: (ctx, parent, args) => {
      const repo = parent._repo as Repo;
      if (typeof args.number !== 'number') throw new Error('pullRequest requires a number argument');
      const pull = ctx.store.getPull(repo, args.number);
      return pull ? pullObj(repo, pull) : null;
    },
    pullRequests: (ctx, parent, args) => {
      const repo = parent._repo as Repo;
      let list = ctx.store.listPulls(repo);
      if (Array.isArray(args.states)) {
        const want = new Set(args.states.map((s) => String(s).toUpperCase()));
        list = list.filter((p) => want.has(pullState(p)));
      } else {
        list = list.filter((p) => p.state === 'open');
      }
      list = sortBy(list, args.orderBy, (p, f) => (f === 'NUMBER' ? p.number : f === 'UPDATED_AT' ? p.updated_at : p.created_at), (a, b) => a.number - b.number);
      const page = paginate(list.map((p) => pullObj(repo, p)), args);
      return connectionObj('PullRequestConnection', page.slice, page);
    },
    labels: (ctx, parent, args) => {
      const repo = parent._repo as Repo;
      const page = paginate(ctx.store.listLabels(repo).map((l) => labelObj(repo, l)), args);
      return connectionObj('LabelConnection', page.slice, page);
    },
  },

  Issue: {
    id: (_ctx, parent) => gid('Issue', (parent._issue as Issue).id),
    databaseId: (_ctx, parent) => (parent._issue as Issue).id,
    number: (_ctx, parent) => (parent._issue as Issue).number,
    title: (_ctx, parent) => (parent._issue as Issue).title,
    body: (_ctx, parent) => (parent._issue as Issue).body,
    state: (_ctx, parent) => issueState(parent._issue as Issue),
    author: (_ctx, parent) => {
      const u = (parent._issue as Issue).user;
      return userObj(u.login, u.id);
    },
    labels: (ctx, parent, args) => {
      const repo = parent._repo as Repo;
      const issue = parent._issue as Issue;
      const byName = new Map(ctx.store.listLabels(repo).map((l) => [l.name, l]));
      const labels = issue.labels.map((name) => labelObj(repo, byName.get(name) ?? { name, color: 'ededed', description: '' }));
      const page = paginate(labels, args);
      return connectionObj('LabelConnection', page.slice, page);
    },
    comments: (ctx, parent, args) => {
      const repo = parent._repo as Repo;
      const issue = parent._issue as Issue;
      const page = paginate(ctx.store.listComments(repo, issue.number).map((c) => commentObj(repo, issue, c)), args);
      return connectionObj('IssueCommentConnection', page.slice, page);
    },
    createdAt: (_ctx, parent) => (parent._issue as Issue).created_at,
    updatedAt: (_ctx, parent) => (parent._issue as Issue).updated_at,
    url: (_ctx, parent) => `https://github.com/${(parent._repo as Repo).full_name}/issues/${(parent._issue as Issue).number}`,
  },

  PullRequest: {
    id: (_ctx, parent) => gid('PullRequest', (parent._pull as Pull).id),
    databaseId: (_ctx, parent) => (parent._pull as Pull).id,
    number: (_ctx, parent) => (parent._pull as Pull).number,
    title: (_ctx, parent) => (parent._pull as Pull).title,
    body: (_ctx, parent) => (parent._pull as Pull).body,
    state: (_ctx, parent) => pullState(parent._pull as Pull),
    merged: (_ctx, parent) => (parent._pull as Pull).merged,
    mergeable: (_ctx, parent) => ((parent._pull as Pull).mergeable ? 'MERGEABLE' : 'CONFLICTING'),
    headRefName: (_ctx, parent) => (parent._pull as Pull).head.ref,
    baseRefName: (_ctx, parent) => (parent._pull as Pull).base.ref,
    author: (_ctx, parent) => {
      const u = (parent._pull as Pull).user;
      return userObj(u.login, u.id);
    },
    createdAt: (_ctx, parent) => (parent._pull as Pull).created_at,
    updatedAt: (_ctx, parent) => (parent._pull as Pull).updated_at,
    url: (_ctx, parent) => `https://github.com/${(parent._repo as Repo).full_name}/pull/${(parent._pull as Pull).number}`,
    files: (ctx, parent, args) => {
      const repo = parent._repo as Repo;
      const pull = parent._pull as Pull;
      const changeType = (status: string): string => {
        if (status === 'added') return 'ADDED';
        if (status === 'removed') return 'REMOVED';
        if (status === 'renamed') return 'RENAMED';
        return 'MODIFIED';
      };
      const files = ctx.store.listPullFiles(repo, pull.number).map((f) => ({
        __type: 'PullRequestChangedFile', _path: f.filename, _additions: f.additions, _deletions: f.deletions, _changeType: changeType(f.status),
      }));
      const page = paginate(files, args);
      return connectionObj('PullRequestChangedFileConnection', page.slice, page);
    },
  },

  User: {
    login: (_ctx, parent) => parent._login as string,
    id: (_ctx, parent) => gid('User', parent._id as number),
    name: (_ctx, parent) => parent._name as string,
    email: (_ctx, parent) => parent._email as string,
  },

  Organization: {
    login: (_ctx, parent) => parent._login as string,
    id: (_ctx, parent) => gid('Organization', parent._id as number),
    name: (_ctx, parent) => parent._name as string,
  },

  Ref: {
    name: (_ctx, parent) => parent._name as string,
  },

  PageInfo: {
    hasNextPage: (_ctx, parent) => parent._hasNextPage as boolean,
    hasPreviousPage: (_ctx, parent) => parent._hasPreviousPage as boolean,
    startCursor: (_ctx, parent) => parent._startCursor as string | null,
    endCursor: (_ctx, parent) => parent._endCursor as string | null,
  },

  IssueConnection: connectionResolvers(),
  PullRequestConnection: connectionResolvers(),
  IssueCommentConnection: connectionResolvers(),
  LabelConnection: connectionResolvers(),
  PullRequestChangedFileConnection: connectionResolvers(),

  IssueEdge: {
    cursor: (_ctx, parent) => parent._cursor as string,
    node: (_ctx, parent) => parent._node as Obj,
  },
  PullRequestEdge: {
    cursor: (_ctx, parent) => parent._cursor as string,
    node: (_ctx, parent) => parent._node as Obj,
  },
  IssueCommentEdge: {
    cursor: (_ctx, parent) => parent._cursor as string,
    node: (_ctx, parent) => parent._node as Obj,
  },
  LabelEdge: {
    cursor: (_ctx, parent) => parent._cursor as string,
    node: (_ctx, parent) => parent._node as Obj,
  },
  PullRequestChangedFileEdge: {
    cursor: (_ctx, parent) => parent._cursor as string,
    node: (_ctx, parent) => parent._node as Obj,
  },

  IssueComment: {
    id: (_ctx, parent) => gid('IssueComment', (parent._comment as Comment).id),
    databaseId: (_ctx, parent) => (parent._comment as Comment).id,
    body: (_ctx, parent) => (parent._comment as Comment).body,
    author: (_ctx, parent) => {
      const u = (parent._comment as Comment).user;
      return userObj(u.login, u.id);
    },
    createdAt: (_ctx, parent) => (parent._comment as Comment).created_at,
    updatedAt: (_ctx, parent) => (parent._comment as Comment).created_at,
    url: (_ctx, parent) => `https://github.com/${(parent._repo as Repo).full_name}/issues/${(parent._issue as Issue).number}#issuecomment-${(parent._comment as Comment).id}`,
  },

  Label: {
    id: (_ctx, parent) => gid('Label', `${(parent._repo as Repo).id}:${(parent._label as Label).name}`),
    name: (_ctx, parent) => (parent._label as Label).name,
    color: (_ctx, parent) => (parent._label as Label).color,
    description: (_ctx, parent) => (parent._label as Label).description,
  },

  PullRequestChangedFile: {
    path: (_ctx, parent) => parent._path as string,
    additions: (_ctx, parent) => parent._additions as number,
    deletions: (_ctx, parent) => parent._deletions as number,
    changeType: (_ctx, parent) => parent._changeType as string,
  },

  CreateIssuePayload: {
    issue: (_ctx, parent) => parent._issue as Obj,
    clientMutationId: (_ctx, parent) => parent._clientMutationId as string | null,
  },
  CloseIssuePayload: {
    issue: (_ctx, parent) => parent._issue as Obj,
    clientMutationId: (_ctx, parent) => parent._clientMutationId as string | null,
  },
  CreatePullRequestPayload: {
    pullRequest: (_ctx, parent) => parent._pull as Obj,
    clientMutationId: (_ctx, parent) => parent._clientMutationId as string | null,
  },
  MergePullRequestPayload: {
    pullRequest: (_ctx, parent) => parent._pull as Obj,
    clientMutationId: (_ctx, parent) => parent._clientMutationId as string | null,
  },
  AddCommentPayload: {
    commentEdge: (_ctx, parent) => parent._edge as Obj,
    clientMutationId: (_ctx, parent) => parent._clientMutationId as string | null,
  },

  __Schema: {
    queryType: () => typeObj('Query'),
    mutationType: () => typeObj('Mutation'),
    subscriptionType: () => null,
    types: () => Object.keys(TYPE_KIND).map((name) => typeObj(name)),
    directives: () => [],
  },
  __Type: {
    name: (_ctx, parent) => parent._name as string,
    kind: (_ctx, parent) => parent._kind as string,
    description: () => null,
    fields: (_ctx, parent) => {
      const fields = parent._fields as string[] | null;
      return fields ? fields.map((name) => ({ __type: '__Field', _name: name })) : null;
    },
    enumValues: (_ctx, parent) => {
      const values = parent._enumValues as string[] | null;
      return values ? values.map((name) => ({ __type: '__EnumValue', _name: name })) : null;
    },
    inputFields: () => null,
    interfaces: () => [],
    possibleTypes: () => null,
  },
  __Field: {
    name: (_ctx, parent) => parent._name as string,
    description: () => null,
    args: () => [],
    type: () => null,
    isDeprecated: () => false,
    deprecationReason: () => null,
  },
  __EnumValue: {
    name: (_ctx, parent) => parent._name as string,
    description: () => null,
    isDeprecated: () => false,
    deprecationReason: () => null,
  },
  __InputValue: {
    name: () => null,
    description: () => null,
    type: () => null,
    defaultValue: () => null,
  },
};

// ---------------------------------------------------------------------------------------------------------
// One operation + the HTTP handler
// ---------------------------------------------------------------------------------------------------------

function runOperation(store: Store, op: unknown): { status: number; body: Json } {
  if (!op || typeof op !== 'object' || Array.isArray(op)) {
    return { status: 400, body: { errors: [{ message: 'Expected a GraphQL operation object' }] } };
  }
  const query = (op as Json).query;
  if (typeof query !== 'string' || query.trim() === '') {
    return { status: 400, body: { errors: [{ message: 'Missing query' }] } };
  }
  let defs: DefinitionNode[];
  try {
    defs = new Parser(tokenize(query)).parseDocument();
  } catch (e) {
    return { status: 400, body: { errors: [{ message: e instanceof Error ? e.message : String(e) }] } };
  }
  const fragments = new Map<string, FragmentNode>();
  const operations: OperationNode[] = [];
  for (const d of defs) {
    if (d.kind === 'fragment') fragments.set(d.name, d);
    else operations.push(d);
  }
  const operationName = (op as Json).operationName;
  let operation: OperationNode | undefined;
  if (typeof operationName === 'string' && operationName !== '') {
    operation = operations.find((o) => o.name === operationName);
    if (!operation) return { status: 400, body: { errors: [{ message: `Unknown operation named "${operationName}".` }] } };
  } else if (operations.length === 1) {
    operation = operations[0];
  } else if (operations.length === 0) {
    return { status: 400, body: { errors: [{ message: 'No operation found in document' }] } };
  } else {
    return { status: 400, body: { errors: [{ message: 'Must provide operation name when there are multiple operations.' }] } };
  }
  const vars: Record<string, unknown> = {};
  for (const vd of operation.varDefs) {
    if (vd.defaultValue !== undefined) vars[vd.name] = resolveValue(vd.defaultValue, {});
  }
  const provided = (op as Json).variables;
  if (provided && typeof provided === 'object' && !Array.isArray(provided)) {
    for (const [k, v] of Object.entries(provided as Record<string, unknown>)) vars[k] = v;
  }
  if (operation.op === 'subscription') {
    return { status: 200, body: { data: null, errors: [{ message: 'Subscriptions are not supported' }] } };
  }
  const ctx: Ctx = { store, vars, errors: [], fragments };
  const rootType = operation.op === 'mutation' ? 'Mutation' : 'Query';
  const data = execSel(operation.selectionSet, { __type: rootType }, ctx, []);
  const body: Json = { data };
  if (ctx.errors.length > 0) body.errors = ctx.errors;
  return { status: 200, body };
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(payload);
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function authed(req: IncomingMessage, token: string): boolean {
  if (token === '') return true;
  return req.headers.authorization === `Bearer ${token}`;
}

export function createGraphqlHandlers(store: ReturnType<typeof createStore>, token: string): (req: IncomingMessage, res: ServerResponse) => Promise<boolean> {
  return async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    let pathname = req.url ?? '/';
    try { pathname = new URL(pathname, 'http://localhost').pathname; } catch { /* keep raw */ }
    if (pathname !== '/api/graphql') return false;
    if (req.method !== 'POST') {
      sendJson(res, 405, { errors: [{ message: 'Method not allowed' }] });
      return true;
    }
    if (!authed(req, token)) {
      sendJson(res, 401, { errors: [{ message: 'Bad credentials' }] });
      return true;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse((await readBody(req)).toString('utf8'));
    } catch {
      sendJson(res, 400, { errors: [{ message: 'Problems parsing JSON' }] });
      return true;
    }
    if (Array.isArray(parsed)) {
      const out = parsed.map((entry) => runOperation(store, entry).body);
      sendJson(res, 200, out);
      return true;
    }
    const result = runOperation(store, parsed);
    sendJson(res, result.status, result.body);
    return true;
  };
}
