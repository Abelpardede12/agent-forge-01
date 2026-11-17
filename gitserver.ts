// gitserver.ts — git smart HTTP (protocol v2 + v0 fetch) over the in-memory store.
// Pure Node, zero dependencies. Erasable TypeScript only (run by Node 24 type-stripping).
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Repo, Store } from './store.ts';
import { pktLine, buildPack, objectClosure, unpackIntoStore, parseCommit } from './git.ts';

const ZERO_OID = '0'.repeat(40);
const MAX_SIDEBAND_CHUNK = 60000;

type Pkt = { kind: 'data' | 'flush' | 'delim'; data?: Buffer; end: number };

function scanPackets(buf: Buffer, stopAtFlush = false): Pkt[] {
  const out: Pkt[] = [];
  let i = 0;
  while (i < buf.length) {
    if (i + 4 > buf.length) throw new Error('scanPackets: truncated length prefix');
    const len = parseInt(buf.subarray(i, i + 4).toString('ascii'), 16);
    if (Number.isNaN(len) || len < 0) throw new Error('scanPackets: bad length prefix');
    if (len === 0) {
      out.push({ kind: 'flush', end: i + 4 });
      i += 4;
      // After a receive-pack flush the raw packfile bytes follow; they are
      // NOT pkt-lines, so stop scanning here.
      if (stopAtFlush) break;
    }
    else if (len === 1) { out.push({ kind: 'delim', end: i + 4 }); i += 4; }
    else {
      if (len < 4 || i + len > buf.length) throw new Error('scanPackets: truncated packet');
      out.push({ kind: 'data', data: buf.subarray(i + 4, i + len), end: i + len });
      i += len;
    }
  }
  return out;
}

// Split a request body into text lines, split at the delim packet (v2 args
// live after it). packStart is the byte offset just after the first flush
// packet (-1 when there is none); everything after it is packfile bytes.
function splitRequest(buf: Buffer, stopAtFlush = false): { head: string[]; args: string[]; packStart: number } {
  const packets = scanPackets(buf, stopAtFlush);
  const head: string[] = [];
  const args: string[] = [];
  let afterDelim = false;
  let packStart = -1;
  for (const p of packets) {
    if (p.kind === 'flush') {
      if (packStart === -1) packStart = p.end;
      // receive-pack bodies carry raw packfile bytes after the flush; those
      // bytes are NOT pkt-lines, so stop scanning there.
      if (stopAtFlush) break;
      continue;
    }
    if (p.kind === 'delim') { afterDelim = true; continue; }
    const text = p.data!.toString('utf8');
    const line = text.endsWith('\n') ? text.slice(0, -1) : text;
    (afterDelim ? args : head).push(line);
  }
  return { head, args, packStart };
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const data = Buffer.from(JSON.stringify(body), 'utf8');
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': data.length });
  res.end(data);
}

function authed(req: IncomingMessage, token: string): boolean {
  if (token === '') return true;
  return req.headers.authorization === `Bearer ${token}`;
}

function flushPkt(): Buffer { return pktLine(null); }

function sideband(pack: Buffer): Buffer[] {
  const out: Buffer[] = [];
  for (let i = 0; i < pack.length; i += MAX_SIDEBAND_CHUNK) {
    const chunk = pack.subarray(i, Math.min(pack.length, i + MAX_SIDEBAND_CHUNK));
    out.push(pktLine(Buffer.concat([Buffer.from([1]), chunk])));
  }
  return out;
}

function packForClosure(repo: Repo, wants: string[], haves: string[], maxDepth?: number, shallow?: string[]): Buffer {
  const closure = objectClosure(repo, wants, haves, maxDepth, shallow);
  const objects: Array<{ type: string; data: Buffer }> = [];
  for (const oid of [...closure].sort()) {
    const obj = repo.objects.get(oid);
    if (obj) objects.push({ type: obj.type, data: obj.data });
  }
  return buildPack(objects);
}

function commitParents(repo: Repo, oid: string): string[] {
  const obj = repo.objects.get(oid);
  if (!obj || obj.type !== 'commit') return [];
  return parseCommit(obj.data).parents;
}

// Follow a tag object chain to its target commit (a ref pointing directly
// at a commit peels to itself). Used for ls-refs `peeled:` values.
function peelToCommit(repo: Repo, oid: string): string {
  let cur = oid;
  for (let i = 0; i < 16; i++) {
    const obj = repo.objects.get(cur);
    if (!obj || obj.type !== 'tag') return cur;
    const m = /^object ([0-9a-f]{40})/m.exec(obj.data.toString('utf8'));
    if (!m) return cur;
    cur = m[1];
  }
  return cur;
}

// BFS generation depths from the want roots (depth 0 = the wants). Tag
// wants peel to their target commit at the same depth. Returns the shallow
// boundary (commits at depth-1 with parents) and the set of commits inside
// the closure (depth < depth).
function shallowBoundary(repo: Repo, wants: string[], depth: number): { boundary: string[]; inside: Set<string> } {
  const depths = new Map<string, number>();
  const queue: Array<[string, number]> = wants.map((w) => [w, 0] as [string, number]);
  const boundary: string[] = [];
  while (queue.length > 0) {
    let [oid, d] = queue.shift()!;
    // Peel tag objects to their target commit without consuming a generation.
    for (let i = 0; i < 16; i++) {
      const obj = repo.objects.get(oid);
      if (!obj || obj.type !== 'tag') break;
      const m = /^object ([0-9a-f]{40})/m.exec(obj.data.toString('utf8'));
      if (!m) break;
      oid = m[1];
    }
    if (d >= depth || depths.has(oid)) continue;
    depths.set(oid, d);
    const parents = commitParents(repo, oid);
    if (d === depth - 1 && parents.length > 0) boundary.push(oid);
    for (const p of parents) queue.push([p, d + 1]);
  }
  return { boundary, inside: new Set(depths.keys()) };
}

function fullAncestorSet(repo: Repo, wants: string[]): Set<string> {
  const seen = new Set<string>();
  const stack = [...wants];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    if (seen.has(cur)) continue;
    seen.add(cur);
    for (const p of commitParents(repo, cur)) stack.push(p);
  }
  return seen;
}

export function createGitHandlers(store: Store, token: string): (req: IncomingMessage, res: ServerResponse) => Promise<boolean> {
  return async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const m = /^\/([^/]+)\/([^/]+)\.git\/(.+)$/.exec(url.pathname);
      if (!m) return false;
      const owner = decodeURIComponent(m[1]);
      const name = decodeURIComponent(m[2]);
      const rest = m[3];
      const method = req.method ?? 'GET';

      const isInfoRefs = method === 'GET' && rest === 'info/refs';
      const isUploadPack = method === 'POST' && rest === 'git-upload-pack';
      const isReceivePack = method === 'POST' && rest === 'git-receive-pack';
      if (!isInfoRefs && !isUploadPack && !isReceivePack) return false;

      if (isInfoRefs) {
        const service = url.searchParams.get('service');
        if (service !== 'git-upload-pack' && service !== 'git-receive-pack') return false;
      }

      if (!authed(req, token)) {
        sendJson(res, 401, { message: 'Bad credentials' });
        return true;
      }

      const repo = store.getRepo(owner, name);
      if (!repo) {
        sendJson(res, 404, { message: 'Not Found' });
        return true;
      }

      if (isInfoRefs) {
        const service = url.searchParams.get('service')!;
        // Protocol v2 only when the client asked for it — and never for
        // receive-pack: git's push client and the kit client both require
        // a v0 receive-pack advertisement.
        const wantsV2 = service === 'git-upload-pack' && req.headers['git-protocol'] === 'version=2';
        if (wantsV2) {
          const parts: Buffer[] = [];
          parts.push(pktLine('# service=git-upload-pack\n'), flushPkt());
          parts.push(pktLine('version 2\n'));
          parts.push(pktLine('ls-refs=unborn\n'));
          parts.push(pktLine('fetch=shallow wait-for-done filter\n'));
          parts.push(pktLine('object-format=sha1\n'));
          parts.push(pktLine('agent=coreforge/1.0\n'));
          parts.push(flushPkt());
          res.writeHead(200, { 'Content-Type': 'application/x-git-upload-pack-advertisement' });
          res.end(Buffer.concat(parts));
          return true;
        }
        // v0 advertisement: '# service=...', flush, '<oid> <ref>\0<caps>' on
        // the first line, one '<oid> <ref>' per ref, flush. Empty repo:
        // '<zero> capabilities^{}' carries the capabilities instead.
        const caps = service === 'git-upload-pack'
          ? `multi_ack thin-pack side-band side-band-64k ofs-delta shallow deepen-since deepen-not deepen-relative no-progress include-tag multi_ack_detailed agent=coreforge/1.0 symref=HEAD:${repo.head}`
          : 'report-status side-band-64k delete-refs quiet ofs-delta agent=coreforge/1.0';
        const parts: Buffer[] = [];
        parts.push(pktLine(`# service=${service}\n`), flushPkt());
        const headOid = store.resolveRef(repo, 'HEAD');
        const refs = store.listRefs(repo);
        if (headOid) {
          parts.push(pktLine(`${headOid} HEAD\0${caps}\n`));
        } else {
          parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
        }
        for (const { ref, oid } of refs) parts.push(pktLine(`${oid} ${ref}\n`));
        parts.push(flushPkt());
        const contentType = service === 'git-upload-pack'
          ? 'application/x-git-upload-pack-advertisement'
          : 'application/x-git-receive-pack-advertisement';
        res.writeHead(200, { 'Content-Type': contentType });
        res.end(Buffer.concat(parts));
        return true;
      }

      const body = await readBody(req);

      if (isUploadPack) {
        const { head, args } = splitRequest(body);
        const firstLine = (head[0] ?? args[0] ?? '').replace(/\n$/, '');
        const allLines = [...head, ...args];
        const isLsRefs = firstLine.startsWith('command=ls-refs');
        const isFetch = firstLine.startsWith('command=fetch');
        const isV0 = firstLine.startsWith('want ');

        res.writeHead(200, { 'Content-Type': 'application/x-git-upload-pack-result' });

        if (isLsRefs) {
          let peel = false;
          let symrefs = false;
          let unborn = false;
          const prefixes: string[] = [];
          for (const line of args) {
            if (line === 'peel') peel = true;
            else if (line === 'symrefs') symrefs = true;
            else if (line === 'unborn') unborn = true;
            else if (line.startsWith('ref-prefix ')) prefixes.push(line.slice('ref-prefix '.length));
          }
          const keep = (n: string): boolean => prefixes.length === 0 || prefixes.some((p) => n.startsWith(p));
          const out: Buffer[] = [];
          const headOid = store.resolveRef(repo, 'HEAD');
          if (headOid) {
            if (keep('HEAD')) {
              let line = `${headOid} HEAD`;
              if (symrefs) line += ` symref-target:${repo.head}`;
              if (peel) line += ` peeled:${peelToCommit(repo, headOid)}`;
              out.push(pktLine(`${line}\n`));
            }
          } else if (unborn && keep('HEAD')) {
            let line = 'unborn HEAD';
            if (symrefs) line += ` symref-target:${repo.head}`;
            out.push(pktLine(`${line}\n`));
          }
          for (const { ref, oid } of store.listRefs(repo)) {
            if (!keep(ref)) continue;
            let line = `${oid} ${ref}`;
            if (peel) line += ` peeled:${peelToCommit(repo, oid)}`;
            out.push(pktLine(`${line}\n`));
          }
          out.push(flushPkt());
          res.end(Buffer.concat(out));
          return true;
        }

        if (isFetch || isV0) {
          const wants: string[] = [];
          const haves: string[] = [];
          const shallowReq: string[] = [];
          let deepen: number | null = null;
          let done = false;
          for (const line of allLines) {
            const nul = line.indexOf('\0');
            const clean = nul === -1 ? line : line.slice(0, nul);
            if (clean === 'done') { done = true; continue; }
            const parts = clean.split(' ');
            if (parts[0] === 'want' && parts[1]) wants.push(parts[1]);
            else if (parts[0] === 'have' && parts[1]) haves.push(parts[1]);
            else if (parts[0] === 'shallow' && parts[1]) shallowReq.push(parts[1]);
            else if (parts[0] === 'deepen' && parts[1]) {
              const n = Number(parts[1]);
              if (Number.isInteger(n) && n > 0) deepen = n;
            }
          }

          if (!done) {
            const out: Buffer[] = [];
            if (isV0) {
              // v0 shallow: the shallow/unshallow lines travel in this first
              // (acknowledgment-phase) response, terminated by a FLUSH —
              // the client expects the flush here, NOT a NAK (the NAK comes
              // only in the `done` response, after a second shallow section).
              if (deepen !== null) {
                const { boundary, inside } = shallowBoundary(repo, wants, deepen);
                for (const b of boundary) out.push(pktLine(`shallow ${b}\n`));
                for (const s of shallowReq) {
                  if (boundary.includes(s)) continue;
                  if (inside.has(s) && commitParents(repo, s).length > 0) out.push(pktLine(`unshallow ${s}\n`));
                }
                out.push(flushPkt());
              } else {
                out.push(pktLine('NAK\n'));
                out.push(flushPkt());
              }
            } else {
              out.push(pktLine('acknowledgments\n'));
              const acks: string[] = [];
              for (const have of haves) {
                if (!repo.objects.has(have)) continue;
                // Peel tag wants: a have equal to a tag's target commit is common.
                if (wants.some((w) => store.isAncestor(repo, have, peelToCommit(repo, w)))) acks.push(have);
              }
              if (acks.length === 0) out.push(pktLine('NAK\n'));
              else for (const a of acks) out.push(pktLine(`ACK ${a}\n`));
              out.push(flushPkt());
            }
            res.end(Buffer.concat(out));
            return true;
          }

          // done: NO acknowledgments section; straight to shallow-info / packfile.
          // The done request may omit haves (protocol v2 sends them only in
          // the negotiation request), so the held set is haves ∪ the client's
          // shallow boundaries — the boundaries are held commits themselves.
          const held = [...new Set([...haves, ...shallowReq])];
          const out: Buffer[] = [];
          if (isV0) {
            if (deepen !== null) {
              const { boundary, inside } = shallowBoundary(repo, wants, deepen);
              for (const b of boundary) out.push(pktLine(`shallow ${b}\n`));
              for (const s of shallowReq) {
                if (boundary.includes(s)) continue;
                if (inside.has(s) && commitParents(repo, s).length > 0) out.push(pktLine(`unshallow ${s}\n`));
              }
              // Flush ends the shallow section; NAK + pack follow.
              out.push(flushPkt());
            }
            out.push(pktLine('NAK\n'));
            const pack = packForClosure(repo, wants, held, deepen ?? undefined, shallowReq);
            out.push(...sideband(pack));
            out.push(flushPkt());
            res.end(Buffer.concat(out));
            return true;
          }
          // v2 with done
          let boundary: string[] = [];
          let inside: Set<string>;
          if (deepen !== null) {
            const r = shallowBoundary(repo, wants, deepen);
            boundary = r.boundary;
            inside = r.inside;
          } else {
            inside = fullAncestorSet(repo, wants);
          }
          const unshallow: string[] = [];
          for (const s of shallowReq) {
            if (boundary.includes(s)) continue;
            if (inside.has(s) && commitParents(repo, s).length > 0) unshallow.push(s);
          }
          if (boundary.length > 0 || unshallow.length > 0) {
            out.push(pktLine('shallow-info\n'));
            for (const b of boundary) out.push(pktLine(`shallow ${b}\n`));
            for (const u of unshallow) out.push(pktLine(`unshallow ${u}\n`));
            out.push(flushPkt());
          }
          out.push(pktLine('packfile\n'));
          const pack = packForClosure(repo, wants, held, deepen ?? undefined, shallowReq);
          out.push(...sideband(pack));
          out.push(flushPkt());
          res.end(Buffer.concat(out));
          return true;
        }

        // Unknown upload-pack body: empty response.
        res.end(flushPkt());
        return true;
      }

      // ---- receive-pack ----
      if (isReceivePack) {
        const { head, packStart } = splitRequest(body, true);
        const commands: Array<{ old: string; new: string; ref: string }> = [];
        for (const line of head) {
          const nul = line.indexOf('\0');
          const clean = nul === -1 ? line : line.slice(0, nul);
          const parts = clean.split(' ');
          if (parts.length >= 3 && /^[0-9a-f]{40}$/.test(parts[0]) && /^[0-9a-f]{40}$/.test(parts[1])) {
            commands.push({ old: parts[0], new: parts[1], ref: parts[2] });
          }
        }
        let unpackError: string | undefined;
        if (packStart !== -1 && packStart < body.length) {
          const packBytes = body.subarray(packStart);
          if (packBytes.length >= 12 && packBytes.subarray(0, 4).toString('ascii') === 'PACK') {
            try {
              unpackIntoStore(repo, packBytes);
            } catch (e) {
              unpackError = e instanceof Error ? e.message : String(e);
            }
          }
        }
        const results: Array<{ ref: string; ok: boolean; reason?: string }> = [];
        for (const cmd of commands) {
          if (unpackError) { results.push({ ref: cmd.ref, ok: false, reason: 'unpack failed' }); continue; }
          if (cmd.new === ZERO_OID) {
            // delete
            if (!store.getRef(repo, cmd.ref)) {
              results.push({ ref: cmd.ref, ok: false, reason: 'remote ref does not exist' });
            } else if (cmd.old !== ZERO_OID && store.getRef(repo, cmd.ref) !== cmd.old) {
              results.push({ ref: cmd.ref, ok: false, reason: 'old value mismatch' });
            } else {
              store.deleteRef(repo, cmd.ref);
              results.push({ ref: cmd.ref, ok: true });
            }
            continue;
          }
          if (!repo.objects.has(cmd.new)) {
            results.push({ ref: cmd.ref, ok: false, reason: 'missing object' });
            continue;
          }
          if (cmd.old === ZERO_OID) {
            if (store.getRef(repo, cmd.ref)) {
              results.push({ ref: cmd.ref, ok: false, reason: 'already exists' });
            } else {
              store.setRef(repo, cmd.ref, cmd.new);
              results.push({ ref: cmd.ref, ok: true });
            }
            continue;
          }
          const current = store.getRef(repo, cmd.ref);
          if (current !== cmd.old) {
            results.push({ ref: cmd.ref, ok: false, reason: 'old value mismatch' });
            continue;
          }
          if (!store.isAncestor(repo, cmd.old, cmd.new)) {
            results.push({ ref: cmd.ref, ok: false, reason: 'non-fast-forward' });
            continue;
          }
          store.setRef(repo, cmd.ref, cmd.new);
          results.push({ ref: cmd.ref, ok: true });
        }
        // Report-status inside side-band-64k band 1: the whole report stream
        // (one inner pkt-line per line, terminated by an INNER flush) is the
        // band-1 data, chunked into sideband packets; a single OUTER flush
        // then ends the response. Without the inner flush the client's
        // report parser hits EOF mid-stream ("remote end hung up").
        const report: Buffer[] = [];
        if (unpackError) report.push(pktLine(`unpack ${unpackError}\n`));
        else report.push(pktLine('unpack ok\n'));
        for (const r of results) {
          report.push(pktLine(r.ok ? `ok ${r.ref}\n` : `ng ${r.ref} ${r.reason ?? 'failed'}\n`));
        }
        report.push(flushPkt());
        const out: Buffer[] = [...sideband(Buffer.concat(report)), flushPkt()];
        res.writeHead(200, { 'Content-Type': 'application/x-git-receive-pack-result' });
        res.end(Buffer.concat(out));
        return true;
      }

      return false;
    } catch (e) {
      if (!res.headersSent) {
        sendJson(res, 500, { message: e instanceof Error ? e.message : String(e) });
      } else {
        try { res.end(); } catch { /* already ended */ }
      }
      return true;
    }
  };
}
