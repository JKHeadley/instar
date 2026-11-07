/**
 * TeamAccessLog — who has access, as a signed log (docs/specs/team-roles-and-access.md §3.3, §4.1).
 *
 * `state/team-access/log.jsonl`, one line per row. A row is either a phone's whole signed request,
 * whose events are read ONLY from the signed body, or a machine-signed row. Every row carries a
 * monotonic `seq` from this machine, assigned under the append and machine-signed with the row, so a
 * clock moving backward cannot reorder events. An append is fsynced before it returns, so a torn
 * last line was never acknowledged, and boot truncates it to the last newline before any append.
 *
 * `state/team-access/confined.json` is separate and survives `team-off` and a restore: every
 * conversation that must never again run with owner reach, with its fixed audience. It is written
 * before the event that makes a conversation so.
 *
 * Step 2a: one machine, and the owner's phone is the only person writer. The fold still re-checks
 * the signer's standing, so a row cannot exceed it. An agent that never invited anyone has no files.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { isGrantAccessEvent, parseSignedEvents, validateMachineEvent, type MachineEvent, type RequestEvent } from './TeamAccessEvents.js';
import {
  canonicalStringFromHash, ledgerViewKey, receiptPayload, sha256Hex, verifyMachineSignature,
  type LedgerView, type MachineKeyLookup, type MachineSignature, type MachineSigner,
} from './AppRecordSignatures.js';
import { DEVICE_TIME_WINDOW_MS, isStrictLowSDer, parseDevicePublicKey } from './MobileDeviceKeys.js';
import { UNCHAINED_INCARNATION, findGaps, hasSeen, mayReadMessage, mergeRows, rankOf, streamKey, type AccessStamp, type Gap, type ReaderGrant, type MergeEvent, type MergeRow } from './TeamAccessMerge.js';
import type { GrantAccess } from '../permissions/TeamAccess.js';
import type { OrgRole } from '../permissions/types.js';

export const TEAM_ACCESS_DIR = path.join('state', 'team-access');
export const TEAM_ACCESS_LAST_GOOD_DIR = path.join('state', 'team-access-last-good');

/**
 * Carried by every row a 2b build writes. Rows from a 2a build have none of it and stay valid: their
 * origin comes from `machineSig.machineId`, and the first chained row anchors a hash of that prefix.
 */
export interface RowChain {
  origin?: string;
  incarnation?: string;
  /** The hash of this origin's previous row, or of the unchained rows before the first chained one. */
  prev?: string | null;
  /** What this machine had seen when it wrote the row: origin/incarnation to highest seq. */
  seen?: Record<string, number>;
}

export interface RequestRow extends RowChain {
  seq: number;
  kind: 'request';
  receivedAt: string;
  /** The phone's stored signed request and the machine's receipt (mobile-native-conversations §4.6). */
  signedOrigin: {
    keyHash: string; deviceId: string; bodyB64: string; bodySha256: string;
    publicKey?: string; host?: string; method?: string; pathWithQuery?: string; timeMs?: string; sig?: string;
  };
  receipt?: MachineSignature;
  machineSig: MachineSignature;
}

export interface MachineRow extends RowChain {
  seq: number;
  kind: 'machine';
  at: string;
  events: MachineEvent[];
  machineSig: MachineSignature;
}

export type TeamAccessRow = RequestRow | MachineRow;

export type RowVerdict = 'verified' | 'unknown' | 'failed';

export interface TeamPerson { personKey: string; name: string; role: OrgRole; relationship?: 'msp'; links: Record<string, string | number> }

export interface TeamAccessState {
  on: boolean;
  ownerPersonKey: string | null;
  people: Map<string, TeamPerson>;
  /** personKey → conversation ref → access. */
  grants: Map<string, Map<string, GrantAccess>>;
  /** conversation ref → the team person who created it. */
  owned: Map<string, string>;
  /** device key hash → who it belongs to: a personKey, or 'owner' / 'msp'. */
  bindings: Map<string, string>;
  highestSeq: number;
}

export type LogHealth = 'absent' | 'ok' | 'unreadable';

export interface ConfinedEntry { ref: string; placeKey?: string; personKey?: string }

export function emptyState(): TeamAccessState {
  return { on: false, ownerPersonKey: null, people: new Map(), grants: new Map(), owned: new Map(), bindings: new Map(), highestSeq: 0 };
}

/** The bytes a machine signs for a row. */
export function rowPayload(row: Omit<RequestRow, 'machineSig'> | Omit<MachineRow, 'machineSig'>): string {
  const content = row.kind === 'request' ? `${row.receivedAt}\n${row.signedOrigin.bodySha256}\n${row.signedOrigin.keyHash}` : `${row.at}\n${sha256Hex(JSON.stringify(row.events))}`;
  if (row.origin === undefined) return `instar-team-access-row-v1\n${row.seq}\n${row.kind}\n${content}`;
  const seen = Object.entries(row.seen ?? {}).sort(([a], [b]) => (a < b ? -1 : 1));
  return `instar-team-access-row-v2\n${row.origin}\n${row.incarnation}\n${row.prev ?? ''}\n${JSON.stringify(seen)}\n${row.seq}\n${row.kind}\n${content}`;
}

export { UNCHAINED_INCARNATION };

/** A signed row's `seen` also says which messages its machine held, under this prefix. */
const MESSAGE_STREAM = 'msg:';

/** One row as the merge rules see it (`TeamAccessMerge`). */
export function toMergeRow(row: TeamAccessRow, events: ReadonlyArray<MergeEvent>): MergeRow {
  return {
    origin: row.origin ?? row.machineSig.machineId,
    incarnation: row.incarnation ?? UNCHAINED_INCARNATION,
    seq: row.seq, prev: row.prev ?? null, hash: rowHash(row), seen: row.seen ?? {}, events,
  };
}

/** The events of a machine row this build understands. */
function knownEvents(row: MachineRow): MachineEvent[] {
  return row.events.filter((e) => validateMachineEvent(e) !== null);
}

/** Enough of a row to hash and verify it. */
function isRowShaped(r: unknown): r is TeamAccessRow {
  const row = r as { seq?: unknown; kind?: unknown; origin?: unknown; incarnation?: unknown; events?: unknown; machineSig?: { sig?: unknown; machineId?: unknown }; signedOrigin?: { bodyB64?: unknown } } | null;
  if (!row || typeof row !== 'object' || !Number.isSafeInteger(row.seq) || (row.seq as number) < 1) return false;
  if (typeof row.machineSig?.sig !== 'string' || typeof row.machineSig.machineId !== 'string') return false;
  if (row.origin !== undefined && (typeof row.origin !== 'string' || typeof row.incarnation !== 'string')) return false;
  if (row.kind === 'machine') return Array.isArray(row.events) && row.events.every((e) => typeof (e as { type?: unknown } | null)?.type === 'string');
  return row.kind === 'request' && typeof row.signedOrigin?.bodyB64 === 'string';
}

/** What a row locks: its `confine` events, and any conversation it grants. */
function confinesIn(row: TeamAccessRow): ConfinedEntry[] {
  if (row.kind === 'machine') {
    return knownEvents(row).flatMap((e) => (e.type === 'confine' ? [{ ref: e.ref, ...(e.placeKey ? { placeKey: e.placeKey } : {}), ...(e.personKey ? { personKey: e.personKey } : {}) }] : []));
  }
  return (bodyEvents(row) ?? []).flatMap((e) => (e.type === 'grant' ? [{ ref: e.ref, ...(e.ref.startsWith('telegram:') ? {} : { placeKey: `app:${e.ref}` }) }] : []));
}

const originOf = (r: TeamAccessRow): string => r.origin ?? r.machineSig.machineId;
const streamOf = (r: TeamAccessRow): string => streamKey(originOf(r), r.incarnation ?? UNCHAINED_INCARNATION);

/** A row's access events in the merge rules' terms. */
function mergeEventsOf(row: TeamAccessRow): MergeEvent[] {
  if (row.kind === 'request') {
    return (bodyEvents(row) ?? []).flatMap((e): MergeEvent[] => (
      e.type === 'origin-gone' || e.type === 'team-on' || e.type === 'team-off' || e.type === 'person-add' || e.type === 'person-set' || e.type === 'person-remove' || e.type === 'grant' || e.type === 'grant-remove' ? [e] : []));
  }
  return knownEvents(row).flatMap((e): MergeEvent[] => {
    if (e.type !== 'lower') return [];
    if (e.ref) return [{ type: 'grant-remove', personKey: e.personKey, ref: e.ref }];
    if (e.remove) return [{ type: 'person-remove', personKey: e.personKey }];
    return e.role ? [{ type: 'person-set', personKey: e.personKey, role: e.role, lower: true }] : [];
  });
}

/**
 * The state of a log. Rows from one machine replay in order. Rows from several go through the merge
 * rules, so the answer depends on the rows and not the order they arrived in. Names and bindings come
 * from the plain fold, which only ever adds them.
 */
export function foldLog(rows: ReadonlyArray<TeamAccessRow>, verify: (row: TeamAccessRow) => RowVerdict): TeamAccessState {
  const plain = foldRows(rows, verify);
  if (new Set(rows.map(originOf)).size <= 1) return plain;
  const counted = rows.filter((r) => verify(r) === 'verified' && (r.kind === 'machine' || plain.bindings.get(r.signedOrigin.keyHash) === 'owner'));
  const merged = mergeRows(counted.map((r) => toMergeRow(r, mergeEventsOf(r))));
  const known = new Map<string, TeamPerson>();
  for (const r of counted) {
    if (r.kind !== 'request') continue;
    for (const e of bodyEvents(r) ?? []) {
      if (e.type === 'person-add') known.set(e.personKey, { personKey: e.personKey, name: e.name, role: e.role, links: e.links ?? {}, ...(e.relationship ? { relationship: e.relationship } : {}) });
    }
  }
  const people = new Map<string, TeamPerson>();
  for (const [key, p] of merged.people) {
    const person = known.get(key);
    if (person) people.set(key, { ...person, role: p.role as OrgRole });
  }
  // Who owns a conversation, leaving out what the owner voided. Owned beats shared: a grant to anyone else goes.
  const gone = counted.flatMap((r) => (r.kind === 'request' ? (bodyEvents(r) ?? []).flatMap((e) => (e.type === 'origin-gone' ? [e] : [])) : []));
  const voided = (r: TeamAccessRow): boolean => gone.some((g) => g.machine === originOf(r) && g.incarnation === (r.incarnation ?? UNCHAINED_INCARNATION) && r.seq > g.throughSeq);
  const owned = new Map<string, string>();
  for (const r of [...counted].sort(rowOrder)) {
    if (r.kind !== 'machine' || voided(r)) continue;
    for (const e of knownEvents(r)) if (e.type === 'conversation-own' && !owned.has(e.ref)) owned.set(e.ref, e.personKey);
  }
  const grants = merged.grants;
  for (const [ref, owner] of owned) for (const [person, refs] of grants) if (person !== owner) refs.delete(ref);
  return { ...plain, on: merged.on, people, grants, owned };
}

/** One order for rows from any machine, so nothing depends on which arrived first. */
function rowOrder(a: TeamAccessRow, b: TeamAccessRow): number {
  return a.seq - b.seq || (streamOf(a) < streamOf(b) ? -1 : streamOf(a) > streamOf(b) ? 1 : rowHash(a) < rowHash(b) ? -1 : 1);
}

/**
 * What this log can see is wrong. One machine's log has nothing to compare, so it holds nobody, and a
 * row counts as settling a gap only if the owner's phone signed it.
 */
export function gapsIn(rows: ReadonlyArray<TeamAccessRow>, verify: (row: TeamAccessRow) => RowVerdict): Gap[] {
  if (new Set(rows.map(originOf)).size <= 1) return [];
  const plain = foldRows(rows, verify);
  const owners = (r: TeamAccessRow): boolean => verify(r) === 'verified' && r.kind === 'request' && plain.bindings.get(r.signedOrigin.keyHash) === 'owner';
  const merge = rows.map((r) => toMergeRow(r, owners(r) ? mergeEventsOf(r) : []));
  const gaps = findGaps(merge);
  const settled = new Set(merge.flatMap((r) => r.events.flatMap((e) => (e.type === 'origin-gone' ? [streamKey(e.machine, e.incarnation)] : []))));
  for (const r of rows) {
    const unread = r.kind === 'machine' && knownEvents(r).length < r.events.length;
    if ((verify(r) === 'unknown' || unread) && !settled.has(streamOf(r))) gaps.push({ kind: 'unplaced', origin: originOf(r), incarnation: r.incarnation ?? UNCHAINED_INCARNATION, seq: r.seq });
  }
  return gaps;
}

/** Every person-and-conversation pair a state grants, with its access. A change of either is a change. */
function grantPairs(s: TeamAccessState): Map<string, string> {
  const out = new Map<string, string>();
  for (const [person, refs] of s.grants) for (const [ref, access] of refs) out.set(`${person}\u0000${ref}\u0000${access}`, ref);
  return out;
}

/** A row's place in its origin's chain. */
export function rowHash(row: TeamAccessRow): string {
  const { machineSig: _sig, ...rest } = row;
  return sha256Hex(rowPayload(rest as Omit<RequestRow, 'machineSig'> | Omit<MachineRow, 'machineSig'>));
}

/** The anchor for the first chained row: a hash of everything written before chains existed. */
export function prefixHash(rows: ReadonlyArray<TeamAccessRow>): string {
  return sha256Hex(rows.map((r) => r.machineSig.sig).join('\n'));
}

/** The routes whose signed requests may carry access events. */
export const TEAM_ACCESS_WRITE_PATHS: readonly RegExp[] = [
  /^\/mobile\/team\/invites$/, /^\/mobile\/team\/grants$/, /^\/mobile\/team\/people\/[^/]+$/, /^\/mobile\/team\/off$/, /^\/mobile\/team\/origin-gone$/,
];

/** Did a machine this one knows sign this row? Anything else is not taken in, and comes again next exchange. */
export function rowSignedByKnownMachine(row: TeamAccessRow, machineKey: MachineKeyLookup): boolean {
  const { machineSig, ...rest } = row;
  const atMs = Date.parse(row.kind === 'request' ? row.receivedAt : row.at);
  if (!Number.isFinite(atMs) || (row.origin !== undefined && row.origin !== machineSig.machineId)) return false;
  return verifyMachineSignature(machineKey, machineSig, rowPayload(rest as Omit<RequestRow, 'machineSig'> | Omit<MachineRow, 'machineSig'>), atMs) === 'ok';
}

/** Which events each route may carry. A row's signature covers its path, so this binds what was signed. */
export function eventsFitPath(pathWithQuery: string, events: ReadonlyArray<{ type: string; personKey?: string }>): boolean {
  const person = /^\/mobile\/team\/people\/([^/]+)$/.exec(pathWithQuery);
  if (person) {
    let key = person[1];
    try { key = decodeURIComponent(key); } catch { return false; } // @silent-fallback-ok — a malformed path fits nothing
    return events.every((e) => (e.type === 'person-set' || e.type === 'person-remove') && e.personKey === key);
  }
  const allowed = pathWithQuery === '/mobile/team/invites' ? ['team-on', 'owner-pin', 'person-add', 'grant']
    : pathWithQuery === '/mobile/team/grants' ? ['grant', 'grant-remove']
      : pathWithQuery === '/mobile/team/off' ? ['team-off']
        : pathWithQuery === '/mobile/team/origin-gone' ? ['origin-gone'] : [];
  return events.every((e) => allowed.includes(e.type));
}

/**
 * A row's verdict. The phone's signature is re-checked over the stored body, the path must be an
 * access route, and the machine must have signed both the receipt and the row. A key this machine
 * cannot look up reads `unknown`, never `failed`.
 */
export function verifyTeamAccessRow(row: TeamAccessRow, ledger: LedgerView, machineKey: MachineKeyLookup): RowVerdict {
  const { machineSig, ...rest } = row;
  // A machine writes only its own stream, so no peer can add to another's.
  if (row.origin !== undefined && row.origin !== machineSig.machineId) return 'failed';
  const atMs = Date.parse(row.kind === 'request' ? row.receivedAt : row.at);
  if (!Number.isFinite(atMs)) return 'failed';
  const rowSig = verifyMachineSignature(machineKey, machineSig, rowPayload(rest as Omit<RequestRow, 'machineSig'> | Omit<MachineRow, 'machineSig'>), atMs);
  if (rowSig === 'bad') return 'failed';
  if (row.kind === 'machine') return rowSig === 'ok' ? 'verified' : 'unknown';

  const o = row.signedOrigin;
  if (!ledger) return 'unknown';
  const entry = ledger.get(ledgerViewKey(o.keyHash, o.deviceId));
  if (!entry) return 'unknown';
  if (o.publicKey !== entry.publicKey || o.deviceId !== entry.deviceId) return 'failed';
  if (typeof o.host !== 'string' || typeof o.pathWithQuery !== 'string' || typeof o.timeMs !== 'string' || typeof o.sig !== 'string') return 'failed';
  if ((o.method ?? '').toUpperCase() !== 'POST' || !TEAM_ACCESS_WRITE_PATHS.some((re) => re.test(o.pathWithQuery as string))) return 'failed';
  const key = parseDevicePublicKey(entry.publicKey);
  const sigBytes = /^[A-Za-z0-9_-]+$/.test(o.sig) ? Buffer.from(o.sig, 'base64url') : null;
  if (!key || !sigBytes || !isStrictLowSDer(sigBytes)) return 'failed';
  const canonical = canonicalStringFromHash(o.deviceId, o.host, o.method as string, o.pathWithQuery, o.timeMs, o.bodySha256);
  let sigOk = false;
  try { sigOk = crypto.verify('sha256', Buffer.from(canonical), { key, dsaEncoding: 'der' }, sigBytes); } catch { sigOk = false; } // @silent-fallback-ok — a malformed signature is a failed row
  if (!sigOk) return 'failed';
  const activated = Date.parse(entry.activatedAt);
  const revoked = entry.revokedAt ? Date.parse(entry.revokedAt) : null;
  if (!Number.isFinite(activated) || atMs < activated || (revoked !== null && atMs >= revoked)) return 'failed';
  if (!/^\d{10,16}$/.test(o.timeMs) || Math.abs(Number(o.timeMs) - atMs) > DEVICE_TIME_WINDOW_MS) return 'failed';
  if (!row.receipt) return 'failed';
  // The signature binds the path, and the path binds what it may carry: `/off` is the Face ID route.
  let signed: ReturnType<typeof parseSignedEvents> = null;
  try { signed = parseSignedEvents(JSON.parse(Buffer.from(o.bodyB64 ?? '', 'base64').toString('utf8'))); } catch { signed = null; } // @silent-fallback-ok — an unparseable body is a failed row, on the next line
  if (!signed || !eventsFitPath(o.pathWithQuery as string, signed)) return 'failed';
  const receipt = verifyMachineSignature(machineKey, row.receipt, receiptPayload(sha256Hex(canonical), row.receivedAt, row.receipt.machineId), atMs);
  if (receipt === 'bad') return 'failed';
  return receipt === 'ok' && rowSig === 'ok' ? 'verified' : 'unknown';
}

function bodyEvents(row: RequestRow): RequestEvent[] | null {
  try {
    const body = Buffer.from(row.signedOrigin.bodyB64, 'base64');
    if (sha256Hex(body) !== row.signedOrigin.bodySha256) return null;
    return parseSignedEvents(JSON.parse(body.toString('utf8')));
  } catch {
    // @silent-fallback-ok — an unparseable signed body has no events; the row counts for nothing.
    return null;
  }
}

function applyRequestEvent(s: TeamAccessState, e: RequestEvent): void {
  switch (e.type) {
    case 'team-on': s.on = true; return;
    case 'team-off':
      s.on = false; s.people.clear(); s.grants.clear();
      return;
    case 'owner-pin':
      if (!s.ownerPersonKey) s.ownerPersonKey = e.personKey;
      return;
    case 'person-add':
      s.people.set(e.personKey, { personKey: e.personKey, name: e.name, role: e.role, links: e.links ?? {}, ...(e.relationship ? { relationship: e.relationship } : {}) });
      return;
    case 'person-set': {
      const p = s.people.get(e.personKey);
      if (p) p.role = e.role;
      return;
    }
    case 'person-remove': s.people.delete(e.personKey); s.grants.delete(e.personKey); return;
    case 'grant': {
      if (!s.people.has(e.personKey)) return;
      const g = s.grants.get(e.personKey) ?? new Map<string, GrantAccess>();
      g.set(e.ref, e.access);
      s.grants.set(e.personKey, g);
      return;
    }
    case 'grant-remove': s.grants.get(e.personKey)?.delete(e.ref); return;
    case 'origin-gone': return; // read by the merge rules
  }
}

function applyMachineEvent(s: TeamAccessState, e: MachineEvent): void {
  switch (e.type) {
    case 'phone-bind': s.bindings.set(e.keyHash, e.boundTo); return;
    case 'conversation-own': s.owned.set(e.ref, e.personKey); return;
    case 'restored': return;
    case 'confine': return;
    case 'lower': {
      if (e.ref) { s.grants.get(e.personKey)?.delete(e.ref); return; }
      if (e.remove) { s.people.delete(e.personKey); s.grants.delete(e.personKey); return; }
      const p = s.people.get(e.personKey);
      // A machine can only ever take someone down, however the row reads.
      if (p && e.role && rankOf(e.role) < rankOf(p.role)) p.role = e.role;
      return;
    }
  }
}

/**
 * The fold: `seq` order, signer standing checked at that point. A request row counts only if its key
 * was bound as the owner's by then (2a), and all its events apply or none: a row is one line.
 */
export function foldRows(rows: ReadonlyArray<TeamAccessRow>, verify: (row: TeamAccessRow) => RowVerdict): TeamAccessState {
  const s = emptyState();
  for (const row of [...rows].sort(rowOrder)) foldRowInto(s, row, verify);
  return s;
}

/** Every conversation the log shows as ever shared or owned. An owned one keeps its person. */
export function confinedFromRows(rows: ReadonlyArray<TeamAccessRow>, verify: (row: TeamAccessRow) => RowVerdict): ConfinedEntry[] {
  const owned = new Map<string, string>();
  const shared = new Set<string>();
  for (const row of rows) {
    if (verify(row) !== 'verified') continue;
    if (row.kind === 'machine') {
      for (const e of row.events) if (e.type === 'conversation-own') owned.set(e.ref, e.personKey);
      continue;
    }
    for (const e of bodyEvents(row) ?? []) if (e.type === 'grant') shared.add(e.ref);
  }
  const entryFor = (ref: string): ConfinedEntry => (ref.startsWith('telegram:') ? { ref } : { ref, placeKey: `app:${ref}` });
  return [
    ...[...owned].map(([ref, personKey]) => ({ ...entryFor(ref), personKey })),
    ...[...shared].filter((ref) => !owned.has(ref)).map(entryFor),
  ];
}

/** One row onto a state. Rows must arrive in `seq` order, as an append does. */
export function foldRowInto(s: TeamAccessState, row: TeamAccessRow, verify: (row: TeamAccessRow) => RowVerdict): void {
  s.highestSeq = Math.max(s.highestSeq, row.seq);
  if (verify(row) !== 'verified') return;
  if (row.kind === 'machine') {
    for (const e of knownEvents(row)) applyMachineEvent(s, e);
    return;
  }
  if (s.bindings.get(row.signedOrigin.keyHash) !== 'owner') return;
  const events = bodyEvents(row);
  if (!events) return;
  for (const e of events) applyRequestEvent(s, e);
}

export interface TeamAccessLogOptions {
  stateDir: string;
  signer: MachineSigner | null;
  verify: (row: TeamAccessRow) => RowVerdict;
  /** A peer's row is taken in only if this says a known machine signed it. */
  machineSigned?: (row: TeamAccessRow) => boolean;
  now?: () => number;
}

export class TeamAccessLog {
  private readonly dir: string;
  private readonly lastGoodDir: string;
  private readonly logFile: string;
  private readonly confinedFile: string;
  private rows: TeamAccessRow[] = [];
  private folded: TeamAccessState = emptyState();
  private health: LogHealth = 'absent';
  private seedSeq = 0;
  private refoldPending = false;
  private unknownRows = -1;
  private incarnationCache: string | null = null;
  private gapsCache: Gap[] | null = null;
  private messageState: { stream: string; seen: Record<string, number> } | null = null;
  /** Conversations whose sharing just changed here, with the log as it stood before. */
  private frozen: Map<string, Record<string, number>> | null = null;
  private readonly grantsCache = new Map<string, ReaderGrant[]>();
  private readonly goneCache = new Map<string, boolean>();
  /** Rows that reached this machine from a peer since it started. */
  private readonly foreign = new WeakSet<TeamAccessRow>();

  private readonly opts: TeamAccessLogOptions;

  constructor(options: TeamAccessLogOptions) {
    // A signature check costs real time and a verified row stays verified, so each is done once.
    const verified = new WeakSet<TeamAccessRow>();
    this.opts = {
      ...options,
      verify: (row) => {
        if (verified.has(row)) return 'verified';
        const verdict = options.verify(row);
        if (verdict === 'verified') verified.add(row);
        return verdict;
      },
    };
    const opts = this.opts;
    this.dir = path.join(opts.stateDir, TEAM_ACCESS_DIR);
    this.lastGoodDir = path.join(opts.stateDir, TEAM_ACCESS_LAST_GOOD_DIR);
    this.logFile = path.join(this.dir, 'log.jsonl');
    this.confinedFile = path.join(this.dir, 'confined.json');
    this.load();
  }

  /** This machine's current stream. A machine that lost its log starts a new one (Step 2b). */
  private incarnation(): string {
    if (this.incarnationCache) return this.incarnationCache;
    const file = path.join(this.dir, 'incarnation.json');
    try {
      const v = (JSON.parse(fs.readFileSync(file, 'utf8')) as { incarnation?: unknown }).incarnation;
      if (typeof v === 'string' && v.length > 0) { this.incarnationCache = v; return v; }
    } catch {
      // @silent-fallback-ok — no record yet: a new one is minted below.
    }
    return this.mintIncarnation();
  }

  private mintIncarnation(): string {
    const value = crypto.randomBytes(8).toString('hex');
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(this.dir, 'incarnation.json'), JSON.stringify({ incarnation: value }), { mode: 0o600 });
    this.incarnationCache = value;
    return value;
  }

  /** The chain fields for the next row this machine writes. */
  private chainFor(signer: MachineSigner): Required<RowChain> {
    const origin = signer.machineId();
    const incarnation = this.incarnation();
    const mine = this.rows.filter((r) => r.origin === origin && r.incarnation === incarnation);
    const last = mine[mine.length - 1];
    const ownEarlier = this.rows.filter((r) => originOf(r) === origin);
    const messages = Object.entries(this.messageRecord().seen).map(([stream, seq]) => [`${MESSAGE_STREAM}${stream}`, seq]);
    return { origin, incarnation, prev: last ? rowHash(last) : (ownEarlier.length > 0 ? prefixHash(ownEarlier) : null), seen: { ...this.vector(), ...Object.fromEntries(messages) } };
  }

  private lastGoodLog(): string { return path.join(this.lastGoodDir, 'log.jsonl'); }
  private lastGoodConfined(): string { return path.join(this.lastGoodDir, 'confined.json'); }

  private parseLines(raw: string): TeamAccessRow[] | null {
    const rows: TeamAccessRow[] = [];
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        const r = JSON.parse(line) as TeamAccessRow;
        if (!r || typeof r.seq !== 'number' || (r.kind !== 'request' && r.kind !== 'machine')) return null;
        // An event from a newer build is kept and held on (`gapsIn`), never a reason to lose the log.
        if (r.kind === 'machine' && (!Array.isArray(r.events) || r.events.some((e) => typeof (e as { type?: unknown } | null)?.type !== 'string'))) return null;
        rows.push(r);
      } catch {
        // @silent-fallback-ok — an unparseable middle line makes the whole log unreadable, reported by health().
        return null;
      }
    }
    return rows;
  }

  private truncateTornTail(): void {
    const raw = fs.readFileSync(this.logFile);
    if (raw.length === 0 || raw[raw.length - 1] === 0x0a) return;
    const lastNewline = raw.lastIndexOf(0x0a);
    fs.truncateSync(this.logFile, lastNewline + 1);
  }

  /** Read both files. Never throws: a failure is health 'unreadable'. */
  load(): void {
    this.seedSeq = this.readLastGoodHighestSeq();
    if (!fs.existsSync(this.logFile)) {
      // A snapshot with no live log means the log was lost, not that there never was one.
      this.rows = []; this.folded = emptyState(); this.health = this.seedSeq > 0 ? 'unreadable' : 'absent';
      return;
    }
    try {
      this.truncateTornTail();
      const rows = this.parseLines(fs.readFileSync(this.logFile, 'utf8'));
      if (!rows) { this.rows = []; this.folded = emptyState(); this.health = 'unreadable'; return; }
      this.rows = rows;
      this.folded = foldLog(rows, this.opts.verify);
      // A log below last-good was rolled back: count it as lost, whatever it says. On one machine every
      // phone is in the ledger, so a row it cannot place means the ledger failed: strict, not empty.
      const own = this.opts.signer?.machineId();
      const unknown = rows.filter((r) => r.kind === 'request' && this.opts.verify(r) === 'unknown');
      const unplaced = unknown.some((r) => originOf(r) === own) && new Set(rows.map(originOf)).size <= 1;
      // A peer's row can wait for its key to arrive: it counts for nothing until then.
      this.refoldPending = unknown.length > 0 && !unplaced;
      // A lost or altered row in the middle could be a downgrade: the fold would quietly give back
      // what it took away. Past the last accepted restore, every row must be there and verify.
      this.health = this.folded.highestSeq < this.seedSeq || unplaced || !this.intact(rows) ? 'unreadable' : 'ok';
    } catch (err) { // @silent-fallback-ok — health 'unreadable' is the report: team phones are refused and the owner sees it
      console.warn(`[team-access] log unreadable: ${err instanceof Error ? err.message : String(err)}`);
      this.rows = []; this.folded = emptyState(); this.health = 'unreadable';
    }
  }

  /**
   * Past the last accepted restore, each origin's rows must all be here and verify. Rows from another
   * machine join under the merge rules, so only this machine's own record has to be whole for it.
   */
  private intact(rows: ReadonlyArray<TeamAccessRow>): boolean {
    // With peers the gap rules see this, and a peer can fill it, so it holds rather than reads as lost.
    if (new Set(rows.map(originOf)).size > 1) return true;
    const sorted = [...rows].sort((a, b) => a.seq - b.seq);
    let from = 0;
    for (const r of sorted) {
      if (r.kind !== 'machine' || this.opts.verify(r) !== 'verified') continue;
      for (const e of r.events) if (e.type === 'restored') from = Math.max(from, e.throughSeq);
    }
    // A machine that moved to a new stream may later receive its old rows back, so numbers can overlap
    // across streams. Each stream must still hold together, and a fork in one reads as a gap, not a loss.
    const chained = new Set(rows.flatMap((r) => (r.incarnation ? [r.incarnation] : [])));
    if (chained.size > 1) {
      for (const stream of chained) {
        const list = sorted.filter((r) => r.incarnation === stream && r.seq > from);
        for (let i = 1; i < list.length; i += 1) if (list[i].seq > list[i - 1].seq + 1) return false;
      }
      return !rows.some((r) => this.opts.verify(r) === 'failed');
    }
    let expected = from + 1;
    for (const r of sorted) {
      if (r.seq <= from) continue;
      if (r.seq !== expected || this.opts.verify(r) === 'failed') return false;
      expected += 1;
      // A chained row names its predecessor, so a replaced row shows even where the numbers still run.
      if (r.origin === undefined) continue;
      const earlier = sorted.filter((x) => x.seq < r.seq);
      const before = [...earlier].reverse().find((x) => x.origin === r.origin && x.incarnation === r.incarnation);
      const want = before ? rowHash(before) : (earlier.length > 0 ? prefixHash(earlier) : null);
      if ((r.prev ?? null) !== want) return false;
    }
    return true;
  }

  private readLastGoodHighestSeq(): number {
    try {
      const rows = this.parseLines(fs.readFileSync(this.lastGoodLog(), 'utf8'));
      return rows ? rows.reduce((m, r) => Math.max(m, r.seq), 0) : 0;
    } catch {
      // @silent-fallback-ok — no or an unreadable last-good seeds from the log (§3.3).
      return 0;
    }
  }

  healthState(): LogHealth { return this.health; }
  allRows(): ReadonlyArray<TeamAccessRow> { return this.rows; }
  state(): TeamAccessState {
    if (this.refoldPending) {
      // Only a row that became placeable changes the answer.
      const unknown = this.rows.filter((r) => this.opts.verify(r) === 'unknown').length;
      if (unknown !== this.unknownRows) {
        this.folded = foldLog(this.rows, this.opts.verify);
        this.gapsCache = null; this.grantsCache.clear(); this.goneCache.clear();
      }
      this.unknownRows = unknown;
      this.refoldPending = unknown > 0;
    }
    return this.folded;
  }

  /** What holds every team person right now. */
  gaps(): Gap[] {
    if (!this.gapsCache) this.gapsCache = gapsIn(this.rows, this.opts.verify);
    return this.gapsCache;
  }

  /**
   * Message numbers and what has been seen. The numbers run on their own stream: if this record is
   * lost a new one starts, because a reused number would pass as something an old grant had seen.
   */
  private messageRecord(): { stream: string; seen: Record<string, number> } {
    if (this.messageState) return this.messageState;
    try {
      const r = JSON.parse(fs.readFileSync(path.join(this.dir, 'message-seen.json'), 'utf8')) as { stream?: unknown; seen?: unknown };
      if (typeof r.stream === 'string' && r.seen && typeof r.seen === 'object') {
        this.messageState = { stream: r.stream, seen: r.seen as Record<string, number> };
        return this.messageState;
      }
    } catch {
      // @silent-fallback-ok — none yet or lost: a grant then records seeing less, and a new stream starts.
    }
    this.messageState = { stream: crypto.randomBytes(8).toString('hex'), seen: {} };
    return this.messageState;
  }

  private saveMessageRecord(): void {
    try {
      fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
      const file = path.join(this.dir, 'message-seen.json');
      fs.writeFileSync(`${file}.tmp`, JSON.stringify(this.messageRecord()), { mode: 0o600 });
      fs.renameSync(`${file}.tmp`, file);
    } catch (err) { // @silent-fallback-ok — the count stays in memory; a lost record starts a new stream
      console.warn(`[team-access] message record not written: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** Note a message's place. A grant signed from here on says it had seen it. */
  noteMessage(stamp: AccessStamp): void {
    const { seen } = this.messageRecord();
    const stream = streamKey(stamp.origin, stamp.incarnation);
    if ((seen[stream] ?? 0) >= stamp.seq) return;
    seen[stream] = stamp.seq;
    this.saveMessageRecord();
  }

  /**
   * The stamp for a new message. An agent's reply carries what its session knew: if rows arrived and
   * its session is not yet ended, that is the log from before they came.
   */
  stampMessage(ref: string, role: 'operator' | 'agent'): AccessStamp | null {
    const origin = this.opts.signer?.machineId();
    if (!origin) return null;
    const record = this.messageRecord();
    const seq = (record.seen[streamKey(origin, record.stream)] ?? 0) + 1;
    const stamp = { origin, incarnation: record.stream, seq, access: (role === 'agent' ? this.frozenAccess().get(ref) : undefined) ?? this.vector() };
    this.noteMessage(stamp);
    return stamp;
  }

  /** Sessions outlive this server, so what they knew is kept on disk until they have ended. */
  private frozenAccess(): Map<string, Record<string, number>> {
    if (this.frozen) return this.frozen;
    this.frozen = new Map();
    try {
      const saved = JSON.parse(fs.readFileSync(path.join(this.dir, 'frozen.json'), 'utf8')) as Record<string, Record<string, number>>;
      for (const [ref, v] of Object.entries(saved)) this.frozen.set(ref, v);
    } catch {
      // @silent-fallback-ok — none is the normal state.
    }
    return this.frozen;
  }

  private saveFrozen(): void {
    const file = path.join(this.dir, 'frozen.json');
    try {
      fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
      fs.writeFileSync(`${file}.tmp`, JSON.stringify(Object.fromEntries(this.frozenAccess())), { mode: 0o600 });
      fs.renameSync(`${file}.tmp`, file);
    } catch (err) { // @silent-fallback-ok — held in memory; lost only if this server also stops
      console.warn(`[team-access] session record not written: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** Conversations whose sessions have not yet been ended after a change. Retried at each exchange. */
  pendingEnds(): string[] { return [...this.frozenAccess().keys()]; }

  /** The conversation's sessions have ended, so new replies know the current log. */
  releaseAccess(ref: string): void { if (this.frozenAccess().delete(ref)) this.saveFrozen(); }

  /** Every signed fact that opens this conversation to this person, leaving out what the owner voided. */
  private readerGrants(personKey: string, ref: string): ReaderGrant[] {
    const key = `${personKey}\u0000${ref}`;
    const cached = this.grantsCache.get(key);
    if (cached) return cached;
    const plain = this.state();
    const verified = new Map(this.rows.map((r) => [r, this.opts.verify(r) === 'verified'] as const));
    const out: ReaderGrant[] = [];
    const owners = (r: TeamAccessRow): r is RequestRow => !!verified.get(r) && r.kind === 'request' && plain.bindings.get(r.signedOrigin.keyHash) === 'owner';
    const gone = this.rows.flatMap((r) => (owners(r) ? (bodyEvents(r) ?? []).flatMap((e) => (e.type === 'origin-gone' ? [e] : [])) : []));
    for (const r of this.rows) {
      const opens = r.kind === 'machine'
        ? !!verified.get(r) && r.events.some((e) => e.type === 'conversation-own' && e.ref === ref && e.personKey === personKey)
        : owners(r) && (bodyEvents(r) ?? []).some((e) => e.type === 'grant' && e.ref === ref && e.personKey === personKey);
      if (!opens) continue;
      if (gone.some((g) => g.machine === originOf(r) && g.incarnation === (r.incarnation ?? UNCHAINED_INCARNATION) && r.seq > g.throughSeq)) continue;
      const seenMessages = Object.fromEntries(Object.entries(r.seen ?? {}).filter(([k]) => k.startsWith(MESSAGE_STREAM)).map(([k, v]) => [k.slice(MESSAGE_STREAM.length), v]));
      out.push({ stream: streamOf(r), seq: r.seq, seenMessages });
    }
    this.grantsCache.set(key, out);
    return out;
  }

  /** May this person read a stamped message in this conversation? */
  mayRead(personKey: string, ref: string, stamp: AccessStamp, authorKey: string | null): boolean {
    return mayReadMessage({ ...stamp, authorKey }, personKey, this.readerGrants(personKey, ref));
  }

  /** Each machine numbers its own rows. Rows from before chains share the sequence they always had. */
  private nextSeq(): number {
    const own = this.opts.signer?.machineId();
    const mine = this.rows.filter((r) => originOf(r) === own).reduce((m, r) => Math.max(m, r.seq), 0);
    // The snapshot's highest row can be a peer's, and a jump in this machine's numbers would read as a lost row.
    return (this.rows.some((r) => originOf(r) !== own) ? mine : Math.max(mine, this.seedSeq)) + 1;
  }

  /** Did the log ever hold this person, present or gone? A used key is never used again. */
  everHeld(personKey: string): boolean {
    return this.rows.some((r) => r.kind === 'request' && (bodyEvents(r) ?? []).some((e) => e.type === 'person-add' && e.personKey === personKey));
  }

  /** Did this person leave, by rows that can be trusted? Silence is not leaving, and a team-off they joined after is not either. */
  wasRemoved(personKey: string): boolean {
    const plain = this.state();
    const owners = this.rows.filter((r): r is RequestRow => r.kind === 'request' && this.opts.verify(r) === 'verified' && plain.bindings.get(r.signedOrigin.keyHash) === 'owner');
    const has = (r: RequestRow, match: (e: RequestEvent) => boolean): boolean => (bodyEvents(r) ?? []).some(match);
    const adds = owners.filter((r) => has(r, (e) => e.type === 'person-add' && e.personKey === personKey));
    if (adds.length === 0) return false;
    if (owners.some((r) => has(r, (e) => e.type === 'person-remove' && e.personKey === personKey))) return true;
    if (this.rows.some((r) => r.kind === 'machine' && this.opts.verify(r) === 'verified' && knownEvents(r).some((e) => e.type === 'lower' && e.personKey === personKey && e.remove === true))) return true;
    const view = (r: TeamAccessRow): MergeRow => toMergeRow(r, []);
    return owners.filter((r) => has(r, (e) => e.type === 'team-off')).some((off) => adds.every((add) => !hasSeen(view(add), view(off))));
  }

  /** Could this agent have a team, going by any row at all? For decisions where a wrong no is the harm. */
  mayHaveTeam(): boolean {
    return this.rows.some((r) => r.kind === 'request' && (bodyEvents(r) ?? []).some((e) => e.type === 'team-on'));
  }

  /** Has the owner named every chained stream this log holds from that machine as gone? */
  isGone(machineId: string): boolean {
    const cached = this.goneCache.get(machineId);
    if (cached !== undefined) return cached;
    const plain = this.state();
    const named = new Set(this.rows.flatMap((r) => (r.kind === 'request' && this.opts.verify(r) === 'verified' && plain.bindings.get(r.signedOrigin.keyHash) === 'owner'
      ? (bodyEvents(r) ?? []).flatMap((e) => (e.type === 'origin-gone' && e.machine === machineId ? [e.incarnation] : []))
      : [])));
    // Rows from before chains are only a machine's start: naming its stream covers them.
    const answer = named.size > 0 && this.rows.filter((r) => originOf(r) === machineId && r.incarnation !== undefined).every((r) => named.has(r.incarnation as string));
    this.goneCache.set(machineId, answer);
    return answer;
  }

  /** What this machine holds: origin/incarnation to highest seq. */
  vector(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const r of this.rows) out[streamOf(r)] = Math.max(out[streamOf(r)] ?? 0, r.seq);
    return out;
  }

  /**
   * What this machine holds without a hole, for asking peers. A row refused on arrival leaves a hole,
   * and it must come again once this machine can take it.
   */
  unbroken(): Record<string, number> {
    const seqs = new Map<string, number[]>();
    for (const r of this.rows) seqs.set(streamOf(r), [...(seqs.get(streamOf(r)) ?? []), r.seq]);
    const out: Record<string, number> = {};
    for (const [stream, list] of seqs) {
      const sorted = [...list].sort((a, b) => a - b);
      let top = sorted[0];
      for (const seq of sorted) { if (seq > top + 1) break; top = seq; }
      out[stream] = top;
    }
    return out;
  }

  /** Rows a peer with this vector lacks, from any origin. Rows verify themselves, so any peer may serve them. */
  rowsBeyond(have: Readonly<Record<string, number>>, heads: Readonly<Record<string, string>> = {}): TeamAccessRow[] {
    // Two rows with one number look the same to a vector, so the hash of a peer's last row is compared too.
    const forked = (r: TeamAccessRow): boolean => r.seq === have[streamOf(r)] && heads[streamOf(r)] !== undefined && heads[streamOf(r)] !== rowHash(r);
    return this.rows.filter((r) => r.seq > (have[streamOf(r)] ?? 0) || forked(r));
  }

  /** Rows on a number two rows claim: a peer must see both, or only this machine knows of the fork. */
  disputed(): TeamAccessRow[] {
    const forks = new Set(this.gaps().flatMap((g) => (g.kind === 'fork' ? [`${streamKey(g.origin, g.incarnation)}#${g.seq}`] : [])));
    return this.rows.filter((r) => forks.has(`${streamOf(r)}#${r.seq}`));
  }

  /** The first number held on each stream, so a peer can tell this machine is missing a stream's start. */
  starts(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const r of this.rows) out[streamOf(r)] = Math.min(out[streamOf(r)] ?? r.seq, r.seq);
    return out;
  }

  /** The hash of the last row held on each stream. */
  heads(): Record<string, string> {
    const top = new Map<string, TeamAccessRow>();
    for (const r of this.rows) {
      const held = top.get(streamOf(r));
      if (!held || r.seq > held.seq) top.set(streamOf(r), r);
    }
    return Object.fromEntries([...top].map(([k, r]) => [k, rowHash(r)]));
  }

  /**
   * Take rows from a peer. A row that fails verification is left out, and one already held changes
   * nothing, so this is safe to run with whatever a peer sends. Returns how many were new.
   */
  ingest(incoming: ReadonlyArray<TeamAccessRow>): { added: number; refused: number; touched: string[] } {
    const before = grantPairs(this.state());
    const vectorBefore = this.vector();
    const touched = new Set<string>();
    const held = new Set(this.rows.map((r) => `${streamOf(r)}#${r.seq}#${rowHash(r)}`));
    let added = 0;
    let refused = 0;
    for (const row of incoming) {
      // A peer's rows are what it sent, so nothing here is assumed about their shape.
      if (!isRowShaped(row)) { refused += 1; continue; }
      const id = `${streamOf(row)}#${row.seq}#${rowHash(row)}`;
      if (held.has(id)) continue;
      if (this.opts.verify(row) === 'failed' || this.opts.machineSigned?.(row) === false) { refused += 1; continue; }
      // Before folding, and for a row that cannot be placed yet too: confining is the safe direction.
      this.ensureConfinedFile();
      for (const entry of confinesIn(row)) { this.confineHere(entry); touched.add(entry.ref); }
      this.writeLine(row);
      this.rows.push(row);
      this.foreign.add(row);
      held.add(id);
      added += 1;
    }
    // A row that could not be placed may be placeable now, so this is worked out afresh after a pull.
    this.gapsCache = null;
    this.grantsCache.clear(); this.goneCache.clear();
    if (added > 0) {
      this.folded = foldLog(this.rows, this.opts.verify);
      this.refoldPending = this.rows.some((r) => this.opts.verify(r) === 'unknown');
      // A machine that has only ever received rows still has a log.
      if (this.health === 'absent') this.health = 'ok';
      this.snapshot();
      this.leaveLostStream();
      const after = grantPairs(this.folded);
      for (const [pair, ref] of [...before, ...after]) if (before.has(pair) !== after.has(pair)) touched.add(ref);
    }
    const frozen = this.frozenAccess();
    let newlyFrozen = false;
    for (const ref of touched) if (!frozen.has(ref)) { frozen.set(ref, vectorBefore); newlyFrozen = true; }
    if (newlyFrozen) this.saveFrozen();
    return { added, refused, touched: [...touched] };
  }

  /**
   * This machine's own stream can only move on from here. If a peer holds more of it than this
   * machine wrote, or the owner named it gone, a tail was lost, and further rows go on a new stream.
   */
  private leaveLostStream(): void {
    const own = this.opts.signer?.machineId();
    if (!own) return;
    const current = this.incarnation();
    const named = this.rows.some((r) => r.kind === 'request' && (bodyEvents(r) ?? []).some((e) => e.type === 'origin-gone' && e.machine === own && e.incarnation === current));
    if (named || this.rows.some((r) => this.foreign.has(r) && r.origin === own && r.incarnation === current)) this.mintIncarnation();
  }

  private writeLine(row: TeamAccessRow): void {
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const fd = fs.openSync(this.logFile, 'a', 0o600);
    try {
      fs.writeSync(fd, `${JSON.stringify(row)}\n`);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  }

  private appendLine(row: TeamAccessRow): void {
    this.writeLine(row);
    this.rows.push(row);
    this.gapsCache = null;
    this.grantsCache.clear(); this.goneCache.clear();
    if (new Set(this.rows.map(originOf)).size > 1) this.folded = foldLog(this.rows, this.opts.verify);
    else foldRowInto(this.folded, row, this.opts.verify);
    // A row that cannot be placed yet (a key cache after an identity change) must not be lost.
    if (this.opts.verify(row) === 'unknown') this.refoldPending = true;
    this.health = 'ok';
    this.snapshot();
  }

  /**
   * A damaged machine repairs itself from a peer before asking the owner (Step 2b). What was here is
   * set aside, the peer's rows and locks replace it, and this machine carries on under a new stream,
   * because it can no longer say what it wrote.
   */
  rebuildFromPeer(rows: ReadonlyArray<TeamAccessRow>): { added: number; refused: number; touched: string[] } {
    const stamp = (this.opts.now ?? Date.now)();
    // Everything that still reads is kept: a row only this machine held may be a removal.
    const salvaged = [...this.salvage(this.lastGoodLog()), ...this.salvage(this.logFile)];
    const locks = this.heldLocks();
    for (const file of [this.logFile, this.confinedFile]) {
      if (fs.existsSync(file)) fs.renameSync(file, `${file}.damaged-${stamp}`);
    }
    this.rows = []; this.folded = emptyState(); this.gapsCache = null; this.grantsCache.clear(); this.goneCache.clear(); this.refoldPending = false;
    this.seedSeq = 0;
    this.health = 'ok';
    this.mintIncarnation();
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    this.writeConfined(locks);
    return this.ingest([...salvaged, ...rows]);
  }

  /** Every lock this machine can still find. The list only ever grows, and a restore's sweep is in no row. */
  private heldLocks(): ConfinedEntry[] {
    let lastGood: ConfinedEntry[] = [];
    try {
      lastGood = (JSON.parse(fs.readFileSync(this.lastGoodConfined(), 'utf8')) as { entries?: ConfinedEntry[] }).entries ?? [];
    } catch {
      // @silent-fallback-ok — no snapshot of the list; what the rows say stands alone.
      lastGood = [];
    }
    const byRef = new Map<string, ConfinedEntry>();
    const rows = this.health === 'unreadable' ? this.salvage(this.logFile) : this.rows;
    for (const e of [...(this.readConfined() ?? []), ...lastGood, ...rows.flatMap(confinesIn), ...confinedFromRows(rows, this.opts.verify)]) {
      if (!byRef.has(e.ref) || e.personKey) byRef.set(e.ref, e);
    }
    return [...byRef.values()];
  }

  /** A damaged lock list comes back from the log and the last good copy. The log itself is left alone. */
  rebuildLocks(): void {
    const locks = this.heldLocks();
    if (fs.existsSync(this.confinedFile)) fs.renameSync(this.confinedFile, `${this.confinedFile}.damaged-${(this.opts.now ?? Date.now)()}`);
    this.writeConfined(locks);
  }

  /** Is this machine's lock list broken, or gone though rows here locked something? A new agent has none, and that is fine. */
  listDamaged(): boolean {
    if (this.readConfined() !== null) return false;
    return fs.existsSync(this.confinedFile) || this.rows.some((r) => confinesIn(r).length > 0);
  }

  /** Which stream this machine is writing now. */
  currentIncarnation(): string { return this.incarnation(); }

  /** The snapshot a rollback is judged against. Failing to take one never undoes a change. */
  private snapshot(): void {
    try { this.writeLastGood(); } catch (err) { // @silent-fallback-ok — the snapshot is a second copy; the change itself is saved
      console.warn(`[team-access] last-good not written: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private requireSigner(): MachineSigner {
    if (!this.opts.signer) throw new Error('team-access-no-identity');
    return this.opts.signer;
  }

  appendMachineEvents(events: MachineEvent[]): MachineRow {
    const signer = this.requireSigner();
    if (this.health === 'unreadable') throw new Error('team-access-unreadable');
    const base = { seq: this.nextSeq(), kind: 'machine' as const, at: new Date((this.opts.now ?? Date.now)()).toISOString(), events, ...this.chainFor(signer) };
    const row: MachineRow = { ...base, machineSig: signer.sign(rowPayload(base)) };
    this.appendLine(row);
    return row;
  }

  appendSignedRequest(req: Pick<RequestRow, 'receivedAt' | 'signedOrigin' | 'receipt'>): RequestRow {
    const signer = this.requireSigner();
    const base = { seq: this.nextSeq(), kind: 'request' as const, ...req, ...this.chainFor(signer) };
    const row: RequestRow = { ...base, machineSig: signer.sign(rowPayload(base)) };
    if (this.health === 'unreadable') throw new Error('team-access-unreadable');
    // A row the fold would ignore must never answer ok: the change would not have happened.
    if (this.opts.verify(row) !== 'verified') throw new Error('team-access-row-refused');
    this.appendLine(row);
    return row;
  }

  // ── Grant lookups ───────────────────────────────────────────────────────

  grantOf(personKey: string, ref: string): GrantAccess | null {
    const access = this.folded.grants.get(personKey)?.get(ref);
    return isGrantAccessEvent(access) ? access : null;
  }

  ownerOf(ref: string): string | null { return this.folded.owned.get(ref) ?? null; }

  // ── The confined list ──────────────────────────────────────────────────

  /** null means it could not be read: the caller refuses. Empty means none. */
  readConfined(): ConfinedEntry[] | null {
    try {
      const raw = JSON.parse(fs.readFileSync(this.confinedFile, 'utf8')) as { entries?: unknown };
      if (!Array.isArray(raw.entries)) return null;
      return raw.entries.filter((e): e is ConfinedEntry => !!e && typeof (e as ConfinedEntry).ref === 'string');
    } catch (err) { // @silent-fallback-ok — null means unreadable, and every caller refuses on it
      // Missing is empty only on an agent that shows no team use here. Callers add the signs they hold.
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return this.health === 'absent' && !this.hasLastGoodTeamOn() ? [] : null;
      return null;
    }
  }

  private writeConfined(entries: ConfinedEntry[]): void {
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const tmp = `${this.confinedFile}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    const fd = fs.openSync(tmp, 'w', 0o600);
    try {
      fs.writeSync(fd, JSON.stringify({ entries }));
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, this.confinedFile);
  }

  /** Before the first `team-on`, so an invite with no grants does not read as a missing file. */
  ensureConfinedFile(): void {
    if (!fs.existsSync(this.confinedFile)) this.writeConfined([]);
  }

  /** Add a conversation, keeping its first audience: it is fixed for good. Throws if the list cannot be read. */
  confine(entry: ConfinedEntry): void {
    if (!this.confineHere(entry)) return;
    // Told to every machine. A restore's sweep writes the file directly and stays local.
    if (this.opts.signer && this.health !== 'unreadable') {
      this.appendMachineEvents([{ type: 'confine', ref: entry.ref, ...(entry.placeKey ? { placeKey: entry.placeKey } : {}), ...(entry.personKey ? { personKey: entry.personKey } : {}) }]);
    }
  }

  /**
   * Add to this machine's list. Confining is always the safe direction, so this happens before a row
   * is folded. If an owned and a shared entry meet for one conversation, the owned one wins, whichever
   * arrived first, so every machine ends with the same audience. Returns whether anything changed.
   */
  private confineHere(entry: ConfinedEntry): boolean {
    const entries = this.readConfined();
    if (!entries) throw new Error('team-access-confined-unreadable');
    const held = entries.find((e) => e.ref === entry.ref);
    if (held && (held.personKey || !entry.personKey)) return false;
    this.writeConfined([...entries.filter((e) => e.ref !== entry.ref), entry]);
    this.snapshot();
    return true;
  }

  /** Writes a `confine` row for every entry a 2a build confined, once. */
  backfillConfineRows(): number {
    if (!this.opts.signer || this.health !== 'ok') return 0;
    // Once, for what 2a confined. A later restore's sweep stays on this machine, and a boot must not tell it.
    const marker = path.join(this.dir, 'confine-told.json');
    if (fs.existsSync(marker)) return 0;
    const told = new Set(this.rows.flatMap((r) => (r.kind === 'machine' ? r.events.flatMap((e) => (e.type === 'confine' ? [e.ref] : [])) : [])));
    const missing = (this.readConfined() ?? []).filter((e) => !told.has(e.ref));
    for (const e of missing) {
      this.appendMachineEvents([{ type: 'confine', ref: e.ref, ...(e.placeKey ? { placeKey: e.placeKey } : {}), ...(e.personKey ? { personKey: e.personKey } : {}) }]);
    }
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(marker, '{}', { mode: 0o600 });
    return missing.length;
  }

  isConfined(ref: string): boolean | null {
    const entries = this.readConfined();
    return entries ? entries.some((e) => e.ref === ref) : null;
  }

  /** After a clean boot, kept outside the access folder. */
  writeLastGood(): void {
    if (this.health !== 'ok') return;
    const entries = this.readConfined();
    if (!entries) return;
    fs.mkdirSync(this.lastGoodDir, { recursive: true, mode: 0o700 });
    fs.copyFileSync(this.logFile, this.lastGoodLog());
    fs.writeFileSync(this.lastGoodConfined(), JSON.stringify({ entries }), { mode: 0o600 });
    this.seedSeq = this.folded.highestSeq;
  }

  /** Was this agent ever in team use, by what survives here? */
  hasLastGoodTeamOn(): boolean {
    try {
      const rows = this.parseLines(fs.readFileSync(this.lastGoodLog(), 'utf8'));
      return !!rows && foldRows(rows, this.opts.verify).on;
    } catch {
      // @silent-fallback-ok — no last-good is no evidence; other signs are checked by the caller.
      return false;
    }
  }

  /**
   * The owner's restore: every parseable row of the log and last-good, merged, and the confined list
   * rebuilt from what remains, what the log shows, and `teamRefs` (conversations with stored team-phone
   * messages). With no list left and a visibly damaged log, `allRefs` is confined too: a read-only
   * grantee leaves no message behind. A lost final row leaves no gap, so that one case cannot be seen.
   */
  /** Every row that still parses in a file, keeping nothing unreadable. */
  private salvage(file: string): TeamAccessRow[] {
    let raw = '';
    try { raw = fs.readFileSync(file, 'utf8'); } catch {
      // @silent-fallback-ok — a missing file contributes no rows.
      return [];
    }
    return raw.split('\n').flatMap((line) => {
      if (!line.trim()) return [];
      try {
        return this.parseLines(line) ?? [];
      } catch {
        // @silent-fallback-ok — keeps every row that still parses.
        return [];
      }
    });
  }

  restore(input: { teamRefs: ConfinedEntry[]; allRefs: () => ConfinedEntry[] }): { logLost: boolean; listLost: boolean } {
    const wasUnreadable = this.health === 'unreadable';
    const live = this.salvage(this.logFile);
    const logLost = live.length === 0;
    const byRow = new Map<string, TeamAccessRow>();
    for (const r of [...this.salvage(this.lastGoodLog()), ...live]) byRow.set(`${streamOf(r)}#${r.seq}#${rowHash(r)}`, r);
    const merged = [...byRow.values()].sort(rowOrder);

    const current = fs.existsSync(this.confinedFile) ? this.readConfined() : null;
    const listLost = current === null;
    let lastGood: ConfinedEntry[] = [];
    try {
      lastGood = (JSON.parse(fs.readFileSync(this.lastGoodConfined(), 'utf8')) as { entries?: ConfinedEntry[] }).entries ?? [];
    } catch {
      // @silent-fallback-ok — no snapshot of the list; the rebuild below stands alone.
      lastGood = [];
    }
    const byRef = new Map<string, ConfinedEntry>();
    // The log says what was ever shared or owned, even where nothing was said there: a read-only grant
    // leaves no message, so a list rebuilt from messages alone would drop it.
    const fromLog = confinedFromRows(merged, this.opts.verify);
    // With no list left and a log visibly damaged, nothing may be released: every conversation is
    // confined. A surviving log with no gap is taken at its word, since it holds every grant.
    const multi = new Set(merged.map(originOf)).size > 1;
    const damaged = logLost || wasUnreadable || merged.some((r, i) => (!multi && r.seq !== i + 1) || this.opts.verify(r) !== 'verified') || (multi && gapsIn(merged, this.opts.verify).length > 0);
    const noList = listLost && lastGood.length === 0;
    const sources = [...(current ?? []), ...lastGood, ...fromLog, ...input.teamRefs, ...(noList && damaged ? input.allRefs() : [])];
    for (const e of sources) if (!byRef.has(e.ref)) byRef.set(e.ref, e);

    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    this.writeConfined([...byRef.values()]);
    const tmp = `${this.logFile}.restore`;
    const fd = fs.openSync(tmp, 'w', 0o600);
    try {
      for (const r of merged) fs.writeSync(fd, `${JSON.stringify(r)}\n`);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, this.logFile);
    this.rows = merged;
    this.gapsCache = null; this.grantsCache.clear(); this.goneCache.clear();
    this.folded = foldLog(merged, this.opts.verify);
    this.seedSeq = Math.max(this.seedSeq, this.folded.highestSeq);
    this.health = 'ok';
    // A repaired log is a new stream, so a row written here cannot collide with one a peer holds.
    this.mintIncarnation();
    // Recorded, or the gap a repair accepted would read as damage again at the next boot.
    if (this.opts.signer) this.appendMachineEvents([{ type: 'restored', throughSeq: this.folded.highestSeq }]);
    return { logLost, listLost };
  }
}
