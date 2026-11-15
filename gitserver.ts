// CoreForge git smart HTTP: protocol v2 + v0 upload-pack, receive-pack with report-status.
// One rule from real-git interop: a v2 fetch request that ends with `done` gets NO
// acknowledgments section — the packfile section follows (after shallow-info, if any).

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  chunkSideband,
  collectReachable,
  encodePktLine,
  encodePktLines,
  isObjectId,
  packetLines,
  parseCommit,
  parsePktStream,
  parseTag,
  parseTree,
  pktDelim,
  pktFlush,
  readPack,
  sidebandPacket,
  verifyPackChecksum,
  writePack,
  ZERO_OID,
  type GitObject,
  type GitPacket,
} from './git.ts';
import {
  VIEWER_LOGIN,
  getRepo,
  lookupObject,
  store,
  type Repo,
} from './store.ts';

const AGENT = 'coreforge/1.0';
const UPLOAD_AD = 'application/x-git-upload-pack-advertisement';
const UPLOAD_RESULT = 'application/x-git-upload-pack-result';
const RECEIVE_AD = 'application/x-git-receive-pack-advertisement';
const RECEIVE_RESULT = 'application/x-git-receive-pack-result';

export function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function sendBuffer(res: ServerResponse, status: number, body: Buffer, contentType: string): void {
  res.writeHead(status, { 'content-type': contentType, 'content-length': body.length });
  res.end(body);
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

/** Peel an annotated tag to its commit (recursively, bounded). */
function peelToCommit(repo: Repo, oid: string): string {
  let current = oid;
  for (let i = 0; i < 10; i += 1) {
    const object = repo.objects.get(current);
    if (object === undefined || object.type !== 'tag') return current;
    current = parseTag(object.data).object;
  }
  return current;
}

/** Sorted ref names: heads first, then tags, alphabetical inside each group. */
function sortedRefNames(repo: Repo): string[] {
  const names = [...repo.refs.keys()];
  names.sort((a, b) => {
    const ga = a.startsWith('refs/heads/') ? 0 : a.startsWith('refs/tags/') ? 1 : 2;
    const gb = b.startsWith('refs/heads/') ? 0 : b.startsWith('refs/tags/') ? 1 : 2;
    if (ga !== gb) return ga - gb;
    return a < b ? -1 : a > b ? 1 : 0;
  });
  return names;
}

function headOid(repo: Repo): string | null {
  return repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? null;
}

// ---------------------------------------------------------------------------
// Advertisements
// ---------------------------------------------------------------------------

function v2Advertisement(service: 'git-upload-pack'): Buffer {
  return Buffer.concat([
    encodePktLine('# service=git-upload-pack\n'),
    pktFlush(),
    encodePktLine('version 2\n'),
    encodePktLine('ls-refs=unborn\n'),
    encodePktLine('fetch=shallow filter\n'),
    encodePktLine('object-format=sha1\n'),
    encodePktLine(`agent=${AGENT}\n`),
    pktFlush(),
  ]);
}

function v0Advertisement(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const caps =
    service === 'git-upload-pack'
      ? `symref=HEAD:refs/heads/${repo.defaultBranch} side-band-64k thin-pack ofs-delta multi_ack_detailed shallow agent=${AGENT}`
      : `symref=HEAD:refs/heads/${repo.defaultBranch} report-status report-status-v2 side-band-64k delete-refs ofs-delta agent=${AGENT}`;
  const parts: Buffer[] = [encodePktLine(`# service=${service}\n`), pktFlush()];
  const names = sortedRefNames(repo);
  if (names.length === 0) {
    parts.push(encodePktLine(`${ZERO_OID} capabilities^{}\u0000${caps}\n`));
    parts.push(pktFlush());
    return Buffer.concat(parts);
  }
  const head = headOid(repo);
  let first = true;
  const line = (text: string): void => {
    if (first) {
      parts.push(encodePktLine(`${text}\u0000${caps}\n`));
      first = false;
    } else {
      parts.push(encodePktLine(`${text}\n`));
    }
  };
  line(`${head ?? ZERO_OID} HEAD`);
  for (const name of names) {
    const oid = repo.refs.get(name)!;
    line(`${oid} ${name}`);
    if (name.startsWith('refs/tags/')) {
      const object = repo.objects.get(oid);
      if (object !== undefined && object.type === 'tag') {
        parts.push(encodePktLine(`${peelToCommit(repo, oid)} ${name}^{}\n`));
      }
    }
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------
// Fetch planning
// ---------------------------------------------------------------------------

interface FetchPlan {
  readonly objects: GitObject[];
  readonly shallow: string[];
  readonly unshallow: string[];
}

/**
 * The objects a fetch must send: the depth-limited closure of the wants, minus what the
 * client already holds (its haves, not descended past its shallow boundaries).
 */
function planFetch(
  repo: Repo,
  wants: readonly string[],
  haves: readonly string[],
  clientShallow: readonly string[],
  depth: number | null,
): FetchPlan {
  const lookup = lookupObject(repo);
  const shallowSet = new Set(clientShallow);

  // What the client holds: closure of haves, cut at its shallow boundaries (the boundary
  // commit itself is held, its parents are not).
  const haveObjects = new Set<string>();
  {
    const queue: string[] = [...haves];
    const seen = new Set<string>();
    while (queue.length > 0) {
      const oid = queue.pop()!;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const object = lookup(oid);
      if (object === undefined) continue;
      haveObjects.add(oid);
      if (object.type === 'commit') {
        const commit = parseCommit(object.data);
        queue.push(commit.tree);
        if (!shallowSet.has(oid)) {
          for (const parent of commit.parents) queue.push(parent);
        }
      } else if (object.type === 'tag') {
        queue.push(parseTag(object.data).object);
      } else if (object.type === 'tree') {
        for (const entry of parseTree(object.data)) {
          if (entry.mode !== '160000') queue.push(entry.oid);
        }
      }
    }
  }

  // Depth-limited walk from the wants. Generation 0 is the wanted commits themselves.
  const includedCommits = new Set<string>();
  const boundary = new Set<string>();
  const wantTags: string[] = [];
  {
    const queue: Array<{ oid: string; gen: number }> = [];
    for (const want of wants) {
      const object = lookup(want);
      if (object === undefined) continue;
      if (object.type === 'tag') {
        wantTags.push(want);
        const target = peelToCommit(repo, want);
        queue.push({ oid: target, gen: 0 });
      } else if (object.type === 'commit') {
        queue.push({ oid: want, gen: 0 });
      }
    }
    const seen = new Set<string>();
    while (queue.length > 0) {
      const { oid, gen } = queue.shift()!;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const object = lookup(oid);
      if (object === undefined || object.type !== 'commit') continue;
      if (depth !== null && gen >= depth) continue;
      includedCommits.add(oid);
      const commit = parseCommit(object.data);
      if (depth !== null && gen === depth - 1 && commit.parents.length > 0) boundary.add(oid);
      // Never descend past the client's shallow boundary on a plain fetch: it holds that
      // commit but not its parents, and it does not want them sent either. A deepen
      // explicitly asks for more generations, so it crosses the boundary up to the depth.
      if (depth === null && shallowSet.has(oid)) continue;
      for (const parent of commit.parents) queue.push({ oid: parent, gen: gen + 1 });
    }
  }

  // The objects the walk needs: the included commits themselves plus each one's tree
  // closure (trees and blobs only — never parents: the depth limit cuts ancestry).
  const included = new Set<string>();
  const addTreeClosure = (treeOid: string): void => {
    const stack: string[] = [treeOid];
    while (stack.length > 0) {
      const oid = stack.pop()!;
      if (included.has(oid)) continue;
      const object = lookup(oid);
      if (object === undefined) continue;
      included.add(oid);
      if (object.type === 'tree') {
        for (const entry of parseTree(object.data)) {
          if (entry.mode !== '160000') stack.push(entry.oid);
        }
      }
    }
  };
  for (const oid of includedCommits) {
    included.add(oid);
    const object = lookup(oid);
    if (object !== undefined && object.type === 'commit') addTreeClosure(parseCommit(object.data).tree);
  }
  for (const tag of wantTags) included.add(tag);
  // A boundary commit's own tree/blobs are included (its parents are the cut, not its tree).
  const sendOids = new Set<string>();
  for (const oid of included) {
    if (!haveObjects.has(oid)) sendOids.add(oid);
  }
  const send: GitObject[] = [];
  for (const oid of sendOids) {
    const object = lookup(oid);
    if (object !== undefined) send.push(object);
  }
  // Deterministic pack order: commits first (parents before children is unnecessary), then trees, blobs, tags.
  const rank = (type: string): number => (type === 'commit' ? 0 : type === 'tree' ? 1 : type === 'blob' ? 2 : 3);
  send.sort((a, b) => rank(a.type) - rank(b.type));

  // Unshallow: an old boundary that is reachable from the wants and whose parents are all
  // now held or sent — it stopped being a boundary.
  const fullClosure = collectReachable(wants, lookup, { allowMissing: true });
  const heldOrSent = new Set<string>([...haveObjects, ...sendOids]);
  const unshallow: string[] = [];
  for (const old of clientShallow) {
    if (!fullClosure.has(old)) continue;
    if (boundary.has(old)) continue;
    const object = lookup(old);
    if (object === undefined || object.type !== 'commit') continue;
    const parents = parseCommit(object.data).parents;
    if (parents.every((parent) => heldOrSent.has(parent))) unshallow.push(old);
  }
  return { objects: send, shallow: [...boundary].sort(), unshallow: unshallow.sort() };
}

// ---------------------------------------------------------------------------
// Upload-pack
// ---------------------------------------------------------------------------

function buildFetchResponse(plan: FetchPlan, includeShallowInfo: boolean): Buffer {
  const parts: Buffer[] = [];
  if (includeShallowInfo) {
    parts.push(encodePktLine('shallow-info\n'));
    for (const oid of plan.shallow) parts.push(encodePktLine(`shallow ${oid}\n`));
    for (const oid of plan.unshallow) parts.push(encodePktLine(`unshallow ${oid}\n`));
    parts.push(pktDelim());
  }
  parts.push(encodePktLine('packfile\n'));
  const pack = writePack(plan.objects);
  for (const packet of chunkSideband(pack)) parts.push(packet);
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

function handleLsRefs(repo: Repo, args: readonly string[]): Buffer {
  const peel = args.includes('peel');
  const symrefs = args.includes('symrefs');
  const unborn = args.includes('unborn');
  const prefixes = args.filter((arg) => arg.startsWith('ref-prefix ')).map((arg) => arg.slice('ref-prefix '.length));
  const keep = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const lines: string[] = [];
  const head = headOid(repo);
  if (symrefs && keep('HEAD')) {
    if (head !== null) lines.push(`${head} HEAD symref-target:refs/heads/${repo.defaultBranch}\n`);
    else if (unborn) lines.push(`unborn HEAD symref-target:refs/heads/${repo.defaultBranch}\n`);
  }
  for (const name of sortedRefNames(repo)) {
    if (!keep(name)) continue;
    const oid = repo.refs.get(name)!;
    let line = `${oid} ${name}`;
    if (peel && name.startsWith('refs/tags/')) {
      const object = repo.objects.get(oid);
      if (object !== undefined && object.type === 'tag') line += ` peeled:${peelToCommit(repo, oid)}`;
    }
    lines.push(`${line}\n`);
  }
  const parts = lines.map((line) => encodePktLine(line));
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

async function handleUploadPack(repo: Repo, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readBody(req);
  const isV2 = req.headers['git-protocol'] === 'version=2';
  if (!isV2) {
    // Protocol v0: wants (+shallow/deepen), flush, haves + done, flush.
    let first: { packets: GitPacket[]; rest: Buffer };
    let second: { packets: GitPacket[]; rest: Buffer };
    try {
      first = parsePktStream(body);
      second = parsePktStream(first.rest);
    } catch {
      sendJson(res, 400, { message: 'malformed pkt-line' });
      return;
    }
    const wants: string[] = [];
    const haves: string[] = [];
    const shallow: string[] = [];
    let depth: number | null = null;
    for (const line of packetLines(first.packets)) {
      const text = line.replace(/\n$/, '');
      if (text.startsWith('want ')) wants.push(text.slice(5).split(' ')[0]);
      else if (text.startsWith('shallow ')) shallow.push(text.slice(8));
      else if (text.startsWith('deepen ')) depth = Number.parseInt(text.slice(7), 10);
    }
    for (const line of packetLines(second.packets)) {
      const text = line.replace(/\n$/, '');
      if (text.startsWith('have ')) haves.push(text.slice(5));
    }
    if (wants.some((want) => !repo.objects.has(want))) {
      sendJson(res, 400, { message: 'want not found' });
      return;
    }
    const plan = planFetch(repo, wants, haves, shallow, Number.isNaN(depth ?? NaN) ? null : depth);
    const parts: Buffer[] = [encodePktLine('NAK\n')];
    for (const oid of plan.shallow) parts.push(encodePktLine(`shallow ${oid}\n`));
    for (const oid of plan.unshallow) parts.push(encodePktLine(`unshallow ${oid}\n`));
    const pack = writePack(plan.objects);
    for (const packet of chunkSideband(pack)) parts.push(packet);
    parts.push(pktFlush());
    sendBuffer(res, 200, Buffer.concat(parts), UPLOAD_RESULT);
    return;
  }

  // Protocol v2.
  let parsed: { packets: GitPacket[]; rest: Buffer };
  try {
    parsed = parsePktStream(body);
  } catch {
    sendJson(res, 400, { message: 'malformed pkt-line' });
    return;
  }
  const lines = packetLines(parsed.packets);
  const commandLine = (lines[0] ?? '').replace(/\n$/, '');
  const match = /^command=([a-z-]+)$/.exec(commandLine);
  if (match === null) {
    sendJson(res, 400, { message: `unknown v2 command ${JSON.stringify(commandLine)}` });
    return;
  }
  const command = match[1];
  // Args live after the delim packet; everything before it is agent/object-format.
  const argLines: string[] = [];
  let pastDelim = false;
  for (const packet of parsed.packets) {
    if (packet.kind === 'delim') {
      pastDelim = true;
      continue;
    }
    if (packet.kind === 'data' && pastDelim) argLines.push(packet.payload.toString('utf8').replace(/\n$/, ''));
  }
  if (command === 'ls-refs') {
    sendBuffer(res, 200, handleLsRefs(repo, argLines), UPLOAD_RESULT);
    return;
  }
  if (command !== 'fetch') {
    sendJson(res, 400, { message: `unsupported v2 command ${command}` });
    return;
  }
  const wants: string[] = [];
  const haves: string[] = [];
  const shallow: string[] = [];
  let depth: number | null = null;
  let done = false;
  for (const text of argLines) {
    if (text.startsWith('want ')) wants.push(text.slice(5));
    else if (text.startsWith('have ')) haves.push(text.slice(5));
    else if (text.startsWith('shallow ')) shallow.push(text.slice(8));
    else if (text.startsWith('deepen ')) depth = Number.parseInt(text.slice(7), 10);
    else if (text === 'done') done = true;
  }
  const missing = wants.find((want) => !repo.objects.has(want));
  if (missing !== undefined) {
    const parts: Buffer[] = [
      encodePktLine('packfile\n'),
      sidebandPacket(3, `want ${missing} not found\n`),
      pktFlush(),
    ];
    sendBuffer(res, 200, Buffer.concat(parts), UPLOAD_RESULT);
    return;
  }
  const plan = planFetch(repo, wants, haves, shallow, depth === null || Number.isNaN(depth) ? null : depth);
  const parts: Buffer[] = [];
  // Real git sends no `done` on its first fetch request when it has haves: it expects an
  // acknowledgments section (ACK/NAK + ready) in the same response as the pack, each
  // section terminated by a delim packet. A `done` request gets no acknowledgments section.
  if (!done && haves.length > 0) {
    const reachable = collectReachable(wants, lookupObject(repo), { allowMissing: true });
    const common = haves.find((have) => reachable.has(have));
    parts.push(encodePktLine('acknowledgments\n'));
    parts.push(encodePktLine(common !== undefined ? `ACK ${common}\n` : 'NAK\n'));
    parts.push(encodePktLine('ready\n'));
    parts.push(pktDelim());
  }
  parts.push(buildFetchResponse(plan, plan.shallow.length > 0 || plan.unshallow.length > 0));
  sendBuffer(res, 200, Buffer.concat(parts), UPLOAD_RESULT);
}

// ---------------------------------------------------------------------------
// Receive-pack
// ---------------------------------------------------------------------------

interface PushCommand {
  readonly oldOid: string;
  readonly newOid: string;
  readonly ref: string;
}

async function handleReceivePack(repo: Repo, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readBody(req);
  let parsed: { packets: GitPacket[]; rest: Buffer };
  try {
    parsed = parsePktStream(body);
  } catch {
    sendJson(res, 400, { message: 'malformed pkt-line' });
    return;
  }
  const commands: PushCommand[] = [];
  for (const line of packetLines(parsed.packets)) {
    const text = line.replace(/\n$/, '').split('\u0000')[0];
    const match = /^([0-9a-f]{40}) ([0-9a-f]{40}) (\S+)$/.exec(text);
    if (match === null) continue;
    commands.push({ oldOid: match[1], newOid: match[2], ref: match[3] });
  }
  const reportLines: string[] = [];
  let unpackOk = true;
  let unpackDetail = 'ok';
  const packBytes = parsed.rest;
  if (packBytes.length > 0) {
    try {
      const checksum = verifyPackChecksum(packBytes);
      if (!checksum.ok) throw new Error('pack trailer does not match its bytes');
      const read = readPack(packBytes, { resolveBase: (oid) => repo.objects.get(oid) });
      for (const [oid, object] of read.objects) {
        if (!repo.objects.has(oid)) repo.objects.set(oid, { type: object.type, data: object.data });
      }
    } catch (err) {
      unpackOk = false;
      unpackDetail = err instanceof Error ? err.message : 'unpack failed';
    }
  }
  const results: Array<{ ref: string; ok: boolean; reason: string }> = [];
  for (const command of commands) {
    if (!unpackOk) {
      results.push({ ref: command.ref, ok: false, reason: 'unpack error' });
      continue;
    }
    const current = repo.refs.get(command.ref);
    const isDelete = command.newOid === ZERO_OID;
    const isCreate = command.oldOid === ZERO_OID;
    if (isDelete) {
      if (current === undefined) {
        results.push({ ref: command.ref, ok: false, reason: 'remote ref does not exist' });
      } else if (!isCreate && command.oldOid !== ZERO_OID && command.oldOid !== current) {
        results.push({ ref: command.ref, ok: false, reason: 'old ref value does not match' });
      } else {
        repo.refs.delete(command.ref);
        results.push({ ref: command.ref, ok: true, reason: '' });
      }
      continue;
    }
    const newObject = repo.objects.get(command.newOid);
    if (newObject === undefined) {
      results.push({ ref: command.ref, ok: false, reason: 'object not found' });
      continue;
    }
    if (isCreate) {
      if (current !== undefined) {
        results.push({ ref: command.ref, ok: false, reason: 'already exists' });
        continue;
      }
      if (command.ref.startsWith('refs/heads/') && newObject.type !== 'commit') {
        results.push({ ref: command.ref, ok: false, reason: 'object is not a commit' });
        continue;
      }
      repo.refs.set(command.ref, command.newOid);
      results.push({ ref: command.ref, ok: true, reason: '' });
      continue;
    }
    if (current === undefined) {
      results.push({ ref: command.ref, ok: false, reason: 'remote ref does not exist' });
      continue;
    }
    if (command.oldOid !== current) {
      results.push({ ref: command.ref, ok: false, reason: 'old ref value does not match' });
      continue;
    }
    if (command.newOid === current) {
      results.push({ ref: command.ref, ok: true, reason: '' });
      continue;
    }
    if (command.ref.startsWith('refs/tags/')) {
      results.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
      continue;
    }
    if (newObject.type !== 'commit') {
      results.push({ ref: command.ref, ok: false, reason: 'object is not a commit' });
      continue;
    }
    // Fast-forward: the current tip must be an ancestor of the new tip.
    let ff = false;
    {
      const seen = new Set<string>();
      const stack: string[] = [command.newOid];
      while (stack.length > 0) {
        const oid = stack.pop()!;
        if (seen.has(oid)) continue;
        seen.add(oid);
        if (oid === current) {
          ff = true;
          break;
        }
        const object = repo.objects.get(oid);
        if (object === undefined || object.type !== 'commit') continue;
        for (const parent of parseCommit(object.data).parents) stack.push(parent);
      }
    }
    if (!ff) {
      results.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
      continue;
    }
    repo.refs.set(command.ref, command.newOid);
    results.push({ ref: command.ref, ok: true, reason: '' });
  }
  reportLines.push(`unpack ${unpackOk ? 'ok' : unpackDetail}\n`);
  for (const result of results) {
    reportLines.push(result.ok ? `ok ${result.ref}\n` : `ng ${result.ref} ${result.reason}\n`);
  }
  // The report-status stream is itself pkt-lined and ends with its own flush INSIDE band 1;
  // the sideband stream then ends with one outer flush. (A missing inner flush is what real
  // git reads as "the remote end hung up unexpectedly".)
  const inner = Buffer.concat([...reportLines.map((line) => encodePktLine(line)), pktFlush()]);
  const parts: Buffer[] = chunkSideband(inner);
  parts.push(pktFlush());
  sendBuffer(res, 200, Buffer.concat(parts), RECEIVE_RESULT);
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

/** Handle a git smart-HTTP request; true when the path is a git route. */
export async function handleGit(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const url = new URL(req.url ?? '/', 'http://entry');
  const match = /^\/([^/]+)\/([^/]+)\.git(\/.*)?$/.exec(url.pathname);
  if (match === null) return false;
  const owner = decodeURIComponent(match[1]);
  const name = decodeURIComponent(match[2]);
  const rest = match[3] ?? '';
  const method = req.method ?? 'GET';
  const repo = owner === VIEWER_LOGIN ? getRepo(store, owner, name) : undefined;
  if (repo === undefined) {
    sendJson(res, 404, { message: 'Not Found' });
    return true;
  }
  try {
    if (method === 'GET' && rest === '/info/refs') {
      const service = url.searchParams.get('service');
      if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
        sendJson(res, 404, { message: 'Not Found' });
        return true;
      }
      if (service === 'git-upload-pack' && req.headers['git-protocol'] === 'version=2') {
        sendBuffer(res, 200, v2Advertisement(service), UPLOAD_AD);
      } else {
        sendBuffer(res, 200, v0Advertisement(repo, service), service === 'git-upload-pack' ? UPLOAD_AD : RECEIVE_AD);
      }
      return true;
    }
    if (method === 'POST' && rest === '/git-upload-pack') {
      await handleUploadPack(repo, req, res);
      return true;
    }
    if (method === 'POST' && rest === '/git-receive-pack') {
      await handleReceivePack(repo, req, res);
      return true;
    }
    sendJson(res, 404, { message: 'Not Found' });
    return true;
  } catch (err) {
    sendJson(res, 400, { message: err instanceof Error ? err.message : 'bad request' });
    return true;
  }
}
