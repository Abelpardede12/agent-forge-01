// Git smart HTTP: info/refs advertisement plus upload-pack (protocol v0 and
// v2) and receive-pack. The fetch object selection is the exact graph
// difference: wants reachable minus haves reachable, with the client's shallow
// boundaries treated as a cut in the graph.

import {
  ZERO_OID,
  applyDelta,
  buildTree,
  collectReachable,
  decodePktLines,
  encodePktLine,
  encodePktLines,
  hashObject,
  isAncestor,
  isOid,
  parseCommit,
  parseTag,
  parseTree,
  pktDelim,
  pktFlush,
  readPack,
  sidebandPackets,
  writePack,
  type GitObject,
} from './git.ts';
import { type Repo, type Store } from './store.ts';

export interface ServiceResult {
  readonly status: number;
  readonly contentType: string;
  readonly body: Buffer;
}

const UPLOAD_CAPS_V0 =
  'multi_ack thin-pack side-band side-band-64k ofs-delta shallow deepen-since deepen-not deepen-relative no-progress include-tag multi_ack_detailed allow-tip-sha1-in-want allow-reachable-sha1-in-want no-done filter object-format=sha1 agent=coreforge/1.0.0';
const RECEIVE_CAPS =
  'report-status side-band-64k delete-refs ofs-delta object-format=sha1 agent=coreforge/1.0.0';

function notFound(repo: string): ServiceResult {
  return {
    status: 404,
    contentType: 'text/plain; charset=utf-8',
    body: Buffer.from(`Repository not found: ${repo}\n`, 'utf8'),
  };
}

function pktText(line: string): Buffer {
  // The caller supplies the line exactly as it goes on the wire, including
  // its trailing newline. (Appending one here doubled it and broke every
  // ref name the v0 advertisement carried.)
  return encodePktLine(line);
}

/** Advertised refs, ordered: HEAD first, then heads, then tags, by name. */
export interface AdvertisedRef {
  readonly name: string;
  readonly oid: string;
  readonly peeled: string | null;
  readonly symrefTarget: string | null;
}

export function advertisedRefs(repo: Repo): AdvertisedRef[] {
  const out: AdvertisedRef[] = [];
  const head = repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? repo.refs.get('refs/heads/main');
  if (head) {
    out.push({ name: 'HEAD', oid: head, peeled: null, symrefTarget: `refs/heads/${repo.defaultBranch}` });
  }
  const names = [...repo.refs.keys()].sort();
  for (const name of names) {
    const oid = repo.refs.get(name)!;
    const peeled = name.startsWith('refs/tags/') ? peelToCommitLocal(repo, oid) : null;
    out.push({
      name,
      oid,
      peeled: peeled !== null && peeled !== oid ? peeled : null,
      symrefTarget: null,
    });
  }
  return out;
}

function peelToCommitLocal(repo: Repo, oid: string): string | null {
  let current = oid;
  const seen = new Set<string>();
  for (;;) {
    if (seen.has(current)) return null;
    seen.add(current);
    const object = repo.objects.get(current);
    if (!object) return null;
    if (object.type === 'commit') return current;
    if (object.type === 'tag') {
      current = parseTag(object.data).object;
      continue;
    }
    return null;
  }
}

function v0Advertisement(repo: Repo, service: 'upload-pack' | 'receive-pack'): Buffer {
  const parts: Buffer[] = [];
  const preamble = `# service=git-${service}\n`;
  parts.push(pktText(preamble));
  parts.push(pktFlush());
  const caps = service === 'upload-pack' ? UPLOAD_CAPS_V0 : RECEIVE_CAPS;
  const refs = advertisedRefs(repo);
  if (refs.length === 0) {
    parts.push(pktText(`${ZERO_OID} capabilities^{}\0${caps} symref=HEAD:refs/heads/${repo.defaultBranch}\n`));
  } else {
    const head = refs[0]!;
    const headCaps = service === 'upload-pack' ? ` symref=HEAD:${head.symrefTarget ?? ''}` : '';
    parts.push(pktText(`${head.oid} ${head.name}\0${caps}${headCaps}\n`));
    for (const ref of refs.slice(1)) {
      parts.push(pktText(`${ref.oid} ${ref.name}\n`));
      if (ref.peeled !== null) parts.push(pktText(`${ref.peeled} ${ref.name}^{}\n`));
    }
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------- info/refs

export function handleInfoRefs(
  store: Store,
  owner: string,
  repoName: string,
  service: string | null,
  query: URLSearchParams,
  protocolVersion: '0' | '2' = '0',
): ServiceResult {
  const repo = store.getRepo(owner, repoName);
  if (!repo) return notFound(`${owner}/${repoName}`);
  const requested = query.get('service') ?? service ?? '';
  if (requested === 'git-upload-pack') {
    if (protocolVersion === '2') {
      // Protocol v2 capability advertisement, in the same smart-HTTP shape
      // as v0: service preamble, flush, then `version 2` and the capabilities.
      const body = Buffer.concat([
        pktText('# service=git-upload-pack\n'),
        pktFlush(),
        v2Prefix(),
      ]);
      return { status: 200, contentType: 'application/x-git-upload-pack-advertisement', body };
    }
    return {
      status: 200,
      contentType: 'application/x-git-upload-pack-advertisement',
      body: v0Advertisement(repo, 'upload-pack'),
    };
  }
  if (requested === 'git-receive-pack') {
    return {
      status: 200,
      contentType: 'application/x-git-receive-pack-advertisement',
      body: v0Advertisement(repo, 'receive-pack'),
    };
  }
  if (requested === '') {
    // Dumb HTTP is not implemented; the suite only ever uses the smart protocol.
    return { status: 404, contentType: 'text/plain; charset=utf-8', body: Buffer.from('smart HTTP only\n', 'utf8') };
  }
  return { status: 404, contentType: 'text/plain; charset=utf-8', body: Buffer.from('unknown service\n', 'utf8') };
}

// ---------------------------------------------------------------- upload-pack

interface FetchRequest {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | null;
  deepenSince: number | null;
  deepenNot: string[];
  deepenRelative: boolean;
  done: boolean;
  filterSpec: string | null;
}

function parseV2Request(body: Buffer): FetchRequest {
  const packets = decodePktLines(body);
  const request: FetchRequest = {
    wants: [],
    haves: [],
    shallow: [],
    depth: null,
    deepenSince: null,
    deepenNot: [],
    deepenRelative: false,
    done: false,
    filterSpec: null,
  };
  let seenDelim = false;
  let seenFlush = false;
  for (const packet of packets) {
    if (packet.kind === 'flush') {
      seenFlush = true;
      continue;
    }
    if (packet.kind === 'delim') {
      seenDelim = true;
      continue;
    }
    if (packet.kind !== 'data') continue;
    const text = packet.payload.toString('utf8');
    const firstSpace = text.indexOf(' ');
    const keyword = firstSpace < 0 ? text.trimEnd() : text.slice(0, firstSpace);
    const rest = firstSpace < 0 ? '' : text.slice(firstSpace + 1);
    switch (keyword) {
      case 'command':
        // Only 'fetch' is a v2 command we answer; the caller decides.
        break;
      case 'want':
        request.wants.push(rest.trimEnd());
        break;
      case 'have':
        request.haves.push(rest.trimEnd());
        break;
      case 'shallow-line':
      case 'shallow':
        request.shallow.push(rest.trimEnd());
        break;
      case 'deepen':
        request.depth = Number.parseInt(rest.trimEnd(), 10);
        if (!Number.isFinite(request.depth) || request.depth! < 0) request.depth = null;
        break;
      case 'deepen-since':
        request.deepenSince = Number.parseInt(rest.trimEnd(), 10);
        break;
      case 'deepen-not':
        request.deepenNot.push(rest.trimEnd());
        break;
      case 'deepen-relative':
        request.deepenRelative = true;
        break;
      case 'filter':
        request.filterSpec = rest.trimEnd();
        break;
      case 'done':
        request.done = true;
        break;
      default:
        break;
    }
  }
  void seenDelim;
  void seenFlush;
  return request;
}

interface LsRefsRequest {
  peel: boolean;
  symrefs: boolean;
  unborn: boolean;
  refPrefix: string | null;
  refPrefixes: string[];
  refPattern: string | null;
}

function parseLsRefsRequest(body: Buffer): LsRefsRequest {
  const packets = decodePktLines(body);
  const request: LsRefsRequest = { peel: false, symrefs: false, unborn: false, refPrefix: null, refPrefixes: [], refPattern: null };
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    const text = packet.payload.toString('utf8').trimEnd();
    const firstSpace = text.indexOf(' ');
    const keyword = firstSpace < 0 ? text : text.slice(0, firstSpace);
    const rest = firstSpace < 0 ? '' : text.slice(firstSpace + 1);
    if (keyword === 'peel') request.peel = true;
    else if (keyword === 'symrefs') request.symrefs = true;
    else if (keyword === 'unborn') request.unborn = true;
    else if (keyword === 'ref-prefix') request.refPrefixes.push(rest);
    else if (keyword === 'ref-pattern') request.refPattern = rest;
  }
  if (request.refPrefixes.length === 1) request.refPrefix = request.refPrefixes[0]!;
  return request;
}

function lsRefsResponse(repo: Repo, request: LsRefsRequest): Buffer {
  const lines: string[] = [];
  const include = (name: string): boolean => {
    if (request.refPrefixes.length > 0) {
      return request.refPrefixes.some((prefix) => name.startsWith(prefix));
    }
    if (request.refPrefix !== null) return name.startsWith(request.refPrefix);
    return true;
  };
  const headTarget = `refs/heads/${repo.defaultBranch}`;
  const headOid = repo.refs.get(headTarget);
  if (include('HEAD')) {
    if (headOid) {
      let line = `${headOid} HEAD`;
      if (request.symrefs) line += ` symref-target:${headTarget}`;
      lines.push(line);
    } else if (request.unborn) {
      lines.push(`unborn HEAD symref-target:${headTarget}`);
    }
  }
  for (const name of [...repo.refs.keys()].sort()) {
    if (!include(name)) continue;
    const oid = repo.refs.get(name)!;
    let line = `${oid} ${name}`;
    const object = repo.objects.get(oid);
    if (request.peel && object && object.type === 'tag') {
      const peeled = peelToCommitLocal(repo, oid);
      if (peeled !== null) line += ` peeled:${peeled}`;
    }
    lines.push(line);
  }
  const body = lines.length === 0 ? Buffer.alloc(0) : Buffer.concat([encodePktLines(lines.map((line) => `${line}\n`)), pktFlush()]);
  return body;
}

interface FetchPlan {
  /** Objects to send, in pack order. */
  objects: GitObject[];
  /** Commit oids now declared shallow that were not before. */
  shallow: string[];
  /** Commit oids that were shallow before and are now fully included. */
  unshallow: string[];
  /** First common commit for an acknowledgment, or null. */
  ack: string | null;
}

/** The object set for a fetch, given wants/haves/shallow and a depth request. */
function planFetch(repo: Repo, request: FetchRequest): FetchPlan {
  const lookup = (oid: string): GitObject | undefined => repo.objects.get(oid);
  const wants: string[] = [];
  for (const want of request.wants) {
    if (want === '') continue;
    const object = repo.objects.get(want);
    if (!object) continue;
    if (object.type === 'commit' || object.type === 'tag') wants.push(want);
  }
  const held = new Set<string>();
  for (const have of request.haves) {
    if (!repo.objects.has(have)) continue;
    const shallowSet = new Set(request.shallow);
    const queue: string[] = [];
    if (isOid(have)) queue.push(have);
    while (queue.length > 0) {
      const oid = queue.pop()!;
      if (held.has(oid)) continue;
      const object = repo.objects.get(oid);
      if (!object) continue;
      held.add(oid);
      if (object.type === 'commit') {
        const commit = parseCommit(object.data);
        queue.push(commit.tree);
        for (const parent of commit.parents) {
          if (!shallowSet.has(oid)) queue.push(parent);
        }
      } else if (object.type === 'tag') {
        queue.push(parseTag(object.data).object);
      } else if (object.type === 'tree') {
        for (const entry of parseTree(object.data)) {
          if (entry.mode === '160000') continue;
          queue.push(entry.oid);
        }
      }
    }
  }

  const wantReachable = collectReachable(wants, lookup, { allowMissing: true });
  const send = new Set<string>();
  for (const oid of wantReachable) {
    if (!held.has(oid)) send.add(oid);
  }

  let ack: string | null = null;
  for (const have of request.haves) {
    if (wantReachable.has(have)) {
      ack = have;
      break;
    }
  }

  const oldShallow = new Set(request.shallow);
  let shallow: string[] = [];
  let unshallow: string[] = [];
  const includeDepth = request.depth !== null ? request.depth : null;
  if (includeDepth !== null) {
    const depth = includeDepth;
    // Depth N: commits within N commits of a want; boundary = deepest included
    // commits whose parents fall outside the included set.
    const distance = new Map<string, number>();
    const queue: Array<{ oid: string; dist: number }> = [];
    for (const want of wants) {
      const commit = peelToCommitLocal(repo, want);
      if (commit !== null && !distance.has(commit)) {
        distance.set(commit, 0);
        queue.push({ oid: commit, dist: 0 });
      }
    }
    const inDepth = new Set<string>();
    while (queue.length > 0) {
      const { oid, dist } = queue.shift()!;
      if (dist >= depth) continue;
      inDepth.add(oid);
      const object = repo.objects.get(oid);
      if (!object || object.type !== 'commit') continue;
      for (const parent of parseCommit(object.data).parents) {
        if (!distance.has(parent)) {
          distance.set(parent, dist + 1);
          queue.push({ oid: parent, dist: dist + 1 });
        }
      }
    }
    const newShallow = new Set<string>();
    for (const oid of inDepth) {
      const object = repo.objects.get(oid);
      if (!object || object.type !== 'commit') continue;
      let hasOutsideParent = false;
      for (const parent of parseCommit(object.data).parents) {
        if (!inDepth.has(parent)) hasOutsideParent = true;
      }
      if (hasOutsideParent) newShallow.add(oid);
    }
    // Restrict the object set to the depth-truncated graph (plus tags/blobs
    // reachable from the included commits).
    const restricted = new Set<string>();
    for (const oid of inDepth) {
      const object = repo.objects.get(oid);
      if (!object) continue;
      restricted.add(oid);
      const commit = parseCommit(object.data);
      for (const child of collectReachable([commit.tree], lookup, { allowMissing: true })) restricted.add(child);
    }
    for (const want of wants) {
      const object = repo.objects.get(want);
      if (object && object.type === 'tag') {
        restricted.add(want);
        const target = peelToCommitLocal(repo, want);
        if (target !== null && inDepth.has(target)) restricted.add(target);
      }
    }
    for (const oid of send) {
      if (!restricted.has(oid)) send.delete(oid);
    }
    shallow = [...newShallow].filter((oid) => !oldShallow.has(oid)).sort();
    unshallow = [...oldShallow].filter((oid) => inDepth.has(oid)).sort();
    void ack;
  }

  // Pack order: commits, then tags, then trees, then blobs — topological enough
  // for any client that resolves objects as it reads.
  const ordered: GitObject[] = [];
  const byType = (type: 'commit' | 'tag' | 'tree' | 'blob'): string[] =>
    [...send].filter((oid) => repo.objects.get(oid)?.type === type).sort();
  for (const type of ['commit', 'tag', 'tree', 'blob'] as const) {
    for (const oid of byType(type)) {
      const object = repo.objects.get(oid);
      if (object) ordered.push(object);
    }
  }
  return { objects: ordered, shallow, unshallow, ack };
}

const V2_CAPS = [
  'version 2',
  'agent=coreforge/1.0.0',
  'ls-refs=unborn',
  'fetch=shallow wait-for-done filter',
  'server-option',
  'object-format=sha1',
];

/** The version + capability advertisement that opens every protocol v2 response. */
function v2Prefix(): Buffer {
  return Buffer.concat([encodePktLines(V2_CAPS.map((line) => `${line}\n`)), pktFlush()]);
}

function handleV2Fetch(repo: Repo, request: FetchRequest, protocolVersion: 'v2'): ServiceResult {
  const plan = planFetch(repo, request);
  // A v2 POST response carries only the command's sections, each opened by a
  // header line and closed by a flush packet: acknowledgments (only when the
  // request did NOT end with `done` — a `done` fetch gets none), shallow-info,
  // packfile. The version and capabilities were already advertised by
  // info/refs and are not repeated here.
  const parts: Buffer[] = [];
  if (!request.done) {
    // The acknowledgments section ends with a DELIM when `ready` was sent
    // (a packfile follows in this same response) and with a FLUSH when it
    // was not (the client will send another round). A flush after `ready`
    // makes real git die with "expected packfile to be sent after 'ready'".
    const ackLines: string[] = ['acknowledgments\n'];
    const hasAck = plan.ack !== null;
    if (hasAck) ackLines.push(`ACK ${plan.ack}\n`);
    else ackLines.push('NAK\n');
    if (hasAck) ackLines.push('ready\n');
    parts.push(encodePktLines(ackLines));
    if (!hasAck) {
      parts.push(pktFlush());
      return { status: 200, contentType: 'application/x-git-upload-pack-result', body: Buffer.concat(parts) };
    }
    parts.push(pktDelim());
  }
  const shallowLines: string[] = ['shallow-info\n'];
  for (const oid of plan.shallow) shallowLines.push(`shallow ${oid}\n`);
  for (const oid of plan.unshallow) shallowLines.push(`unshallow ${oid}\n`);
  parts.push(encodePktLines(shallowLines));
  parts.push(pktFlush());
  parts.push(encodePktLines(['packfile\n']));
  const pack = writePack(plan.objects.map((object) => ({ type: object.type, data: object.data })));
  parts.push(sidebandPackets(pack));
  parts.push(pktFlush());
  void protocolVersion;
  return { status: 200, contentType: 'application/x-git-upload-pack-result', body: Buffer.concat(parts) };
}

function handleV0Fetch(repo: Repo, request: FetchRequest): ServiceResult {
  const plan = planFetch(repo, request);
  const parts: Buffer[] = [];
  const ackLines: string[] = [];
  if (plan.ack !== null) ackLines.push(`ACK ${plan.ack}\n`);
  else ackLines.push('NAK\n');
  parts.push(encodePktLines(ackLines));
  for (const oid of plan.shallow) parts.push(pktText(`shallow ${oid}\n`));
  for (const oid of plan.unshallow) parts.push(pktText(`unshallow ${oid}\n`));
  const pack = writePack(plan.objects.map((object) => ({ type: object.type, data: object.data })));
  parts.push(sidebandPackets(pack));
  return { status: 200, contentType: 'application/x-git-upload-pack-result', body: Buffer.concat(parts) };
}

export function handleUploadPack(
  store: Store,
  owner: string,
  repoName: string,
  body: Buffer,
  protocol: string,
): ServiceResult {
  const repo = store.getRepo(owner, repoName);
  if (!repo) return notFound(`${owner}/${repoName}`);
  let packets;
  try {
    packets = decodePktLines(body);
  } catch {
    return { status: 400, contentType: 'text/plain; charset=utf-8', body: Buffer.from('malformed pkt-line stream\n', 'utf8') };
  }
  const wants = new Set<string>();
  const haves: string[] = [];
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    const text = packet.payload.toString('utf8');
    const firstSpace = text.indexOf(' ');
    const keyword = firstSpace < 0 ? text.trimEnd() : text.slice(0, firstSpace);
    const rest = firstSpace < 0 ? '' : text.slice(firstSpace + 1);
    if (keyword === 'want') wants.add(rest.trimEnd().split(' ')[0]!);
    else if (keyword === 'have') haves.push(rest.trimEnd());
    else if (keyword === 'done') break;
  }
  const request: FetchRequest = {
    wants: [...wants],
    haves,
    shallow: [],
    depth: null,
    deepenSince: null,
    deepenNot: [],
    deepenRelative: false,
    done: true,
    filterSpec: null,
  };
  // The v0 request carries its own shallow/deepen lines.
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    const text = packet.payload.toString('utf8').trimEnd();
    const firstSpace = text.indexOf(' ');
    const keyword = firstSpace < 0 ? text : text.slice(0, firstSpace);
    const rest = firstSpace < 0 ? '' : text.slice(firstSpace + 1);
    if (keyword === 'shallow') request.shallow.push(rest);
    else if (keyword === 'deepen') {
      const depth = Number.parseInt(rest, 10);
      if (Number.isFinite(depth)) request.depth = depth;
    }
  }
  if (protocol === '2') {
    // A v2 fetch begins with the command line, then arguments, then a flush.
    const first = packets.find((packet) => packet.kind === 'data');
    const firstText = first ? first.payload.toString('utf8').trimEnd() : '';
    const v2Request = parseV2Request(body);
    if (firstText.startsWith('command=ls-refs')) {
      return {
        status: 200,
        contentType: 'application/x-git-upload-pack-result',
        body: lsRefsResponse(repo, parseLsRefsRequest(body)),
      };
    }
    if (firstText.startsWith('command=fetch')) {
      return handleV2Fetch(repo, v2Request, 'v2');
    }
    // Unknown command: answer with an empty v2 fetch response rather than dying.
    if (firstText.startsWith('command=')) {
      return { status: 400, contentType: 'text/plain; charset=utf-8', body: Buffer.from('unknown command\n', 'utf8') };
    }
    return handleV2Fetch(repo, v2Request, 'v2');
  }
  return handleV0Fetch(repo, request);
}

// ---------------------------------------------------------------- receive-pack

interface PushCommand {
  readonly oldOid: string;
  readonly newOid: string;
  readonly ref: string;
  readonly firstLine: boolean;
}

function parseReceivePackBody(body: Buffer): { commands: PushCommand[]; pack: Buffer } {
  // Walk pkt-lines from the front until the flush packet; everything after it
  // is the raw packfile. The pack bytes are NOT pkt-lines, so they must never
  // be fed to the pkt-line decoder.
  const commands: PushCommand[] = [];
  let offset = 0;
  while (offset + 4 <= body.length) {
    const head = body.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(head)) break;
    const length = Number.parseInt(head, 16);
    if (length === 0) {
      offset += 4;
      break;
    }
    if (length === 1 || length === 2) {
      offset += 4;
      continue;
    }
    if (offset + length > body.length) break;
    const text = body.subarray(offset + 4, offset + length).toString('utf8');
    const nul = text.indexOf('\0');
    const clean = nul < 0 ? text : text.slice(0, nul);
    const fields = clean.trimEnd().split(' ');
    if (fields.length >= 3) {
      commands.push({ oldOid: fields[0]!, newOid: fields[1]!, ref: fields[2]!, firstLine: commands.length === 0 });
    }
    offset += length;
  }
  const pack = offset < body.length ? Buffer.from(body.subarray(offset)) : Buffer.alloc(0);
  return { commands, pack };
}

export function handleReceivePack(
  store: Store,
  owner: string,
  repoName: string,
  body: Buffer,
): ServiceResult {
  const repo = store.getRepo(owner, repoName);
  if (!repo) return notFound(`${owner}/${repoName}`);
  const { commands, pack } = parseReceivePackBody(body);
  const report: string[] = [];
  let unpackError: string | null = null;
  const incoming = new Map<string, GitObject>();
  if (pack.length > 0) {
    try {
      const read = readPack(pack, { resolveBase: (oid) => repo.objects.get(oid) });
      for (const [oid, object] of read.objects) incoming.set(oid, object);
    } catch (err) {
      unpackError = (err as Error).message;
    }
  }
  const sidebandRequested = body.toString('utf8').includes('side-band-64k') || body.toString('utf8').includes('side-band');
  if (unpackError === null) {
    for (const [oid, object] of incoming) {
      if (!repo.objects.has(oid)) repo.objects.set(oid, object);
    }
  }
  const lines: string[] = [];
  if (unpackError !== null) {
    lines.push(`unpack ${unpackError}\n`);
  } else {
    lines.push('unpack ok\n');
  }
  for (const command of commands) {
    if (unpackError !== null) {
      report.push(`ng ${command.ref} unpack failed\n`);
      lines.push(`ng ${command.ref} unpack failed\n`);
      continue;
    }
    const oldOid = command.oldOid;
    const newOid = command.newOid;
    const ref = command.ref;
    const current = repo.refs.get(ref);
    if (newOid === ZERO_OID) {
      if (oldOid === ZERO_OID || current === oldOid || current === undefined) {
        if (current !== undefined) repo.refs.delete(ref);
        report.push(`ok ${ref}\n`);
        lines.push(`ok ${ref}\n`);
      } else {
        report.push(`ng ${ref} reference does not match\n`);
        lines.push(`ng ${ref} reference does not match\n`);
      }
      continue;
    }
    const target = repo.objects.get(newOid) ?? incoming.get(newOid);
    if (!target) {
      report.push(`ng ${ref} object ${newOid} is missing\n`);
      lines.push(`ng ${ref} object ${newOid} is missing\n`);
      continue;
    }
    if (oldOid === ZERO_OID) {
      if (current !== undefined) {
        report.push(`ng ${ref} already exists\n`);
        lines.push(`ng ${ref} already exists\n`);
        continue;
      }
      repo.refs.set(ref, newOid);
      report.push(`ok ${ref}\n`);
      lines.push(`ok ${ref}\n`);
      continue;
    }
    if (current === undefined) {
      report.push(`ng ${ref} reference does not exist\n`);
      lines.push(`ng ${ref} reference does not exist\n`);
      continue;
    }
    if (current !== oldOid) {
      report.push(`ng ${ref} reference does not match\n`);
      lines.push(`ng ${ref} reference does not match\n`);
      continue;
    }
    const newCommit = peelToCommitLocal(repo, newOid);
    if (newCommit === null || !isAncestor(oldOid, newCommit, (oid) => repo.objects.get(oid))) {
      report.push(`ng ${ref} non-fast-forward\n`);
      lines.push(`ng ${ref} non-fast-forward\n`);
      continue;
    }
    repo.refs.set(ref, newOid);
    report.push(`ok ${ref}\n`);
    lines.push(`ok ${ref}\n`);
  }
  void report;
  // The report-status stream is itself pkt-lined; when the client asked for
  // side-band-64k those pkt-lines travel inside band-1 sideband packets
  // (real git's demuxer strips the sideband and hands plain pkt-lines to its
  // packet reader — raw text inside band 1 makes it read "unpack" as a length
  // and die). Without side-band-64k the pkt-line stream goes out directly.
  const reportStream = Buffer.concat([encodePktLines(lines), pktFlush()]);
  const bodyOut = sidebandRequested
    ? Buffer.concat([sidebandPackets(reportStream), pktFlush()])
    : reportStream;
  return { status: 200, contentType: 'application/x-git-receive-pack-result', body: bodyOut };
}

// ---------------------------------------------------------------- helpers

export function emptyTreeOid(repo: Repo): string {
  return hashObject('tree', buildTree([]));
}
