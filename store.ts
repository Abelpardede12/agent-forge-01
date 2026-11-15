// store.ts — the forge itself: an in-memory store of repositories, each with a full git object
// map, mutable refs, and the issue/pull/label/comment records the REST, GraphQL, and MCP
// surfaces share. Identity is single-tenant: one viewer (the token owner), one teammate, one
// stranger, one org — the cast a GitHub-shaped API needs to tell its stories with.

import { buildCommit, buildTree, hashObject, isTreeMode, parseCommit, parseTag, parseTree } from './git.ts';
import type { GitObject, GitObjectType, TreeEntry } from './git.ts';

export interface UserRecord {
  readonly login: string;
  readonly id: number;
  readonly name: string;
  readonly email: string;
  readonly type: 'User' | 'Organization';
}

export const VIEWER: UserRecord = {
  login: 'adaiversen',
  id: 1000,
  name: 'ada iversen',
  email: 'adaiversen@example.invalid',
  type: 'User',
};

export const TEAMMATE: UserRecord = {
  login: 'quinnkeller',
  id: 1001,
  name: 'quinn keller',
  email: 'quinnkeller@example.invalid',
  type: 'User',
};

export const STRANGER: UserRecord = {
  login: 'olgabauer',
  id: 1002,
  name: 'olga bauer',
  email: 'olgabauer@example.invalid',
  type: 'User',
};

export const ORG: UserRecord = {
  login: 'faint-meadow-org',
  id: 2000,
  name: 'faint meadow org',
  email: 'org@faint-meadow-org.example.invalid',
  type: 'Organization',
};

const USERS: readonly UserRecord[] = [VIEWER, TEAMMATE, STRANGER, ORG];

export function findUser(login: string): UserRecord | undefined {
  return USERS.find((user) => user.login === login);
}

/** The default label set GitHub seeds every new repository with: name, color, description. */
export const DEFAULT_LABELS: readonly { name: string; color: string; description: string }[] = [
  { name: 'bug', color: 'd73a4a', description: "Something isn't working" },
  { name: 'documentation', color: '0075ca', description: 'Improvements or additions to documentation' },
  { name: 'duplicate', color: 'cfd3d7', description: 'This issue or pull request already exists' },
  { name: 'enhancement', color: 'a2eeef', description: 'New feature or request' },
  { name: 'good first issue', color: '7057ff', description: 'Good for newcomers' },
  { name: 'help wanted', color: '008672', description: 'Extra attention is needed' },
  { name: 'invalid', color: 'e4e669', description: "This doesn't seem right" },
  { name: 'question', color: 'd876e3', description: 'Further information is requested' },
  { name: 'wontfix', color: 'ffffff', description: 'This will not be worked on' },
];

export interface LabelRecord {
  id: number;
  name: string;
  color: string;
  description: string;
}

export interface CommentRecord {
  id: number;
  body: string;
  author: UserRecord;
  createdAt: number;
}

export interface IssueRecord {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  author: UserRecord;
  labels: string[];
  comments: CommentRecord[];
  createdAt: number;
  updatedAt: number;
  isPull: false;
}

export interface PullRecord {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  author: UserRecord;
  labels: string[];
  comments: CommentRecord[];
  createdAt: number;
  updatedAt: number;
  isPull: true;
  headRef: string;
  baseRef: string;
  merged: boolean;
  mergedAt: number | null;
  mergeCommitSha: string | null;
  mergeMethod: string | null;
}

export type NumberedRecord = IssueRecord | PullRecord;

let nextRepoId = 1;
let nextLabelId = 1;
let nextCommentId = 1;

export class Repo {
  readonly id: number;
  readonly owner: string;
  readonly name: string;
  description = '';
  isPrivate = false;
  readonly createdAt: number;
  objects = new Map<string, GitObject>();
  refs = new Map<string, string>();
  head = 'refs/heads/main';
  labels = new Map<string, LabelRecord>();
  issues = new Map<number, NumberedRecord>();
  nextNumber = 1;

  constructor(owner: string, name: string) {
    this.id = nextRepoId;
    nextRepoId += 1;
    this.owner = owner;
    this.name = name;
    this.createdAt = Date.now();
    for (const seed of DEFAULT_LABELS) {
      this.labels.set(seed.name, { id: nextLabelId, ...seed });
      nextLabelId += 1;
    }
  }

  get fullName(): string {
    return `${this.owner}/${this.name}`;
  }

  /** The branch HEAD names, e.g. "main". */
  get defaultBranch(): string {
    return this.head.replace(/^refs\/heads\//, '');
  }

  /** Commit oid the default branch points at, or undefined while the branch is unborn. */
  headCommit(): string | undefined {
    return this.refs.get(this.head);
  }

  getObject(oid: string): GitObject | undefined {
    return this.objects.get(oid);
  }

  /** Store an object, returning its oid. Storing is idempotent, like git's object database. */
  putObject(type: GitObjectType, data: Uint8Array): string {
    const buffer = Buffer.from(data);
    const oid = hashObject(type, buffer);
    if (!this.objects.has(oid)) this.objects.set(oid, { type, data: buffer });
    return oid;
  }

  /** Follow annotated tags to the object they ultimately name. */
  peel(oid: string): string {
    let current = oid;
    for (let depth = 0; depth < 16; depth += 1) {
      const object = this.objects.get(current);
      if (!object || object.type !== 'tag') return current;
      current = parseTag(object.data).object;
    }
    return current;
  }

  /** Peel to a commit oid, or undefined when the target is not commit-shaped. */
  peelToCommit(oid: string): string | undefined {
    const target = this.peel(oid);
    const object = this.objects.get(target);
    return object && object.type === 'commit' ? target : undefined;
  }

  /**
   * The set of objects reachable from `tips`: commits by ancestry, each commit's tree, and every
   * tree and blob under it. `exclude` seeds the walk with already-known objects (the fetch
   * haves): excluded commits stop the ancestry walk and excluded objects never enter the set.
   */
  closure(tips: readonly string[], exclude?: ReadonlySet<string>): Map<string, GitObject> {
    const out = new Map<string, GitObject>();
    const seen = new Set<string>();
    const stack: string[] = [];
    const push = (oid: string): void => {
      if (seen.has(oid)) return;
      seen.add(oid);
      if (exclude && exclude.has(oid)) return;
      stack.push(oid);
    };
    for (const tip of tips) push(tip);
    // Annotated tags among the tips belong in the set, followed by what they name.
    const tagTips = tips.filter((tip) => this.objects.get(tip)?.type === 'tag');
    for (const tip of tagTips) {
      if (!(exclude && exclude.has(tip))) {
        const tagObject = this.objects.get(tip);
        if (tagObject) out.set(tip, tagObject);
      }
      push(this.peel(tip));
    }
    while (stack.length > 0) {
      const oid = stack.pop()!;
      const object = this.objects.get(oid);
      if (!object) continue;
      out.set(oid, object);
      if (object.type === 'commit') {
        const view = parseCommit(object.data);
        push(view.tree);
        for (const parent of view.parents) push(parent);
      } else if (object.type === 'tree') {
        for (const entry of parseTree(object.data)) push(entry.oid);
      } else if (object.type === 'tag') {
        push(parseTag(object.data).object);
      }
    }
    return out;
  }

  /** Every commit oid reachable from `tip`, tip first, breadth over ancestry. */
  ancestors(tip: string): Set<string> {
    const out = new Set<string>();
    const stack = [tip];
    while (stack.length > 0) {
      const oid = stack.pop()!;
      if (out.has(oid)) continue;
      const object = this.objects.get(oid);
      if (!object || object.type !== 'commit') continue;
      out.add(oid);
      for (const parent of parseCommit(object.data).parents) stack.push(parent);
    }
    return out;
  }

  /** True when `ancestor` is reachable from `descendant` (inclusive). */
  isAncestor(ancestor: string, descendant: string): boolean {
    if (ancestor === descendant) return true;
    return this.ancestors(descendant).has(ancestor);
  }

  /**
   * Shallow-clone closure: the commits within `depth` generations of the tips, plus the full
   * tree/blob closure of every included commit. Boundary commits (exactly at depth) are named
   * in `boundary` so the caller can report them as shallow.
   */
  shallowClosure(
    tips: readonly string[],
    depth: number,
  ): { objects: Map<string, GitObject>; boundary: Set<string> } {
    const levels = new Map<string, number>();
    const queue: { oid: string; level: number }[] = [];
    for (const tip of tips) {
      const commit = this.peelToCommit(tip);
      if (commit) queue.push({ oid: commit, level: 1 });
    }
    const boundary = new Set<string>();
    const included: string[] = [];
    while (queue.length > 0) {
      const { oid, level } = queue.shift()!;
      if (levels.has(oid) && levels.get(oid)! <= level) continue;
      levels.set(oid, level);
      included.push(oid);
      if (level >= depth) {
        boundary.add(oid);
        continue;
      }
      const object = this.objects.get(oid);
      if (!object || object.type !== 'commit') continue;
      for (const parent of parseCommit(object.data).parents) {
        queue.push({ oid: parent, level: level + 1 });
      }
    }
    // Tags riding along: include the tag objects for tips that are tags.
    const objects = new Map<string, GitObject>();
    for (const tip of tips) {
      const object = this.objects.get(tip);
      if (object && object.type === 'tag') objects.set(tip, object);
    }
    const stack: string[] = [...included];
    const seen = new Set<string>();
    while (stack.length > 0) {
      const oid = stack.pop()!;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const object = this.objects.get(oid);
      if (!object) continue;
      if (object.type === 'commit' && !levels.has(oid)) continue; // a parent past the boundary
      objects.set(oid, object);
      if (object.type === 'commit') {
        stack.push(parseCommit(object.data).tree);
      } else if (object.type === 'tree') {
        for (const entry of parseTree(object.data)) stack.push(entry.oid);
      } else if (object.type === 'tag') {
        stack.push(parseTag(object.data).object);
      }
    }
    return { objects, boundary };
  }

  /** Flatten a tree into path -> entry, recursing into subtrees. */
  flattenTree(treeOid: string, prefix = ''): Map<string, TreeEntry & { path: string }> {
    const out = new Map<string, TreeEntry & { path: string }>();
    const object = this.objects.get(treeOid);
    if (!object || object.type !== 'tree') return out;
    for (const entry of parseTree(object.data)) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (isTreeMode(entry.mode)) {
        for (const [sub, value] of this.flattenTree(entry.oid, path)) out.set(sub, value);
      } else {
        out.set(path, { ...entry, path });
      }
    }
    return out;
  }

  /** Write a flattened path map back into nested tree objects; returns the root tree oid. */
  unflattenTree(files: ReadonlyMap<string, { mode: string; oid: string }>): string {
    interface Dir {
      entries: Map<string, TreeEntry>;
      dirs: Map<string, Dir>;
    }
    const root: Dir = { entries: new Map(), dirs: new Map() };
    for (const [path, file] of files) {
      const parts = path.split('/');
      let dir = root;
      for (const part of parts.slice(0, -1)) {
        if (!dir.dirs.has(part)) dir.dirs.set(part, { entries: new Map(), dirs: new Map() });
        dir = dir.dirs.get(part)!;
      }
      dir.entries.set(parts[parts.length - 1], { mode: file.mode, name: parts[parts.length - 1], oid: file.oid });
    }
    const build = (dir: Dir): string => {
      const entries: TreeEntry[] = [...dir.entries.values()];
      for (const [name, sub] of dir.dirs) {
        entries.push({ mode: '40000', name, oid: build(sub) });
      }
      return this.putObject('tree', buildTree(entries));
    };
    return build(root);
  }

  /** The best common ancestor of two commits, or undefined when histories are unrelated. */
  mergeBase(a: string, b: string): string | undefined {
    const ancestorsA = this.ancestors(a);
    const queue = [b];
    const seen = new Set<string>();
    while (queue.length > 0) {
      const oid = queue.shift()!;
      if (seen.has(oid)) continue;
      seen.add(oid);
      if (ancestorsA.has(oid)) return oid;
      const object = this.objects.get(oid);
      if (object && object.type === 'commit') queue.push(...parseCommit(object.data).parents);
    }
    return undefined;
  }

  addComment(record: NumberedRecord, body: string, author: UserRecord): CommentRecord {
    const comment: CommentRecord = { id: nextCommentId, body, author, createdAt: Date.now() };
    nextCommentId += 1;
    record.comments.push(comment);
    record.updatedAt = Math.max(record.updatedAt + 1, Date.now());
    return comment;
  }
}

/** Render a git identity line for the viewer at a moment in time. */
export function viewerIdentity(at: Date = new Date()): string {
  const seconds = Math.floor(at.getTime() / 1000);
  return `${VIEWER.name} <${VIEWER.email}> ${seconds} +0000`;
}

// ------------------------------------------------------------------ global ids

/** Global ids are opaque base64 "Type:payload" strings, stable across every surface. */
export function encodeGlobalId(type: string, payload: string | number): string {
  return Buffer.from(`${type}:${payload}`, 'utf8').toString('base64');
}

export function decodeGlobalId(id: string): { type: string; payload: string } | undefined {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const split = text.indexOf(':');
    if (split <= 0) return undefined;
    return { type: text.slice(0, split), payload: text.slice(split + 1) };
  } catch {
    return undefined;
  }
}

export function repoNodeId(repo: Repo): string {
  return encodeGlobalId('Repository', repo.id);
}

export function issueNodeId(repo: Repo, number: number): string {
  return encodeGlobalId('Issue', `${repo.id}:${number}`);
}

export function pullNodeId(repo: Repo, number: number): string {
  return encodeGlobalId('PullRequest', `${repo.id}:${number}`);
}

export function commentNodeId(comment: CommentRecord): string {
  return encodeGlobalId('IssueComment', comment.id);
}

export function userNodeId(user: UserRecord): string {
  return encodeGlobalId('User', user.id);
}

// ------------------------------------------------------------------ the forge

export class Forge {
  repos = new Map<string, Repo>();
  private repoById = new Map<number, Repo>();

  createRepo(owner: string, name: string): Repo {
    const key = `${owner}/${name}`;
    const existing = this.repos.get(key);
    if (existing) return existing;
    const repo = new Repo(owner, name);
    this.repos.set(key, repo);
    this.repoById.set(repo.id, repo);
    return repo;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(`${owner}/${name}`);
  }

  getRepoById(id: number): Repo | undefined {
    return this.repoById.get(id);
  }

  deleteRepo(owner: string, name: string): boolean {
    const repo = this.getRepo(owner, name);
    if (!repo) return false;
    this.repos.delete(`${owner}/${name}`);
    this.repoById.delete(repo.id);
    return true;
  }

  /** Repos owned by a login, in creation order. */
  reposOf(owner: string): Repo[] {
    return [...this.repos.values()].filter((repo) => repo.owner === owner);
  }
}

/** The one forge instance every surface shares. */
export const forge = new Forge();
