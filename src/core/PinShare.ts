/**
 * PinShare — SEC-170 part 1 of 2 (docs/specs/pool-wide-pin-budget.md §3, §4).
 *
 * The agent's unknown-browser PIN budget is 20 wrong guesses per 5 minutes for the whole agent,
 * not 20 per machine. Each machine owns a fixed share of the 20 and counts its own attempts in its
 * own PinAttemptStore; the shares sum to at most 20, so a stranger who knows every address still
 * gets at most 20 per window.
 *
 * Part 1 carries the floor of the design: the canonical division (equal, remainder one each in id
 * order), the applied share stored durably in two copies, and the rule that a machine may LOWER its
 * own share at any moment but never raises it on its own. Raises, the hand-down to a newly paired
 * machine, recovery from lost records and the owner's "gone for good" are the agreement protocol of
 * part 2 of 2; until then a retirement keeps every share where it is (the safe side).
 *
 * Membership is read from this machine's own registry: every entry that is not revoked (active or
 * pending), plus this machine. A pending pairing counts, which only lowers shares.
 */

import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { DegradationReporter } from '../monitoring/DegradationReporter.js';
import { featureEvidence } from '../monitoring/FeatureEvidenceLog.js';
import type { PinTable, HandDownGiven, HandDownReceived, PeerShareReport } from './PinShareTable.js';
import { makeTable, entryFor, validateTable, compareTables, sameTable, loweredShare, raiseTarget, fullyAcknowledged, mayAcknowledge, absorbedBy, loanSettled, chooseGiver, handDownAmount, GONE_FOR_GOOD_SILENCE_MS, MAX_TABLE_SEQ } from './PinShareTable.js';

/** The agent-wide budget (identity-security-piece1c's ratified figure for one machine). */
export const AGENT_PIN_BUDGET = 20;

/**
 * The canonical division of `total` among `memberIds`: floor(total / N) each, plus one for the first
 * (total mod N) members in sorted id order. Always sums to `total` (for N >= 1). Deterministic, so
 * every machine computing it from the same membership gets the same table.
 */
export function canonicalShares(memberIds: readonly string[], total = AGENT_PIN_BUDGET): Record<string, number> {
  const ids = [...new Set(memberIds)].sort();
  const out: Record<string, number> = {};
  if (ids.length === 0) return out;
  const base = Math.floor(total / ids.length);
  const rem = total % ids.length;
  ids.forEach((id, i) => { out[id] = base + (i < rem ? 1 : 0); });
  return out;
}

export function membershipHash(memberIds: readonly string[]): string {
  return createHash('sha256').update([...new Set(memberIds)].sort().join('\n')).digest('hex').slice(0, 32);
}

interface StoredShare {
  v: 1 | 2;
  applied: number;
  members: string[];
  hash: string;
  updatedAt: number;
  // Part 2 (agreement protocol). Absent on a version-1 record, read as empty.
  table?: PinTable | null;
  agreed?: PinTable | null;
  given?: HandDownGiven[];
  received?: HandDownReceived | null;
  retired?: boolean;
  needsShare?: boolean;
  /** Wall-clock time a hand-down was received; the admit wait restarts in full after a restart. */
  receivedAt?: number | null;
}

export interface PinShareDeps {
  stateDir: string;
  /** Live `security.pinBudget.poolWide` (dev-gated, file-only). */
  enabled: () => boolean;
  /** This machine's id and the ids of every registry entry that is not revoked. Null = unknown. */
  membership: () => { self: string; members: string[]; selfRevoked?: boolean } | null;
  now?: () => number;
  /**
   * Part 2 of 2: the agreement protocol's inputs. Absent = part-1 behaviour (lower only, first table
   * from the registry). The poller (pinBudgetPoller.ts) supplies verified peer reports.
   */
  protocol?: PinShareProtocolDeps;
}

export interface PinShareProtocolDeps {
  /** Latest verified report from each peer (signed by that peer). */
  reports: () => ReadonlyMap<string, PeerShareReport>;
  /** True once one poll round has completed (answered or timed out) since boot. */
  pollReady: () => boolean;
  /** Owner "gone for good" confirmations. */
  goneForGood: () => ReadonlySet<string>;
  /** Newest signed contact per machine, merged across the pool; complete = every member's record read. */
  contacts: () => { map: ReadonlyMap<string, number>; complete: boolean };
  /** Monotonic clock (ms) for the waits. */
  monoNow: () => number;
  /** Deliver a hand-down this machine has already durably given (best effort; failure keeps the giver lowered). */
  sendHandDown: (to: string, gift: HandDownGiven) => void;
}

export interface PinShareState {
  enabled: boolean;
  share: number;
  members: number;
  /** 'off' | 'never-paired' | 'applied' | 'unknown-membership' | 'records-lost' | 'deciding' | 'newcomer' | 'retired' | 'admit-wait' */
  basis: string;
}

const RECOMPUTE_MS = 5_000;
/** Spec §4: one window between full agreement (or a hand-down) and using the new share. */
export const RAISE_WAIT_MS = 5 * 60 * 1000;

export class PinShareProvider {
  private readonly file: string;
  private readonly prevFile: string;
  private readonly now: () => number;
  private stored: StoredShare | null = null;
  /** Both copies existed but neither could be read: share 0 until part 2's recovery (spec §4). */
  private recordsLost = false;
  private loaded = false;
  private cache: { at: number; state: PinShareState } | null = null;
  private persistFailureReported = false;
  private selfId: string | null = null;
  private pendingRaise: { table: PinTable; since: number } | null = null;
  /** Monotonic time before which a received hand-down admits no one (restart restarts the wait). */
  private admitFromMono: number | null = null;

  constructor(private readonly deps: PinShareDeps) {
    const dir = path.join(deps.stateDir, 'state');
    this.file = path.join(dir, 'pin-share.json');
    this.prevFile = path.join(dir, 'pin-share.prev.json');
    this.now = deps.now ?? (() => Date.now());
  }

  /** The unknown-browser cap this machine enforces right now. 20 when the switch is off. */
  share(): number {
    return this.state().share;
  }

  state(): PinShareState {
    const now = this.now();
    if (this.cache && now - this.cache.at < RECOMPUTE_MS) return this.cache.state;
    const state = this.compute();
    this.cache = { at: now, state };
    return state;
  }

  /** Drop the short cache (tests, and a registry change the caller knows about). */
  invalidate(): void { this.cache = null; }

  private compute(): PinShareState {
    let enabled = false;
    try { enabled = this.deps.enabled(); } catch { enabled = false; } // @silent-fallback-ok — an unreadable switch is off, which is today's per-machine 20
    if (!enabled) return { enabled: false, share: AGENT_PIN_BUDGET, members: 1, basis: 'off' };
    this.ensureLoaded();

    let m: { self: string; members: string[]; selfRevoked?: boolean } | null = null;
    try { m = this.deps.membership(); } catch { m = null; } // @silent-fallback-ok — handled as unknown membership below, which never raises
    if (m?.self) this.selfId = m.self;

    // Spec §4 "A retirement": a machine that learns of its own retirement writes 0, then reports it.
    if (m?.selfRevoked) {
      if (!this.stored || this.stored.applied !== 0 || !this.stored.retired) this.write({ ...this.base(), applied: 0, retired: true, needsShare: false });
      return { enabled: true, share: 0, members: this.stored?.members.length ?? 0, basis: 'retired' };
    }
    if (this.stored?.retired && m && !m.selfRevoked) {
      // Re-added under the same id: start over like a machine with lost records (0, ask for a hand-down).
      this.write({ ...this.base(), applied: 0, retired: false, needsShare: true, table: null, agreed: null, given: [], received: null });
    }
    if (this.recordsLost && !this.deps.protocol) return { enabled: true, share: 0, members: this.stored?.members.length ?? 0, basis: 'records-lost' };
    if (!m || !m.self) {
      // Unknown membership never raises: keep the stored share, or refuse if there is none.
      return { enabled: true, share: this.stored ? this.stored.applied : 0, members: this.stored?.members.length ?? 0, basis: 'unknown-membership' };
    }
    const members = [...new Set([...m.members, m.self])].sort();
    return this.deps.protocol ? this.computeProtocol(m.self, members, this.deps.protocol) : this.computeLowerOnly(m.self, members);
  }

  /** Part-1 behaviour (no protocol wired): first table from the registry, then lower only. */
  private computeLowerOnly(self: string, members: string[]): PinShareState {
    const entry = canonicalShares(members)[self] ?? 0;
    if (!this.stored) {
      // First table on this machine (spec §6 "Turning it on"): take the lower of 20 and its entry.
      const applied = Math.min(AGENT_PIN_BUDGET, entry);
      this.write({ v: 2, applied, members, hash: membershipHash(members), updatedAt: this.now() });
      return { enabled: true, share: applied, members: members.length, basis: members.length === 1 ? 'never-paired' : 'applied' };
    }
    if (entry < this.stored.applied) {
      // Lowering needs no agreement and applies at once (spec §4 "Seeing a new table").
      this.write({ ...this.base(), applied: entry, members, hash: membershipHash(members) });
    }
    const share = this.stored.applied;
    return { enabled: true, share, members: members.length, basis: members.length === 1 && share === AGENT_PIN_BUDGET ? 'never-paired' : 'applied' };
  }

  /** Part 2 of 2: the agreement protocol (spec §4). */
  private computeProtocol(self: string, members: string[], p: PinShareProtocolDeps): PinShareState {
    const reports = p.reports();
    const mono = p.monoNow();

    // First decision on this machine: newcomer or founding member (spec §6; plan "newcomer detection").
    if (!this.stored || this.recordsLost) {
      if (!p.pollReady()) return { enabled: true, share: 0, members: members.length, basis: 'deciding' };
      const anyTable = [...reports.values()].some((r) => r.table);
      // Founding member only if EVERY other registry machine answered (fresh) and each either has no
      // table yet (it is deciding too) or lists this machine and holds no more than its entry there.
      // Anything else (an unreachable peer, a lagging registry, a table without this machine) means
      // this machine is new: it starts at 0 and takes a hand-down (conserved), never a fresh entry.
      const peersOk = members.filter((mm) => mm !== self).every((mm) => {
        const r = reports.get(mm);
        if (!r) return false;
        if (!r.table) return r.applied === 0;
        // The peer's table must cover exactly this machine's registry: a lagging registry here (or there)
        // means the shares would be computed over different machine counts.
        const same = r.table.members.length === members.length && r.table.members.every((x) => members.includes(x));
        return same && r.applied <= entryFor(r.table, mm);
      });
      const foreign = !peersOk;
      if (members.length === 1 && !anyTable) {
        this.recordsLost = false;
        this.write({ v: 2, applied: AGENT_PIN_BUDGET, members, hash: membershipHash(members), updatedAt: this.now(), table: makeTable(0, members), agreed: makeTable(0, members) });
        return { enabled: true, share: AGENT_PIN_BUDGET, members: 1, basis: 'never-paired' };
      }
      if (foreign || this.recordsLost) {
        // A newcomer, or a machine that lost its records: share 0 until a hand-down arrives or a new
        // table is fully acknowledged. Old certificates never restore capacity (spec §4).
        this.recordsLost = false;
        this.write({ v: 2, applied: 0, members, hash: membershipHash(members), updatedAt: this.now(), table: null, needsShare: true });
      } else {
        const t = makeTable(this.highestSeq(reports), members);
        // The founding table is the starting point for later agreement, so a machine retired after it
        // is still checked (spec §4 "A retirement").
        this.write({ v: 2, applied: Math.min(AGENT_PIN_BUDGET, entryFor(t, self)), members, hash: t.hash, updatedAt: this.now(), table: t, agreed: t });
      }
    }
    const st = this.stored!;
    let table = st.table ?? null;
    const given = st.given ?? [];
    const agreed = st.agreed ?? null;

    // Adopt the newest valid table: one from a peer, or propose one when the registry has moved on.
    let best: PinTable | null = table && validateTable(table, members, 0).ok ? table : null;
    for (const r of reports.values()) {
      if (r.table && validateTable(r.table, members, best?.seq ?? 0).ok && (!best || compareTables(r.table, best) > 0)) best = r.table;
    }
    if (!best) best = makeTable(this.highestSeq(reports) + 1, members);
    if (!sameTable(best, table)) {
      table = best;
      const lowered = st.needsShare && st.applied === 0 ? 0 : loweredShare(st.applied, table, self, given, agreed, reports);
      this.write({ ...this.base(), table, members, hash: table.hash, applied: lowered });
      this.pendingRaise = null;
    } else {
      const lowered = loweredShare(st.applied, table!, self, given, agreed, reports);
      if (lowered < st.applied) this.write({ ...this.base(), applied: lowered });
    }

    // Raise: every listed machine acknowledges this table (and any retired since the last agreed one
    // is settled), then one window passes on the monotonic clock (spec §4).
    const contacts = p.contacts();
    // A loan ends when its recipient's retirement is complete (spec §4 "A transfer ends"); its capacity
    // then comes back only through the raise rule.
    const ended = this.endedLoanRecipients(members, reports, p.goneForGood(), contacts);
    if (ended.size && given.some((g) => ended.has(g.to))) this.write({ ...this.base(), given: given.filter((g) => !ended.has(g.to)) });
    const liveGiven = this.stored!.given ?? [];
    if (table && !sameTable(table, agreed) && mayAcknowledge(table, self, liveGiven, this.stored!.received ?? null, agreed, ended)) {
      const ack = fullyAcknowledged(table, {
        self, reports, previousMembers: agreed?.members ?? table.members, goneForGood: p.goneForGood(),
        lastContact: contacts.map, contactRecordsComplete: contacts.complete, now: this.now(),
      });
      if (ack.agreed) {
        if (!this.pendingRaise || !sameTable(this.pendingRaise.table, table)) this.pendingRaise = { table, since: mono };
        else if (mono - this.pendingRaise.since >= RAISE_WAIT_MS) {
          const target = raiseTarget(table, self, liveGiven, reports);
          const keepGiven = liveGiven.filter((g) => !loanSettled(g, table, reports.get(g.to)));
          const rec = this.stored!.received ?? null;
          const keepRec = rec && absorbedBy(rec.baseSeq, self, table) ? null : rec;
          this.write({ ...this.base(), applied: Math.max(this.stored!.applied, target), agreed: table, given: keepGiven, received: keepRec, needsShare: false, receivedAt: keepRec ? this.stored!.receivedAt : null });
          this.pendingRaise = null;
        }
      } else if (this.pendingRaise) {
        this.pendingRaise = null;
      }
    }

    // Give a hand-down to a peer at 0 that asked, if this machine is the chosen giver (spec §4).
    this.maybeGive(self, reports, p);

    // Spec §9 graduation check, second part: the applied shares, read across every member, never sum
    // above 20. Measured only when settled (every member reports this agreed table, no hand-down in
    // flight), so a report pulled a moment before a peer lowered never reads as a breach.
    const settled = this.stored!.table && sameTable(this.stored!.table, this.stored!.agreed ?? null)
      && !(this.stored!.given ?? []).length && !this.stored!.received
      && members.every((mm) => mm === self || (reports.has(mm) && sameTable(reports.get(mm)!.table, this.stored!.table ?? null) && !reports.get(mm)!.needsShare));
    if (settled) {
      const total = this.stored!.applied + members.filter((mm) => mm !== self).reduce((a, mm) => a + (reports.get(mm)?.applied ?? 0), 0);
      if (total > AGENT_PIN_BUDGET) {
        featureEvidence.recordAtMostEvery('pinBudgetPoolWide', 'bound-breach', 10 * 60_000, { kind: 'error', reason: 'applied PIN shares across machines sum above 20', context: { total, members: members.length } });
      }
    }

    const s2 = this.stored!;
    if (s2.received && this.admitFromMono !== null && mono < this.admitFromMono) {
      return { enabled: true, share: 0, members: members.length, basis: 'admit-wait' };
    }
    return { enabled: true, share: s2.applied, members: members.length, basis: s2.needsShare ? 'newcomer' : (members.length === 1 ? 'never-paired' : 'applied') };
  }

  private maybeGive(self: string, reports: ReadonlyMap<string, PeerShareReport>, p: PinShareProtocolDeps): void {
    const st = this.stored!;
    const table = st.table ?? null;
    for (const r of reports.values()) {
      if (!r.needsShare || r.applied !== 0 || r.retired) continue;
      if ((st.given ?? []).some((g) => g.to === r.machineId)) continue;
      const candidates = [{ machineId: self, applied: st.applied }, ...[...reports.values()].filter((x) => x.machineId !== r.machineId && !x.retired).map((x) => ({ machineId: x.machineId, applied: x.applied }))];
      if (chooseGiver(candidates) !== self) continue;
      const amount = handDownAmount(st.applied);
      if (amount < 1) continue;
      const gift: HandDownGiven = { transferId: randomUUID(), to: r.machineId, amount, baseSeq: table?.seq ?? 0 };
      // Durably lower first, then send, and send only if the lowering reached the disk: a restart must
      // never bring the old share back while the recipient holds the loan. A lost send keeps the giver lowered.
      if (!this.write({ ...this.base(), applied: st.applied - amount, given: [...(st.given ?? []), gift] })) return;
      try { p.sendHandDown(r.machineId, gift); } catch { /* @silent-fallback-ok — the giver stays lowered; the next agreed table absorbs the loan */ }
      return; // one hand-down per decision pass
    }
  }

  /**
   * Accept a hand-down from a pool machine (authenticated by the caller's route). Only a machine at 0
   * that asked for one takes it; it admits after one window, restarted in full after a restart.
   */
  receiveHandDown(from: string, gift: { transferId: string; amount: number; baseSeq: number }): { accepted: boolean; reason?: string } {
    this.ensureLoaded();
    const st = this.stored;
    if (!st || !st.needsShare || st.applied !== 0 || st.retired) return { accepted: false, reason: 'not-needed' };
    if (!Number.isInteger(gift.amount) || gift.amount < 1 || gift.amount > AGENT_PIN_BUDGET || typeof gift.transferId !== 'string' || !gift.transferId) return { accepted: false, reason: 'bad-gift' };
    // A loan made under a table older than one already agreed here is stale: refuse it (the agreed
    // table's raise covers this machine). Never take more than this machine's entry in its table.
    if (st.agreed && Number.isSafeInteger(gift.baseSeq) && gift.baseSeq < st.agreed.seq) return { accepted: false, reason: 'stale-gift' };
    const cap = st.table && this.selfId ? entryFor(st.table, this.selfId) : gift.amount;
    const amount = Math.min(gift.amount, cap);
    if (amount < 1) return { accepted: false, reason: 'no-entry' };
    const received: HandDownReceived = { transferId: gift.transferId, from, amount, baseSeq: Number.isSafeInteger(gift.baseSeq) ? gift.baseSeq : 0 };
    if (!this.write({ ...this.base(), applied: amount, received, receivedAt: this.now() })) return { accepted: false, reason: 'not-saved' };
    this.admitFromMono = (this.deps.protocol?.monoNow() ?? 0) + RAISE_WAIT_MS;
    this.cache = null;
    return { accepted: true };
  }

  /** What this machine reports to its peers (the poller signs it). */
  report(): PeerShareReport | null {
    const st = this.state();
    if (!st.enabled || !this.selfId) return null;
    const s = this.stored;
    return { machineId: this.selfId, table: s?.table ?? null, applied: st.basis === 'admit-wait' ? 0 : (s?.applied ?? 0), retired: !!s?.retired, needsShare: !!s?.needsShare, heldTransfer: s?.received?.transferId ?? null };
  }

  /** Recipients of my loans that are no longer members and whose retirement is complete (spec §4). */
  private endedLoanRecipients(members: string[], reports: ReadonlyMap<string, PeerShareReport>, gone: ReadonlySet<string>, contacts: { map: ReadonlyMap<string, number>; complete: boolean }): Set<string> {
    const out = new Set<string>();
    for (const g of this.stored?.given ?? []) {
      if (members.includes(g.to)) continue;
      const r = reports.get(g.to);
      const last = contacts.map.get(g.to) ?? 0;
      if ((r && r.retired && r.applied === 0) || (gone.has(g.to) && contacts.complete && this.now() - last >= GONE_FOR_GOOD_SILENCE_MS)) out.add(g.to);
    }
    return out;
  }

  private highestSeq(reports: ReadonlyMap<string, PeerShareReport>): number {
    let h = this.stored?.table?.seq ?? 0;
    for (const r of reports.values()) if (r.table && Number.isSafeInteger(r.table.seq) && r.table.seq <= MAX_TABLE_SEQ && r.table.seq > h) h = r.table.seq;
    return h;
  }

  private base(): StoredShare {
    const s = this.stored;
    return { v: 2, applied: s?.applied ?? 0, members: s?.members ?? [], hash: s?.hash ?? '', updatedAt: this.now(),
      table: s?.table ?? null, agreed: s?.agreed ?? null, given: s?.given ?? [], received: s?.received ?? null,
      retired: s?.retired ?? false, needsShare: s?.needsShare ?? false, receivedAt: s?.receivedAt ?? null };
  }

  private ensureLoaded(): void {
    if (this.loaded) return;
    this.loaded = true;
    const primary = this.read(this.file);
    if (primary.value) { this.stored = primary.value; this.restartWaits(); return; }
    const prev = this.read(this.prevFile);
    if (prev.value) {
      this.stored = prev.value;
      this.write(prev.value); // repair the primary copy from the second one
      this.restartWaits();
      return;
    }
    if (primary.existed || prev.existed) {
      this.recordsLost = true;
      DegradationReporter.getInstance().report({ feature: 'PinBudget.recordsLost',
        primary: 'This machine\'s share of the agent\'s PIN guess limit is read from its own records',
        fallback: 'Both copies of the record are damaged, so this machine refuses PIN sign-in from new browsers',
        reason: `pin-share records unreadable (${primary.reason ?? 'missing'}; ${prev.reason ?? 'missing'})`,
        impact: 'New browsers cannot sign in with the PIN on this computer until its share is restored. Browsers that signed in before, the phone and this computer itself still work.' });
    }
    // Neither copy ever existed: the first table is written on first use (compute()).
  }

  /** A wait in progress at a restart starts again in full from boot (spec §4 "Waits use a clock that cannot be set"). */
  private restartWaits(): void {
    if (this.stored?.received && this.deps.protocol) this.admitFromMono = this.deps.protocol.monoNow() + RAISE_WAIT_MS;
  }

  private read(file: string): { value: StoredShare | null; existed: boolean; reason?: string } {
    let text: string;
    try { text = fs.readFileSync(file, 'utf-8'); } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      return { value: null, existed: code !== 'ENOENT', reason: code ?? 'unreadable' };
    }
    try {
      const raw = JSON.parse(text) as StoredShare;
      if (!raw || (raw.v !== 1 && raw.v !== 2) || !Number.isInteger(raw.applied) || raw.applied < 0 || raw.applied > AGENT_PIN_BUDGET
        || !Array.isArray(raw.members) || raw.members.some((x) => typeof x !== 'string')) throw new Error('invalid');
      return { value: raw, existed: true };
    } catch {
      return { value: null, existed: true, reason: 'corrupt' };
    }
  }

  /**
   * Durable write of both copies (temporary file, flush, rename, flush the folder). The new value is
   * applied in memory even if the write fails: every write here lowers or first-sets the share, and
   * a lower share is the safe side. A failure is reported once per episode.
   */
  private write(value: StoredShare): boolean {
    this.stored = value;
    try {
      for (const f of [this.file, this.prevFile]) writeDurable(f, JSON.stringify(value));
      this.persistFailureReported = false;
      return true;
    } catch (err) {
      if (!this.persistFailureReported) {
        this.persistFailureReported = true;
        DegradationReporter.getInstance().report({ feature: 'PinBudget.persist',
          primary: 'This machine\'s share of the PIN guess limit is saved to disk',
          fallback: 'The lower share is enforced in memory',
          reason: err instanceof Error ? err.message : String(err),
          impact: 'None now. A restart before the next successful save could bring back the previous, larger share on this computer.' });
      }
      return false;
    }
  }
}

/** Write a small file so it survives a crash or power loss: temp file, fsync, rename, fsync the folder. */
export function writeDurable(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  const fd = fs.openSync(tmp, 'w', 0o600);
  try {
    fs.writeSync(fd, text);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
  try {
    const dfd = fs.openSync(path.dirname(file), 'r');
    try { fs.fsyncSync(dfd); } finally { fs.closeSync(dfd); }
  } catch { /* @silent-fallback-ok — some filesystems refuse a directory fsync; the rename itself has landed */ }
}

/** Reads `security.pinBudget.poolWide` live from the settings file (dev-gated, file-only). */
export function pinBudgetPoolWideReader(projectDir: string, resolve: (v: boolean | undefined, cfg: never) => boolean): () => boolean {
  const configPath = path.join(projectDir, '.instar', 'config.json');
  let cached: { at: number; value: boolean } | null = null;
  return () => {
    const now = Date.now();
    if (cached && now - cached.at < RECOMPUTE_MS) return cached.value;
    let value = false;
    try {
      const cfg = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as { security?: { pinBudget?: { poolWide?: boolean } } };
      value = resolve(cfg.security?.pinBudget?.poolWide, cfg as never);
    } catch {
      // @silent-fallback-ok — an unreadable file keeps the last known value (off before the first read).
      value = cached?.value ?? false;
    }
    cached = { at: now, value };
    return value;
  };
}

/**
 * Membership from this machine's own registry: itself plus every entry that is not revoked. No
 * machine identity, or no registry, means this machine has never been paired (it keeps 20).
 */
export function registryMembership(identity: {
  hasIdentity(): boolean;
  loadIdentity(): { machineId: string };
  loadRegistry(): { machines: Record<string, { status?: string; revokedAt?: string | null }> };
}): () => { self: string; members: string[]; selfRevoked?: boolean } | null {
  return () => {
    if (!identity.hasIdentity()) return { self: 'never-paired', members: [] };
    const self = identity.loadIdentity().machineId;
    let machines: Record<string, { status?: string; revokedAt?: string | null }> = {};
    try { machines = identity.loadRegistry().machines ?? {}; } catch { return null; } // @silent-fallback-ok — unreadable registry is unknown membership, which never raises
    const members = Object.entries(machines)
      .filter(([, e]) => e && e.status !== 'revoked' && !e.revokedAt)
      .map(([id]) => id);
    const own = machines[self];
    const selfRevoked = !!own && (own.status === 'revoked' || !!own.revokedAt);
    return selfRevoked ? { self, members, selfRevoked } : { self, members };
  };
}

/**
 * The owner's "gone for good" confirmations (spec §4), one machine id per entry in
 * `<stateDir>/state/pin-gone-for-good.json`. Written only by the owner's phone action; an unreadable
 * file counts as no confirmations (the raise keeps waiting).
 */
export function readGoneForGood(stateDir: string): ReadonlySet<string> {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(stateDir, 'state', 'pin-gone-for-good.json'), 'utf-8')) as { machines?: unknown };
    return new Set(Array.isArray(raw.machines) ? raw.machines.filter((m): m is string => typeof m === 'string') : []);
  } catch {
    return new Set(); // @silent-fallback-ok — no confirmations is the strict side
  }
}
