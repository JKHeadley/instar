/**
 * TeamAccessMerge — how machines agree on who has access (team-roles-and-access, "Step 2b").
 *
 * Pure and not yet wired: step 2a refuses a second machine, so nothing reaches this until 2b lifts that.
 * Every answer here depends only on the set of rows, never on the order they arrived in, because
 * two machines holding the same rows must reach the same access.
 */
import { tierOfRole, type GrantAccess } from '../permissions/TeamAccess.js';
import type { OrgRole } from '../permissions/types.js';

export type Vector = Readonly<Record<string, number>>;

export type MergeEvent =
  | { type: 'team-on' }
  | { type: 'team-off' }
  | { type: 'person-add'; personKey: string; role: string }
  /** `lower` is a machine narrowing someone: it can only ever take a role down. */
  | { type: 'person-set'; personKey: string; role: string; lower?: boolean }
  | { type: 'person-remove'; personKey: string }
  | { type: 'grant'; personKey: string; ref: string; access: GrantAccess }
  | { type: 'grant-remove'; personKey: string; ref: string }
  | { type: 'origin-gone'; machine: string; incarnation: string; throughSeq: number };

export interface MergeRow {
  origin: string;
  incarnation: string;
  seq: number;
  /** The hash of this origin's previous row, or null for its first. */
  prev: string | null;
  hash: string;
  /** What the accepting machine had seen, signed with the row: origin/incarnation to highest seq. */
  seen: Vector;
  events: ReadonlyArray<MergeEvent>;
}

/** The stream name of rows written before chains existed. */
export const UNCHAINED_INCARNATION = 'v1';

export const streamKey = (origin: string, incarnation: string): string => `${origin}/${incarnation}`;
const streamOf = (r: MergeRow): string => streamKey(r.origin, r.incarnation);
const rowKey = (r: MergeRow): string => `${streamOf(r)}#${r.seq}#${r.hash}`;

/** Had `by` seen `row`? A row sees what its vector names, and what came before it in its own stream. */
export function hasSeen(by: MergeRow, row: MergeRow): boolean {
  if (streamOf(by) === streamOf(row)) return row.seq < by.seq;
  return (by.seen[streamOf(row)] ?? 0) >= row.seq;
}

/** A role's place by its tier, so operator and contributor rank as the members they are. */
export const rankOf = (role: string): number => {
  const tier = tierOfRole(role as OrgRole);
  return tier === 'guest' ? 0 : tier === 'member' ? 1 : tier === 'admin' ? 2 : 3;
};

/** What stands without the rows a gone machine wrote past its last good one. */
interface Standing { roleRank: ReadonlyMap<string, number> }

/** Does this event give anyone anything? Only these are void from a returning gone origin. */
function widens(e: MergeEvent, standing: Standing): boolean {
  if (e.type === 'person-set') return !e.lower && rankOf(e.role) > (standing.roleRank.get(e.personKey) ?? 0);
  return e.type === 'grant' || e.type === 'person-add' || e.type === 'team-on';
}

interface Change { row: MergeRow; index: number; event: MergeEvent }

/** One stable order, so a tie cannot depend on arrival. */
function canonical(rows: ReadonlyArray<MergeRow>): MergeRow[] {
  const seen = new Map<string, MergeRow>();
  for (const r of rows) seen.set(rowKey(r), r);
  return [...seen.values()].sort((a, b) => (streamOf(a) < streamOf(b) ? -1 : streamOf(a) > streamOf(b) ? 1 : a.seq - b.seq || (a.hash < b.hash ? -1 : 1)));
}

/** `earlier` is out of date if `later` knew of it: same row in order, or the later row had seen it. */
function supersedes(later: Change, earlier: Change): boolean {
  if (later.row === earlier.row) return later.index > earlier.index;
  return hasSeen(later.row, earlier.row);
}

export interface MergedAccess {
  on: boolean;
  people: Map<string, { role: string }>;
  grants: Map<string, Map<string, GrantAccess>>;
  /** Every key a person ever held and lost: nothing brings these back. */
  removed: Set<string>;
  /** Widening rows dropped because their origin was declared gone, for the owner's screen. */
  voided: string[];
}

export function mergeRows(input: ReadonlyArray<MergeRow>): MergedAccess {
  const rows = canonical(input);
  const gone: Array<Extract<MergeEvent, { type: 'origin-gone' }>> = [];
  for (const r of rows) for (const e of r.events) if (e.type === 'origin-gone') gone.push(e);
  const pastGone = (r: MergeRow): boolean => gone.some((g) => g.machine === r.origin && g.incarnation === r.incarnation && r.seq > g.throughSeq);
  const roleRank = new Map<string, number>();
  for (const r of rows) {
    if (pastGone(r)) continue;
    for (const e of r.events) {
      if (e.type === 'person-add' || e.type === 'person-set') roleRank.set(e.personKey, Math.min(roleRank.get(e.personKey) ?? Infinity, rankOf(e.role)));
    }
  }
  const isVoid = (c: Change): boolean => widens(c.event, { roleRank })
    && gone.some((g) => g.machine === c.row.origin && g.incarnation === c.row.incarnation && c.row.seq > g.throughSeq);

  const all: Change[] = rows.flatMap((row) => row.events.map((event, index) => ({ row, index, event })));
  const voided = [...new Set(all.filter(isVoid).map((c) => rowKey(c.row)))];
  // Void first: a voided change drops nothing, or a void could undo a removal.
  const live = all.filter((c) => !isVoid(c));

  const removed = new Set<string>();
  for (const c of live) if (c.event.type === 'person-remove') removed.add(c.event.personKey);
  const teamOffs = live.filter((c) => c.event.type === 'team-off');
  const teamOns = live.filter((c) => c.event.type === 'team-on');
  // A change stands past a team-off only if it knew of that team-off.
  const clearedByOff = (c: Change): boolean => teamOffs.some((off) => off !== c && !supersedes(c, off));

  const out: MergedAccess = { on: false, people: new Map(), grants: new Map(), removed, voided };
  out.on = teamOns.some((on) => !clearedByOff(on));

  const current = (changes: Change[]): Change[] => changes.filter((c) => !changes.some((d) => d !== c && supersedes(d, c)));

  const byPerson = new Map<string, Change[]>();
  for (const c of live) {
    if ((c.event.type === 'person-add' || c.event.type === 'person-set') && !clearedByOff(c)) {
      const list = byPerson.get(c.event.personKey) ?? [];
      list.push(c);
      byPerson.set(c.event.personKey, list);
    }
  }
  for (const [key, changes] of byPerson) {
    // A later change cannot bring back someone whose add was voided.
    if (removed.has(key) || !changes.some((c) => c.event.type === 'person-add')) continue;
    const lowers = changes.filter((c) => (c.event as { lower?: boolean }).lower);
    const set = changes.filter((c) => !lowers.includes(c));
    const roleOf = (c: Change): string => (c.event as { role: string }).role;
    // A lowering takes a role down from wherever it stands, until the owner sets one knowing of it.
    const roles = [...current(set).map(roleOf), ...lowers.filter((l) => !set.some((d) => supersedes(d, l))).map(roleOf)];
    out.people.set(key, { role: roles.reduce((low, r) => (rankOf(r) < rankOf(low) ? r : low)) });
  }

  const byGrant = new Map<string, Change[]>();
  for (const c of live) {
    if ((c.event.type === 'grant' || c.event.type === 'grant-remove') && !clearedByOff(c)) {
      const key = `${c.event.personKey}\u0000${c.event.ref}`;
      const list = byGrant.get(key) ?? [];
      list.push(c);
      byGrant.set(key, list);
    }
  }
  for (const [key, changes] of byGrant) {
    const [personKey, ref] = key.split('\u0000');
    if (removed.has(personKey) || !out.people.has(personKey)) continue;
    const left = current(changes);
    // Narrowest wins: a removal, then read, then use.
    if (left.some((c) => c.event.type === 'grant-remove')) continue;
    const access: GrantAccess = left.some((c) => (c.event as { access: GrantAccess }).access === 'read') ? 'read' : 'use';
    const held = out.grants.get(personKey) ?? new Map<string, GrantAccess>();
    held.set(ref, access);
    out.grants.set(personKey, held);
  }
  return out;
}

export type Gap =
  | { kind: 'chain-break'; origin: string; incarnation: string; afterSeq: number }
  | { kind: 'fork'; origin: string; incarnation: string; seq: number }
  /** Settled by naming `previous`, the stream that lost its tail, through `throughSeq`. */
  | { kind: 'new-incarnation'; origin: string; incarnation: string; previous: string; throughSeq: number }
  /** A row this machine cannot verify yet, because the signer's key has not reached it. */
  | { kind: 'unplaced'; origin: string; incarnation: string; seq: number };

/**
 * What a machine can actually see is wrong. A row only a sleeping machine holds is none of these: it is
 * pending, and holds nobody. A machine's streams follow its own numbering, so each new one proves the one
 * before lost a tail, unless the owner named that one.
 */
export function findGaps(input: ReadonlyArray<MergeRow>): Gap[] {
  const rows = canonical(input);
  const gone = rows.flatMap((r) => r.events.flatMap((e) => (e.type === 'origin-gone' ? [e] : [])));
  const gaps: Gap[] = [];
  const streams = new Map<string, MergeRow[]>();
  for (const r of rows) {
    const list = streams.get(streamOf(r)) ?? [];
    list.push(r);
    streams.set(streamOf(r), list);
  }
  const named = (origin: string, incarnation: string): boolean => gone.some((g) => g.machine === origin && g.incarnation === incarnation);
  // Rows from before chains are the start of an origin's history, never a lost tail.
  const chained = [...streams.values()].filter((l) => l[0].incarnation !== UNCHAINED_INCARNATION).sort((x, y) => x[0].seq - y[0].seq || (x[0].incarnation < y[0].incarnation ? -1 : 1));
  const lastOf = new Map<string, MergeRow[]>();
  for (const list of chained) {
    const { origin, incarnation } = list[0];
    const before = lastOf.get(origin);
    if (before && !named(origin, before[0].incarnation)) {
      gaps.push({ kind: 'new-incarnation', origin, incarnation, previous: before[0].incarnation, throughSeq: before[before.length - 1].seq });
    }
    lastOf.set(origin, list);
  }
  for (const list of streams.values()) {
    const { origin, incarnation } = list[0];
    // The owner has settled this stream: its rows count only as `mergeRows` allows, and hold nobody.
    if (named(origin, incarnation)) continue;
    let last: MergeRow | null = null;
    for (const r of list) {
      if (last && r.seq === last.seq) { gaps.push({ kind: 'fork', origin, incarnation, seq: r.seq }); continue; }
      // Rows from before chains carry no previous hash, so only their numbering can break.
      const linked = incarnation === UNCHAINED_INCARNATION || r.prev === last?.hash;
      if (last && (r.seq !== last.seq + 1 || !linked)) gaps.push({ kind: 'chain-break', origin, incarnation, afterSeq: last.seq });
      last = r;
    }
  }
  return gaps;
}

/** What a message carries so every machine can judge who may read it. */
export interface AccessStamp {
  origin: string;
  incarnation: string;
  seq: number;
  /** An agent's row: what its session knew of the log. A person's row: the receiving machine's log. */
  access: Vector;
}

export interface MessageStamp extends AccessStamp {
  /** The person who wrote it, if a person did. */
  authorKey: string | null;
}

export interface ReaderGrant {
  /** The grant's own row. */
  stream: string;
  seq: number;
  /** The message rows its machine had seen: origin/incarnation to highest message seq. */
  seenMessages: Vector;
}

/**
 * May this reader see this message? Decided only from facts that never change, so no acknowledgment
 * arriving later can narrow what was already shown. `grants` are the reader's non-void grants for
 * this conversation, and `conversation-own` counts as one.
 */
export function mayReadMessage(message: MessageStamp, readerKey: string, grants: ReadonlyArray<ReaderGrant>): boolean {
  if (message.authorKey === readerKey) return true;
  const stream = streamKey(message.origin, message.incarnation);
  return grants.some((g) => (g.seenMessages[stream] ?? 0) >= message.seq || (message.access[g.stream] ?? 0) >= g.seq);
}
