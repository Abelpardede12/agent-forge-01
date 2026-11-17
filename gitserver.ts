// gitserver.ts — git smart HTTP (protocol v2 + v0) over the in-memory store.
// Pure Node, zero dependencies. Erasable TypeScript only (run directly by Node 24).
// No git binary is used anywhere in this file.
//
// NOTE on git.ts's parseFetchArgs / parseLsRefsArgs: they cannot parse a real
// protocol-v2 request body, because the body contains a delim packet (0001)
// and parsePktLines throws on it, so the helpers silently return empty args
// (verified: a v2 fetch body parses to wants: [] / done: false). This file
// therefore scans pkt-lines itself (scanPktLines / scanUntilFlush) and parses
// the decoded argument lines locally, with the same line grammar.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createStore } from './store.ts';
import type { Repo } from './store.ts';
import { pktLine, buildPack, unpackIntoStore, parseCommit, parseTree } from './git.ts';

type Store = ReturnType<typeof createStore>;

const ZERO_OID = '0000000000000000000000000000000000000000';
const AGENT = 'coreforge/1.0';
const SIDEBAND_MAX_DATA = 65515; // pkt-line max 65520 - 4 (length) - 1 (band byte)

// ---- small helpers (local; nothing is imported from other repo files) ----

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  if (res.headersSent) return;
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer | string) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function authed(req: IncomingMessage, token: string): boolean {
  if (token === '') return true;
  return req.headers.authorization === `Bearer ${token}`;
}

function decodeSegment(s: string): string | null {
  try {
    return decodeURIComponent(s);
  } catch {
    return null;
  }
}

// ---- pkt-line scanning ----

// Scan a whole body of pkt-lines (upload-pack: the body is only pkt-lines).
// Flush (0000), delim (0001) and response-end (0002) packets are skipped;
// data payloads are returned as strings. Throws on malformed framing.
function scanPktLines(buf: Buffer): string[] {
  const lines: string[] = [];
  let i = 0;
  while (i + 4 <= buf.length) {
    const len = parseInt(buf.subarray(i, i + 4).toString('ascii'), 16);
    if (Number.isNaN(len)) throw new Error('bad pkt-line length');
    if (len === 0 || len === 1 || len === 2) {
      i += 4;
      continue;
    }
    if (len < 4 || i + len > buf.length) throw new Error('truncated pkt-line');
    lines.push(buf.subarray(i + 4, i + len).toString('utf8'));
    i += len;
  }
  if (i !== buf.length) throw new Error('trailing bytes after pkt-lines');
  return lines;
}

// Scan a receive-pack body: command pkt-lines up to the first flush packet.
// Returns the command lines plus the offset where the raw pack bytes start
// (-1 when there is no flush / no pack).
function scanUntilFlush(buf: Buffer): { lines: string[]; packStart: number } {
  const lines: string[] = [];
  let i = 0;
  while (i + 4 <= buf.length) {
    const len = parseInt(buf.subarray(i, i + 4).toString('ascii'), 16);
    if (Number.isNaN(len)) throw new Error('bad pkt-line length');
    if (len === 0) return { lines, packStart: i + 4 };
    if (len === 1 || len === 2) {
      i += 4;
      continue;
    }
    if (len < 4 || i + len > buf.length) throw new Error('truncated pkt-line');
    lines.push(buf.subarray(i + 4, i + len).toString('utf8'));
    i += len;
  }
  return { lines, packStart: -1 };
}

// ---- argument parsing (same line grammar as git.ts, on decoded lines) ----

type FetchArgs = {
  command: string | null;
  wants: string[];
  haves: string[];
  shallow: string[];
  deepen: number | null;
  filter: string | null;
  done: boolean;
};

function parseFetchLines(lines: string[]): FetchArgs {
  const wants: string[] = [];
  const haves: string[] = [];
  const shallow: string[] = [];
  let deepen: number | null = null;
  let filter: string | null = null;
  let done = false;
  let command: string | null = null;
  for (const raw of lines) {
    const line = raw.endsWith('\n') ? raw.slice(0, -1) : raw;
    if (line.startsWith('command=')) {
      command = line.slice('command='.length);
      continue;
    }
    if (line === 'done') {
      done = true;
      continue;
    }
    const nul = line.indexOf('\0');
    const head = nul === -1 ? line : line.slice(0, nul);
    const parts = head.split(' ');
    const cmd = parts[0];
    if (cmd === 'want' && parts[1]) wants.push(parts[1]);
    else if (cmd === 'have' && parts[1]) haves.push(parts[1]);
    else if (cmd === 'shallow' && parts[1]) shallow.push(parts[1]);
    else if (cmd === 'deepen' && parts[1]) {
      const n = Number(parts[1]);
      if (Number.isInteger(n) && n > 0) deepen = n;
    } else if (cmd === 'filter') filter = head.slice('filter '.length);
    // thin-pack / ofs-delta / no-progress / agent= / object-format= / deepen-since / deepen-not: ignored
  }
  return { command, wants, haves, shallow, deepen, filter, done };
}

type LsRefsArgs = { prefixes: string[]; symrefs: boolean; peel: boolean; unborn: boolean };

function parseLsRefsLines(lines: string[]): LsRefsArgs {
  const prefixes: string[] = [];
  let symrefs = false;
  let peel = false;
  let unborn = false;
  for (const raw of lines) {
    const line = raw.endsWith('\n') ? raw.slice(0, -1) : raw;
    if (line === 'command=ls-refs') continue;
    if (line === 'peel') {
      peel = true;
      continue;
    }
    if (line === 'unborn') {
      unborn = true;
      continue;
    }
    if (line === 'symrefs') {
      symrefs = true;
      continue;
    }
    if (line === 'ref-prefix') {
      prefixes.push('');
      continue;
    }
    if (line.startsWith('ref-prefix ')) {
      prefixes.push(line.slice('ref-prefix '.length));
      continue;
    }
  }
  return { prefixes, symrefs, peel, unborn };
}

// ---- object graph walks ----

function collectTreeObjects(repo: Repo, treeOid: string, out: Set<string>): void {
  const stack = [treeOid];
  const seen = new Set<string>();
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = repo.objects.get(oid);
    if (!obj || obj.type !== 'tree') continue;
    out.add(oid);
    for (const e of parseTree(obj.data)) {
      const child = repo.objects.get(e.oid);
      if (!child) continue;
      out.add(e.oid);
      if (e.mode === '40000') stack.push(e.oid);
    }
  }
}

function tagTarget(repo: Repo, oid: string): string | null {
  const obj = repo.objects.get(oid);
  if (!obj || obj.type !== 'tag') return null;
  const m = /^object ([0-9a-f]{40})/m.exec(obj.data.toString('utf8'));
  return m ? m[1] : null;
}

// Resolve a ref target for ls-refs peel: a tag peels to its target object, a
// commit peels to itself.
function peelTarget(repo: Repo, oid: string): string {
  return tagTarget(repo, oid) ?? oid;
}

// Closure of the wanted roots. With a depth limit D, only commits at depth
// 0..D-1 are included; `boundary` holds the depth-(D-1) commits whose parents
// were cut (the new shallow boundary). Without a limit the full closure is
// returned and `boundary` is empty.
function wantClosure(repo: Repo, wants: string[], deepen: number | null): {
  objects: Set<string>;
  commits: Set<string>;
  boundary: Set<string>;
} {
  const objects = new Set<string>();
  const commits = new Set<string>();
  const boundary = new Set<string>();
  const maxDepth = deepen ?? Infinity;
  const queue: Array<{ oid: string; depth: number }> = wants.map((oid) => ({ oid, depth: 0 }));
  const seen = new Set<string>();
  while (queue.length > 0) {
    const { oid, depth } = queue.shift()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    if (depth >= maxDepth) continue;
    const obj = repo.objects.get(oid);
    if (!obj) continue;
    objects.add(oid);
    if (obj.type === 'commit') {
      commits.add(oid);
      const c = parseCommit(obj.data);
      if (c.tree) collectTreeObjects(repo, c.tree, objects);
      if (depth === maxDepth - 1) {
        if (c.parents.length > 0) boundary.add(oid);
      } else {
        for (const p of c.parents) queue.push({ oid: p, depth: depth + 1 });
      }
    } else if (obj.type === 'tree') {
      collectTreeObjects(repo, oid, objects);
    } else if (obj.type === 'tag') {
      const target = tagTarget(repo, oid);
      if (target) queue.push({ oid: target, depth });
    }
  }
  return { objects, commits, boundary };
}

// Closure of what the client already holds. A `have` that is one of the
// client's shallow boundaries contributes itself and its tree, but its
// parents are NOT held (they were cut by the shallow clone).
function heldClosure(repo: Repo, haves: string[], shallow: Set<string>): Set<string> {
  const objects = new Set<string>();
  const queue = [...haves];
  const seen = new Set<string>();
  while (queue.length > 0) {
    const oid = queue.shift()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = repo.objects.get(oid);
    if (!obj) continue;
    objects.add(oid);
    if (obj.type === 'commit') {
      const c = parseCommit(obj.data);
      if (c.tree) collectTreeObjects(repo, c.tree, objects);
      if (!shallow.has(oid)) {
        for (const p of c.parents) queue.push(p);
      }
    } else if (obj.type === 'tree') {
      collectTreeObjects(repo, oid, objects);
    } else if (obj.type === 'tag') {
      const target = tagTarget(repo, oid);
      if (target) queue.push(target);
    }
  }
  return objects;
}

// ---- sideband framing (packfile sections and push reports) ----

function sidebandPackets(data: Buffer): Buffer[] {
  const out: Buffer[] = [];
  for (let i = 0; i < data.length; i += SIDEBAND_MAX_DATA) {
    out.push(pktLine(Buffer.concat([Buffer.from([1]), data.subarray(i, i + SIDEBAND_MAX_DATA)])));
  }
  return out;
}

// ---- advertisements ----

function v0Advertisement(store: Store, repo: Repo, service: string, caps: string): Buffer {
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), pktLine(null)];
  const refs = store.listRefs(repo);
  const headOid = repo.refs.get(repo.head);
  const lines: string[] = [];
  if (refs.length === 0) {
    lines.push(`${ZERO_OID} capabilities^{}`);
  } else {
    lines.push(`${headOid ?? ZERO_OID} HEAD`);
    for (const { ref, oid } of refs) {
      lines.push(`${oid} ${ref}`);
      const obj = repo.objects.get(oid);
      if (obj && obj.type === 'tag') {
        lines.push(`${peelTarget(repo, oid)} ${ref}^{}`);
      }
    }
  }
  parts.push(pktLine(`${lines[0]}\0${caps}\n`));
  for (const line of lines.slice(1)) parts.push(pktLine(`${line}\n`));
  parts.push(pktLine(null));
  return Buffer.concat(parts);
}

function v2Advertisement(): Buffer {
  return Buffer.concat([
    pktLine('# service=git-upload-pack\n'),
    pktLine(null),
    pktLine('version 2\n'),
    pktLine('ls-refs=unborn\n'),
    pktLine('fetch=shallow wait-for-done filter\n'),
    pktLine('object-format=sha1\n'),
    pktLine(`agent=${AGENT}\n`),
    pktLine(null),
  ]);
}

// ---- ls-refs ----

function lsRefsResponse(store: Store, repo: Repo, args: LsRefsArgs): Buffer {
  const parts: Buffer[] = [];
  const keep = (name: string): boolean =>
    args.prefixes.length === 0 || args.prefixes.some((p) => name.startsWith(p));
  const headOid = repo.refs.get(repo.head);
  if (headOid === undefined) {
    if (args.unborn && keep('HEAD')) {
      parts.push(pktLine(`unborn HEAD symref-target:${repo.head}\n`));
    }
  } else if (keep('HEAD')) {
    let line = `${headOid} HEAD`;
    if (args.symrefs) line += ` symref-target:${repo.head}`;
    if (args.peel) line += ` peeled:${peelTarget(repo, headOid)}`;
    parts.push(pktLine(`${line}\n`));
  }
  for (const { ref, oid } of store.listRefs(repo)) {
    if (!keep(ref)) continue;
    let line = `${oid} ${ref}`;
    if (args.peel) line += ` peeled:${peelTarget(repo, oid)}`;
    parts.push(pktLine(`${line}\n`));
  }
  parts.push(pktLine(null));
  return Buffer.concat(parts);
}

// ---- fetch ----

function fetchResponse(store: Store, repo: Repo, args: FetchArgs, isV2: boolean): Buffer {
  const want = wantClosure(repo, args.wants, args.deepen);
  const held = heldClosure(repo, args.haves, new Set(args.shallow));
  const packSet = new Set<string>();
  for (const oid of want.objects) {
    if (!held.has(oid)) packSet.add(oid);
  }
  const packObjects: Array<{ type: string; data: Buffer }> = [];
  for (const oid of [...packSet].sort()) {
    const obj = repo.objects.get(oid);
    if (obj) packObjects.push({ type: obj.type, data: obj.data });
  }
  const pack = buildPack(packObjects);

  // Shallow-info: the new boundary when deepening, plus old boundaries that
  // this fetch completes (their parents are now delivered or already held).
  const shallowLines = args.deepen !== null ? [...want.boundary].sort() : [];
  const unshallowLines: string[] = [];
  for (const b of args.shallow) {
    if (!want.commits.has(b)) continue;
    const obj = repo.objects.get(b);
    if (!obj || obj.type !== 'commit') continue;
    const parents = parseCommit(obj.data).parents;
    if (parents.every((p) => want.objects.has(p) || held.has(p))) unshallowLines.push(b);
  }

  // Negotiation round (no `done`): acknowledgments only, no packfile.
  // The `done` case below sends NO acknowledgments section at all — real git
  // rejects a fetch that carries one after `done`.
  if (!args.done) {
    const acks: string[] = [];
    for (const have of args.haves) {
      if (want.commits.has(have)) acks.push(have);
    }
    const parts: Buffer[] = [];
    if (isV2) {
      parts.push(pktLine('acknowledgments\n'));
      if (acks.length > 0) {
        for (const ack of acks) parts.push(pktLine(`ACK ${ack}\n`));
      } else {
        parts.push(pktLine('NAK\n'));
      }
      parts.push(pktLine(null));
    } else {
      if (acks.length > 0) {
        for (const ack of acks) parts.push(pktLine(`ACK ${ack}\n`));
      } else {
        parts.push(pktLine('NAK\n'));
      }
      parts.push(pktLine(null));
    }
    return Buffer.concat(parts);
  }

  if (isV2) {
    const parts: Buffer[] = [];
    if (shallowLines.length > 0 || unshallowLines.length > 0) {
      parts.push(pktLine('shallow-info\n'));
      for (const oid of shallowLines) parts.push(pktLine(`shallow ${oid}\n`));
      for (const oid of unshallowLines) parts.push(pktLine(`unshallow ${oid}\n`));
      parts.push(pktLine(null));
    }
    parts.push(pktLine('packfile\n'));
    parts.push(...sidebandPackets(pack));
    parts.push(pktLine(null));
    return Buffer.concat(parts);
  }

  // v0: NAK/ACK lines, then shallow lines, then the sideband pack.
  const parts: Buffer[] = [];
  const acks: string[] = [];
  for (const have of args.haves) {
    if (want.commits.has(have)) acks.push(have);
  }
  if (acks.length > 0) {
    for (const ack of acks) parts.push(pktLine(`ACK ${ack}\n`));
  } else {
    parts.push(pktLine('NAK\n'));
  }
  for (const oid of shallowLines) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of unshallowLines) parts.push(pktLine(`unshallow ${oid}\n`));
  parts.push(...sidebandPackets(pack));
  parts.push(pktLine(null));
  return Buffer.concat(parts);
}

// ---- receive-pack ----

type PushCommand = { oldOid: string; newOid: string; ref: string };

function receivePackResponse(store: Store, repo: Repo, body: Buffer): { payload: Buffer; sideband: boolean } {
  const { lines, packStart } = scanUntilFlush(body);
  const commands: PushCommand[] = [];
  let clientCaps: string[] = [];
  for (let idx = 0; idx < lines.length; idx++) {
    const raw = lines[idx];
    const line = raw.endsWith('\n') ? raw.slice(0, -1) : raw;
    const nul = line.indexOf('\0');
    const head = nul === -1 ? line : line.slice(0, nul);
    if (idx === 0 && nul !== -1) clientCaps = line.slice(nul + 1).split(' ').filter(Boolean);
    const parts = head.split(' ');
    if (parts.length !== 3) throw new Error('bad receive-pack command line');
    commands.push({ oldOid: parts[0], newOid: parts[1], ref: parts[2] });
  }
  if (commands.length === 0) throw new Error('receive-pack with no commands');

  const packBytes = packStart === -1 ? Buffer.alloc(0) : body.subarray(packStart);
  let unpackOk = true;
  let unpackDetail = 'ok';
  if (packBytes.length > 0) {
    try {
      unpackIntoStore(repo, packBytes);
    } catch (err) {
      unpackOk = false;
      unpackDetail = `error ${String(err instanceof Error ? err.message : err).replace(/[\r\n]+/g, ' ')}`;
    }
  }

  const results: Array<{ ref: string; ok: boolean; reason: string }> = [];
  for (const cmd of commands) {
    if (!unpackOk) {
      results.push({ ref: cmd.ref, ok: false, reason: 'unpack failed' });
      continue;
    }
    const current = store.getRef(repo, cmd.ref);
    if (cmd.newOid === ZERO_OID) {
      // delete
      if (current === undefined) {
        results.push({ ref: cmd.ref, ok: false, reason: 'remote ref does not exist' });
      } else if (cmd.oldOid !== ZERO_OID && cmd.oldOid !== current) {
        results.push({ ref: cmd.ref, ok: false, reason: 'non-fast-forward' });
      } else {
        store.deleteRef(repo, cmd.ref);
        results.push({ ref: cmd.ref, ok: true, reason: '' });
      }
      continue;
    }
    if (!repo.objects.has(cmd.newOid)) {
      results.push({ ref: cmd.ref, ok: false, reason: 'object not found' });
      continue;
    }
    if (current === undefined) {
      if (cmd.oldOid !== ZERO_OID) {
        results.push({ ref: cmd.ref, ok: false, reason: 'non-fast-forward' });
      } else {
        store.setRef(repo, cmd.ref, cmd.newOid);
        results.push({ ref: cmd.ref, ok: true, reason: '' });
      }
      continue;
    }
    if (cmd.oldOid !== current) {
      results.push({ ref: cmd.ref, ok: false, reason: 'non-fast-forward' });
      continue;
    }
    if (cmd.newOid === current || store.isAncestor(repo, current, cmd.newOid)) {
      store.setRef(repo, cmd.ref, cmd.newOid);
      results.push({ ref: cmd.ref, ok: true, reason: '' });
    } else {
      results.push({ ref: cmd.ref, ok: false, reason: 'non-fast-forward' });
    }
  }

  const reportLines: string[] = [unpackOk ? 'unpack ok\n' : `unpack ${unpackDetail}\n`];
  for (const r of results) {
    reportLines.push(r.ok ? `ok ${r.ref}\n` : `ng ${r.ref} ${r.reason}\n`);
  }
  const inner = Buffer.concat([...reportLines.map((l) => pktLine(l)), pktLine(null)]);
  const useSideband = clientCaps.includes('side-band-64k');
  if (!useSideband) return { payload: inner, sideband: false };
  return { payload: Buffer.concat([...sidebandPackets(inner), pktLine(null)]), sideband: true };
}

// ---- handler factory ----

export function createGitHandlers(store: ReturnType<typeof createStore>, token: string): (req: IncomingMessage, res: ServerResponse) => Promise<boolean> {
  return async (req, res): Promise<boolean> => {
    let pathname: string;
    let searchParams: URLSearchParams;
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      pathname = url.pathname;
      searchParams = url.searchParams;
    } catch {
      return false;
    }
    const segs = pathname.split('/').filter((s) => s.length > 0);
    if (segs.length < 2 || !segs[1].endsWith('.git')) return false;
    const owner = decodeSegment(segs[0]);
    const name = decodeSegment(segs[1].slice(0, -4));
    if (owner === null || name === null || owner === '' || name === '') return false;
    const rest = segs.slice(2);
    const method = req.method ?? '';

    const isInfoRefs = method === 'GET' && rest.length === 2 && rest[0] === 'info' && rest[1] === 'refs';
    const isUploadPack = method === 'POST' && rest.length === 1 && rest[0] === 'git-upload-pack';
    const isReceivePack = method === 'POST' && rest.length === 1 && rest[0] === 'git-receive-pack';
    if (!isInfoRefs && !isUploadPack && !isReceivePack) return false;

    try {
      if (isInfoRefs) {
        const service = searchParams.get('service');
        if (service !== 'git-upload-pack' && service !== 'git-receive-pack') return false;
        if (!authed(req, token)) {
          sendJson(res, 401, { message: 'Bad credentials' });
          return true;
        }
        const repo = store.getRepo(owner, name);
        if (!repo) {
          sendJson(res, 404, { message: 'Not Found' });
          return true;
        }
        if (service === 'git-receive-pack') {
          res.writeHead(200, { 'Content-Type': 'application/x-git-receive-pack-advertisement' });
          res.end(
            v0Advertisement(
              store,
              repo,
              'git-receive-pack',
              `report-status delete-refs side-band-64k ofs-delta agent=${AGENT} symref=HEAD:${repo.head}`,
            ),
          );
          return true;
        }
        // git-upload-pack: v2 when the client asked for it, v0 otherwise.
        if (req.headers['git-protocol'] === 'version=2') {
          res.writeHead(200, { 'Content-Type': 'application/x-git-upload-pack-advertisement' });
          res.end(v2Advertisement());
        } else {
          res.writeHead(200, { 'Content-Type': 'application/x-git-upload-pack-advertisement' });
          res.end(
            v0Advertisement(
              store,
              repo,
              'git-upload-pack',
              `symref=HEAD:${repo.head} side-band-64k thin-pack ofs-delta shallow multi_ack agent=${AGENT}`,
            ),
          );
        }
        return true;
      }

      // POST git-upload-pack / git-receive-pack
      if (!authed(req, token)) {
        sendJson(res, 401, { message: 'Bad credentials' });
        return true;
      }
      const repo = store.getRepo(owner, name);
      if (!repo) {
        sendJson(res, 404, { message: 'Not Found' });
        return true;
      }
      const body = await readBody(req);
      if (isUploadPack) {
        const lines = scanPktLines(body);
        const args = parseFetchLines(lines);
        if (args.command === 'ls-refs') {
          res.writeHead(200, { 'Content-Type': 'application/x-git-upload-pack-result' });
          res.end(lsRefsResponse(store, repo, parseLsRefsLines(lines)));
          return true;
        }
        if (args.command === 'fetch' || args.wants.length > 0) {
          const isV2 = args.command === 'fetch' || req.headers['git-protocol'] === 'version=2';
          res.writeHead(200, { 'Content-Type': 'application/x-git-upload-pack-result' });
          res.end(fetchResponse(store, repo, args, isV2));
          return true;
        }
        sendJson(res, 400, { message: 'Bad request' });
        return true;
      }

      // git-receive-pack
      const { payload } = receivePackResponse(store, repo, body);
      res.writeHead(200, { 'Content-Type': 'application/x-git-receive-pack-result' });
      res.end(payload);
      return true;
    } catch (err) {
      if (!res.headersSent) {
        sendJson(res, 400, { message: err instanceof Error ? err.message : 'Bad request' });
      } else {
        try {
          res.end();
        } catch {
          // already finishing
        }
      }
      return true;
    }
  };
}
