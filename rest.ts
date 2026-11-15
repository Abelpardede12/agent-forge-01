// rest.ts — the REST v3 surface: repositories, contents, branches, commits, issues, comments,
// and pull requests with real merges computed over the object graph. Every handler returns
// GitHub-shaped JSON; errors carry a `message`, and the merge machinery below is shared with
// the GraphQL and MCP surfaces so all three always agree about what a merge did.

import { buildCommit, buildTree, hashObject, identityTimestamp, parseCommit, parseTag, parseTree } from './git.ts';
import type { TreeEntry } from './git.ts';
import { forge, ORG, repoNodeId, STRANGER, TEAMMATE, VIEWER, viewerIdentity } from './store.ts';
import type { IssueRecord, NumberedRecord, PullRecord, Repo, UserRecord } from './store.ts';

export interface RestResult {
  readonly status: number;
  readonly body: unknown;
}

const ok = (body: unknown, status = 200): RestResult => ({ status, body });
const fail = (status: number, message: string): RestResult => ({ status, body: { message } });
export const notFound = (message = 'Not Found'): RestResult => fail(404, message);
export const unprocessable = (message: string): RestResult => fail(422, message);

export function userJson(user: UserRecord): Record<string, unknown> {
  return { login: user.login, id: user.id, type: user.type, name: user.name, email: user.email };
}

export function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: repoNodeId(repo),
    name: repo.name,
    full_name: repo.fullName,
    owner: userJson(ownerOf(repo)),
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    html_url: `https://forge.example/${repo.fullName}`,
    clone_url: `https://forge.example/${repo.fullName}.git`,
    created_at: new Date(repo.createdAt).toISOString(),
    updated_at: new Date(repo.createdAt).toISOString(),
    has_issues: true,
    has_projects: true,
    has_wiki: true,
    open_issues_count: [...repo.issues.values()].filter((issue) => issue.state === 'open').length,
  };
}

function ownerOf(repo: Repo): UserRecord {
  if (repo.owner === TEAMMATE.login) return TEAMMATE;
  if (repo.owner === STRANGER.login) return STRANGER;
  if (repo.owner === ORG.login) return ORG;
  return VIEWER;
}

export function labelJson(repo: Repo, name: string): Record<string, unknown> | undefined {
  const label = repo.labels.get(name);
  if (!label) return undefined;
  return { id: label.id, name: label.name, color: label.color, description: label.description };
}

export function issueJson(repo: Repo, record: NumberedRecord): Record<string, unknown> {
  const base: Record<string, unknown> = {
    id: repo.id * 100000 + record.number,
    node_id: `issue-${repo.id}-${record.number}`,
    number: record.number,
    title: record.title,
    body: record.body,
    state: record.state,
    user: userJson(record.author),
    labels: record.labels.map((name) => labelJson(repo, name)).filter(Boolean),
    comments: record.comments.length,
    created_at: new Date(record.createdAt).toISOString(),
    updated_at: new Date(record.updatedAt).toISOString(),
    closed_at: record.state === 'closed' ? new Date(record.updatedAt).toISOString() : null,
    html_url: `https://forge.example/${repo.fullName}/issues/${record.number}`,
  };
  if (record.isPull) {
    base.pull_request = { url: `https://forge.example/api/v3/repos/${repo.fullName}/pulls/${record.number}` };
    base.head = { ref: record.headRef, sha: branchTip(repo, record.headRef) ?? '' };
    base.base = { ref: record.baseRef, sha: branchTip(repo, record.baseRef) ?? '' };
    base.merged = record.merged;
    base.merged_at = record.mergedAt ? new Date(record.mergedAt).toISOString() : null;
    base.merge_commit_sha = record.mergeCommitSha;
  }
  return base;
}

export function commentJson(repo: Repo, record: NumberedRecord, comment: { id: number; body: string; author: UserRecord; createdAt: number }): Record<string, unknown> {
  return {
    id: comment.id,
    node_id: `comment-${comment.id}`,
    body: comment.body,
    user: userJson(comment.author),
    created_at: new Date(comment.createdAt).toISOString(),
    updated_at: new Date(comment.createdAt).toISOString(),
    html_url: `https://forge.example/${repo.fullName}/issues/${record.number}#issuecomment-${comment.id}`,
  };
}

export function branchTip(repo: Repo, ref: string): string | undefined {
  const name = ref.startsWith('refs/') ? ref : `refs/heads/${ref}`;
  const oid = repo.refs.get(name);
  return oid ? repo.peelToCommit(oid) ?? oid : undefined;
}

/** Resolve a ref-ish (branch name, tag name, full ref, or raw oid) to a commit oid. */
export function resolveCommit(repo: Repo, ref: string): string | undefined {
  const candidates = [ref, `refs/heads/${ref}`, `refs/tags/${ref}`, `refs/${ref}`];
  for (const candidate of candidates) {
    const oid = repo.refs.get(candidate);
    if (oid) {
      const commit = repo.peelToCommit(oid);
      if (commit) return commit;
    }
  }
  if (/^[0-9a-f]{40}$/.test(ref)) {
    const commit = repo.peelToCommit(ref);
    if (commit) return commit;
    const object = repo.getObject(ref);
    if (object && object.type === 'commit') return ref;
  }
  return undefined;
}

// ------------------------------------------------------------------ repositories

export function createRepo(body: Record<string, unknown>): RestResult {
  const name = typeof body.name === 'string' ? body.name : '';
  if (!name) return unprocessable('name is required');
  if (forge.getRepo(VIEWER.login, name)) return unprocessable('name already exists on this account');
  const repo = forge.createRepo(VIEWER.login, name);
  if (typeof body.description === 'string') repo.description = body.description;
  if (typeof body.private === 'boolean') repo.isPrivate = body.private;
  return ok(repoJson(repo), 201);
}

export function listUserRepos(query: URLSearchParams): RestResult {
  const repos = forge.reposOf(VIEWER.login);
  return ok(paginate(repos.map((repo) => repoJson(repo)), query, repos.length));
}

/** GitHub-style pagination: slice by page/per_page; Link headers are added by the app layer. */
export function paginate<T>(items: T[], query: URLSearchParams, total?: number): T[] {
  const perPage = Math.max(1, Math.min(100, Number(query.get('per_page') ?? '30') || 30));
  const page = Math.max(1, Number(query.get('page') ?? '1') || 1);
  void total;
  return items.slice((page - 1) * perPage, page * perPage);
}

export function pageCount(total: number, query: URLSearchParams): number {
  const perPage = Math.max(1, Math.min(100, Number(query.get('per_page') ?? '30') || 30));
  return Math.max(1, Math.ceil(total / perPage));
}

export function getRepo(owner: string, name: string): RestResult {
  const repo = forge.getRepo(owner, name);
  if (!repo) return notFound();
  return ok(repoJson(repo));
}

export function patchRepo(owner: string, name: string, body: Record<string, unknown>): RestResult {
  const repo = forge.getRepo(owner, name);
  if (!repo) return notFound();
  if (typeof body.description === 'string') repo.description = body.description;
  if (typeof body.private === 'boolean') repo.isPrivate = body.private;
  if (typeof body.name === 'string' && body.name && body.name !== repo.name) {
    forge.deleteRepo(owner, name);
    const moved = forge.createRepo(repo.owner, body.name);
    moved.description = repo.description;
    moved.isPrivate = repo.isPrivate;
    moved.objects = repo.objects;
    moved.refs = repo.refs;
    moved.head = repo.head;
    moved.labels = repo.labels;
    moved.issues = repo.issues;
    moved.nextNumber = repo.nextNumber;
    return ok(repoJson(moved));
  }
  return ok(repoJson(repo));
}

export function deleteRepo(owner: string, name: string): RestResult {
  if (!forge.deleteRepo(owner, name)) return notFound();
  return { status: 204, body: null };
}

export function listBranches(repo: Repo): RestResult {
  const branches = [...repo.refs.keys()]
    .filter((ref) => ref.startsWith('refs/heads/'))
    .map((ref) => ({
      name: ref.replace(/^refs\/heads\//, ''),
      commit: { sha: repo.refs.get(ref) },
      protected: false,
    }));
  return ok(branches);
}

export function createRef(repo: Repo, body: Record<string, unknown>): RestResult {
  const ref = typeof body.ref === 'string' ? body.ref : '';
  const sha = typeof body.sha === 'string' ? body.sha : '';
  if (!ref.startsWith('refs/')) return unprocessable('ref must be fully qualified');
  if (!repo.getObject(sha)) return unprocessable('sha does not name an object');
  repo.refs.set(ref, sha);
  return ok({ ref, node_id: `ref-${repo.id}-${ref}`, url: '', object: { sha, type: repo.getObject(sha)?.type } }, 201);
}

export function listCommits(repo: Repo, query: URLSearchParams): RestResult {
  const sha = query.get('sha') ?? repo.defaultBranch;
  const start = resolveCommit(repo, sha);
  if (!start) return ok([]);
  const commits: Record<string, unknown>[] = [];
  const seen = new Set<string>();
  const queue = [start];
  while (queue.length > 0 && commits.length < 500) {
    const oid = queue.shift()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = repo.getObject(oid);
    if (!object || object.type !== 'commit') continue;
    const view = parseCommit(object.data);
    commits.push(commitJson(repo, oid));
    queue.push(...view.parents);
  }
  commits.sort((a, b) => ((b.commit as Record<string, unknown>).committer as Record<string, unknown>).date as string < (((a.commit as Record<string, unknown>).committer as Record<string, unknown>).date as string) ? -1 : 1);
  return ok(paginate(commits, query));
}

export function commitJson(repo: Repo, oid: string): Record<string, unknown> {
  const object = repo.getObject(oid);
  if (!object || object.type !== 'commit') return { sha: oid };
  const view = parseCommit(object.data);
  const nameOf = (identity: string): string => identity.replace(/ <.*>$/, '');
  const emailOf = (identity: string): string => /<([^>]*)>/.exec(identity)?.[1] ?? '';
  const dateOf = (identity: string): string => new Date(identityTimestamp(identity) * 1000).toISOString();
  return {
    sha: oid,
    node_id: `commit-${oid}`,
    commit: {
      tree: { sha: view.tree },
      message: view.message.replace(/\n$/, ''),
      author: { name: nameOf(view.author), email: emailOf(view.author), date: dateOf(view.author) },
      committer: { name: nameOf(view.committer), email: emailOf(view.committer), date: dateOf(view.committer) },
    },
    parents: view.parents.map((parent) => ({ sha: parent })),
    author: userJson(VIEWER),
    committer: userJson(VIEWER),
  };
}

// ------------------------------------------------------------------ contents

interface ContentsEntry {
  name: string;
  path: string;
  sha: string;
  type: 'file' | 'dir';
  mode: string;
}

function contentsEntry(repo: Repo, treeOid: string, path: string): ContentsEntry[] | RestResult {
  const object = repo.getObject(treeOid);
  if (!object || object.type !== 'tree') return notFound();
  return parseTree(object.data).map((entry) => ({
    name: entry.name,
    path: path ? `${path}/${entry.name}` : entry.name,
    sha: entry.oid,
    type: entry.mode === '40000' || entry.mode === '040000' ? 'dir' : 'file',
    mode: entry.mode,
  }));
}

/** Walk to the tree or blob at `path` under a commit; returns the oid and whether it is a tree. */
function walkPath(repo: Repo, commitOid: string, path: string): { oid: string; isTree: boolean; mode: string } | undefined {
  const commit = repo.getObject(commitOid);
  if (!commit || commit.type !== 'commit') return undefined;
  let oid = parseCommit(commit.data).tree;
  let mode = '40000';
  if (!path) return { oid, isTree: true, mode };
  for (const part of path.split('/').filter(Boolean)) {
    const object = repo.getObject(oid);
    if (!object || object.type !== 'tree') return undefined;
    const entry = parseTree(object.data).find((candidate) => candidate.name === part);
    if (!entry) return undefined;
    oid = entry.oid;
    mode = entry.mode;
  }
  const object = repo.getObject(oid);
  return { oid, isTree: object?.type === 'tree', mode };
}

export function getContents(repo: Repo, path: string, query: URLSearchParams): RestResult {
  const ref = query.get('ref') ?? repo.defaultBranch;
  const commit = resolveCommit(repo, ref);
  if (!commit) {
    // An unborn branch reads as an empty listing at the root and a 404 anywhere deeper.
    return path ? notFound() : ok([]);
  }
  const found = walkPath(repo, commit, path);
  if (!found) return notFound();
  if (found.isTree) {
    const entries = contentsEntry(repo, found.oid, path);
    if (!Array.isArray(entries)) return entries;
    return ok(entries.map((entry) => ({
      name: entry.name,
      path: entry.path,
      sha: entry.sha,
      type: entry.type,
      size: entry.type === 'file' ? repo.getObject(entry.sha)?.data.length ?? 0 : 0,
      download_url: null,
    })));
  }
  const blob = repo.getObject(found.oid);
  if (!blob) return notFound();
  return ok({
    name: path.split('/').pop(),
    path,
    sha: found.oid,
    type: 'file',
    size: blob.data.length,
    encoding: 'base64',
    content: blob.data.toString('base64'),
  });
}

/** Commit a new tree onto a branch: the shared write path for contents PUT/DELETE. */
function commitTree(repo: Repo, branch: string, treeOid: string, message: string): string {
  const ref = `refs/heads/${branch}`;
  const parent = repo.refs.get(ref);
  const parentCommit = parent ? repo.peelToCommit(parent) : undefined;
  const identity = viewerIdentity();
  const commit = buildCommit({
    tree: treeOid,
    parents: parentCommit ? [parentCommit] : [],
    author: identity,
    committer: identity,
    message,
  });
  const oid = repo.putObject('commit', commit);
  repo.refs.set(ref, oid);
  return oid;
}

export function putContents(repo: Repo, path: string, body: Record<string, unknown>): RestResult {
  const branch = typeof body.branch === 'string' ? body.branch : repo.defaultBranch;
  const message = typeof body.message === 'string' ? body.message : `Update ${path}`;
  const content = typeof body.content === 'string' ? body.content : '';
  const blobOid = repo.putObject('blob', Buffer.from(content.replace(/\s+/g, ''), 'base64'));
  const headCommit = branchTip(repo, branch);
  const files = new Map<string, { mode: string; oid: string }>();
  if (headCommit) {
    const commit = repo.getObject(headCommit);
    if (commit && commit.type === 'commit') {
      for (const [filePath, entry] of repo.flattenTree(parseCommit(commit.data).tree)) {
        files.set(filePath, { mode: entry.mode, oid: entry.oid });
      }
    }
  }
  const existing = files.get(path);
  if (existing && typeof body.sha === 'string' && body.sha !== existing.oid) {
    return fail(409, 'Conflict: the file has changed since it was read');
  }
  files.set(path, { mode: existing?.mode ?? '100644', oid: blobOid });
  const treeOid = repo.unflattenTree(files);
  const commitOid = commitTree(repo, branch, treeOid, message);
  const blob = repo.getObject(blobOid);
  return ok({
    content: {
      name: path.split('/').pop(),
      path,
      sha: blobOid,
      type: 'file',
      encoding: 'base64',
      size: blob?.data.length ?? 0,
    },
    commit: { sha: commitOid },
  }, existing ? 200 : 201);
}

export function deleteContents(repo: Repo, path: string, body: Record<string, unknown>): RestResult {
  const branch = typeof body.branch === 'string' ? body.branch : repo.defaultBranch;
  const message = typeof body.message === 'string' ? body.message : `Delete ${path}`;
  const headCommit = branchTip(repo, branch);
  if (!headCommit) return notFound();
  const commit = repo.getObject(headCommit);
  if (!commit || commit.type !== 'commit') return notFound();
  const files = new Map<string, { mode: string; oid: string }>();
  for (const [filePath, entry] of repo.flattenTree(parseCommit(commit.data).tree)) {
    files.set(filePath, { mode: entry.mode, oid: entry.oid });
  }
  if (!files.has(path)) return notFound();
  files.delete(path);
  const treeOid = repo.unflattenTree(files);
  const commitOid = commitTree(repo, branch, treeOid, message);
  return ok({ content: null, commit: { sha: commitOid } });
}

// ------------------------------------------------------------------ issues and labels

export function createIssue(repo: Repo, body: Record<string, unknown>): RestResult {
  const title = typeof body.title === 'string' ? body.title : '';
  if (!title) return unprocessable('title is required');
  const labels = Array.isArray(body.labels) ? body.labels.filter((label): label is string => typeof label === 'string') : [];
  for (const label of labels) {
    if (!repo.labels.has(label)) return unprocessable(`label '${label}' does not exist`);
  }
  const now = Date.now();
  const record: IssueRecord = {
    number: repo.nextNumber,
    title,
    body: typeof body.body === 'string' ? body.body : '',
    state: 'open',
    author: VIEWER,
    labels: [...labels],
    comments: [],
    createdAt: now,
    updatedAt: now,
    isPull: false,
  };
  repo.nextNumber += 1;
  repo.issues.set(record.number, record);
  return ok(issueJson(repo, record), 201);
}

export function listIssues(repo: Repo, query: URLSearchParams, pullsOnly: boolean): RestResult {
  const state = query.get('state') ?? 'open';
  const sort = query.get('sort') ?? 'created';
  const direction = query.get('direction') ?? 'desc';
  let records = [...repo.issues.values()].filter((record) => (pullsOnly ? record.isPull : true));
  if (!pullsOnly) records = records.filter((record) => !record.isPull || query.get('pulls') === 'true');
  if (state === 'open' || state === 'closed') records = records.filter((record) => record.state === state);
  const key = (record: NumberedRecord): number => (sort === 'updated' ? record.updatedAt : record.createdAt);
  records.sort((a, b) => (direction === 'asc' ? key(a) - key(b) || a.number - b.number : key(b) - key(a) || b.number - a.number));
  return ok(paginate(records.map((record) => issueJson(repo, record)), query));
}

export function getIssue(repo: Repo, number: number): RestResult {
  const record = repo.issues.get(number);
  if (!record) return notFound();
  return ok(issueJson(repo, record));
}

export function patchIssue(repo: Repo, number: number, body: Record<string, unknown>): RestResult {
  const record = repo.issues.get(number);
  if (!record) return notFound();
  if (typeof body.title === 'string') record.title = body.title;
  if (typeof body.body === 'string') record.body = body.body;
  if (body.state === 'open' || body.state === 'closed') record.state = body.state;
  if (Array.isArray(body.labels)) {
    const labels = body.labels.filter((label): label is string => typeof label === 'string');
    for (const label of labels) {
      if (!repo.labels.has(label)) return unprocessable(`label '${label}' does not exist`);
    }
    record.labels = labels;
  }
  record.updatedAt = Math.max(record.updatedAt + 1, Date.now());
  return ok(issueJson(repo, record));
}

export function addLabels(repo: Repo, number: number, body: Record<string, unknown>): RestResult {
  const record = repo.issues.get(number);
  if (!record) return notFound();
  const labels = Array.isArray(body.labels) ? body.labels.filter((label): label is string => typeof label === 'string') : [];
  for (const label of labels) {
    if (!repo.labels.has(label)) return unprocessable(`label '${label}' does not exist`);
  }
  for (const label of labels) {
    if (!record.labels.includes(label)) record.labels.push(label);
  }
  record.updatedAt = Math.max(record.updatedAt + 1, Date.now());
  return ok(record.labels.map((name) => labelJson(repo, name)).filter(Boolean));
}

export function listLabels(repo: Repo): RestResult {
  return ok([...repo.labels.values()].map((label) => ({ id: label.id, name: label.name, color: label.color, description: label.description })));
}

export function createLabel(repo: Repo, body: Record<string, unknown>): RestResult {
  const name = typeof body.name === 'string' ? body.name : '';
  if (!name) return unprocessable('name is required');
  const color = typeof body.color === 'string' ? body.color.replace(/^#/, '') : 'ededed';
  const description = typeof body.description === 'string' ? body.description : '';
  const existing = repo.labels.get(name);
  if (existing) {
    // Creating a label that already exists refreshes it and still answers 201: the forge
    // seeds GitHub's default set, and clients create their working labels unconditionally.
    existing.color = color;
    if (description) existing.description = description;
    return ok({ id: existing.id, name: existing.name, color: existing.color, description: existing.description }, 201);
  }
  const label = { id: 9000 + repo.labels.size, name, color, description };
  repo.labels.set(name, label);
  return ok(label, 201);
}

export function createComment(repo: Repo, number: number, body: Record<string, unknown>): RestResult {
  const record = repo.issues.get(number);
  if (!record) return notFound();
  const text = typeof body.body === 'string' ? body.body : '';
  if (!text) return unprocessable('body is required');
  const comment = repo.addComment(record, text, VIEWER);
  return ok(commentJson(repo, record, comment), 201);
}

export function listComments(repo: Repo, number: number): RestResult {
  const record = repo.issues.get(number);
  if (!record) return notFound();
  return ok(record.comments.map((comment) => commentJson(repo, record, comment)));
}

// ------------------------------------------------------------------ pulls and merging

export function createPull(repo: Repo, body: Record<string, unknown>): RestResult {
  const head = typeof body.head === 'string' ? body.head : '';
  const base = typeof body.base === 'string' ? body.base : '';
  const title = typeof body.title === 'string' ? body.title : '';
  if (!head || !base) return unprocessable('head and base are required');
  if (!branchTip(repo, head)) return unprocessable(`head branch '${head}' does not exist`);
  if (!branchTip(repo, base)) return unprocessable(`base branch '${base}' does not exist`);
  const now = Date.now();
  const record: PullRecord = {
    number: repo.nextNumber,
    title,
    body: typeof body.body === 'string' ? body.body : '',
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
  return ok(issueJson(repo, record), 201);
}

/** Per-file change statistics between two commits, by flattened path comparison. */
export function diffFiles(repo: Repo, baseCommit: string, headCommit: string): { filename: string; status: string; additions: number; deletions: number; changes: number }[] {
  const baseObject = repo.getObject(baseCommit);
  const headObject = repo.getObject(headCommit);
  if (!baseObject || baseObject.type !== 'commit' || !headObject || headObject.type !== 'commit') return [];
  const baseFiles = repo.flattenTree(parseCommit(baseObject.data).tree);
  const headFiles = repo.flattenTree(parseCommit(headObject.data).tree);
  const paths = new Set([...baseFiles.keys(), ...headFiles.keys()]);
  const files: { filename: string; status: string; additions: number; deletions: number; changes: number }[] = [];
  const countLines = (oid: string | undefined): number => {
    if (!oid) return 0;
    const blob = repo.getObject(oid);
    if (!blob) return 0;
    const text = blob.data.toString('utf8');
    if (text.length === 0) return 0;
    return text.endsWith('\n') ? text.split('\n').length - 1 : text.split('\n').length;
  };
  for (const path of [...paths].sort()) {
    const before = baseFiles.get(path);
    const after = headFiles.get(path);
    if (before && after && before.oid === after.oid) continue;
    const status = !before ? 'added' : !after ? 'removed' : 'modified';
    const additions = countLines(after?.oid);
    const deletions = countLines(before?.oid);
    files.push({ filename: path, status, additions, deletions, changes: additions + deletions });
  }
  return files;
}

export function listPullFiles(repo: Repo, number: number): RestResult {
  const record = repo.issues.get(number);
  if (!record || !record.isPull) return notFound();
  const base = branchTip(repo, record.baseRef);
  const head = branchTip(repo, record.headRef);
  if (!base || !head) return ok([]);
  const headObject = repo.getObject(head);
  const headFiles = headObject && headObject.type === 'commit'
    ? repo.flattenTree(parseCommit(headObject.data).tree)
    : new Map<string, TreeEntry & { path: string }>();
  return ok(diffFiles(repo, base, head).map((file) => ({ ...file, sha: headFiles.get(file.filename)?.oid ?? '' })));
}

export type MergeOutcome =
  | { readonly kind: 'merged'; readonly sha: string }
  | { readonly kind: 'conflict' }
  | { readonly kind: 'not-found' }
  | { readonly kind: 'already' };

/**
 * Merge a pull the GitHub way: `merge` writes a two-parent merge commit, `squash` writes the
 * combined tree as one commit on the base, `rebase` replays the head's own commits. Conflicts
 * are the classic three-way rule: a path changed on both sides to different blobs conflicts.
 */
export function mergePull(repo: Repo, record: PullRecord, method: string): MergeOutcome {
  if (record.merged) return { kind: 'already' };
  const baseTip = branchTip(repo, record.baseRef);
  const headTip = branchTip(repo, record.headRef);
  if (!baseTip || !headTip) return { kind: 'not-found' };
  const base = repo.mergeBase(baseTip, headTip);
  const baseFiles = new Map<string, { mode: string; oid: string }>();
  const headFiles = new Map<string, { mode: string; oid: string }>();
  const ontoFiles = new Map<string, { mode: string; oid: string }>();
  const flattenInto = (commit: string | undefined, into: Map<string, { mode: string; oid: string }>): void => {
    if (!commit) return;
    const object = repo.getObject(commit);
    if (!object || object.type !== 'commit') return;
    for (const [path, entry] of repo.flattenTree(parseCommit(object.data).tree)) {
      into.set(path, { mode: entry.mode, oid: entry.oid });
    }
  };
  flattenInto(base, baseFiles);
  flattenInto(headTip, headFiles);
  flattenInto(baseTip, ontoFiles);
  const merged = new Map(ontoFiles);
  const paths = new Set([...baseFiles.keys(), ...headFiles.keys(), ...ontoFiles.keys()]);
  for (const path of paths) {
    const inBase = baseFiles.get(path);
    const inHead = headFiles.get(path);
    const inOnto = ontoFiles.get(path);
    const headChanged = (inHead?.oid ?? '') !== (inBase?.oid ?? '');
    const ontoChanged = (inOnto?.oid ?? '') !== (inBase?.oid ?? '');
    if (headChanged && ontoChanged && (inHead?.oid ?? '') !== (inOnto?.oid ?? '')) {
      return { kind: 'conflict' };
    }
    if (headChanged) {
      if (inHead) merged.set(path, inHead);
      else merged.delete(path);
    }
  }
  const treeOid = repo.unflattenTree(merged);
  const identity = viewerIdentity();
  const title = record.title || `Pull request #${record.number}`;
  let commitOid: string;
  if (method === 'rebase') {
    commitOid = rebaseOnto(repo, baseTip, headTip, base);
    if (!commitOid) return { kind: 'conflict' };
  } else if (method === 'squash') {
    const data = buildCommit({
      tree: treeOid,
      parents: [baseTip],
      author: identity,
      committer: identity,
      message: `${title} (#${record.number})`,
    });
    commitOid = repo.putObject('commit', data);
  } else {
    const data = buildCommit({
      tree: treeOid,
      parents: [baseTip, headTip],
      author: identity,
      committer: identity,
      message: `Merge pull request #${record.number} from ${record.headRef}`,
    });
    commitOid = repo.putObject('commit', data);
  }
  repo.refs.set(`refs/heads/${record.baseRef}`, commitOid);
  record.merged = true;
  record.mergedAt = Date.now();
  record.mergeCommitSha = commitOid;
  record.mergeMethod = method;
  record.state = 'closed';
  record.updatedAt = Math.max(record.updatedAt + 1, Date.now());
  return { kind: 'merged', sha: commitOid };
}

/** Replay the head-side commits (oldest first) onto the base tip; undefined on a content clash. */
function rebaseOnto(repo: Repo, baseTip: string, headTip: string, mergeBase: string | undefined): string | undefined {
  const chain: string[] = [];
  const ancestorsOfBase = repo.ancestors(baseTip);
  const stack = [headTip];
  const seen = new Set<string>();
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (seen.has(oid) || ancestorsOfBase.has(oid)) continue;
    seen.add(oid);
    if (mergeBase && oid === mergeBase) continue;
    const object = repo.getObject(oid);
    if (!object || object.type !== 'commit') continue;
    chain.push(oid);
    stack.push(...parseCommit(object.data).parents);
  }
  chain.reverse();
  // Order the chain by ancestry: repeatedly take a commit whose parents are all placed.
  const placed = new Set<string>([mergeBase ?? '']);
  const ordered: string[] = [];
  const pending = [...chain];
  let guard = 0;
  while (pending.length > 0 && guard < 1000) {
    guard += 1;
    const index = pending.findIndex((oid) => {
      const view = parseCommit(repo.getObject(oid)!.data as Buffer);
      return view.parents.every((parent) => placed.has(parent) || !chain.includes(parent));
    });
    if (index < 0) break;
    const [oid] = pending.splice(index, 1);
    ordered.push(oid);
    placed.add(oid);
  }
  let current = baseTip;
  for (const oid of ordered) {
    const view = parseCommit(repo.getObject(oid)!.data as Buffer);
    const data = buildCommit({
      tree: view.tree,
      parents: [current],
      author: view.author,
      committer: viewerIdentity(),
      message: view.message,
    });
    current = repo.putObject('commit', data);
  }
  return current;
}

export function mergePullRest(repo: Repo, number: number, body: Record<string, unknown>): RestResult {
  const record = repo.issues.get(number);
  if (!record || !record.isPull) return notFound('Pull request not found');
  const method = typeof body.merge_method === 'string' ? body.merge_method : 'merge';
  const outcome = mergePull(repo, record, method);
  if (outcome.kind === 'not-found') return notFound('Pull request not found');
  if (outcome.kind === 'conflict') return fail(405, 'Pull Request is not mergeable');
  if (outcome.kind === 'already') return fail(405, 'Pull Request is not mergeable');
  return ok({ sha: outcome.sha, merged: true, message: 'Pull Request successfully merged' });
}

/** True when the head still needs merging: not merged, and not already contained in the base. */
export function pullMergeable(repo: Repo, record: PullRecord): boolean {
  if (record.merged) return false;
  const baseTip = branchTip(repo, record.baseRef);
  const headTip = branchTip(repo, record.headRef);
  if (!baseTip || !headTip) return false;
  if (repo.isAncestor(headTip, baseTip)) return false;
  const load = (commit: string | undefined): Map<string, { mode: string; oid: string }> => {
    const map = new Map<string, { mode: string; oid: string }>();
    if (!commit) return map;
    const object = repo.getObject(commit);
    if (!object || object.type !== 'commit') return map;
    for (const [path, entry] of repo.flattenTree(parseCommit(object.data).tree)) {
      map.set(path, { mode: entry.mode, oid: entry.oid });
    }
    return map;
  };
  const base = repo.mergeBase(baseTip, headTip);
  const baseFiles = load(base);
  const headFiles = load(headTip);
  const ontoFiles = load(baseTip);
  const paths = new Set([...baseFiles.keys(), ...headFiles.keys(), ...ontoFiles.keys()]);
  for (const path of paths) {
    const headChanged = (headFiles.get(path)?.oid ?? '') !== (baseFiles.get(path)?.oid ?? '');
    const ontoChanged = (ontoFiles.get(path)?.oid ?? '') !== (baseFiles.get(path)?.oid ?? '');
    if (headChanged && ontoChanged && (headFiles.get(path)?.oid ?? '') !== (ontoFiles.get(path)?.oid ?? '')) {
      return false;
    }
  }
  return true;
}
