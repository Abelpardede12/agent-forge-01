// git.ts — the git object model in pure Node: hashing, tree/commit/tag parsing and building,
// packfile reading (with ofs/ref delta resolution) and packfile writing (full objects only),
// plus the pkt-line codec the smart-HTTP protocol speaks. Nothing here shells out: the trial
// sandbox has no git binary, so the forge is its own git.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  readonly type: GitObjectType;
  readonly data: Buffer;
}

export const ZERO_OID = '0'.repeat(40);

const TYPE_IDS: Readonly<Record<GitObjectType, number>> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const ID_TYPES: readonly (GitObjectType | '')[] = ['', 'commit', 'tree', 'blob', 'tag'];

/** SHA-1 of a git object: sha1("<type> <size>\0" + data), as lowercase hex. */
export function hashObject(type: GitObjectType, data: Uint8Array): string {
  const hash = createHash('sha1');
  hash.update(`${type} ${data.length}\0`, 'utf8');
  hash.update(data);
  return hash.digest('hex');
}

export function isObjectId(value: string): boolean {
  return /^[0-9a-f]{40}$/.test(value);
}

// ------------------------------------------------------------------ trees

export interface TreeEntry {
  readonly mode: string;
  readonly name: string;
  readonly oid: string;
}

/** Parse a tree object's bytes into its entries, in stored order. */
export function parseTree(data: Uint8Array): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    const nul = data.indexOf(0x00, space);
    const mode = Buffer.from(data.subarray(offset, space)).toString('utf8');
    const name = Buffer.from(data.subarray(space + 1, nul)).toString('utf8');
    const oid = Buffer.from(data.subarray(nul + 1, nul + 21)).toString('hex');
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

/** Git's tree ordering: names compare bytewise, directories as if they ended in '/'. */
function treeSortKey(entry: TreeEntry): string {
  return isTreeMode(entry.mode) ? `${entry.name}/` : entry.name;
}

/** Serialize entries into a tree object, sorted the way git sorts them. */
export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const ka = treeSortKey(a);
    const kb = treeSortKey(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export function isTreeMode(mode: string): boolean {
  return mode === '40000' || mode === '040000';
}

// ------------------------------------------------------------------ commits and tags

export interface CommitView {
  readonly tree: string;
  readonly parents: readonly string[];
  readonly author: string;
  readonly committer: string;
  readonly message: string;
}

export function parseCommit(data: Uint8Array): CommitView {
  const text = Buffer.from(data).toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split >= 0 ? text.slice(0, split) : text;
  const message = split >= 0 ? text.slice(split + 2) : '';
  let tree = '';
  let author = '';
  let committer = '';
  const parents: string[] = [];
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, author, committer, message };
}

/** The unix timestamp inside an author/committer line ("Name <mail> 1735689600 +0000"), or 0. */
export function identityTimestamp(identity: string): number {
  const match = / (\d+) [+-]\d{4}$/.exec(identity.trim());
  return match ? Number(match[1]) : 0;
}

export function buildCommit(fields: {
  tree: string;
  parents: readonly string[];
  author: string;
  committer: string;
  message: string;
}): Buffer {
  const lines = [`tree ${fields.tree}`];
  for (const parent of fields.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${fields.author}`);
  lines.push(`committer ${fields.committer}`);
  const message = fields.message.endsWith('\n') ? fields.message : `${fields.message}\n`;
  return Buffer.from(`${lines.join('\n')}\n\n${message}`, 'utf8');
}

export interface TagView {
  readonly object: string;
  readonly type: string;
  readonly tag: string;
  readonly tagger: string;
  readonly message: string;
}

export function parseTag(data: Uint8Array): TagView {
  const text = Buffer.from(data).toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split >= 0 ? text.slice(0, split) : text;
  const view: TagView = {
    object: '',
    type: '',
    tag: '',
    tagger: '',
    message: split >= 0 ? text.slice(split + 2) : '',
  };
  for (const line of head.split('\n')) {
    if (line.startsWith('object ')) view.object = line.slice(7).trim();
    else if (line.startsWith('type ')) view.type = line.slice(5).trim();
    else if (line.startsWith('tag ')) view.tag = line.slice(4).trim();
    else if (line.startsWith('tagger ')) view.tagger = line.slice(7);
  }
  return view;
}

// ------------------------------------------------------------------ pack writing

/** One object header inside a pack: the variable-length type+size encoding. */
function writePackObjectHeader(type: GitObjectType, size: number): Buffer {
  const bytes: number[] = [];
  let first = (TYPE_IDS[type] << 4) | (size & 0x0f);
  size = Math.floor(size / 16);
  while (size > 0) {
    bytes.push(first | 0x80);
    first = size & 0x7f;
    size = Math.floor(size / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

/**
 * Build a packfile holding the given objects whole (never delta-compressed: a reader that
 * resolves no deltas still reads every object, and correctness beats bytes here).
 */
export function writePack(objects: Iterable<GitObject>): Buffer {
  const list = [...objects];
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(list.length, 8);
  parts.push(header);
  for (const object of list) {
    parts.push(writePackObjectHeader(object.type, object.data.length));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

/** Apply a git delta (copy/insert instructions) to a base object, per the pack format. */
export function applyDelta(base: Uint8Array, delta: Uint8Array): Buffer {
  let offset = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[offset];
      offset += 1;
      value |= (byte & 0x7f) << shift;
      shift += 7;
      if ((byte & 0x80) === 0) break;
    }
    return value;
  };
  const sourceSize = readVarint();
  if (sourceSize !== base.length) throw new Error(`delta base size ${sourceSize} does not match ${base.length}`);
  const targetSize = readVarint();
  const out: Buffer[] = [];
  let produced = 0;
  while (offset < delta.length) {
    const opcode = delta[offset];
    offset += 1;
    if (opcode & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (opcode & (1 << bit)) {
          copyOffset |= delta[offset] << (8 * bit);
          offset += 1;
        }
      }
      for (let bit = 0; bit < 3; bit += 1) {
        if (opcode & (0x10 << bit)) {
          copySize |= delta[offset] << (8 * bit);
          offset += 1;
        }
      }
      if (copySize === 0) copySize = 0x10000;
      out.push(Buffer.from(base.subarray(copyOffset, copyOffset + copySize)));
      produced += copySize;
    } else if (opcode > 0) {
      out.push(Buffer.from(delta.subarray(offset, offset + opcode)));
      produced += opcode;
      offset += opcode;
    } else {
      throw new Error('delta opcode 0 is reserved');
    }
  }
  const result = Buffer.concat(out);
  if (produced !== targetSize || result.length !== targetSize) {
    throw new Error(`delta produced ${result.length} bytes, expected ${targetSize}`);
  }
  return result;
}

// ------------------------------------------------------------------ pack reading

/**
 * How many compressed bytes the zlib stream starting at `offset` occupies. inflateSync tolerates
 * trailing bytes, so success is monotone in slice length and the exact length is the smallest
 * slice that inflates: bracket it exponentially, then binary-search the boundary.
 */
function inflatedLength(pack: Buffer, offset: number, end: number): number {
  const succeeds = (length: number): boolean => {
    try {
      inflateSync(pack.subarray(offset, offset + length));
      return true;
    } catch {
      return false;
    }
  };
  const limit = end - offset;
  if (!succeeds(limit)) throw new Error('pack object does not inflate');
  let failing = 0;
  let passing = limit;
  let probe = 32;
  while (probe < limit && !succeeds(probe)) {
    failing = probe;
    probe *= 2;
  }
  if (probe < limit) passing = probe;
  while (passing - failing > 1) {
    const mid = Math.floor((failing + passing) / 2);
    if (succeeds(mid)) passing = mid;
    else failing = mid;
  }
  return passing;
}

/**
 * Inflate the stream starting at `offset`, returning its data and its exact compressed length.
 * The zlib engine reports how many input bytes it consumed, which makes finding the next
 * object a single call; the binary search below stays as a fallback for engines that do not.
 */
function inflateExact(pack: Buffer, offset: number, end: number): { data: Buffer; length: number } {
  const slice = pack.subarray(offset, end);
  try {
    const result = inflateSync(slice, { info: true }) as unknown as {
      buffer: Buffer;
      engine?: { bytesWritten?: number };
    };
    const consumed = result.engine?.bytesWritten;
    if (typeof consumed === 'number' && consumed > 0 && consumed <= slice.length) {
      return { data: result.buffer, length: consumed };
    }
  } catch {
    // Fall through to the searching variant.
  }
  const length = inflatedLength(pack, offset, end);
  return { data: inflateSync(pack.subarray(offset, offset + length)), length };
}

interface RawPackEntry {
  readonly offset: number;
  readonly typeId: number;
  readonly data: Buffer;
  readonly baseOid?: string;
  readonly baseOffset?: number;
}

export interface PackReadResult {
  readonly objects: Map<string, GitObject>;
  readonly count: number;
}

/**
 * Read a whole packfile into an object map. Deltas resolve against the pack itself first, then
 * against `resolveBase` (a thin pack's external bases). Throws on any structural problem.
 */
export function readPack(pack: Buffer, resolveBase?: (oid: string) => GitObject | undefined): PackReadResult {
  if (pack.length < 12 + 20 || pack.subarray(0, 4).toString('ascii') !== 'PACK') {
    throw new Error('not a packfile');
  }
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = pack.readUInt32BE(8);
  const end = pack.length - 20;
  const trailer = pack.subarray(end).toString('hex');
  const checksum = createHash('sha1').update(pack.subarray(0, end)).digest('hex');
  if (trailer !== checksum) throw new Error('pack checksum mismatch');
  const raw: RawPackEntry[] = [];
  let offset = 12;
  for (let index = 0; index < count; index += 1) {
    const objectStart = offset;
    let byte = pack[offset];
    offset += 1;
    const typeId = (byte >> 4) & 0x07;
    let size = byte & 0x0f;
    let shift = 4;
    while (byte & 0x80) {
      byte = pack[offset];
      offset += 1;
      size |= (byte & 0x7f) << shift;
      shift += 7;
    }
    let baseOid: string | undefined;
    let baseOffset: number | undefined;
    if (typeId === 6) {
      // ofs-delta: a negative offset encoded one byte at a time, each step adding one.
      let back = pack[offset];
      offset += 1;
      let value = back & 0x7f;
      while (back & 0x80) {
        back = pack[offset];
        offset += 1;
        value = ((value + 1) << 7) | (back & 0x7f);
      }
      baseOffset = objectStart - value;
    } else if (typeId === 7) {
      baseOid = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    } else if (typeId < 1 || typeId > 4) {
      throw new Error(`unknown pack object type ${typeId}`);
    }
    const { data, length } = inflateExact(pack, offset, end);
    if (data.length !== size) throw new Error(`pack object size ${data.length} != header ${size}`);
    offset += length;
    raw.push({ offset: objectStart, typeId, data, baseOid, baseOffset });
  }
  const objects = new Map<string, GitObject>();
  const resolvedByOffset = new Map<number, GitObject>();
  const pending: RawPackEntry[] = [];
  for (const entry of raw) {
    if (entry.typeId >= 1 && entry.typeId <= 4) {
      const type = ID_TYPES[entry.typeId] as GitObjectType;
      const object: GitObject = { type, data: entry.data };
      objects.set(hashObject(type, entry.data), object);
      resolvedByOffset.set(entry.offset, object);
    } else {
      pending.push(entry);
    }
  }
  let remaining = pending;
  let guard = 0;
  while (remaining.length > 0) {
    guard += 1;
    if (guard > count + 2) throw new Error('delta chain does not resolve');
    const next: RawPackEntry[] = [];
    let progressed = false;
    for (const entry of remaining) {
      let base: GitObject | undefined;
      if (entry.typeId === 7) {
        base = objects.get(entry.baseOid!) ?? resolveBase?.(entry.baseOid!);
      } else {
        base = resolvedByOffset.get(entry.baseOffset!);
      }
      if (!base) {
        next.push(entry);
        continue;
      }
      const data = applyDelta(base.data, entry.data);
      const object: GitObject = { type: base.type, data };
      objects.set(hashObject(object.type, data), object);
      resolvedByOffset.set(entry.offset, object);
      progressed = true;
    }
    if (!progressed && next.length === remaining.length) throw new Error('delta base missing');
    remaining = next;
  }
  return { objects, count };
}

// ------------------------------------------------------------------ pkt-line

/** Encode one pkt-line (4-hex length prefix including itself). */
export function pktLine(payload: string | Uint8Array): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : Buffer.from(payload);
  const length = data.length + 4;
  if (length > 65520) throw new Error('pkt-line too long');
  const head = Buffer.from(length.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([head, data]);
}
export const PKT_DELIM = Buffer.from('0001', 'ascii');
export const PKT_RESPONSE_END = Buffer.from('0002', 'ascii');

export type PktPacket =
  | { readonly kind: 'data'; readonly payload: Buffer }
  | { readonly kind: 'flush' }
  | { readonly kind: 'delim' }
  | { readonly kind: 'response-end' };

/** Decode pkt-lines from `start` until the buffer runs out; throws on malformed framing. */
export function decodePktLines(bytes: Buffer, start = 0): { packets: PktPacket[]; next: number } {
  const packets: PktPacket[] = [];
  let offset = start;
  while (offset < bytes.length) {
    if (offset + 4 > bytes.length) throw new Error('truncated pkt-line header');
    const head = bytes.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(head)) throw new Error(`bad pkt-line length ${JSON.stringify(head)}`);
    const length = parseInt(head, 16);
    if (length === 0) {
      packets.push({ kind: 'flush' });
      offset += 4;
    } else if (length === 1) {
      packets.push({ kind: 'delim' });
      offset += 4;
    } else if (length === 2) {
      packets.push({ kind: 'response-end' });
      offset += 4;
    } else if (length < 4) {
      throw new Error(`pkt-line length ${length} is reserved`);
    } else {
      if (offset + length > bytes.length) throw new Error('truncated pkt-line payload');
      packets.push({ kind: 'data', payload: Buffer.from(bytes.subarray(offset + 4, offset + length)) });
      offset += length;
    }
  }
  return { packets, next: offset };
}

/** Frame pack bytes as sideband band-1 pkt-lines of at most 32 KiB of payload each. */
export function sidebandFrame(pack: Buffer): Buffer {
  const parts: Buffer[] = [];
  const CHUNK = 32768;
  for (let offset = 0; offset < pack.length; offset += CHUNK) {
    const slice = pack.subarray(offset, Math.min(pack.length, offset + CHUNK));
    parts.push(pktLine(Buffer.concat([Buffer.from([1]), slice])));
  }
  return Buffer.concat(parts);
}
