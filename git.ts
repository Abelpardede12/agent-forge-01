// git.ts — git object model + pack protocol. Pure Node, zero dependencies.
// Erasable TypeScript only (run directly by Node 24 type-stripping).
import { createHash } from 'node:crypto';
import { inflateSync, deflateSync } from 'node:zlib';
import type { Repo } from './store.ts';

export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';
export type PackObject = { type: GitObjectType; data: Buffer; oid: string };
export type TreeEntry = { mode: string; name: string; oid: string };
export type CommitView = { tree: string; parents: string[]; author: string; committer: string; message: string };

const OBJ_COMMIT = 1;
const OBJ_TREE = 2;
const OBJ_BLOB = 3;
const OBJ_TAG = 4;
const OBJ_OFS_DELTA = 6;
const OBJ_REF_DELTA = 7;

function typeName(n: number): GitObjectType {
  if (n === OBJ_COMMIT) return 'commit';
  if (n === OBJ_TREE) return 'tree';
  if (n === OBJ_BLOB) return 'blob';
  if (n === OBJ_TAG) return 'tag';
  throw new Error(`parsePack: unknown object type ${n}`);
}

function typeNum(t: string): number {
  if (t === 'commit') return OBJ_COMMIT;
  if (t === 'tree') return OBJ_TREE;
  if (t === 'blob') return OBJ_BLOB;
  if (t === 'tag') return OBJ_TAG;
  throw new Error(`buildPack: unknown object type ${t}`);
}

// ---- hashing ----

export function sha1Hex(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

function objectId(type: string, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return createHash('sha1').update(header).update(data).digest('hex');
}

// ---- pkt-lines ----

export function pktLine(data: Buffer | string | null): Buffer {
  if (data === null) return Buffer.from('0000', 'ascii');
  const payload = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
  const len = payload.length + 4;
  if (len > 0xffff) throw new Error('pktLine: payload too large');
  return Buffer.concat([Buffer.from(len.toString(16).padStart(4, '0'), 'ascii'), payload]);
}

export function parsePktLines(buf: Buffer): Array<{ data: Buffer } | { flush: true }> {
  const out: Array<{ data: Buffer } | { flush: true }> = [];
  let i = 0;
  while (i < buf.length) {
    if (i + 4 > buf.length) throw new Error('parsePktLines: truncated length prefix');
    const len = parseInt(buf.subarray(i, i + 4).toString('ascii'), 16);
    if (Number.isNaN(len)) throw new Error('parsePktLines: bad length prefix');
    if (len === 0) {
      out.push({ flush: true });
      i += 4;
    } else {
      if (len < 4 || i + len > buf.length) throw new Error('parsePktLines: truncated packet');
      out.push({ data: buf.subarray(i + 4, i + len) });
      i += len;
    }
  }
  return out;
}

// ---- deltas ----

function readVarint(buf: Buffer, pos: number): { value: number; next: number } {
  let value = 0;
  let shift = 0;
  let i = pos;
  for (;;) {
    if (i >= buf.length) throw new Error('applyDelta: truncated varint');
    const b = buf[i++];
    value |= (b & 0x7f) << shift;
    shift += 7;
    if ((b & 0x80) === 0) break;
  }
  return { value, next: i };
}

export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  const src = readVarint(delta, 0);
  if (src.value !== base.length) throw new Error(`applyDelta: base size mismatch (${src.value} != ${base.length})`);
  const tgt = readVarint(delta, src.next);
  const parts: Buffer[] = [];
  let total = 0;
  let i = tgt.next;
  while (i < delta.length) {
    const op = delta[i++];
    if (op & 0x80) {
      // copy from base: offset/size encoded in following bytes
      let offset = 0;
      let size = 0;
      for (let bit = 0; bit < 4; bit++) {
        if (op & (1 << bit)) {
          if (i >= delta.length) throw new Error('applyDelta: truncated copy op');
          offset |= delta[i++] << (bit * 8);
        }
      }
      for (let bit = 0; bit < 3; bit++) {
        if (op & (0x10 << bit)) {
          if (i >= delta.length) throw new Error('applyDelta: truncated copy op');
          size |= delta[i++] << (bit * 8);
        }
      }
      if (size === 0) size = 0x10000;
      if (offset + size > base.length) throw new Error('applyDelta: copy out of range');
      parts.push(base.subarray(offset, offset + size));
      total += size;
    } else if (op !== 0) {
      // insert literal bytes
      if (i + op > delta.length) throw new Error('applyDelta: truncated insert op');
      parts.push(delta.subarray(i, i + op));
      i += op;
      total += op;
    } else {
      throw new Error('applyDelta: opcode 0 is reserved');
    }
  }
  if (total !== tgt.value) throw new Error(`applyDelta: target size mismatch (${total} != ${tgt.value})`);
  return Buffer.concat(parts, total);
}

// ---- pack parsing ----

// node:zlib inflateSync ignores trailing bytes but throws on truncation, so the
// compressed length is found by binary search against the expected size from
// the pack entry header.
function inflateAt(buf: Buffer, pos: number, expectedSize: number): { data: Buffer; next: number } {
  let lo = 1;
  let hi = buf.length - pos;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    let ok = false;
    try {
      const out = inflateSync(buf.subarray(pos, pos + mid));
      ok = out.length === expectedSize;
    } catch {
      ok = false;
    }
    if (ok) {
      found = mid;
      hi = mid - 1;
    } else {
      // Distinguish "too short" (throws) from "wrong size" (succeeds but
      // wrong length): a successful inflate with the wrong length means the
      // stream already ended, so longer slices will not help either — but
      // they cannot be shorter than the true stream, so treat as too short
      // only when it threw. Re-check by trying: if inflate succeeded, the
      // stream ended at or before mid, so the true length is <= mid.
      let threw = false;
      try {
        inflateSync(buf.subarray(pos, pos + mid));
      } catch {
        threw = true;
      }
      if (threw) lo = mid + 1;
      else hi = mid - 1;
    }
  }
  if (found === -1) throw new Error('parsePack: could not inflate object data');
  return { data: inflateSync(buf.subarray(pos, pos + found)), next: pos + found };
}

function readPackEntryHeader(buf: Buffer, pos: number): { type: number; size: number; next: number } {
  if (pos >= buf.length) throw new Error('parsePack: truncated entry header');
  const b0 = buf[pos];
  const type = (b0 >> 4) & 0x07;
  let size = b0 & 0x0f;
  let shift = 4;
  let i = pos + 1;
  while ((buf[i - 1] & 0x80) !== 0) {
    if (i >= buf.length) throw new Error('parsePack: truncated entry size');
    const b = buf[i++];
    size += (b & 0x7f) * 2 ** shift;
    shift += 7;
    if ((b & 0x80) === 0) break;
  }
  return { type, size, next: i };
}

function readOfsDeltaOffset(buf: Buffer, pos: number): { offset: number; next: number } {
  if (pos >= buf.length) throw new Error('parsePack: truncated ofs-delta offset');
  let offset = buf[pos] & 0x7f;
  let i = pos + 1;
  while (buf[i - 1] & 0x80) {
    if (i >= buf.length) throw new Error('parsePack: truncated ofs-delta offset');
    offset = ((offset + 1) << 7) | (buf[i] & 0x7f);
    i++;
  }
  return { offset, next: i };
}

export function parsePack(
  buf: Buffer,
  externalBase?: (oid: string) => { type: string; data: Buffer } | undefined,
): { objects: PackObject[] } {
  if (buf.length < 12 || buf.subarray(0, 4).toString('ascii') !== 'PACK') {
    throw new Error('parsePack: bad magic');
  }
  const version = buf.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`parsePack: unsupported version ${version}`);
  const count = buf.readUInt32BE(8);

  type RawEntry = {
    start: number;
    type: number;
    size: number;
    data: Buffer;
    ofsBase?: number;
    refBase?: string;
  };
  const raw: RawEntry[] = [];
  let pos = 12;
  for (let n = 0; n < count; n++) {
    const start = pos;
    const header = readPackEntryHeader(buf, pos);
    pos = header.next;
    let ofsBase: number | undefined;
    let refBase: string | undefined;
    if (header.type === OBJ_OFS_DELTA) {
      const off = readOfsDeltaOffset(buf, pos);
      ofsBase = start - off.offset;
      pos = off.next;
    } else if (header.type === OBJ_REF_DELTA) {
      if (pos + 20 > buf.length) throw new Error('parsePack: truncated ref-delta base');
      refBase = buf.subarray(pos, pos + 20).toString('hex');
      pos += 20;
    } else if (header.type !== OBJ_COMMIT && header.type !== OBJ_TREE && header.type !== OBJ_BLOB && header.type !== OBJ_TAG) {
      throw new Error(`parsePack: unknown entry type ${header.type}`);
    }
    const inflated = inflateAt(buf, pos, header.size);
    pos = inflated.next;
    raw.push({ start, type: header.type, size: header.size, data: inflated.data, ofsBase, refBase });
  }

  const byStart = new Map<number, RawEntry>();
  for (const e of raw) byStart.set(e.start, e);

  const resolved = new Map<number, PackObject>();
  const resolving = new Set<number>();
  function resolve(entry: RawEntry): PackObject {
    const cached = resolved.get(entry.start);
    if (cached) return cached;
    if (resolving.has(entry.start)) throw new Error('parsePack: delta cycle');
    resolving.add(entry.start);
    let out: PackObject;
    if (entry.type === OBJ_OFS_DELTA) {
      const baseEntry = byStart.get(entry.ofsBase!);
      if (!baseEntry) throw new Error('parsePack: ofs-delta base not in pack');
      const base = resolve(baseEntry);
      const data = applyDelta(base.data, entry.data);
      out = { type: base.type, data, oid: objectId(base.type, data) };
    } else if (entry.type === OBJ_REF_DELTA) {
      const baseEntry = raw.find((e) => e.type !== OBJ_OFS_DELTA && e.type !== OBJ_REF_DELTA && objectId(typeName(e.type), e.data) === entry.refBase);
      if (baseEntry) {
        const base = resolve(baseEntry);
        const data = applyDelta(base.data, entry.data);
        out = { type: base.type, data, oid: objectId(base.type, data) };
      } else if (externalBase) {
        const ext = externalBase(entry.refBase!);
        if (!ext) throw new Error(`parsePack: ref-delta base ${entry.refBase} not in pack or store`);
        const data = applyDelta(ext.data, entry.data);
        const type = ext.type as GitObjectType;
        out = { type, data, oid: objectId(type, data) };
      } else {
        throw new Error(`parsePack: ref-delta base ${entry.refBase} not in pack`);
      }
    } else {
      const type = typeName(entry.type);
      out = { type, data: entry.data, oid: objectId(type, entry.data) };
    }
    resolving.delete(entry.start);
    resolved.set(entry.start, out);
    return out;
  }

  const objects = raw.map((e) => resolve(e));
  return { objects };
}

// ---- pack building ----

function writePackEntryHeader(type: number, size: number): Buffer {
  const bytes: number[] = [];
  let b = (type << 4) | (size & 0x0f);
  size >>= 4;
  if (size !== 0) b |= 0x80;
  bytes.push(b);
  while (size !== 0) {
    let next = size & 0x7f;
    size >>= 7;
    if (size !== 0) next |= 0x80;
    bytes.push(next);
  }
  return Buffer.from(bytes);
}

export function buildPack(objects: Array<{ type: string; data: Buffer }>): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  for (const obj of objects) {
    parts.push(writePackEntryHeader(typeNum(obj.type), obj.data.length));
    parts.push(deflateSync(obj.data));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

// ---- commit / tree parsing (local copies; store.ts keeps the same logic) ----

export function parseCommit(data: Buffer): CommitView {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const header = split === -1 ? text : text.slice(0, split);
  const message = split === -1 ? '' : text.slice(split + 2);
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of header.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, author, committer, message };
}

export function parseTree(data: Buffer): TreeEntry[] {
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

// ---- closure / fetch ----

export function objectClosure(repo: Repo, roots: string[], exclude: string[], maxDepth?: number): Set<string> {
  const excluded = new Set<string>();
  if (exclude.length > 0) {
    // full closure of the exclude roots (no depth limit: haves are fully held)
    collect(repo, exclude, excluded, undefined);
  }
  const out = new Set<string>();
  collect(repo, roots, out, maxDepth);
  for (const oid of excluded) out.delete(oid);
  return out;
}

function collect(repo: Repo, roots: string[], out: Set<string>, maxDepth: number | undefined): void {
  // Walk commits breadth-first by generation so maxDepth cuts history cleanly.
  const queue: Array<{ oid: string; depth: number }> = roots.map((oid) => ({ oid, depth: 0 }));
  const seenCommits = new Set<string>();
  while (queue.length > 0) {
    const { oid, depth } = queue.shift()!;
    if (seenCommits.has(oid)) continue;
    seenCommits.add(oid);
    // maxDepth N = N generations: depth 0 is the root; a commit at
    // depth >= maxDepth is beyond the boundary and is not included.
    if (maxDepth !== undefined && depth >= maxDepth) continue;
    const obj = repo.objects.get(oid);
    if (!obj || obj.type !== 'commit') {
      // Non-commit root (e.g. a tag or bare tree): include it and its tree.
      if (obj && !out.has(oid)) {
        out.add(oid);
        if (obj.type === 'tree') collectTree(repo, oid, out);
        else if (obj.type === 'tag') {
          const m = /^object ([0-9a-f]{40})/m.exec(obj.data.toString('utf8'));
          if (m) collect(repo, [m[1]], out, undefined);
        }
      }
      continue;
    }
    out.add(oid);
    const commit = parseCommit(obj.data);
    if (commit.tree) collectTree(repo, commit.tree, out);
    if (maxDepth === undefined || depth < maxDepth) {
      for (const p of commit.parents) queue.push({ oid: p, depth: depth + 1 });
    }
  }
}

function collectTree(repo: Repo, treeOid: string, out: Set<string>): void {
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
      if (!child) continue; // missing object: skip silently
      out.add(e.oid);
      if (e.mode === '40000') stack.push(e.oid);
    }
  }
}

export function packForFetch(repo: Repo, wants: string[], haves: string[]): Buffer {
  const closure = objectClosure(repo, wants, haves);
  const objects: Array<{ type: string; data: Buffer }> = [];
  for (const oid of [...closure].sort()) {
    const obj = repo.objects.get(oid);
    if (obj) objects.push({ type: obj.type, data: obj.data });
  }
  return buildPack(objects);
}

export function unpackIntoStore(repo: Repo, buf: Buffer): string[] {
  const { objects } = parsePack(buf, (oid) => {
    const obj = repo.objects.get(oid);
    return obj ? { type: obj.type, data: obj.data } : undefined;
  });
  const oids: string[] = [];
  for (const obj of objects) {
    if (!repo.objects.has(obj.oid)) repo.objects.set(obj.oid, { type: obj.type, data: obj.data });
    oids.push(obj.oid);
  }
  return oids;
}

// ---- protocol v2 argument parsing ----

// Decode the wire text into argument lines: either pkt-line framed input or
// plain newline-separated lines (the server joins decoded pkt-line payloads).
function argLines(text: string): string[] {
  let lines: string[];
  const buf = Buffer.from(text, 'utf8');
  let framed: string[] | null = null;
  if (buf.length >= 4) {
    try {
      const packets = parsePktLines(buf);
      framed = packets
        .filter((p): p is { data: Buffer } => 'data' in p)
        .map((p) => p.data.toString('utf8'));
    } catch {
      framed = null;
    }
  }
  lines = framed ?? text.split('\n');
  return lines
    .map((l) => l.replace(/\r$/, ''))
    .map((l) => (l.endsWith('\n') ? l.slice(0, -1) : l))
    .filter((l) => l.length > 0 && l !== '0000');
}

export function parseFetchArgs(text: string): {
  wants: string[]; haves: string[]; shallow: string[]; deepen: number | null; filter: string | null; done: boolean;
} {
  const wants: string[] = [];
  const haves: string[] = [];
  const shallow: string[] = [];
  let deepen: number | null = null;
  let filter: string | null = null;
  let done = false;
  for (const line of argLines(text)) {
    if (line === 'done') { done = true; continue; }
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
    } else if (cmd === 'filter') {
      filter = head.slice('filter '.length);
    }
    // deepen-since / deepen-not / agent= / object-format= : ignored here
  }
  return { wants, haves, shallow, deepen, filter, done };
}

export function parseLsRefsArgs(text: string): {
  prefixes: string[]; symrefs: boolean; peel: boolean; unborn: boolean;
} {
  const prefixes: string[] = [];
  let symrefs = false;
  let peel = false;
  let unborn = false;
  for (const line of argLines(text)) {
    if (line === 'command=ls-refs') continue;
    if (line === 'peel') { peel = true; continue; }
    if (line === 'unborn') { unborn = true; continue; }
    if (line === 'symrefs') { symrefs = true; continue; }
    if (line === 'ref-prefix') { prefixes.push(''); continue; }
    if (line.startsWith('ref-prefix ')) { prefixes.push(line.slice('ref-prefix '.length)); continue; }
    // object-format= / agent= : ignored here
  }
  return { prefixes, symrefs, peel, unborn };
}
