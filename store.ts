// store.ts — single in-memory store behind git smart HTTP, REST v3, GraphQL, MCP.
// Pure Node, zero dependencies. Erasable TypeScript only (type-stripped by Node 24).
import { createHash } from 'node:crypto';

export const VIEWER = { login: 'adaiversen', id: 1000, name: 'ada iversen', email: 'adaiversen@example.invalid', type: 'User' };
export const TEAMMATE = { login: 'quinnkeller', id: 1001 };
export const STRANGER = { login: 'olgabauer', id: 1002 };
export const ORG = 'faint-meadow-org';

export const EMPTY_TREE_OID = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

export type Author = { name: string; email: string; epoch: number };
export type GitObject = { type: string; data: Buffer };
export type TreeEntry = { mode: string; name: string; oid: string };
export type Label = { name: string; color: string; description: string };
export type Comment = { id: number; body: string; created_at: string; user: { login: string; id: number; type: string } };
export type Issue = {
  id: number; number: number; title: string; body: string; state: string;
  labels: string[]; comments: Comment[]; created_at: string; updated_at: string;
  user: { login: string; id: number; type: string };
};
export type PullFile = { filename: string; status: string; additions: number; deletions: number; patch: string };
export type Pull = {
  id: number; number: number; title: string; body: string; state: string;
  head: { ref: string; sha: string }; base: { ref: string; sha: string };
  merged: boolean; mergeable: boolean; merge_base: string | undefined;
  created_at: string; updated_at: string; merged_at: string | undefined;
  user: { login: string; id: number; type: string };
  files: PullFile[]; commits: string[];
};
export type Repo = {
  id: number; name: string; owner: string; full_name: string; description: string;
  private: boolean; default_branch: string; created_at: string; updated_at: string; pushed_at: string;
  objects: Map<string, GitObject>; refs: Map<string, string>; head: string;
  issues: Map<number, Issue>; labels: Map<string, Label>; pulls: Map<number, Pull>;
  nextIssue: number; nextPull: number; nextComment: number;
};

const SEED_LABELS: [string, string, string][] = [
  ['bug', 'd73a4a', "Something isn't working"],
  ['enhancement', 'a2eeef', 'New feature or request'],
  ['documentation', '0075ca', 'Improvements or additions to documentation'],
  ['question', 'd876e3', 'Further information is requested'],
  ['good first issue', '7057ff', 'Good for newcomers'],
  ['help wanted', '008672', 'Extra attention is needed'],
];

function nowIso(): string { return new Date().toISOString(); }
function viewerUser() { return { login: VIEWER.login, id: VIEWER.id, type: 'User' }; }

export function createStore() {
  const repos = new Map<string, Repo>();
  let nextRepoId = 1;
  let nextCommentId = 1;

  function hashObject(type: string, data: Buffer): string {
    const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
    return createHash('sha1').update(header).update(data).digest('hex');
  }

  function putObject(repo: Repo, type: string, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
    return oid;
  }

  function getObject(repo: Repo, oid: string): GitObject | undefined {
    return repo.objects.get(oid);
  }

  function createRepo(owner: string, name: string, opts: { description?: string; private?: boolean; defaultBranch?: string } = {}): Repo | null {
    const fullName = `${owner}/${name}`;
    if (repos.has(fullName)) return null;
    const now = nowIso();
    const repo: Repo = {
      id: nextRepoId++, name, owner, full_name: fullName,
      description: opts.description ?? '', private: opts.private ?? false,
      default_branch: opts.defaultBranch ?? 'main',
      created_at: now, updated_at: now, pushed_at: now,
      objects: new Map(), refs: new Map(), head: `refs/heads/${opts.defaultBranch ?? 'main'}`,
      issues: new Map(), labels: new Map(), pulls: new Map(),
      nextIssue: 1, nextPull: 1, nextComment: 1,
    };
    for (const [n, c, d] of SEED_LABELS) repo.labels.set(n, { name: n, color: c, description: d });
    putObject(repo, 'tree', Buffer.alloc(0));
    repos.set(fullName, repo);
    return repo;
  }

  function getRepo(owner: string, name: string): Repo | undefined {
    return repos.get(`${owner}/${name}`);
  }

  function listRepos(owner?: string): Repo[] {
    const all = [...repos.values()];
    return owner === undefined ? all : all.filter((r) => r.owner === owner);
  }

  function deleteRepo(owner: string, name: string): boolean {
    return repos.delete(`${owner}/${name}`);
  }

  // ---- commits / trees ----
  function parsePerson(line: string): Author {
    const m = /^([^<]*) <([^>]*)> (\d+) ([+-]\d{4})$/.exec(line.trim());
    if (!m) return { name: line.trim(), email: '', epoch: 0 };
    return { name: m[1].trim(), email: m[2], epoch: Number(m[3]) };
  }

  function parseCommit(data: Buffer): { tree: string; parents: string[]; author: Author; committer: Author; message: string } {
    const text = data.toString('utf8');
    const split = text.indexOf('\n\n');
    const header = split === -1 ? text : text.slice(0, split);
    const message = split === -1 ? '' : text.slice(split + 2);
    let tree = '';
    const parents: string[] = [];
    let author: Author = { name: '', email: '', epoch: 0 };
    let committer: Author = { name: '', email: '', epoch: 0 };
    for (const line of header.split('\n')) {
      if (line.startsWith('tree ')) tree = line.slice(5).trim();
      else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
      else if (line.startsWith('author ')) author = parsePerson(line.slice(7));
      else if (line.startsWith('committer ')) committer = parsePerson(line.slice(10));
    }
    return { tree, parents, author, committer, message };
  }

  function personLine(p: Author): string {
    return `${p.name} <${p.email}> ${p.epoch} +0000`;
  }

  function buildCommit(c: { tree: string; parents: string[]; author: Author; committer: Author; message: string }): Buffer {
    let out = `tree ${c.tree}\n`;
    for (const p of c.parents) out += `parent ${p}\n`;
    out += `author ${personLine(c.author)}\n`;
    out += `committer ${personLine(c.committer)}\n`;
    out += `\n${c.message}`;
    if (!out.endsWith('\n')) out += '\n';
    return Buffer.from(out, 'utf8');
  }

  function parseTree(data: Buffer): TreeEntry[] {
    const entries: TreeEntry[] = [];
    let i = 0;
    while (i < data.length) {
      const nul = data.indexOf(0, i);
      if (nul === -1) break;
      const head = data.subarray(i, nul).toString('utf8');
      const sp = head.indexOf(' ');
      const mode = head.slice(0, sp);
      const name = head.slice(sp + 1);
      const oid = data.subarray(nul + 1, nul + 21).toString('hex');
      entries.push({ mode, name, oid });
      i = nul + 21;
    }
    return entries;
  }

  function sortTreeEntries(entries: TreeEntry[]): TreeEntry[] {
    return [...entries].sort((a, b) => {
      const ka = a.name + (a.mode === '40000' ? '/' : '');
      const kb = b.name + (b.mode === '40000' ? '/' : '');
      return ka < kb ? -1 : ka > kb ? 1 : 0;
    });
  }

  function buildTree(entries: TreeEntry[]): Buffer {
    const parts: Buffer[] = [];
    for (const e of sortTreeEntries(entries)) {
      parts.push(Buffer.from(`${e.mode} ${e.name}\0`, 'utf8'));
      parts.push(Buffer.from(e.oid, 'hex'));
    }
    return Buffer.concat(parts);
  }

  function treeEntries(repo: Repo, treeOid: string): TreeEntry[] {
    const obj = getObject(repo, treeOid);
    if (!obj || obj.type !== 'tree') return [];
    return parseTree(obj.data);
  }

  function flattenTree(repo: Repo, treeOid: string, prefix: string, out: Map<string, { oid: string; mode: string }>): void {
    for (const e of treeEntries(repo, treeOid)) {
      const path = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.mode === '40000') flattenTree(repo, e.oid, path, out);
      else out.set(path, { oid: e.oid, mode: e.mode });
    }
  }

  function flatMap(repo: Repo, treeOid: string): Map<string, { oid: string; mode: string }> {
    const out = new Map<string, { oid: string; mode: string }>();
    if (treeOid) flattenTree(repo, treeOid, '', out);
    return out;
  }

  function buildTreeFromMap(repo: Repo, files: Map<string, { oid: string; mode: string }>): string {
    // group by first segment, recurse
    const build = (paths: string[]): string => {
      const entries: TreeEntry[] = [];
      const dirs = new Map<string, string[]>();
      for (const p of paths) {
        const slash = p.indexOf('/');
        if (slash === -1) {
          const f = files.get(p);
          if (f) entries.push({ mode: f.mode, name: p, oid: f.oid });
        } else {
          const dir = p.slice(0, slash);
          const rest = p.slice(slash + 1);
          if (!dirs.has(dir)) dirs.set(dir, []);
          dirs.get(dir)!.push(rest);
        }
      }
      // sub-maps need full paths relative to this level: rebuild via a sub-map
      for (const [dir, subs] of dirs) {
        const subFiles = new Map<string, { oid: string; mode: string }>();
        for (const s of subs) {
          // find the original full path: dir + '/' + s within this level's namespace
          const f = files.get(`${dir}/${s}`) ?? [...files.entries()].find(([k]) => k.endsWith(`/${s}`) && k.startsWith(`${dir}/`))?.[1];
          if (f) subFiles.set(s, f);
        }
        // simpler: collect from files whose key starts with dir + '/'
        subFiles.clear();
        for (const [k, v] of files) {
          if (k.startsWith(`${dir}/`)) subFiles.set(k.slice(dir.length + 1), v);
        }
        void subs;
        const subOid = buildFromSub(repo, subFiles);
        entries.push({ mode: '40000', name: dir, oid: subOid });
      }
      return putObject(repo, 'tree', buildTree(entries));
    };
    const buildFromSub = (r: Repo, subFiles: Map<string, { oid: string; mode: string }>): string => {
      const entries: TreeEntry[] = [];
      const dirs = new Map<string, string[]>();
      for (const [p, f] of subFiles) {
        const slash = p.indexOf('/');
        if (slash === -1) entries.push({ mode: f.mode, name: p, oid: f.oid });
        else {
          const dir = p.slice(0, slash);
          if (!dirs.has(dir)) dirs.set(dir, []);
          dirs.get(dir)!.push(p.slice(slash + 1));
        }
      }
      for (const [dir] of dirs) {
        const nested = new Map<string, { oid: string; mode: string }>();
        for (const [k, v] of subFiles) if (k.startsWith(`${dir}/`)) nested.set(k.slice(dir.length + 1), v);
        entries.push({ mode: '40000', name: dir, oid: buildFromSub(r, nested) });
      }
      return putObject(r, 'tree', buildTree(entries));
    };
    return buildFromSub(repo, files);
  }

  function getBlobAtPath(repo: Repo, commitOid: string, path: string): { oid: string; data: Buffer } | undefined {
    const commitObj = getObject(repo, commitOid);
    if (!commitObj || commitObj.type !== 'commit') return undefined;
    const commit = parseCommit(commitObj.data);
    const parts = path.split('/').filter((p) => p.length > 0);
    let treeOid = commit.tree;
    for (let i = 0; i < parts.length; i++) {
      const entries = treeEntries(repo, treeOid);
      const entry = entries.find((e) => e.name === parts[i]);
      if (!entry) return undefined;
      if (i === parts.length - 1) {
        if (entry.mode === '40000') return undefined;
        const obj = getObject(repo, entry.oid);
        if (!obj) return undefined;
        return { oid: entry.oid, data: obj.data };
      }
      if (entry.mode !== '40000') return undefined;
      treeOid = entry.oid;
    }
    return undefined;
  }

  function rewriteTree(repo: Repo, treeOid: string | undefined, parts: string[], blobOid: string | null): string {
    const entries = treeOid ? treeEntries(repo, treeOid) : [];
    const [head, ...rest] = parts;
    const idx = entries.findIndex((e) => e.name === head);
    if (rest.length === 0) {
      if (blobOid === null) {
        if (idx !== -1) entries.splice(idx, 1);
      } else {
        const entry: TreeEntry = { mode: '100644', name: head, oid: blobOid };
        if (idx !== -1) entries[idx] = entry;
        else entries.push(entry);
      }
    } else {
      const sub = idx !== -1 && entries[idx].mode === '40000' ? entries[idx].oid : undefined;
      const newSub = rewriteTree(repo, sub, rest, blobOid);
      const newEntries = treeEntries(repo, newSub);
      if (newEntries.length === 0) {
        if (idx !== -1) entries.splice(idx, 1);
      } else if (idx !== -1) entries[idx] = { mode: '40000', name: head, oid: newSub };
      else entries.push({ mode: '40000', name: head, oid: newSub });
    }
    return putObject(repo, 'tree', buildTree(entries));
  }

  function setPath(repo: Repo, baseCommitOid: string, path: string, blobOid: string | null, message: string, author: Author): string {
    const baseObj = getObject(repo, baseCommitOid);
    if (!baseObj || baseObj.type !== 'commit') throw new Error(`setPath: base commit not found: ${baseCommitOid}`);
    const base = parseCommit(baseObj.data);
    const parts = path.split('/').filter((p) => p.length > 0);
    if (parts.length === 0) throw new Error('setPath: empty path');
    const newTree = rewriteTree(repo, base.tree, parts, blobOid);
    const epoch = author.epoch || Math.floor(Date.now() / 1000);
    const who: Author = { name: author.name, email: author.email, epoch };
    const commitBuf = buildCommit({ tree: newTree, parents: [baseCommitOid], author: who, committer: who, message });
    const oid = putObject(repo, 'commit', commitBuf);
    repo.updated_at = nowIso();
    return oid;
  }

  // ---- refs ----
  function getRef(repo: Repo, ref: string): string | undefined {
    return repo.refs.get(ref);
  }

  function setRef(repo: Repo, ref: string, oid: string): void {
    repo.refs.set(ref, oid);
    repo.pushed_at = nowIso();
    repo.updated_at = nowIso();
  }

  function deleteRef(repo: Repo, ref: string): boolean {
    return repo.refs.delete(ref);
  }

  function listRefs(repo: Repo): { ref: string; oid: string }[] {
    return [...repo.refs.entries()].map(([ref, oid]) => ({ ref, oid })).sort((a, b) => (a.ref < b.ref ? -1 : 1));
  }

  function resolveRef(repo: Repo, ref: string): string | undefined {
    if (ref === 'HEAD') return repo.refs.get(repo.head);
    return repo.refs.get(ref);
  }

  // ---- history ----
  function commitParents(repo: Repo, oid: string): string[] {
    const obj = getObject(repo, oid);
    if (!obj || obj.type !== 'commit') return [];
    return parseCommit(obj.data).parents;
  }

  function ancestorDistances(repo: Repo, start: string): Map<string, number> {
    const dist = new Map<string, number>();
    const queue: string[] = [start];
    dist.set(start, 0);
    while (queue.length > 0) {
      const cur = queue.shift()!;
      const d = dist.get(cur)!;
      for (const p of commitParents(repo, cur)) {
        if (!dist.has(p)) { dist.set(p, d + 1); queue.push(p); }
      }
    }
    return dist;
  }

  function mergeBase(repo: Repo, a: string, b: string): string | undefined {
    if (!a || !b) return undefined;
    if (a === b) return a;
    const da = ancestorDistances(repo, a);
    const db = ancestorDistances(repo, b);
    let best: string | undefined;
    let bestScore = Infinity;
    for (const [oid, d] of da) {
      if (db.has(oid)) {
        const score = d + db.get(oid)!;
        if (score < bestScore) { bestScore = score; best = oid; }
      }
    }
    return best;
  }

  function isAncestor(repo: Repo, anc: string, desc: string): boolean {
    if (anc === desc) return true;
    return ancestorDistances(repo, desc).has(anc);
  }

  function commitTree(repo: Repo, oid: string): string {
    const obj = getObject(repo, oid);
    if (!obj || obj.type !== 'commit') return EMPTY_TREE_OID;
    return parseCommit(obj.data).tree;
  }

  function threeWayMerge(repo: Repo, baseOid: string, oursOid: string, theirsOid: string): { treeOid: string; conflicts: string[] } {
    const base = baseOid ? flatMap(repo, commitTree(repo, baseOid)) : new Map();
    const ours = oursOid ? flatMap(repo, commitTree(repo, oursOid)) : new Map();
    const theirs = theirsOid ? flatMap(repo, commitTree(repo, theirsOid)) : new Map();
    const result = new Map<string, { oid: string; mode: string }>();
    const conflicts: string[] = [];
    const paths = new Set<string>([...base.keys(), ...ours.keys(), ...theirs.keys()]);
    for (const path of paths) {
      const b = base.get(path);
      const o = ours.get(path);
      const t = theirs.get(path);
      const same = (x?: { oid: string }, y?: { oid: string }) => (x?.oid ?? null) === (y?.oid ?? null);
      if (same(o, t)) { if (o) result.set(path, o); }
      else if (same(o, b)) { if (t) result.set(path, t); }
      else if (same(t, b)) { if (o) result.set(path, o); }
      else {
        conflicts.push(path);
        if (o) result.set(path, o);
      }
    }
    const treeOid = buildTreeFromMap(repo, result);
    return { treeOid, conflicts };
  }

  // ---- issues / labels / comments ----
  function createIssue(repo: Repo, input: { title: string; body?: string; labels?: string[] }): Issue {
    const now = nowIso();
    const issue: Issue = {
      id: repo.nextIssue, number: repo.nextIssue,
      title: input.title, body: input.body ?? '', state: 'open',
      labels: [...(input.labels ?? [])], comments: [],
      created_at: now, updated_at: now, user: viewerUser(),
    };
    repo.nextIssue++;
    repo.issues.set(issue.number, issue);
    return issue;
  }

  function getIssue(repo: Repo, n: number): Issue | undefined {
    return repo.issues.get(n);
  }

  function listIssues(repo: Repo, filter: { state?: string; labels?: string[] } = {}): Issue[] {
    let out = [...repo.issues.values()].sort((a, b) => a.number - b.number);
    if (filter.state) out = out.filter((i) => i.state === filter.state);
    if (filter.labels && filter.labels.length > 0) {
      out = out.filter((i) => filter.labels!.every((l) => i.labels.includes(l)));
    }
    return out;
  }

  function updateIssue(repo: Repo, n: number, patch: { title?: string; body?: string; state?: string; labels?: string[] }): Issue | undefined {
    const issue = repo.issues.get(n);
    if (!issue) return undefined;
    if (patch.title !== undefined) issue.title = patch.title;
    if (patch.body !== undefined) issue.body = patch.body;
    if (patch.state !== undefined) issue.state = patch.state;
    if (patch.labels !== undefined) issue.labels = [...patch.labels];
    issue.updated_at = nowIso();
    return issue;
  }

  function createComment(repo: Repo, n: number, body: string): Comment | undefined {
    const issue = repo.issues.get(n);
    if (!issue) return undefined;
    const comment: Comment = { id: nextCommentId++, body, created_at: nowIso(), user: viewerUser() };
    issue.comments.push(comment);
    issue.updated_at = nowIso();
    return comment;
  }

  function listComments(repo: Repo, n: number): Comment[] {
    return repo.issues.get(n)?.comments ?? [];
  }

  function createLabel(repo: Repo, input: { name: string; color?: string; description?: string }): Label {
    const label: Label = { name: input.name, color: input.color ?? 'ededed', description: input.description ?? '' };
    repo.labels.set(label.name, label);
    return label;
  }

  function listLabels(repo: Repo): Label[] {
    return [...repo.labels.values()];
  }

  function getLabel(repo: Repo, name: string): Label | undefined {
    return repo.labels.get(name);
  }

  function updateLabel(repo: Repo, name: string, patch: { name?: string; color?: string; description?: string }): Label | undefined {
    const label = repo.labels.get(name);
    if (!label) return undefined;
    if (patch.color !== undefined) label.color = patch.color;
    if (patch.description !== undefined) label.description = patch.description;
    if (patch.name !== undefined && patch.name !== name) {
      repo.labels.delete(name);
      label.name = patch.name;
      repo.labels.set(label.name, label);
      for (const issue of repo.issues.values()) {
        issue.labels = issue.labels.map((l) => (l === name ? patch.name! : l));
      }
    }
    return label;
  }

  function deleteLabel(repo: Repo, name: string): boolean {
    const ok = repo.labels.delete(name);
    if (ok) for (const issue of repo.issues.values()) issue.labels = issue.labels.filter((l) => l !== name);
    return ok;
  }

  // ---- pulls ----
  function lineCount(data: Buffer): number {
    const text = data.toString('utf8');
    if (text.length === 0) return 0;
    const lines = text.split('\n');
    if (lines[lines.length - 1] === '') lines.pop();
    return lines.length;
  }

  function diffFiles(repo: Repo, baseTree: string, headTree: string): PullFile[] {
    const base = flatMap(repo, baseTree);
    const head = flatMap(repo, headTree);
    const files: PullFile[] = [];
    const paths = new Set<string>([...base.keys(), ...head.keys()]);
    for (const path of [...paths].sort()) {
      const b = base.get(path);
      const h = head.get(path);
      if (b && !h) {
        const oldData = getObject(repo, b.oid)?.data ?? Buffer.alloc(0);
        const dels = lineCount(oldData);
        files.push({ filename: path, status: 'removed', additions: 0, deletions: dels, patch: oldData.toString('utf8').split('\n').filter((l) => l !== '' || true).map((l) => `-${l}`).join('\n') });
      } else if (!b && h) {
        const newData = getObject(repo, h.oid)?.data ?? Buffer.alloc(0);
        const adds = lineCount(newData);
        files.push({ filename: path, status: 'added', additions: adds, deletions: 0, patch: newData.toString('utf8').split('\n').map((l) => `+${l}`).join('\n') });
      } else if (b && h && b.oid !== h.oid) {
        const oldData = getObject(repo, b.oid)?.data ?? Buffer.alloc(0);
        const newData = getObject(repo, h.oid)?.data ?? Buffer.alloc(0);
        const oldLines = oldData.toString('utf8').split('\n');
        const newLines = newData.toString('utf8').split('\n');
        const oldSet = new Set(oldLines);
        const newSet = new Set(newLines);
        let adds = 0; let dels = 0;
        for (const l of newLines) if (!oldSet.has(l)) adds++;
        for (const l of oldLines) if (!newSet.has(l)) dels++;
        if (adds === 0 && dels === 0) { adds = 1; }
        const patch = `@@ -1,${oldLines.length} +1,${newLines.length} @@\n` +
          oldLines.map((l) => `-${l}`).join('\n') + '\n' + newLines.map((l) => `+${l}`).join('\n');
        files.push({ filename: path, status: 'modified', additions: adds, deletions: dels, patch });
      }
    }
    return files;
  }

  function createPull(repo: Repo, input: { title: string; body?: string; head: string; base: string }): Pull {
    const now = nowIso();
    const headSha = getRef(repo, `refs/heads/${input.head}`) ?? '';
    const baseSha = getRef(repo, `refs/heads/${input.base}`) ?? '';
    const base = (headSha && baseSha) ? mergeBase(repo, headSha, baseSha) : undefined;
    const files = (headSha && baseSha) ? diffFiles(repo, commitTree(repo, baseSha), commitTree(repo, headSha)) : [];
    const merge = (headSha && baseSha && base) ? threeWayMerge(repo, base, baseSha, headSha) : { treeOid: EMPTY_TREE_OID, conflicts: ['__missing__'] };
    const commits = (headSha && base) ? pullCommits(repo, headSha, base) : [];
    const pull: Pull = {
      id: repo.nextPull, number: repo.nextPull,
      title: input.title, body: input.body ?? '', state: 'open',
      head: { ref: input.head, sha: headSha }, base: { ref: input.base, sha: baseSha },
      merged: false, mergeable: merge.conflicts.length === 0, merge_base: base,
      created_at: now, updated_at: now, merged_at: undefined,
      user: viewerUser(), files, commits,
    };
    repo.nextPull++;
    repo.pulls.set(pull.number, pull);
    return pull;
  }

  function pullCommits(repo: Repo, headSha: string, base: string): string[] {
    const baseAncestors = ancestorDistances(repo, base);
    const out: string[] = [];
    const seen = new Set<string>();
    const stack = [headSha];
    while (stack.length > 0) {
      const cur = stack.pop()!;
      if (seen.has(cur) || baseAncestors.has(cur)) continue;
      seen.add(cur);
      out.push(cur);
      for (const p of commitParents(repo, cur)) stack.push(p);
    }
    // newest-first by author epoch
    out.sort((a, b) => {
      const ea = commitEpoch(repo, a);
      const eb = commitEpoch(repo, b);
      return eb - ea;
    });
    return out;
  }

  function commitEpoch(repo: Repo, oid: string): number {
    const obj = getObject(repo, oid);
    if (!obj || obj.type !== 'commit') return 0;
    return parseCommit(obj.data).author.epoch;
  }

  function getPull(repo: Repo, n: number): Pull | undefined {
    return repo.pulls.get(n);
  }

  function listPulls(repo: Repo, filter: { state?: string } = {}): Pull[] {
    let out = [...repo.pulls.values()].sort((a, b) => a.number - b.number);
    if (filter.state) out = out.filter((p) => p.state === filter.state);
    return out;
  }

  function mergePull(repo: Repo, n: number, method: 'merge' | 'squash' | 'rebase'): { merged: boolean; sha?: string; conflict?: boolean; message?: string } {
    const pull = repo.pulls.get(n);
    if (!pull) return { merged: false, message: 'pull request not found' };
    if (pull.state !== 'open') return { merged: false, message: 'pull request is not open' };
    const headSha = getRef(repo, `refs/heads/${pull.head.ref}`) ?? pull.head.sha;
    const baseSha = getRef(repo, `refs/heads/${pull.base.ref}`) ?? pull.base.sha;
    if (!headSha || !baseSha) return { merged: false, message: 'head or base ref not found' };
    const base = mergeBase(repo, headSha, baseSha);
    if (!base) return { merged: false, message: 'no merge base' };
    const merge = threeWayMerge(repo, base, baseSha, headSha);
    if (merge.conflicts.length > 0) {
      return { merged: false, conflict: true, message: `merge conflict in: ${merge.conflicts.join(', ')}` };
    }
    const now = Math.floor(Date.now() / 1000);
    const author: Author = { name: VIEWER.name, email: VIEWER.email, epoch: now };
    let newSha: string;
    if (method === 'merge') {
      const msg = `Merge pull request #${pull.number} from ${pull.head.ref}\n\n${pull.title}`;
      newSha = putObject(repo, 'commit', buildCommit({ tree: merge.treeOid, parents: [baseSha, headSha], author, committer: author, message: msg }));
    } else if (method === 'squash') {
      const headCommit = parseCommit(getObject(repo, headSha)!.data);
      const msg = `${pull.title}\n\n${pull.body ?? ''}`.trim();
      newSha = putObject(repo, 'commit', buildCommit({ tree: headCommit.tree, parents: [baseSha], author, committer: author, message: msg }));
    } else {
      // rebase: replay head-only commits oldest-first onto base
      const commits = [...pullCommits(repo, headSha, base)].reverse();
      let parent = baseSha;
      for (const oid of commits) {
        const c = parseCommit(getObject(repo, oid)!.data);
        const buf = buildCommit({ tree: c.tree, parents: [parent], author: c.author, committer: c.committer, message: c.message });
        parent = putObject(repo, 'commit', buf);
      }
      newSha = parent;
    }
    setRef(repo, `refs/heads/${pull.base.ref}`, newSha);
    pull.merged = true;
    pull.state = 'closed';
    pull.merged_at = nowIso();
    pull.updated_at = nowIso();
    pull.head.sha = headSha;
    pull.base.sha = newSha;
    return { merged: true, sha: newSha };
  }

  function listPullFiles(repo: Repo, n: number): PullFile[] {
    return repo.pulls.get(n)?.files ?? [];
  }

  function listPullCommits(repo: Repo, n: number): string[] {
    return repo.pulls.get(n)?.commits ?? [];
  }

  // ---- branches / commits ----
  function listBranches(repo: Repo): { name: string; sha: string }[] {
    const out: { name: string; sha: string }[] = [];
    for (const [ref, oid] of repo.refs) {
      if (ref.startsWith('refs/heads/')) out.push({ name: ref.slice('refs/heads/'.length), sha: oid });
    }
    return out.sort((a, b) => (a.name < b.name ? -1 : 1));
  }

  function getCommit(repo: Repo, oid: string): { oid: string; tree: string; parents: string[]; author: Author; committer: Author; message: string } | undefined {
    const obj = getObject(repo, oid);
    if (!obj || obj.type !== 'commit') return undefined;
    const c = parseCommit(obj.data);
    return { oid, ...c };
  }

  function listCommits(repo: Repo, opts: { sha?: string; path?: string } = {}): string[] {
    const start = opts.sha ?? resolveRef(repo, 'HEAD');
    if (!start) return [];
    const seen = new Set<string>();
    const all: string[] = [];
    const stack = [start];
    while (stack.length > 0) {
      const cur = stack.pop()!;
      if (seen.has(cur)) continue;
      seen.add(cur);
      const obj = getObject(repo, cur);
      if (!obj || obj.type !== 'commit') continue;
      all.push(cur);
      for (const p of parseCommit(obj.data).parents) stack.push(p);
    }
    all.sort((a, b) => commitEpoch(repo, b) - commitEpoch(repo, a));
    if (!opts.path) return all;
    const out: string[] = [];
    for (const oid of all) {
      const c = parseCommit(getObject(repo, oid)!.data);
      const mine = getBlobAtPath(repo, oid, opts.path)?.oid;
      let parentBlob: string | undefined;
      if (c.parents.length > 0) parentBlob = getBlobAtPath(repo, c.parents[0], opts.path)?.oid;
      if (mine !== parentBlob) out.push(oid);
    }
    return out;
  }

  return {
    repos,
    createRepo, getRepo, listRepos, deleteRepo,
    hashObject, putObject, getObject,
    parseCommit, buildCommit, parseTree, buildTree,
    getBlobAtPath, setPath,
    getRef, setRef, deleteRef, listRefs, resolveRef,
    mergeBase, isAncestor, threeWayMerge,
    createIssue, getIssue, listIssues, updateIssue, createComment, listComments,
    createLabel, listLabels, getLabel, updateLabel, deleteLabel,
    createPull, getPull, listPulls, mergePull, listPullFiles, listPullCommits,
    listBranches, getCommit, listCommits,
  };
}

export type Store = ReturnType<typeof createStore>;
