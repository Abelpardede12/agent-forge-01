// gitserver.ts — git smart HTTP, spoken natively: reference advertisement, protocol v2
// ls-refs and fetch (with shallow/deepen negotiation), protocol v0 fetch, and receive-pack
// with per-ref report-status. Everything is served from the forge's in-memory object store,
// so a clone or push is exactly as durable as the process — by design for a demo forge.

import { decodePktLines, pktLine, readPack, sidebandFrame, writePack, ZERO_OID } from './git.ts';
import type { PktPacket } from './git.ts';
import { parseCommit } from './git.ts';
import type { Repo } from './store.ts';

export const AGENT = 'agent=forge/1.0';

const V2_CAPABILITY_LINES = [
  'version 2',
  'agent=forge/1.0',
  'ls-refs=unborn',
  'fetch=shallow wait-for-done',
  'object-format=sha1',
];

/** The v2 capability list as a pkt-line stream, the shape both info/refs and the
 *  capabilities command answer with. */
function v2CapabilityBytes(): Buffer {
  return Buffer.concat([...V2_CAPABILITY_LINES.map((line) => pktLine(`${line}\n`)), Buffer.from('0000')]);
}

interface RefCommand {
  readonly oldOid: string;
  readonly newOid: string;
  readonly ref: string;
}

/** All refs a client may see: branches, tags, and anything else stored, sorted by name. */
export function visibleRefs(repo: Repo): { name: string; oid: string }[] {
  return [...repo.refs.entries()]
    .map(([name, oid]) => ({ name, oid }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** The peeled target of a ref's tip when it is an annotated tag, else undefined. */
function peeledOf(repo: Repo, oid: string): string | undefined {
  const object = repo.getObject(oid);
  if (!object || object.type !== 'tag') return undefined;
  const target = repo.peel(oid);
  return target === oid ? undefined : target;
}

export function handleInfoRefs(repo: Repo, service: string, protocolV2: boolean): { status: number; contentType: string; body: Buffer } {
  if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
    return { status: 403, contentType: 'text/plain', body: Buffer.from('unknown service\n') };
  }
  if (service === 'git-upload-pack' && protocolV2) {
    // Protocol v2 answers info/refs with the capability list itself, after the preamble.
    return {
      status: 200,
      contentType: 'application/x-git-upload-pack-advertisement',
      body: Buffer.concat([pktLine('# service=git-upload-pack\n'), Buffer.from('0000'), v2CapabilityBytes()]),
    };
  }
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), Buffer.from('0000')];
  const refs = visibleRefs(repo);
  if (service === 'git-receive-pack') {
    const caps = 'report-status delete-refs side-band-64k ofs-delta quiet atomic';
    if (refs.length === 0) {
      parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps} ${AGENT}\n`));
    } else {
      refs.forEach((ref, index) => {
        const suffix = index === 0 ? `\0${caps} ${AGENT}` : '';
        parts.push(pktLine(`${ref.oid} ${ref.name}${suffix}\n`));
      });
    }
    parts.push(Buffer.from('0000'));
    return { status: 200, contentType: 'application/x-git-receive-pack-advertisement', body: Buffer.concat(parts) };
  }
  // git-upload-pack, protocol v0: HEAD first, with capabilities and its symref target.
  const headOid = repo.refs.get(repo.head);
  const caps = [
    'multi_ack_detailed',
    'side-band-64k',
    'thin-pack',
    'ofs-delta',
    'deepen-since',
    'deepen-not',
    AGENT,
    `symref=HEAD:${repo.head}`,
  ].join(' ');
  if (!headOid) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    parts.push(pktLine(`${headOid} HEAD\0${caps}\n`));
    for (const ref of refs) {
      parts.push(pktLine(`${ref.oid} ${ref.name}\n`));
      const peeled = peeledOf(repo, ref.oid);
      if (peeled) parts.push(pktLine(`${peeled} ${ref.name}^{}\n`));
    }
  }
  parts.push(Buffer.from('0000'));
  return { status: 200, contentType: 'application/x-git-upload-pack-advertisement', body: Buffer.concat(parts) };
}

// ------------------------------------------------------------------ protocol v2

export function handleV2(repo: Repo, body: Buffer): { status: number; contentType: string; body: Buffer } {
  const { packets } = decodePktLines(body);
  const lines: string[] = [];
  for (const packet of packets) {
    if (packet.kind === 'data') lines.push(packet.payload.toString('utf8').replace(/\n$/, ''));
  }
  const commandLine = lines.find((line) => line.startsWith('command='));
  const command = commandLine ? commandLine.slice('command='.length) : '';
  if (command === 'capabilities') {
    return { status: 200, contentType: 'application/x-git-upload-pack-result', body: v2CapabilityBytes() };
  }
  if (command === 'ls-refs') return { status: 200, contentType: 'application/x-git-upload-pack-result', body: lsRefs(repo, lines) };
  if (command === 'fetch') return { status: 200, contentType: 'application/x-git-upload-pack-result', body: fetchV2(repo, lines) };
  return { status: 400, contentType: 'text/plain', body: Buffer.from('unknown command\n') };
}

function lsRefs(repo: Repo, lines: readonly string[]): Buffer {
  const args = new Set(lines.filter((line) => !line.includes('=') || line.startsWith('ref-prefix ')));
  const prefixes = lines.filter((line) => line.startsWith('ref-prefix ')).map((line) => line.slice('ref-prefix '.length));
  const wantPeel = args.has('peel');
  const wantSymrefs = args.has('symrefs');
  const wantUnborn = args.has('unborn');
  const matches = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const out: Buffer[] = [];
  const headOid = repo.refs.get(repo.head);
  if (matches('HEAD')) {
    if (headOid) {
      let line = `${headOid} HEAD`;
      if (wantSymrefs) line += ` symref-target:${repo.head}`;
      out.push(pktLine(`${line}\n`));
    } else if (wantUnborn) {
      let line = `unborn HEAD`;
      if (wantSymrefs) line += ` symref-target:${repo.head}`;
      out.push(pktLine(`${line}\n`));
    }
  }
  for (const ref of visibleRefs(repo)) {
    if (!matches(ref.name)) continue;
    let line = `${ref.oid} ${ref.name}`;
    if (wantPeel) {
      const peeled = peeledOf(repo, ref.oid);
      if (peeled) line += ` peeled:${peeled}`;
    }
    out.push(pktLine(`${line}\n`));
  }
  out.push(Buffer.from('0000'));
  return Buffer.concat(out);
}

// ------------------------------------------------------------------ fetch machinery

interface FetchRequest {
  readonly wants: string[];
  readonly haves: string[];
  readonly shallowLines: string[];
  readonly deepen: number | undefined;
  readonly done: boolean;
  readonly noProgress: boolean;
}

/** The full object closure of the client's haves: everything it provably already holds. */
function haveObjectSet(repo: Repo, haves: readonly string[]): Set<string> {
  const out = new Set<string>();
  for (const have of haves) {
    for (const oid of repo.closure([have]).keys()) out.add(oid);
  }
  return out;
}

/** The commit graph difference: what the client lacks, computed exactly, never by time. */
function selectFetchObjects(repo: Repo, request: FetchRequest): { pack: Buffer; shallow: string[]; unshallow: string[] } {
  if (request.deepen !== undefined) {
    return deepenSelection(repo, request);
  }
  const haveCommits = new Set<string>();
  for (const have of request.haves) {
    const commit = repo.peelToCommit(have);
    if (commit) for (const ancestor of repo.ancestors(commit)) haveCommits.add(ancestor);
  }
  const wantCommits: string[] = [];
  for (const want of request.wants) {
    const commit = repo.peelToCommit(want);
    if (commit) wantCommits.push(commit);
  }
  // A want the client already fully has needs no pack at all.
  const missing = wantCommits.filter((commit) => !haveCommits.has(commit));
  if (missing.length === 0) return { pack: Buffer.alloc(0), shallow: [], unshallow: [] };
  // Exclude the haves' whole closure — commits, trees, and blobs alike — so nothing the
  // client already holds is ever re-sent.
  const objects = repo.closure(request.wants, haveObjectSet(repo, request.haves));
  return { pack: writePack(objects.values()), shallow: [], unshallow: [] };
}

function deepenSelection(
  repo: Repo,
  request: FetchRequest,
): { pack: Buffer; shallow: string[]; unshallow: string[] } {
  // In this protocol dialect `deepen N` names the absolute depth, counted from the wanted
  // tips, that the clone should hold afterwards; the client's `shallow` lines name its
  // current boundary so the boundary movement can be reported back.
  const clientBoundary = new Set<string>();
  for (const line of request.shallowLines) {
    const oid = line.replace(/^shallow /, '').trim();
    if (oid) clientBoundary.add(oid);
  }
  const depth = Math.max(1, request.deepen ?? 1);
  const { objects, boundary } = repo.shallowClosure(request.wants, depth);
  const included = new Set(objects.keys());
  // A shallow client's haves are held shallowly: the commits themselves and their own
  // trees and blobs, never their ancestors. Only that much may be left out of the pack.
  const held = new Set<string>();
  for (const have of request.haves) {
    for (const oid of repo.shallowClosure([have], 1).objects.keys()) held.add(oid);
  }
  for (const oid of held) objects.delete(oid);
  const shallow: string[] = [];
  const unshallow: string[] = [];
  for (const oid of boundary) {
    if (!clientBoundary.has(oid)) shallow.push(oid);
  }
  for (const oid of clientBoundary) {
    if (!boundary.has(oid) && included.has(oid)) unshallow.push(oid);
  }
  return { pack: writePack(objects.values()), shallow, unshallow };
}

function fetchV2(repo: Repo, lines: readonly string[]): Buffer {
  const wants: string[] = [];
  const haves: string[] = [];
  const shallowLines: string[] = [];
  let deepen: number | undefined;
  let done = false;
  for (const line of lines) {
    if (line.startsWith('want ')) wants.push(line.slice(5).trim());
    else if (line.startsWith('have ')) haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) shallowLines.push(line);
    else if (line.startsWith('deepen ')) deepen = Number(line.slice(7).trim());
    else if (line === 'done') done = true;
  }
  const request: FetchRequest = { wants, haves, shallowLines, deepen, done, noProgress: lines.includes('no-progress') };
  if (!done) {
    // Negotiation round: acknowledge the common haves the client named, nothing more.
    const acked = new Set<string>();
    const out: Buffer[] = [pktLine('acknowledgments\n')];
    for (const have of haves) {
      const commit = repo.peelToCommit(have);
      if (commit && !acked.has(commit)) {
        acked.add(commit);
        out.push(pktLine(`ACK ${commit}\n`));
      }
    }
    if (acked.size === 0) out.push(pktLine('NAK\n'));
    out.push(Buffer.from('0000'));
    return Buffer.concat(out);
  }
  // A done request is answered the way git answers it: no acknowledgments section, just the
  // shallow bookkeeping (when the depth changed) and the packfile, delim-separated.
  const { pack, shallow, unshallow } = selectFetchObjects(repo, request);
  const sections: Buffer[] = [];
  if (shallow.length > 0 || unshallow.length > 0 || deepen !== undefined) {
    const info: Buffer[] = [pktLine('shallow-info\n')];
    for (const oid of shallow) info.push(pktLine(`shallow ${oid}\n`));
    for (const oid of unshallow) info.push(pktLine(`unshallow ${oid}\n`));
    sections.push(Buffer.concat(info));
  }
  if (pack.length > 0) {
    sections.push(Buffer.concat([pktLine('packfile\n'), sidebandFrame(pack)]));
  }
  const out: Buffer[] = [];
  sections.forEach((section, index) => {
    if (index > 0) out.push(Buffer.from('0001'));
    out.push(section);
  });
  out.push(Buffer.from('0000'));
  return Buffer.concat(out);
}

/** Protocol v0 fetch: one request, one sideband pack, the classic shape. */
export function handleUploadPackV0(repo: Repo, body: Buffer): { status: number; contentType: string; body: Buffer } {
  const text = body.toString('latin1');
  const wants: string[] = [];
  const haves: string[] = [];
  let done = false;
  for (const match of text.matchAll(/want ([0-9a-f]{40})/g)) wants.push(match[1]);
  for (const match of text.matchAll(/have ([0-9a-f]{40})/g)) haves.push(match[1]);
  if (/(^|\n)done/.test(text) || text.includes('done\n') || body.includes(Buffer.from('done'))) done = true;
  const request: FetchRequest = { wants, haves, shallowLines: [], deepen: undefined, done, noProgress: false };
  const { pack } = selectFetchObjects(repo, request);
  const parts: Buffer[] = [];
  if (haves.length === 0) parts.push(pktLine('NAK\n'));
  else parts.push(pktLine(`ACK ${haves[0]}\n`));
  if (pack.length > 0) parts.push(sidebandFrame(pack));
  parts.push(Buffer.from('0000'));
  return { status: 200, contentType: 'application/x-git-upload-pack-result', body: Buffer.concat(parts) };
}

// ------------------------------------------------------------------ receive-pack

/** Parse the command list at the head of a receive-pack request. */
export function parseRefCommands(body: Buffer): { commands: RefCommand[]; packStart: number } {
  const commands: RefCommand[] = [];
  let offset = 0;
  for (;;) {
    if (offset + 4 > body.length) throw new Error('truncated command list');
    const head = body.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(head)) throw new Error('bad pkt-line in command list');
    const length = parseInt(head, 16);
    if (length === 0) {
      offset += 4;
      break;
    }
    if (length < 4 || offset + length > body.length) throw new Error('bad command pkt-line');
    let payload = body.subarray(offset + 4, offset + length).toString('utf8');
    const nul = payload.indexOf('\0');
    if (nul >= 0) payload = payload.slice(0, nul);
    const line = payload.replace(/\n$/, '');
    const parts = line.split(' ');
    if (parts.length >= 3) {
      commands.push({ oldOid: parts[0], newOid: parts[1], ref: parts.slice(2).join(' ') });
    }
    offset += length;
  }
  return { commands, packStart: offset };
}

function isFastForward(repo: Repo, oldOid: string, newOid: string): boolean {
  const oldCommit = repo.peelToCommit(oldOid);
  const newCommit = repo.peelToCommit(newOid);
  if (!oldCommit || !newCommit) return false;
  return repo.isAncestor(oldCommit, newCommit);
}

export function handleReceivePack(repo: Repo, body: Buffer): { status: number; contentType: string; body: Buffer } {
  const { commands, packStart } = parseRefCommands(body);
  const packBytes = body.subarray(packStart);
  let unpackLine = 'unpack ok\n';
  if (packBytes.length > 0) {
    try {
      const { objects } = readPack(Buffer.from(packBytes), (oid) => repo.getObject(oid));
      for (const [oid, object] of objects) {
        if (!repo.objects.has(oid)) repo.objects.set(oid, object);
      }
    } catch (error) {
      unpackLine = `unpack ${(error as Error).message}\n`;
    }
  }
  const results: string[] = [];
  if (unpackLine === 'unpack ok\n') {
    for (const command of commands) {
      results.push(applyRefCommand(repo, command));
    }
  } else {
    for (const command of commands) results.push(`ng ${command.ref} unpack failed\n`);
  }
  const report = Buffer.concat([pktLine(unpackLine), ...results.map((line) => pktLine(line)), Buffer.from('0000')]);
  const framed = Buffer.concat([
    pktLine(Buffer.concat([Buffer.from([1]), report])),
    Buffer.from('0000'),
  ]);
  return { status: 200, contentType: 'application/x-git-receive-pack-result', body: framed };
}

function applyRefCommand(repo: Repo, command: RefCommand): string {
  const current = repo.refs.get(command.ref) ?? ZERO_OID;
  if (command.newOid === ZERO_OID) {
    // Delete: the client's old value must match what we hold.
    if (current === ZERO_OID) return `ng ${command.ref} reference not found\n`;
    if (command.oldOid !== ZERO_OID && command.oldOid !== current) {
      return `ng ${command.ref} expected ${command.oldOid} but is ${current}\n`;
    }
    repo.refs.delete(command.ref);
    return `ok ${command.ref}\n`;
  }
  if (!repo.getObject(command.newOid)) return `ng ${command.ref} missing object ${command.newOid}\n`;
  if (current === ZERO_OID) {
    if (command.oldOid !== ZERO_OID) return `ng ${command.ref} reference already exists\n`;
    repo.refs.set(command.ref, command.newOid);
    return `ok ${command.ref}\n`;
  }
  if (command.oldOid !== current) {
    return `ng ${command.ref} expected ${command.oldOid} but is ${current}\n`;
  }
  const isTagRef = command.ref.startsWith('refs/tags/');
  if (!isTagRef && !isFastForward(repo, current, command.newOid)) {
    return `ng ${command.ref} non-fast-forward\n`;
  }
  repo.refs.set(command.ref, command.newOid);
  return `ok ${command.ref}\n`;
}
