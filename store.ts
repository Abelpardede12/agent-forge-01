// CoreForge shared in-memory store: ONE store behind git smart HTTP, REST v3, GraphQL and MCP.
// Effects cross-visible: a repo/issue/pull created on one surface reads back on the others.
// Deterministic timestamps: a monotonic sequence over a fixed epoch (no wall clock in any
// stored value), so ordering is stable and creation order is reproducible within a run.

import {
  buildCommit,
  buildTree,
  collectReachable,
  hashObject,
  isObjectId,
  parseCommit,
  parseTag,
  parseTree,
  type GitObjectType,
} from './git.ts';

// ---------------------------------------------------------------------------
// Scenario identity: the suite's viewer/stranger logins, re-derived from the
// sealed scenario seed (wire.ts SCENARIO_SEED) with the same PRNG, so the entry
// knows which login its bearer token names without the token encoding it.
// ---------------------------------------------------------------------------

const SCENARIO_SEED = 0x6a09e667f3bcc909n;
const U64_MASK = 0xffffffffffffffffn;
export const SCENARIO_EPOCH_SEC = 1735689600;

function fnv1a64(text: string): bigint {
  let hash = 0xcbf29ce484222325n;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= BigInt(text.charCodeAt(i));
    hash = (hash * 0x100000001b3n) & U64_MASK;
  }
  return hash;
}

function mix64(value: bigint): bigint {
  let z = (value + 0x9e3779b97f4a7c15n) & U64_MASK;
  z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & U64_MASK;
  z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & U64_MASK;
  return (z ^ (z >> 31n)) & U64_MASK;
}

class Rng {
  #state: bigint;
  constructor(seed: bigint) {
    const masked = seed & U64_MASK;
    this.#state = masked === 0n ? SCENARIO_SEED : masked;
  }
  nextU64(): bigint {
    let x = this.#state;
    x = (x ^ (x >> 12n)) & U64_MASK;
    x = (x ^ (x << 25n)) & U64_MASK;
    x = (x ^ (x >> 27n)) & U64_MASK;
    this.#state = x;
    return (x * 0x2545f4914f6cdd1dn) & U64_MASK;
  }
  nextU32(): number {
    return Number(this.nextU64() >> 32n);
  }
  nextInt(maxExclusive: number): number {
    if (maxExclusive === 1) return 0;
    const range = 4294967296;
    const limit = range - (range % maxExclusive);
    for (;;) {
      const value = this.nextU32();
      if (value < limit) return value % maxExclusive;
    }
  }
  pick<T>(items: readonly T[]): T {
    return items[this.nextInt(items.length)];
  }
}

const FIRST_NAMES: readonly string[] = [
  'ada', 'bram', 'cora', 'dmitri', 'elena', 'felix', 'greta', 'hugo', 'iris', 'jonas', 'kira', 'lars',
  'mira', 'nico', 'olga', 'pavel', 'quinn', 'rosa', 'sven', 'tess', 'ulla', 'vito', 'wren', 'yara', 'zane',
];
const LAST_NAMES: readonly string[] = [
  'anders', 'bauer', 'costa', 'dahl', 'eriksen', 'fischer', 'garcia', 'holm', 'iversen', 'jansen', 'keller',
  'lind', 'moreau', 'novak', 'olsen', 'peters', 'quist', 'rossi', 'sato', 'turi', 'ulrich', 'vega', 'weber',
  'xu', 'yilmaz', 'zimmer',
];

export interface ScenarioUser {
  readonly id: number;
  readonly login: string;
  readonly name: string;
  readonly email: string;
}

function generateUsers(rng: Rng, count: number): ScenarioUser[] {
  const used = new Set<string>();
  const users: ScenarioUser[] = [];
  for (let i = 0; i < count; i += 1) {
    const first = rng.pick(FIRST_NAMES);
    const last = rng.pick(LAST_NAMES);
    const base = `${first}${last}`.replace(/[^a-z0-9-]/g, '');
    let login = base;
    let suffix = 2;
    while (used.has(login)) {
      login = `${base}-${suffix}`;
      suffix += 1;
    }
    used.add(login);
    users.push({ id: 1000 + i, login, name: `${first} ${last}`, email: `${login}@example.invalid` });
  }
  return users;
}

const scenarioUsers = generateUsers(new Rng(mix64(SCENARIO_SEED ^ fnv1a64('users'))), 12);
export const VIEWER: ScenarioUser = scenarioUsers[0];
export const STRANGER: ScenarioUser = scenarioUsers[2];
export const VIEWER_LOGIN: string = VIEWER.login;
export const VIEWER_NAME: string = VIEWER.name;
export const VIEWER_EMAIL: string = VIEWER.email;

// ---------------------------------------------------------------------------
// Entities
// ---------------------------------------------------------------------------

export interface StoredObject {
  readonly type: GitObjectType;
  readonly data: Buffer;
}

export interface Label {
  readonly id: number;
  readonly name: string;
  readonly color: string;
  readonly description: string;
}

export interface Comment {
  readonly id: number;
  readonly body: string;
  readonly userLogin: string;
  readonly createdAt: string;
  readonly seq: number;
}

export interface Issue {
  readonly id: number;
  readonly number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  readonly userLogin: string;
  readonly createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  readonly seq: number;
  comments: Comment[];
}

export interface Pull {
  readonly id: number;
  readonly number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  readonly headRef: string;
  readonly baseRef: string;
  headSha: string;
  baseSha: string;
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  readonly userLogin: string;
  readonly createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  readonly seq: number;
}

export interface Repo {
  readonly id: number;
  readonly owner: string;
  readonly name: string;
  description: string;
  isPrivate: boolean;
  readonly defaultBranch: string;
  readonly createdSeq: number;
  deleted: boolean;
  readonly objects: Map<string, StoredObject>;
  readonly refs: Map<string, string>;
  readonly labels: Map<string, Label>;
  readonly issues: Issue[];
  readonly pulls: Pull[];
  nextNumber: number;
}

export interface TreeEntryOut {
  readonly mode: string;
  readonly name: string;
  readonly oid: string;
}

// ---------------------------------------------------------------------------
// The store
// ---------------------------------------------------------------------------

/** The store's state. A class (not just an interface) so main.ts can `new Store()`. */
export class Store {
  readonly token: string;
  readonly repos: Map<string, Repo>;
  seq: number;
  nextId: number;
  nextRepoId: number;
  constructor() {
    this.token = process.env.MAKEFUN_SHOP_TOKEN ?? '';
    this.repos = new Map<string, Repo>();
    this.seq = 0;
    this.nextId = 1000000;
    this.nextRepoId = 100000;
  }
}

export function createStore(): Store {
  return new Store();
}

/** The shared singleton instance every surface reads and writes. */
export const store: Store = createStore();

export function nextSeq(s: Store): number {
  s.seq += 1;
  return s.seq;
}

export function isoAt(seq: number): string {
  return new Date((SCENARIO_EPOCH_SEC + seq) * 1000).toISOString();
}

export function repoKey(owner: string, name: string): string {
  return `${owner}/${name}`;
}

export function getRepo(s: Store, owner: string, name: string): Repo | undefined {
  const direct = s.repos.get(repoKey(owner, name));
  if (direct !== undefined && !direct.deleted) return direct;
  const want = repoKey(owner, name).toLowerCase();
  for (const repo of s.repos.values()) {
    if (!repo.deleted && repoKey(repo.owner, repo.name).toLowerCase() === want) return repo;
  }
  return undefined;
}

export function listViewerRepos(s: Store, owner: string): Repo[] {
  const out: Repo[] = [];
  for (const repo of s.repos.values()) {
    if (!repo.deleted && repo.owner === owner) out.push(repo);
  }
  out.sort((a, b) => a.createdSeq - b.createdSeq);
  return out;
}

export function createRepo(
  s: Store,
  owner: string,
  name: string,
  options: { description?: string; isPrivate?: boolean },
): Repo | null {
  if (getRepo(s, owner, name) !== undefined) return null;
  const repo: Repo = {
    id: s.nextRepoId,
    owner,
    name,
    description: options.description ?? '',
    isPrivate: options.isPrivate ?? false,
    defaultBranch: 'main',
    createdSeq: nextSeq(s),
    deleted: false,
    objects: new Map<string, StoredObject>(),
    refs: new Map<string, string>(),
    labels: new Map<string, Label>(),
    issues: [],
    pulls: [],
    nextNumber: 1,
  };
  s.nextRepoId += 1;
  s.repos.set(repoKey(owner, name), repo);
  return repo;
}

export function putObject(repo: Repo, type: GitObjectType, data: Buffer): string {
  const oid = hashObject(type, data);
  if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
  return oid;
}

export function lookupObject(repo: Repo): (oid: string) => StoredObject | undefined {
  return (oid: string) => repo.objects.get(oid);
}

/** Resolve a branch name, full ref, HEAD or 40-hex oid to a commit oid, or null. */
export function resolveRef(repo: Repo, ref: string): string | null {
  if (ref === 'HEAD') {
    return repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? null;
  }
  if (isObjectId(ref)) return repo.objects.has(ref) ? ref : null;
  if (ref.startsWith('refs/')) {
    const oid = repo.refs.get(ref);
    return oid ?? null;
  }
  const branch = repo.refs.get(`refs/heads/${ref}`);
  if (branch !== undefined) return branch;
  const tag = repo.refs.get(`refs/tags/${ref}`);
  if (tag !== undefined) return tag;
  return null;
}

/** The commit a ref resolves to, peeling annotated tags. */
export function resolveCommit(repo: Repo, ref: string): string | null {
  const oid = resolveRef(repo, ref);
  if (oid === null) return null;
  let current = oid;
  for (let depth = 0; depth < 10; depth += 1) {
    const object = repo.objects.get(current);
    if (object === undefined) return null;
    if (object.type === 'commit') return current;
    if (object.type === 'tag') {
      current = parseTag(object.data).object;
      continue;
    }
    return null;
  }
  return null;
}

export function refTip(repo: Repo, branch: string): string | null {
  return repo.refs.get(`refs/heads/${branch}`) ?? null;
}

// ---------------------------------------------------------------------------
// Trees
// ---------------------------------------------------------------------------

export type FlatTree = Map<string, { mode: string; oid: string }>;

/** Flatten a tree object to path -> entry, recursively. */
export function flattenTree(repo: Repo, treeOid: string): FlatTree {
  const out: FlatTree = new Map();
  const walk = (oid: string, prefix: string): void => {
    const object = repo.objects.get(oid);
    if (object === undefined || object.type !== 'tree') return;
    for (const entry of parseTree(object.data)) {
      const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.mode === '40000') walk(entry.oid, path);
      else out.set(path, { mode: entry.mode, oid: entry.oid });
    }
  };
  walk(treeOid, '');
  return out;
}

/** Build (and store) the nested tree objects for a flat path map; returns the root tree oid. */
export function buildTreeFromMap(repo: Repo, flat: FlatTree): string {
  interface Node {
    files: Map<string, { mode: string; oid: string }>;
    dirs: Map<string, Node>;
  }
  const make = (): Node => ({ files: new Map(), dirs: new Map() });
  const root = make();
  for (const [path, entry] of [...flat.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const segments = path.split('/');
    let node = root;
    for (let i = 0; i < segments.length - 1; i += 1) {
      const name = segments[i];
      if (!node.dirs.has(name)) node.dirs.set(name, make());
      node = node.dirs.get(name)!;
    }
    node.files.set(segments[segments.length - 1], entry);
  }
  const build = (node: Node): string => {
    const entries: TreeEntryOut[] = [];
    for (const [name, entry] of node.files) entries.push({ mode: entry.mode, name, oid: entry.oid });
    for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: build(child) });
    return putObject(repo, 'tree', buildTree(entries));
  };
  return build(root);
}

/** The tree oid of a commit, or null. */
export function commitTree(repo: Repo, commitOid: string): string | null {
  const object = repo.objects.get(commitOid);
  if (object === undefined || object.type !== 'commit') return null;
  return parseCommit(object.data).tree;
}

// ---------------------------------------------------------------------------
// Commits
// ---------------------------------------------------------------------------

export function makeCommit(
  s: Store,
  repo: Repo,
  options: { tree: string; parents: readonly string[]; message: string },
): string {
  const seq = nextSeq(s);
  const who = `${VIEWER_NAME} <${VIEWER_EMAIL}>`;
  const data = buildCommit({
    tree: options.tree,
    parents: options.parents,
    message: options.message,
    author: who,
    committer: who,
    timestamp: SCENARIO_EPOCH_SEC + seq,
  });
  return putObject(repo, 'commit', data);
}

/** Commits reachable from `tip`, newest first (DFS preorder from the tip). */
export function listCommits(repo: Repo, tipOid: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const stack: string[] = [tipOid];
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = repo.objects.get(oid);
    if (object === undefined || object.type !== 'commit') continue;
    out.push(oid);
    const commit = parseCommit(object.data);
    for (let i = commit.parents.length - 1; i >= 0; i -= 1) stack.push(commit.parents[i]);
  }
  return out;
}

/** The nearest common ancestor commit of a and b, or null. */
export function mergeBase(repo: Repo, a: string, b: string): string | null {
  const depthA = new Map<string, number>();
  const queueA: Array<[string, number]> = [[a, 0]];
  while (queueA.length > 0) {
    const [oid, depth] = queueA.shift()!;
    if (depthA.has(oid)) continue;
    depthA.set(oid, depth);
    const object = repo.objects.get(oid);
    if (object === undefined || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) queueA.push([parent, depth + 1]);
  }
  const seenB = new Set<string>();
  const queueB: Array<[string, number]> = [[b, 0]];
  let best: string | null = null;
  let bestScore = Number.POSITIVE_INFINITY;
  while (queueB.length > 0) {
    const [oid, depth] = queueB.shift()!;
    if (seenB.has(oid)) continue;
    seenB.add(oid);
    const da = depthA.get(oid);
    if (da !== undefined && da + depth < bestScore) {
      bestScore = da + depth;
      best = oid;
    }
    const object = repo.objects.get(oid);
    if (object === undefined || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) queueB.push([parent, depth + 1]);
  }
  return best;
}

/** True when `ancestor` is an ancestor of (or equal to) `tip`. */
export function isAncestor(repo: Repo, ancestor: string, tip: string): boolean {
  if (ancestor === tip) return true;
  const seen = new Set<string>();
  const stack: string[] = [tip];
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    if (oid === ancestor) return true;
    const object = repo.objects.get(oid);
    if (object === undefined || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) stack.push(parent);
  }
  return false;
}

// ---------------------------------------------------------------------------
// Contents (REST) — files as real commits
// ---------------------------------------------------------------------------

export interface CommitFileResult {
  readonly ok: boolean;
  readonly status: number;
  readonly message?: string;
  readonly commitSha?: string;
  readonly contentSha?: string;
}

export function commitFile(
  s: Store,
  repo: Repo,
  options: { branch?: string; path: string; content: Buffer; message: string; sha?: string },
): CommitFileResult {
  const branch = options.branch ?? repo.defaultBranch;
  const tip = refTip(repo, branch);
  if (tip === null && repo.refs.size > 0) {
    return { ok: false, status: 404, message: `branch ${branch} does not exist` };
  }
  const flat: FlatTree = tip === null ? new Map() : flattenTree(repo, commitTree(repo, tip) ?? '');
  const existing = flat.get(options.path);
  if (existing !== undefined) {
    if (options.sha === undefined) {
      return { ok: false, status: 422, message: `"sha" wasn't supplied` };
    }
    if (options.sha.toLowerCase() !== existing.oid.toLowerCase()) {
      return { ok: false, status: 409, message: 'the sha does not match the current file' };
    }
  } else if (options.sha !== undefined) {
    return { ok: false, status: 422, message: 'the file does not exist, so no sha applies' };
  }
  const blobOid = putObject(repo, 'blob', options.content);
  flat.set(options.path, { mode: '100644', oid: blobOid });
  const treeOid = buildTreeFromMap(repo, flat);
  const commitOid = makeCommit(s, repo, {
    tree: treeOid,
    parents: tip === null ? [] : [tip],
    message: options.message,
  });
  repo.refs.set(`refs/heads/${branch}`, commitOid);
  return {
    ok: true,
    status: existing !== undefined ? 200 : 201,
    commitSha: commitOid,
    contentSha: blobOid,
  };
}

export interface DeleteFileResult {
  readonly ok: boolean;
  readonly status: number;
  readonly message?: string;
  readonly commitSha?: string;
}

export function deleteFile(
  s: Store,
  repo: Repo,
  options: { branch?: string; path: string; message: string; sha?: string },
): DeleteFileResult {
  const branch = options.branch ?? repo.defaultBranch;
  const tip = refTip(repo, branch);
  if (tip === null) return { ok: false, status: 404, message: `branch ${branch} does not exist` };
  const flat = flattenTree(repo, commitTree(repo, tip) ?? '');
  const existing = flat.get(options.path);
  if (existing === undefined) return { ok: false, status: 404, message: `path ${options.path} does not exist` };
  if (options.sha !== undefined && options.sha.toLowerCase() !== existing.oid.toLowerCase()) {
    return { ok: false, status: 409, message: 'the sha does not match the current file' };
  }
  flat.delete(options.path);
  const treeOid = buildTreeFromMap(repo, flat);
  const commitOid = makeCommit(s, repo, { tree: treeOid, parents: [tip], message: options.message });
  repo.refs.set(`refs/heads/${branch}`, commitOid);
  return { ok: true, status: 200, commitSha: commitOid };
}

export type PathRead =
  | { readonly kind: 'file'; readonly blobOid: string; readonly data: Buffer }
  | { readonly kind: 'dir'; readonly entries: Array<{ name: string; path: string; type: 'file' | 'dir'; oid: string }> }
  | null;

/** Read a path at a ref: a file's blob, or a directory's entries. */
export function readPath(repo: Repo, ref: string, path: string): PathRead {
  const commitOid = resolveCommit(repo, ref);
  if (commitOid === null) return null;
  const treeOid = commitTree(repo, commitOid);
  if (treeOid === null) return null;
  const clean = path.replace(/^\/+/, '').replace(/\/+$/, '');
  if (clean === '') {
    const entries: Array<{ name: string; path: string; type: 'file' | 'dir'; oid: string }> = [];
    const object = repo.objects.get(treeOid);
    if (object === undefined || object.type !== 'tree') return null;
    for (const entry of parseTree(object.data)) {
      entries.push({ name: entry.name, path: entry.name, type: entry.mode === '40000' ? 'dir' : 'file', oid: entry.oid });
    }
    return { kind: 'dir', entries };
  }
  const segments = clean.split('/');
  let currentTree = treeOid;
  for (let i = 0; i < segments.length; i += 1) {
    const object = repo.objects.get(currentTree);
    if (object === undefined || object.type !== 'tree') return null;
    const entry = parseTree(object.data).find((candidate) => candidate.name === segments[i]);
    if (entry === undefined) return null;
    const last = i === segments.length - 1;
    if (last) {
      if (entry.mode === '40000') {
        const child = repo.objects.get(entry.oid);
        if (child === undefined || child.type !== 'tree') return null;
        const entries = parseTree(child.data).map((candidate) => ({
          name: candidate.name,
          path: `${clean}/${candidate.name}`,
          type: (candidate.mode === '40000' ? 'dir' : 'file') as 'file' | 'dir',
          oid: candidate.oid,
        }));
        return { kind: 'dir', entries };
      }
      const blob = repo.objects.get(entry.oid);
      if (blob === undefined || blob.type !== 'blob') return null;
      return { kind: 'file', blobOid: entry.oid, data: blob.data };
    }
    if (entry.mode !== '40000') return null;
    currentTree = entry.oid;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Issues, labels, comments, pulls
// ---------------------------------------------------------------------------

export function createLabel(
  s: Store,
  repo: Repo,
  options: { name: string; color?: string; description?: string },
): Label | null {
  if (repo.labels.has(options.name)) return null;
  const label: Label = {
    id: s.nextId,
    name: options.name,
    color: options.color ?? 'ededed',
    description: options.description ?? '',
  };
  s.nextId += 1;
  repo.labels.set(options.name, label);
  return label;
}

export function createIssue(
  s: Store,
  repo: Repo,
  options: { title: string; body?: string; labels?: readonly string[] },
): { issue: Issue } | { error: string } {
  const labels: string[] = [];
  for (const name of options.labels ?? []) {
    if (!repo.labels.has(name)) return { error: `label ${name} does not exist` };
    labels.push(name);
  }
  const seq = nextSeq(s);
  const issue: Issue = {
    id: s.nextId,
    number: repo.nextNumber,
    title: options.title,
    body: options.body ?? '',
    state: 'open',
    labels,
    userLogin: VIEWER_LOGIN,
    createdAt: isoAt(seq),
    updatedAt: isoAt(seq),
    closedAt: null,
    seq,
    comments: [],
  };
  s.nextId += 1;
  repo.nextNumber += 1;
  repo.issues.push(issue);
  return { issue };
}

export function createPull(
  s: Store,
  repo: Repo,
  options: { title: string; body?: string; head: string; base: string },
): { pull: Pull } | { error: string } {
  const headName = options.head.includes(':') ? (options.head.split(':').pop() ?? options.head) : options.head;
  const baseName = options.base.includes(':') ? (options.base.split(':').pop() ?? options.base) : options.base;
  const headSha = resolveCommit(repo, headName);
  const baseSha = resolveCommit(repo, baseName);
  if (headSha === null) return { error: `head branch ${headName} does not exist` };
  if (baseSha === null) return { error: `base branch ${baseName} does not exist` };
  const seq = nextSeq(s);
  const pull: Pull = {
    id: s.nextId,
    number: repo.nextNumber,
    title: options.title,
    body: options.body ?? '',
    state: 'open',
    headRef: headName,
    baseRef: baseName,
    headSha,
    baseSha,
    merged: false,
    mergedAt: null,
    mergeCommitSha: null,
    userLogin: VIEWER_LOGIN,
    createdAt: isoAt(seq),
    updatedAt: isoAt(seq),
    closedAt: null,
    seq,
  };
  s.nextId += 1;
  repo.nextNumber += 1;
  repo.pulls.push(pull);
  return { pull };
}

/** Line counts for a changed file, by multiset difference of lines. */
function lineCounts(oldText: string, newText: string): { additions: number; deletions: number } {
  const split = (text: string): string[] => {
    if (text === '') return [];
    const lines = text.split('\n');
    if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
    return lines;
  };
  const oldLines = split(oldText);
  const newLines = split(newText);
  const counts = new Map<string, number>();
  for (const line of oldLines) counts.set(line, (counts.get(line) ?? 0) + 1);
  let additions = 0;
  for (const line of newLines) {
    const left = counts.get(line) ?? 0;
    if (left > 0) counts.set(line, left - 1);
    else additions += 1;
  }
  let deletions = 0;
  for (const left of counts.values()) deletions += left;
  return { additions, deletions };
}

export interface PullFile {
  readonly filename: string;
  readonly status: 'added' | 'modified' | 'removed';
  readonly additions: number;
  readonly deletions: number;
  readonly changes: number;
}

/** The files a pull request changes: diff of base tip tree vs head tip tree. */
export function pullFiles(repo: Repo, pull: Pull): PullFile[] {
  const baseTree = commitTree(repo, pull.baseSha);
  const headTree = commitTree(repo, pull.headSha);
  const base = baseTree === null ? new Map<string, { mode: string; oid: string }>() : flattenTree(repo, baseTree);
  const head = headTree === null ? new Map<string, { mode: string; oid: string }>() : flattenTree(repo, headTree);
  const paths = new Set<string>([...base.keys(), ...head.keys()]);
  const out: PullFile[] = [];
  for (const path of [...paths].sort()) {
    const b = base.get(path);
    const h = head.get(path);
    if (b !== undefined && h !== undefined && b.oid === h.oid) continue;
    if (b === undefined && h !== undefined) {
      const blob = repo.objects.get(h.oid);
      const text = blob !== undefined && blob.type === 'blob' ? blob.data.toString('utf8') : '';
      const { additions } = lineCounts('', text);
      out.push({ filename: path, status: 'added', additions, deletions: 0, changes: additions });
    } else if (b !== undefined && h === undefined) {
      const blob = repo.objects.get(b.oid);
      const text = blob !== undefined && blob.type === 'blob' ? blob.data.toString('utf8') : '';
      const { deletions } = lineCounts(text, '');
      out.push({ filename: path, status: 'removed', additions: 0, deletions, changes: deletions });
    } else if (b !== undefined && h !== undefined) {
      const oldBlob = repo.objects.get(b.oid);
      const newBlob = repo.objects.get(h.oid);
      const oldText = oldBlob !== undefined && oldBlob.type === 'blob' ? oldBlob.data.toString('utf8') : '';
      const newText = newBlob !== undefined && newBlob.type === 'blob' ? newBlob.data.toString('utf8') : '';
      const { additions, deletions } = lineCounts(oldText, newText);
      out.push({ filename: path, status: 'modified', additions, deletions, changes: additions + deletions });
    }
  }
  return out;
}

export interface MergeResult {
  readonly ok: boolean;
  readonly status: number;
  readonly message?: string;
  readonly sha?: string;
}

/** A real three-way merge of a pull request onto its base branch. */
export function mergePull(
  s: Store,
  repo: Repo,
  pull: Pull,
  method: string,
): MergeResult {
  if (pull.state !== 'open' || pull.merged) {
    return { ok: false, status: 405, message: 'Pull Request is already merged or closed' };
  }
  const baseTip = resolveCommit(repo, pull.baseRef);
  const headTip = resolveCommit(repo, pull.headRef);
  if (baseTip === null || headTip === null) {
    return { ok: false, status: 404, message: 'the head or base branch does not exist' };
  }
  if (isAncestor(repo, headTip, baseTip)) {
    return { ok: false, status: 405, message: 'Head branch is already merged into base' };
  }
  const ancestor = mergeBase(repo, baseTip, headTip);
  const ancestorTree = ancestor === null ? '' : commitTree(repo, ancestor) ?? '';
  const baseTree = commitTree(repo, baseTip) ?? '';
  const headTree = commitTree(repo, headTip) ?? '';
  const a = ancestorTree === '' ? new Map<string, { mode: string; oid: string }>() : flattenTree(repo, ancestorTree);
  const b = flattenTree(repo, baseTree);
  const h = flattenTree(repo, headTree);
  const paths = new Set<string>([...a.keys(), ...b.keys(), ...h.keys()]);
  const merged: FlatTree = new Map();
  const conflicts: string[] = [];
  for (const path of paths) {
    const av = a.get(path);
    const bv = b.get(path);
    const hv = h.get(path);
    const same = (x: { mode: string; oid: string } | undefined, y: { mode: string; oid: string } | undefined): boolean =>
      (x === undefined && y === undefined) || (x !== undefined && y !== undefined && x.oid === y.oid && x.mode === y.mode);
    if (same(bv, hv)) {
      if (bv !== undefined) merged.set(path, bv);
    } else if (same(av, bv)) {
      if (hv !== undefined) merged.set(path, hv);
    } else if (same(av, hv)) {
      if (bv !== undefined) merged.set(path, bv);
    } else {
      conflicts.push(path);
    }
  }
  if (conflicts.length > 0) {
    return { ok: false, status: 405, message: `Merge conflict in ${conflicts.join(', ')}` };
  }
  const treeOid = buildTreeFromMap(repo, merged);
  const parents = method === 'merge' ? [baseTip, headTip] : [baseTip];
  const commitOid = makeCommit(s, repo, {
    tree: treeOid,
    parents,
    message: `Merge pull request #${pull.number} from ${pull.headRef}\n\n${pull.title}`,
  });
  repo.refs.set(`refs/heads/${pull.baseRef}`, commitOid);
  const seq = nextSeq(s);
  pull.state = 'closed';
  pull.merged = true;
  pull.mergedAt = isoAt(seq);
  pull.mergeCommitSha = commitOid;
  pull.updatedAt = isoAt(seq);
  pull.closedAt = isoAt(seq);
  return { ok: true, status: 200, sha: commitOid };
}

// ---------------------------------------------------------------------------
// REST shapes (shared with GraphQL/MCP views of the same objects)
// ---------------------------------------------------------------------------

export function userJson(user: ScenarioUser): Record<string, unknown> {
  return {
    login: user.login,
    id: user.id,
    node_id: toGlobalId('User', user.id),
    avatar_url: '',
    type: 'User',
    name: user.name,
    email: user.email,
  };
}

export function repoJson(s: Store, repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: toGlobalId('Repository', repo.id),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: userJson(VIEWER),
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    html_url: `https://github.local/${repo.owner}/${repo.name}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    created_at: isoAt(repo.createdSeq),
    updated_at: isoAt(repo.createdSeq),
    pushed_at: isoAt(repo.createdSeq),
    has_issues: true,
    has_projects: true,
    has_wiki: true,
  };
}

export function labelJson(label: Label): Record<string, unknown> {
  return {
    id: label.id,
    node_id: toGlobalId('Label', label.id),
    name: label.name,
    color: label.color,
    description: label.description,
    default: false,
  };
}

export function commentJson(comment: Comment): Record<string, unknown> {
  return {
    id: comment.id,
    node_id: toGlobalId('IssueComment', comment.id),
    body: comment.body,
    user: userJson(VIEWER),
    created_at: comment.createdAt,
    updated_at: comment.createdAt,
  };
}

export function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: toGlobalId('Issue', issue.id),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => {
      const label = repo.labels.get(name);
      return label !== undefined ? labelJson(label) : { name, color: 'ededed', description: '' };
    }),
    user: userJson(VIEWER),
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.closedAt,
    comments: issue.comments.length,
    html_url: `https://github.local/${repo.owner}/${repo.name}/issues/${issue.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
  };
}

export function pullJson(repo: Repo, pull: Pull): Record<string, unknown> {
  const head = {
    ref: pull.headRef,
    sha: pull.headSha,
    label: `${repo.owner}:${pull.headRef}`,
    user: userJson(VIEWER),
    repo: { name: repo.name, full_name: `${repo.owner}/${repo.name}` },
  };
  const base = {
    ref: pull.baseRef,
    sha: pull.baseSha,
    label: `${repo.owner}:${pull.baseRef}`,
    user: userJson(VIEWER),
    repo: { name: repo.name, full_name: `${repo.owner}/${repo.name}` },
  };
  return {
    id: pull.id,
    node_id: toGlobalId('PullRequest', pull.id),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    head,
    base,
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    mergeable: true,
    user: userJson(VIEWER),
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    closed_at: pull.closedAt,
    html_url: `https://github.local/${repo.owner}/${repo.name}/pull/${pull.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
  };
}

/** A stable opaque global id for node() lookups (GraphQL/MCP share this encoding). */
export function toGlobalId(kind: string, id: number | string): string {
  return Buffer.from(`${kind}:${id}`).toString('base64');
}

export function fromGlobalId(gid: string): { kind: string; id: string } | null {
  try {
    const text = Buffer.from(gid, 'base64').toString('utf8');
    const colon = text.indexOf(':');
    if (colon <= 0) return null;
    return { kind: text.slice(0, colon), id: text.slice(colon + 1) };
  } catch {
    return null;
  }
}

/** Every object reachable from `roots` (thin helper over git's walk, kept here for surfaces). */
export function reachableObjects(repo: Repo, roots: Iterable<string>): Set<string> {
  return collectReachable(roots, lookupObject(repo));
}
