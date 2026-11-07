/**
 * TeamAccessMerge — how machines agree on who has access (team-roles-and-access, "Step 2b").
 *
 * Pure and not yet wired: step 2a refuses a second machine, so nothing reaches this until 2b lifts that.
 * Every answer here depends only on the set of rows, never on the order they arrived in, because
 * two machines holding the same rows must reach the same access.
 */
import type { GrantAccess } from '../permissions/TeamAccess.js';

export type Vector = Readonly<Record<string, number>>;

export type MergeEvent =
  | { type: 'team-on' }
  | { type: 'team-off' }
  | { type: 'person-add'; personKey: string; role: string }
  | { type: 'person-set'; personKey: string; role: string }
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

const ROLE_RANK: Readonly<Record<string, number>> = { guest: 0, member: 1, admin: 2 };
const rankOf = (role: string): number => ROLE_RANK[role] ?? 0;

/** Does this event give anyone anything? Only these are void from a returning gone origin. */
function widens(e: MergeEvent): boolean {
  return e.type === 'grant' || e.type === 'person-add' || e.type === 'team-on' || e.type === 'person-set';
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
  const isVoid = (c: Change): boolean => widens(c.event)
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
    if (removed.has(key)) continue;
    const roles = current(changes).map((c) => (c.event as { role: string }).role);
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
  | { kind: 'new-incarnation'; origin: string; incarnation: string }
  /** A row this machine cannot verify yet, because the signer's key has not reached it. */
  | { kind: 'unplaced'; origin: string; incarnation: string; seq: number };

/**
 * What a machine can actually see is wrong. A row only a sleeping machine holds is none of these: it is
 * pending, and holds nobody. `firstIncarnation` says which stream of an origin was its first.
 */
export function findGaps(input: ReadonlyArray<MergeRow>, firstIncarnation: (origin: string) => string | null): Gap[] {
  const rows = canonical(input);
  const gone = rows.flatMap((r) => r.events.flatMap((e) => (e.type === 'origin-gone' ? [e] : [])));
  const gaps: Gap[] = [];
  const streams = new Map<string, MergeRow[]>();
  for (const r of rows) {
    const list = streams.get(streamOf(r)) ?? [];
    list.push(r);
    streams.set(streamOf(r), list);
  }
  for (const list of streams.values()) {
    const { origin, incarnation } = list[0];
    const named = gone.some((g) => g.machine === origin);
    const first = firstIncarnation(origin);
    // Rows from before chains are the start of an origin's history, never a lost tail.
    if (first !== null && first !== incarnation && incarnation !== UNCHAINED_INCARNATION && !named) gaps.push({ kind: 'new-incarnation', origin, incarnation });
    // The owner has settled this stream: its rows count only as `mergeRows` allows, and hold nobody.
    if (gone.some((g) => g.machine === origin && g.incarnation === incarnation)) continue;
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

export interface MessageStamp {
  /** The person who wrote it, if a person did. */
  authorKey: string | null;
  origin: string;
  incarnation: string;
  seq: number;
  /** An agent's row: what its session knew at launch. A person's row: the receiving machine's log. */
  access: Vector;
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
