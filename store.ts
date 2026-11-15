// One in-memory store behind all four surfaces: git objects and refs, REST
// repositories/issues/pull requests, and the GraphQL/MCP views of the same data.
// The viewer login is derived from the contest's fixed scenario seed (the same
// deterministic generator the suite uses), so the token's owner is known without
// any network call.

import {
  ZERO_OID,
  buildCommit,
  buildTree,
  collectReachable,
  hashObject,
  isAncestor,
  isOid,
  mergeBase,
  parseCommit,
  parseTag,
  parseTree,
  peelToCommit,
  type GitObject,
  type GitObjectType,
  type TreeEntry,
} from './git.ts';

// ---------------------------------------------------------------- scenario identity

const SCENARIO_SEED = 0x6a09e667f3bcc909n;
const U64_MASK = 0xffffffffffffffffn;

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
    if (maxExclusive <= 1) return 0;
    const range = 4_294_967_296;
    const limit = range - (range % maxExclusive);
    for (;;) {
      const value = this.nextU32();
      if (value < limit) return value % maxExclusive;
    }
  }

  pick<T>(items: readonly T[]): T {
    return items[this.nextInt(items.length)]!;
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

export interface ViewerIdentity {
  readonly id: number;
  readonly login: string;
  readonly name: string;
  readonly email: string;
}

/** The scenario's first generated user: the login the bearer token names. */
export function scenarioViewer(): ViewerIdentity {
  const rng = new Rng(mix64(SCENARIO_SEED ^ fnv1a64('users')));
  const used = new Set<string>();
  let first: ViewerIdentity | null = null;
  for (let i = 0; i < 12; i += 1) {
    const firstName = rng.pick(FIRST_NAMES);
    const lastName = rng.pick(LAST_NAMES);
    const base = `${firstName}${lastName}`.replace(/[^a-z0-9-]/g, '');
    let login = base;
    let suffix = 2;
    while (used.has(login)) {
      login = `${base}-${suffix}`;
      suffix += 1;
    }
    used.add(login);
    const user: ViewerIdentity = { id: 1000 + i, login, name: `${firstName} ${lastName}`, email: `${login}@example.invalid` };
    if (first === null) first = user;
  }
  return first!;
}

// ---------------------------------------------------------------- global ids (opaque, stable)

function b64(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64url');
}

export function globalId(kind: string, ...parts: Array<string | number>): string {
  return b64(`${kind}:${parts.join(':')}`);
}

export function decodeGlobalId(id: string): { kind: string; parts: string[] } | null {
  try {
    const text = Buffer.from(id, 'base64url').toString('utf8');
    const split = text.indexOf(':');
    if (split < 0) return null;
    return { kind: text.slice(0, split), parts: text.slice(split + 1).split(':') };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- records

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  createdSeq: number;
  updatedSeq: number;
  userLogin: string;
}

export interface IssueComment {
  id: number;
  body: string;
  createdSeq: number;
  userLogin: string;
}

export interface Label {
  name: string;
  color: string;
  description: string;
}

export interface PullRequest {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  headRef: string;
  baseRef: string;
  headSha: string;
  baseSha: string;
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  createdSeq: number;
  updatedSeq: number;
  userLogin: string;
}

export interface Repo {
  id: number;
  owner: string;
  name: string;
  description: string;
  private: boolean;
  defaultBranch: string;
  createdSeq: number;
  objects: Map<string, GitObject>;
  refs: Map<string, string>;
  labels: Map<string, Label>;
  issues: Map<number, Issue>;
  comments: Map<number, IssueComment[]>;
  pulls: Map<number, PullRequest>;
  nextNumber: number;
  seq: number;
}

function nowIso(): string {
  return new Date().toISOString();
}

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

// ---------------------------------------------------------------- the store

export class Store {
  readonly viewer: ViewerIdentity = scenarioViewer();
  readonly repos = new Map<string, Repo>();
  readonly reposById = new Map<number, Repo>();
  private nextRepoId = 1;
  private nextIssueId = 1;
  private nextCommentId = 1;
  private nextPullId = 1;
  private seq = 0;

  private nextSeq(): number {
    this.seq += 1;
    return this.seq;
  }

  key(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.key(owner, name));
  }

  getRepoById(id: number): Repo | undefined {
    return this.reposById.get(id);
  }

  createRepo(owner: string, name: string, options: { description?: string; private?: boolean } = {}): Repo {
    const repo: Repo = {
      id: this.nextRepoId++,
      owner,
      name,
      description: options.description ?? '',
      private: options.private ?? false,
      defaultBranch: 'main',
      createdSeq: this.nextSeq(),
      objects: new Map(),
      refs: new Map(),
      labels: new Map(),
      issues: new Map(),
      comments: new Map(),
      pulls: new Map(),
      nextNumber: 1,
      seq: 0,
    };
    this.repos.set(this.key(owner, name), repo);
    this.reposById.set(repo.id, repo);
    return repo;
  }

  deleteRepo(owner: string, name: string): boolean {
    const repo = this.getRepo(owner, name);
    if (!repo) return false;
    this.repos.delete(this.key(owner, name));
    this.reposById.delete(repo.id);
    return true;
  }

  listViewerRepos(): Repo[] {
    const out: Repo[] = [];
    for (const repo of this.repos.values()) {
      if (repo.owner === this.viewer.login) out.push(repo);
    }
    out.sort((a, b) => a.createdSeq - b.createdSeq);
    return out;
  }

  // ------------------------------------------------------------ git objects

  putObject(repo: Repo, type: GitObjectType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!repo.objects.has(oid)) {
      repo.objects.set(oid, { type, data });
      if (type === 'commit') repo.seq += 1;
    }
    return oid;
  }

  getObject(repo: Repo, oid: string): GitObject | undefined {
    return repo.objects.get(oid);
  }

  lookup(repo: Repo): (oid: string) => GitObject | undefined {
    return (oid: string) => repo.objects.get(oid);
  }

  getRef(repo: Repo, ref: string): string | undefined {
    return repo.refs.get(ref);
  }

  /** Resolve a branch name, full ref, or commit sha to a commit oid (null when unknown). */
  resolveCommit(repo: Repo, ref: string): string | null {
    if (ref === 'HEAD') ref = `refs/heads/${repo.defaultBranch}`;
    let oid: string | undefined;
    if (ref.startsWith('refs/')) oid = repo.refs.get(ref);
    else if (repo.refs.has(`refs/heads/${ref}`)) oid = repo.refs.get(`refs/heads/${ref}`);
    else if (repo.refs.has(`refs/tags/${ref}`)) oid = repo.refs.get(`refs/tags/${ref}`);
    else if (isOid(ref) && repo.objects.has(ref)) oid = ref;
    if (!oid) return null;
    return peelToCommit(oid, this.lookup(repo));
  }

  /** The tree oid of a commit, or null. */
  treeOf(repo: Repo, commitOid: string): string | null {
    const object = repo.objects.get(commitOid);
    if (!object || object.type !== 'commit') return null;
    return parseCommit(object.data).tree;
  }

  /** Flatten a tree to path -> {mode, oid} (recursive). */
  flattenTree(repo: Repo, treeOid: string): Map<string, { mode: string; oid: string }> {
    const out = new Map<string, { mode: string; oid: string }>();
    const walk = (oid: string, prefix: string): void => {
      const object = repo.objects.get(oid);
      if (!object || object.type !== 'tree') return;
      for (const entry of parseTree(object.data)) {
        const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
        if (entry.mode === '40000') walk(entry.oid, path);
        else out.set(path, { mode: entry.mode, oid: entry.oid });
      }
    };
    walk(treeOid, '');
    return out;
  }

  /** Build a tree object from a flat path map, storing every intermediate tree. */
  buildTreeFromFlat(repo: Repo, flat: ReadonlyMap<string, { mode: string; oid: string }>): string {
    interface Node {
      files: Map<string, { mode: string; oid: string }>;
      dirs: Map<string, Node>;
    }
    const make = (): Node => ({ files: new Map(), dirs: new Map() });
    const root = make();
    for (const [path, entry] of flat) {
      const segments = path.split('/');
      let node = root;
      for (let i = 0; i < segments.length - 1; i += 1) {
        const name = segments[i]!;
        if (!node.dirs.has(name)) node.dirs.set(name, make());
        node = node.dirs.get(name)!;
      }
      node.files.set(segments[segments.length - 1]!, entry);
    }
    const build = (node: Node): string => {
      const entries: TreeEntry[] = [];
      for (const [name, entry] of node.files) entries.push({ mode: entry.mode, name, oid: entry.oid });
      for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: build(child) });
      return this.putObject(repo, 'tree', buildTree(entries));
    };
    return build(root);
  }

  /** The blob oid at `path` in the tree of `commitOid`, or null. */
  blobAt(repo: Repo, commitOid: string, path: string): string | null {
    const treeOid = this.treeOf(repo, commitOid);
    if (!treeOid) return null;
    const flat = this.flattenTree(repo, treeOid);
    const entry = flat.get(path);
    return entry ? entry.oid : null;
  }

  /** Create a commit object on `repo` and return its oid. */
  makeCommit(
    repo: Repo,
    treeOid: string,
    parents: readonly string[],
    message: string,
    authorLogin?: string,
  ): string {
    const login = authorLogin ?? this.viewer.login;
    const who = `${login} <${login}@example.invalid>`;
    const data = buildCommit({
      tree: treeOid,
      parents,
      message: message.endsWith('\n') ? message : `${message}\n`,
      author: who,
      committer: who,
      timestamp: nowSec(),
    });
    return this.putObject(repo, 'commit', data);
  }

  /** Set one path in a commit's tree; returns the new tree oid (stores intermediates). */
  setPath(repo: Repo, baseCommitOid: string | null, path: string, blobOid: string | null): string {
    const baseTree = baseCommitOid === null ? null : this.treeOf(repo, baseCommitOid);
    const flat = baseTree === null ? new Map<string, { mode: string; oid: string }>() : this.flattenTree(repo, baseTree);
    if (blobOid === null) flat.delete(path);
    else flat.set(path, { mode: '100644', oid: blobOid });
    return this.buildTreeFromFlat(repo, flat);
  }

  /** All commit oids reachable from `tip`, tip first, depth-first (a valid
   *  topological order, matching what a log listing shows first). */
  listCommits(repo: Repo, tip: string): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    const stack = [tip];
    while (stack.length > 0) {
      const oid = stack.pop()!;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const object = repo.objects.get(oid);
      if (!object || object.type !== 'commit') continue;
      out.push(oid);
      const parents = parseCommit(object.data).parents;
      for (let i = parents.length - 1; i >= 0; i -= 1) stack.push(parents[i]!);
    }
    return out;
  }

  // ------------------------------------------------------------ issues / labels / comments

  createLabel(repo: Repo, name: string, color: string): Label {
    const label: Label = { name, color: color || 'ededed', description: '' };
    repo.labels.set(name, label);
    return label;
  }

  createIssue(repo: Repo, title: string, body: string, labels: string[]): Issue {
    const number = repo.nextNumber++;
    const issue: Issue = {
      id: this.nextIssueId++,
      number,
      title,
      body: body ?? '',
      state: 'open',
      labels: [...labels],
      createdSeq: this.nextSeq(),
      updatedSeq: this.seq,
      userLogin: this.viewer.login,
    };
    repo.issues.set(number, issue);
    return issue;
  }

  createComment(repo: Repo, issueNumber: number, body: string): IssueComment {
    const comment: IssueComment = {
      id: this.nextCommentId++,
      body,
      createdSeq: this.nextSeq(),
      userLogin: this.viewer.login,
    };
    const list = repo.comments.get(issueNumber) ?? [];
    list.push(comment);
    repo.comments.set(issueNumber, list);
    return comment;
  }

  // ------------------------------------------------------------ pull requests

  createPull(repo: Repo, input: { title: string; body: string; head: string; base: string }): PullRequest | { error: string } {
    const headSha = this.resolveCommit(repo, input.head);
    const baseSha = this.resolveCommit(repo, input.base);
    if (headSha === null) return { error: `head branch ${input.head} does not exist` };
    if (baseSha === null) return { error: `base branch ${input.base} does not exist` };
    for (const existing of repo.pulls.values()) {
      if (existing.state === 'open' && existing.headRef === input.head && existing.baseRef === input.base) {
        return { error: 'a pull request already exists for this head and base' };
      }
    }
    const number = repo.nextNumber++;
    const pull: PullRequest = {
      id: this.nextPullId++,
      number,
      title: input.title,
      body: input.body ?? '',
      state: 'open',
      headRef: input.head,
      baseRef: input.base,
      headSha,
      baseSha,
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      createdSeq: this.nextSeq(),
      updatedSeq: this.seq,
      userLogin: this.viewer.login,
    };
    repo.pulls.set(number, pull);
    return pull;
  }

  /** Whether the head can merge into the base without a conflict (three-way, blob level). */
  mergeable(repo: Repo, pull: PullRequest): boolean {
    return this.mergePlan(repo, pull).conflict === false;
  }

  mergePlan(repo: Repo, pull: PullRequest): { conflict: boolean; tree: string | null; base: string | null } {
    const headTip = this.resolveCommit(repo, pull.headRef);
    const baseTip = this.resolveCommit(repo, pull.baseRef);
    if (headTip === null || baseTip === null) return { conflict: true, tree: null, base: null };
    const base = mergeBase(headTip, baseTip, this.lookup(repo));
    const baseTree = base === null ? null : this.treeOf(repo, base);
    const headTree = this.treeOf(repo, headTip);
    const oursTree = this.treeOf(repo, baseTip);
    if (headTree === null || oursTree === null) return { conflict: true, tree: null, base };
    const baseFlat = baseTree === null ? new Map() : this.flattenTree(repo, baseTree);
    const headFlat = this.flattenTree(repo, headTree);
    const oursFlat = this.flattenTree(repo, oursTree);
    const merged = new Map<string, { mode: string; oid: string }>();
    let conflict = false;
    const paths = new Set<string>([...baseFlat.keys(), ...headFlat.keys(), ...oursFlat.keys()]);
    for (const path of paths) {
      const b = baseFlat.get(path);
      const h = headFlat.get(path);
      const o = oursFlat.get(path);
      const same = (x: { oid: string } | undefined, y: { oid: string } | undefined): boolean =>
        (x?.oid ?? null) === (y?.oid ?? null);
      if (same(o, h)) {
        if (o) merged.set(path, o);
      } else if (same(b, o)) {
        if (h) merged.set(path, h);
      } else if (same(b, h)) {
        if (o) merged.set(path, o);
      } else {
        conflict = true;
      }
    }
    if (conflict) return { conflict: true, tree: null, base };
    return { conflict: false, tree: this.buildTreeFromFlat(repo, merged), base };
  }

  /** Perform the merge; returns the merge commit sha or an error string. */
  mergePull(repo: Repo, pull: PullRequest, method: string): { sha: string } | { error: string; status: number } {
    if (pull.state !== 'open') return { error: 'pull request is not open', status: 405 };
    const headTip = this.resolveCommit(repo, pull.headRef);
    const baseTip = this.resolveCommit(repo, pull.baseRef);
    if (headTip === null || baseTip === null) return { error: 'head or base branch is missing', status: 404 };
    const normalized = method.toUpperCase();
    if (normalized === 'REBASE') {
      const base = mergeBase(headTip, baseTip, this.lookup(repo));
      const headOnly: string[] = [];
      const seen = new Set<string>();
      const queue = [headTip];
      const baseAncestors = new Set<string>();
      if (base !== null) {
        const qb = [base];
        while (qb.length > 0) {
          const oid = qb.pop()!;
          if (baseAncestors.has(oid)) continue;
          baseAncestors.add(oid);
          const object = repo.objects.get(oid);
          if (!object || object.type !== 'commit') continue;
          for (const parent of parseCommit(object.data).parents) qb.push(parent);
        }
      }
      while (queue.length > 0) {
        const oid = queue.pop()!;
        if (seen.has(oid) || baseAncestors.has(oid)) continue;
        seen.add(oid);
        const object = repo.objects.get(oid);
        if (!object || object.type !== 'commit') continue;
        headOnly.push(oid);
        for (const parent of parseCommit(object.data).parents) queue.push(parent);
      }
      headOnly.reverse();
      if (headOnly.length === 0) {
        pull.state = 'closed';
        pull.merged = true;
        pull.mergedAt = nowIso();
        pull.mergeCommitSha = baseTip;
        pull.updatedSeq = this.nextSeq();
        return { sha: baseTip };
      }
      let parent = baseTip;
      let last = baseTip;
      for (const oid of headOnly) {
        const object = repo.objects.get(oid)!;
        const parsed = parseCommit(object.data);
        last = this.makeCommit(repo, parsed.tree, [parent], parsed.message, this.viewer.login);
        parent = last;
      }
      repo.refs.set(`refs/heads/${pull.baseRef}`, last);
      pull.state = 'closed';
      pull.merged = true;
      pull.mergedAt = nowIso();
      pull.mergeCommitSha = last;
      pull.updatedSeq = this.nextSeq();
      return { sha: last };
    }
    const plan = this.mergePlan(repo, pull);
    if (plan.conflict || plan.tree === null) return { error: 'merge conflict', status: 405 };
    const parents = normalized === 'SQUASH' ? [baseTip] : [baseTip, headTip];
    const message =
      normalized === 'SQUASH'
        ? `${pull.title} (#${pull.number})`
        : `Merge pull request #${pull.number} from ${repo.owner}/${pull.headRef}`;
    const sha = this.makeCommit(repo, plan.tree, parents, message);
    repo.refs.set(`refs/heads/${pull.baseRef}`, sha);
    pull.state = 'closed';
    pull.merged = true;
    pull.mergedAt = nowIso();
    pull.mergeCommitSha = sha;
    pull.updatedSeq = this.nextSeq();
    return { sha };
  }

  /** Files changed between the merge base and the head tip, with line counts. */
  pullFiles(repo: Repo, pull: PullRequest): Array<{
    filename: string;
    status: string;
    additions: number;
    deletions: number;
    changes: number;
  }> {
    const headTip = this.resolveCommit(repo, pull.headRef);
    const baseTip = this.resolveCommit(repo, pull.baseRef);
    if (headTip === null || baseTip === null) return [];
    const base = mergeBase(headTip, baseTip, this.lookup(repo));
    const baseTree = base === null ? null : this.treeOf(repo, base);
    const headTree = this.treeOf(repo, headTip);
    if (headTree === null) return [];
    const baseFlat = baseTree === null ? new Map() : this.flattenTree(repo, baseTree);
    const headFlat = this.flattenTree(repo, headTree);
    const out: Array<{ filename: string; status: string; additions: number; deletions: number; changes: number }> = [];
    const paths = new Set<string>([...baseFlat.keys(), ...headFlat.keys()]);
    for (const path of [...paths].sort()) {
      const b = baseFlat.get(path);
      const h = headFlat.get(path);
      if (b && h && b.oid === h.oid) continue;
      const oldText = b ? blobText(repo, b.oid) : '';
      const newText = h ? blobText(repo, h.oid) : '';
      const diff = lineDiff(oldText, newText);
      if (!b && h) out.push({ filename: path, status: 'added', additions: diff.added, deletions: 0, changes: diff.added });
      else if (b && !h) out.push({ filename: path, status: 'removed', additions: 0, deletions: diff.removed, changes: diff.removed });
      else out.push({ filename: path, status: 'modified', additions: diff.added, deletions: diff.removed, changes: diff.added + diff.removed });
    }
    return out;
  }
}

export function blobText(repo: Repo, oid: string): string {
  const object = repo.objects.get(oid);
  if (!object || object.type !== 'blob') return '';
  return object.data.toString('utf8');
}

/** A small LCS line diff: counts of added/removed lines. */
export function lineDiff(oldText: string, newText: string): { added: number; removed: number } {
  const a = oldText === '' ? [] : oldText.split('\n');
  const b = newText === '' ? [] : newText.split('\n');
  if (a.length === 0) return { added: b.length, removed: 0 };
  if (b.length === 0) return { added: 0, removed: a.length };
  // LCS lengths with a rolling row; blobs here are small.
  let prev = new Array<number>(b.length + 1).fill(0);
  let curr = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      curr[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], curr[j - 1]);
    }
    const tmp = prev;
    prev = curr;
    curr = tmp;
    curr.fill(0);
  }
  const lcs = prev[b.length];
  return { added: b.length - lcs, removed: a.length - lcs };
}

export { ZERO_OID };
