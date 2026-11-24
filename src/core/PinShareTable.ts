/**
 * PinShareTable — SEC-170 part 2 of 2 (docs/specs/pool-wide-pin-budget.md §4): the pure decision
 * logic of the agreement protocol. No I/O; PinShare.ts drives it.
 *
 * The rule the whole file serves: a machine may LOWER its own share at any moment, alone; it RAISES
 * only on a table every listed machine has acknowledged, after one more window.
 *
 * Implementation shape (equivalent to spec §4, simpler data):
 *  - A table is `{ seq, members, hash }`; its shares are always the canonical division of its members,
 *    so a table carries nothing a proposer could bend. It is valid for a receiver only if its members
 *    equal the receiver's own registry members and its seq is at least the highest valid seq seen.
 *  - A hand-down is a bilateral loan, not part of any table: it comes out of the giver's own applied
 *    share, which the giver lowers durably before sending. No third machine's share depends on it, so
 *    a forged hand-down cannot lower anyone (the spec's giver-signature rule guards exactly that).
 *  - A hand-down is absorbed by the first fully acknowledged table, newer than the one it was made
 *    under, that lists the recipient: from then on both sides count only their table entries.
 */

import { canonicalShares, membershipHash, AGENT_PIN_BUDGET } from './PinShare.js';

export interface PinTable {
  seq: number;
  members: string[];
  hash: string;
}

export interface HandDownGiven {
  transferId: string;
  to: string;
  amount: number;
  /** seq of the newest valid table the giver held when it gave. */
  baseSeq: number;
}

export interface HandDownReceived {
  transferId: string;
  from: string;
  amount: number;
  baseSeq: number;
}

/** What a peer reports about itself (signed by that peer; verified by the caller before use). */
export interface PeerShareReport {
  machineId: string;
  /** The newest valid table this peer applies, or null if it has none yet. */
  table: PinTable | null;
  applied: number;
  /** True when the peer has learned of its own retirement and holds share 0. */
  retired: boolean;
  /** True when the peer is at 0 for lack of records or as a newcomer, and wants a hand-down. */
  needsShare: boolean;
  /** The hand-down this peer currently holds (its transferId), or null. Lets a giver see its loan was taken. */
  heldTransfer?: string | null;
}

/** Far above any real pool's changes; stops one report from pushing seq past the safe-integer range. */
export const MAX_TABLE_SEQ = 2 ** 40;

export function makeTable(seq: number, members: readonly string[]): PinTable {
  const m = [...new Set(members)].sort();
  return { seq, members: m, hash: membershipHash(m) };
}

export function sameTable(a: PinTable | null, b: PinTable | null): boolean {
  return !!a && !!b && a.seq === b.seq && a.hash === b.hash;
}

/** Ordering: seq, then hash. Positive when a is newer than b. */
export function compareTables(a: PinTable, b: PinTable): number {
  if (a.seq !== b.seq) return a.seq - b.seq;
  return a.hash < b.hash ? -1 : a.hash > b.hash ? 1 : 0;
}

export function entryFor(t: PinTable, machineId: string): number {
  return canonicalShares(t.members)[machineId] ?? 0;
}

export type TableVerdict = { ok: true } | { ok: false; reason: string };

/**
 * Spec §4 "A table is valid only if": its members equal the receiver's registry members (so a table
 * listing only its proposer, or anyone the receiver does not know, is ignored), its hash matches,
 * its seq is a non-negative safe integer and at least the highest valid seq the receiver has seen
 * (a replayed older table is ignored). Gaps in seq are allowed.
 */
export function validateTable(t: unknown, registryMembers: readonly string[], highestSeq: number): TableVerdict {
  const x = t as PinTable;
  if (!x || typeof x !== 'object') return { ok: false, reason: 'not-a-table' };
  if (!Number.isSafeInteger(x.seq) || x.seq < 0 || x.seq > MAX_TABLE_SEQ) return { ok: false, reason: 'bad-seq' };
  if (!Array.isArray(x.members) || x.members.length === 0 || x.members.some((m) => typeof m !== 'string' || !m)) return { ok: false, reason: 'bad-members' };
  const mine = [...new Set(registryMembers)].sort();
  const theirs = [...new Set(x.members)].sort();
  if (theirs.length !== x.members.length || mine.length !== theirs.length || mine.some((m, i) => m !== theirs[i])) return { ok: false, reason: 'members-differ-from-registry' };
  if (x.hash !== membershipHash(theirs)) return { ok: false, reason: 'bad-hash' };
  if (x.seq < highestSeq) return { ok: false, reason: 'older-than-seen' };
  return { ok: true };
}

/**
 * Whether a hand-down's capacity is settled by the agreed table `agreed`: the table lists the recipient,
 * is no older than the table the loan was made under, and the recipient's own signed report confirms
 * it holds this loan or no longer needs one (so a delayed delivery can never land on top of a raise).
 * `recipient` is that report, when known. Without it, a loan stays outstanding (the strict side).
 */
export function loanSettled(g: HandDownGiven, agreed: PinTable | null, recipient: PeerShareReport | undefined): boolean {
  if (!agreed || agreed.seq < g.baseSeq || !agreed.members.includes(g.to) || !recipient) return false;
  return recipient.heldTransfer === g.transferId || (!recipient.needsShare && !recipient.retired);
}

/** Hand-downs this machine gave that are not settled (see loanSettled). */
export function outstandingGiven(given: readonly HandDownGiven[], agreed: PinTable | null, reports?: ReadonlyMap<string, PeerShareReport>): HandDownGiven[] {
  return given.filter((g) => !loanSettled(g, agreed, reports?.get(g.to)));
}

/** A recipient's own received loan is absorbed by an agreed table that lists it and is no older than the loan. */
export function absorbedBy(baseSeq: number, recipient: string, agreed: PinTable | null): boolean {
  return !!agreed && agreed.seq >= baseSeq && agreed.members.includes(recipient);
}

/**
 * Spec §4 "Seeing a new table": the lower of the applied share and this machine's entry minus every
 * hand-down it has given that is still outstanding. Never raises.
 */
export function loweredShare(applied: number, t: PinTable, self: string, given: readonly HandDownGiven[], agreed: PinTable | null, reports?: ReadonlyMap<string, PeerShareReport>): number {
  const owed = outstandingGiven(given, agreed, reports).reduce((a, g) => a + g.amount, 0);
  return Math.max(0, Math.min(applied, entryFor(t, self) - owed));
}

/**
 * Spec §4 raise target once `t` is fully acknowledged and one window has passed: the entry minus the
 * hand-downs it has not absorbed (the fence for a hand-down made while a raise was pending). A
 * recipient's own received loan is absorbed by such a table, so it counts its entry, not entry + loan.
 */
export function raiseTarget(t: PinTable, self: string, given: readonly HandDownGiven[], reports?: ReadonlyMap<string, PeerShareReport>): number {
  const owed = outstandingGiven(given, t, reports).reduce((a, g) => a + g.amount, 0);
  return Math.max(0, Math.min(AGENT_PIN_BUDGET, entryFor(t, self) - owed));
}

export interface AckContext {
  self: string;
  /** Latest verified report per peer. */
  reports: ReadonlyMap<string, PeerShareReport>;
  /** Members of the table last fully acknowledged here (to find machines retired since). */
  previousMembers: readonly string[];
  /** Owner "gone for good" confirmations, by machine id. */
  goneForGood: ReadonlySet<string>;
  /** Newest signed contact from each machine, as recorded anywhere in the pool (merged). */
  lastContact: ReadonlyMap<string, number>;
  /** Readable-everywhere flag: false when any machine's contact record could not be read. */
  contactRecordsComplete: boolean;
  now: number;
}

export const GONE_FOR_GOOD_SILENCE_MS = 7 * 24 * 60 * 60 * 1000;

/** A peer acknowledges `t` when it reports exactly `t` and holds at most its entry there. */
export function acknowledges(r: PeerShareReport | undefined, t: PinTable): boolean {
  return !!r && sameTable(r.table, t) && Number.isInteger(r.applied) && r.applied >= 0 && r.applied <= entryFor(t, r.machineId);
}

/**
 * Spec §4: the table is agreed when every member other than this machine acknowledges it, and every
 * machine retired since the previous agreed table has either acknowledged its retirement (reported
 * retired at share 0) or been confirmed gone for good by the owner AND shown no signed contact
 * anywhere for 7 days, with every machine's contact record readable.
 */
export function fullyAcknowledged(t: PinTable, ctx: AckContext): { agreed: boolean; missing: string[] } {
  const missing: string[] = [];
  for (const m of t.members) {
    if (m === ctx.self) continue;
    if (!acknowledges(ctx.reports.get(m), t)) missing.push(m);
  }
  for (const m of ctx.previousMembers) {
    if (t.members.includes(m) || m === ctx.self) continue;
    const r = ctx.reports.get(m);
    const retiredAck = !!r && r.retired && r.applied === 0;
    const last = ctx.lastContact.get(m) ?? 0;
    const gone = ctx.goneForGood.has(m) && ctx.contactRecordsComplete && ctx.now - last >= GONE_FOR_GOOD_SILENCE_MS;
    if (!retiredAck && !gone) missing.push(m);
  }
  return { agreed: missing.length === 0, missing };
}

/**
 * Spec §4 acknowledgment safety: a machine acknowledges a table only if its members equal its own
 * registry members (guaranteed by validateTable) and it lists every machine it holds an outstanding
 * hand-down to or from.
 */
export function mayAcknowledge(t: PinTable, self: string, given: readonly HandDownGiven[], received: HandDownReceived | null, agreed: PinTable | null, endedLoanRecipients: ReadonlySet<string> = new Set()): boolean {
  for (const g of outstandingGiven(given, agreed)) if (!t.members.includes(g.to) && !endedLoanRecipients.has(g.to)) return false;
  if (received && !absorbedBy(received.baseSeq, self, agreed) && !t.members.includes(received.from)) return false;
  return true;
}

/** Spec §4 hand-down: who gives to a machine at 0. The lowest-id reachable peer with a share of 2 or more. */
export function chooseGiver(candidates: ReadonlyArray<{ machineId: string; applied: number }>): string | null {
  const ok = candidates.filter((c) => c.applied >= 2).map((c) => c.machineId).sort();
  return ok[0] ?? null;
}

export function handDownAmount(giverApplied: number): number {
  return Math.floor(giverApplied / 2);
}
