/**
 * PreferencesSync — WS2.1 of multi-machine seamlessness: the serve / receive /
 * merge engine behind the `preferences-sync` mesh verb. Replicates the
 * correction-learning preference store (PreferencesManager,
 * `.instar/preferences.json`) across the machine pool so a preference learned on
 * machine A is honored on machine B.
 *
 * Spec: MULTI-MACHINE-SEAMLESSNESS-SPEC §WS2.1. Mirrors the COMMITMENTS-COHERENCE
 * replication pattern (CommitmentsSync.ts) — transport-agnostic, seam-injected;
 * the server registers the serve side as the verb handler and rides the
 * PeerPresencePuller cadence on the receive side, exactly like journal-sync.
 *
 * Preferences are ADVISORY SIGNALS (session-start hints), never authority — so
 * this is read-replication only, no write-back, no election, no quorum.
 *
 * Load-bearing rules (mirrors §3.2):
 *  - Pages are seq-windowed DELTAS by `lastMutatedSeq` (asc, dedupeKey tiebreak),
 *    EXCLUSIVE cursor, capped at `syncPageBytes` with ≥1 record/page — a store
 *    replicates fully over multiple pages, never a blob whose tail strands.
 *  - Incarnation fencing: a stale incarnation is answered `incarnationChanged`;
 *    the receiver discards the replica wholesale and re-pulls from 0 (a restored
 *    `.instar/preferences.json` must never strand replication).
 *  - First-hop with teeth: the replica owner derives from the AUTHENTICATED
 *    envelope sender; any served row whose originMachineId names a DIFFERENT
 *    machine is rejected + counted (forgedRows) — a peer cannot inject rows
 *    attributed to a third machine.
 *  - Disclosure honesty: the free-text `learning` is credential-shape-scanned at
 *    serve time; a flagged row ships with `learning` REDACTED (it still
 *    replicates — usefulness never depends on the scan).
 *
 * The ONE merge difference from commitments (design fork, resolved): commitments
 * union on composite key with no cross-origin merge; preferences COLLAPSE by
 * `dedupeKey` because the same dedupeKey on two machines is the SAME learned
 * lesson observed independently. The merged view presents ONE row per dedupeKey
 * (newest `recordedAt` wins the fields; `dedupeCount` sums across origins) so the
 * session-start block never double-injects the same guidance.
 */

import fs from 'node:fs';
import path from 'node:path';

import { redactForLiveTail } from './liveTailRedaction.js';
import type { PreferenceEntry } from './PreferencesManager.js';

export const DEFAULT_SYNC_PAGE_BYTES = 256 * 1024;
export const DEFAULT_REPLICA_STALE_WARN_MS = 10 * 60 * 1000;
/** Per-store bound — preferences are few; a runaway peer can't bloat the merge. */
export const DEFAULT_MAX_REPLICATED_PREFERENCES = 500;

// ── Wire shapes ─────────────────────────────────────────────────────

export interface PreferencesSyncRequest {
  sinceSeq: number;
  incarnation?: string;
}

/** A preference as it travels: always origin-stamped + seq-stamped, possibly redacted. */
export interface ReplicatedPreference extends PreferenceEntry {
  originMachineId: string;
  /** Monotonic per-origin mutation sequence — the delta-window key. */
  lastMutatedSeq: number;
  /** True when `learning` was credential-redacted at serve time. */
  textRedacted?: boolean;
}

export interface PreferencesSyncPage {
  incarnation: string;
  replicationSeq: number;
  /** Served records (redacted + origin-stamped). Empty when caught up. */
  records: ReplicatedPreference[];
  /** EXCLUSIVE cursor for the next request. */
  nextSinceSeq: number;
  /** True when no records remain past nextSinceSeq. */
  done: boolean;
  /** Set when the requester's incarnation is stale — re-pull from 0. */
  incarnationChanged?: boolean;
}

// ── Serve side ──────────────────────────────────────────────────────

/** A preference plus its (possibly absent → 0) replication seq, from the own store. */
export interface ServeablePreference extends PreferenceEntry {
  /** Absent on a legacy store ⇒ treated as 0 so a first sync replicates fully. */
  lastMutatedSeq?: number;
}

export interface ServePageDeps {
  ownMachineId: string;
  /** The OWN store's preferences — never replicas. */
  records: ServeablePreference[];
  advert: { incarnation: string; replicationSeq: number };
  syncPageBytes?: number;
}

export function buildPreferencesSyncPage(
  req: PreferencesSyncRequest,
  deps: ServePageDeps,
): PreferencesSyncPage {
  const { incarnation, replicationSeq } = deps.advert;
  // Incarnation fence: a stale requester re-pulls from 0.
  if (req.incarnation !== undefined && req.incarnation !== incarnation) {
    return { incarnation, replicationSeq, records: [], nextSinceSeq: 0, done: false, incarnationChanged: true };
  }
  const sinceSeq = Number.isFinite(req.sinceSeq) && req.sinceSeq >= 0 ? req.sinceSeq : 0;
  const pageBytes = deps.syncPageBytes && deps.syncPageBytes > 0 ? deps.syncPageBytes : DEFAULT_SYNC_PAGE_BYTES;

  // Delta window, EXCLUSIVE cursor; (lastMutatedSeq asc, dedupeKey tiebreak).
  const eligible = deps.records
    .map((r) => ({ r, seq: typeof r.lastMutatedSeq === 'number' ? r.lastMutatedSeq : 0 }))
    .filter((x) => x.seq > sinceSeq)
    .sort((a, b) => (a.seq - b.seq) || a.r.dedupeKey.localeCompare(b.r.dedupeKey));

  const records: ReplicatedPreference[] = [];
  let bytes = 0;
  let nextSinceSeq = sinceSeq;
  for (const { r, seq } of eligible) {
    const scan = redactForLiveTail(r.learning);
    // `violationPattern` is a LOCAL-ONLY signal (the user's self-violation
    // detection regex/keywords — e.g. `regex:api_key|secret|token`). It is
    // never injected into the session block and reveals the operator's security
    // posture, so it MUST NOT replicate to peers (review WS2.1 finding #1).
    // Strip it explicitly rather than spreading the whole record.
    const { violationPattern: _localOnly, lastMutatedSeq: _seq, ...replicable } = r;
    void _localOnly;
    void _seq;
    const row: ReplicatedPreference = {
      ...replicable,
      learning: scan.redactedCount > 0 ? scan.text : r.learning,
      originMachineId: deps.ownMachineId,
      lastMutatedSeq: seq,
      ...(scan.redactedCount > 0 ? { textRedacted: true } : {}),
    };
    const size = Buffer.byteLength(JSON.stringify(row), 'utf-8');
    // ≥1 record per page even when a single record exceeds the cap.
    if (records.length > 0 && bytes + size > pageBytes) break;
    records.push(row);
    bytes += size;
    nextSinceSeq = seq;
  }

  const done = records.length === 0 || !eligible.some((x) => x.seq > nextSinceSeq);
  return { incarnation, replicationSeq, records, nextSinceSeq, done };
}

// ── Receive side ────────────────────────────────────────────────────

interface ReplicaFileShape {
  version: 1;
  ownerMachineId: string;
  incarnation: string;
  sinceSeq: number;
  receivedAt: string;
  /** Keyed by dedupeKey within a single owner (the owner's own upsert key). */
  records: Record<string, ReplicatedPreference>;
}

export interface ApplyResult {
  applied: number;
  /** Rows claiming an originMachineId ≠ the authenticated sender — rejected. */
  forgedRows: number;
  /** The replica was discarded wholesale (incarnation change). */
  replaced: boolean;
  /** Rows dropped because the per-peer bound was already reached. */
  dropped: number;
}

/**
 * The per-peer replica store: one JSON file per owner under
 * `state/preference-replicas/`, written ONLY by this receive path
 * (single-writer), temp-file + atomic rename, corrupt → quarantine + fresh
 * (never silently empty).
 */
export class PreferenceReplicaStore {
  private readonly dir: string;
  private readonly now: () => Date;
  private readonly logger: (msg: string) => void;
  private readonly maxRecords: number;
  private cache = new Map<string, ReplicaFileShape>();

  constructor(config: {
    stateDir: string;
    now?: () => Date;
    logger?: (msg: string) => void;
    maxRecordsPerPeer?: number;
  }) {
    this.dir = path.join(config.stateDir, 'state', 'preference-replicas');
    this.now = config.now ?? (() => new Date());
    this.logger = config.logger ?? (() => {});
    this.maxRecords =
      config.maxRecordsPerPeer && config.maxRecordsPerPeer > 0
        ? config.maxRecordsPerPeer
        : DEFAULT_MAX_REPLICATED_PREFERENCES;
  }

  /** The cursor to request next from a peer (0 + no incarnation when fresh). */
  cursorFor(ownerMachineId: string): { sinceSeq: number; incarnation?: string } {
    const r = this.load(ownerMachineId);
    return r ? { sinceSeq: r.sinceSeq, incarnation: r.incarnation } : { sinceSeq: 0 };
  }

  /**
   * Apply a served page. `senderMachineId` is the AUTHENTICATED envelope
   * sender — the replica identity derives from it, never a payload field.
   */
  applyPage(senderMachineId: string, page: PreferencesSyncPage): ApplyResult {
    let replica = this.load(senderMachineId);
    let replaced = false;
    if (page.incarnationChanged || !replica || replica.incarnation !== page.incarnation) {
      replica = {
        version: 1,
        ownerMachineId: senderMachineId,
        incarnation: page.incarnation,
        sinceSeq: 0,
        receivedAt: this.now().toISOString(),
        records: {},
      };
      replaced = true;
      if (page.incarnationChanged) {
        this.persist(senderMachineId, replica);
        return { applied: 0, forgedRows: 0, replaced, dropped: 0 };
      }
    }
    let applied = 0;
    let forgedRows = 0;
    let dropped = 0;
    for (const row of page.records) {
      if (row.originMachineId !== senderMachineId) {
        forgedRows++; // first-hop with teeth — counted, never applied
        continue;
      }
      const isNewKey = !(row.dedupeKey in replica.records);
      if (isNewKey && Object.keys(replica.records).length >= this.maxRecords) {
        dropped++; // per-peer bound reached — an existing key may still update
        continue;
      }
      replica.records[row.dedupeKey] = row;
      applied++;
    }
    replica.sinceSeq = Math.max(replica.sinceSeq, page.nextSinceSeq);
    replica.receivedAt = this.now().toISOString();
    this.persist(senderMachineId, replica);
    return { applied, forgedRows, replaced, dropped };
  }

  /** Every replica's rows, tagged with owner + receivedAt. */
  allReplicas(): { ownerMachineId: string; receivedAt: string; records: ReplicatedPreference[] }[] {
    const out: { ownerMachineId: string; receivedAt: string; records: ReplicatedPreference[] }[] = [];
    let names: string[] = [];
    try {
      names = fs.readdirSync(this.dir).filter((n) => n.endsWith('.json') && !n.includes('.corrupt-'));
    } catch {
      /* @silent-fallback-ok: replica dir absent = no replicas yet (single-machine or fresh boot) — an empty merge, never an error (MULTI-MACHINE-SEAMLESSNESS-SPEC §WS2.1) */
    }
    for (const name of names) {
      const owner = name.replace(/\.json$/, '');
      const r = this.load(owner);
      if (r) out.push({ ownerMachineId: r.ownerMachineId, receivedAt: r.receivedAt, records: Object.values(r.records) });
    }
    return out;
  }

  private fileFor(owner: string): string {
    return path.join(this.dir, `${owner.replace(/[^A-Za-z0-9_.-]/g, '_')}.json`);
  }

  private load(owner: string): ReplicaFileShape | null {
    const cached = this.cache.get(owner);
    if (cached) return cached;
    const file = this.fileFor(owner);
    let raw: string;
    try {
      raw = fs.readFileSync(file, 'utf-8');
    } catch {
      /* @silent-fallback-ok: absent replica = first contact with this peer — a fresh pull from 0, never an error (MULTI-MACHINE-SEAMLESSNESS-SPEC §WS2.1) */
      return null;
    }
    try {
      const parsed = JSON.parse(raw) as ReplicaFileShape;
      if (parsed?.version !== 1 || typeof parsed.records !== 'object') throw new Error('shape');
      this.cache.set(owner, parsed);
      return parsed;
    } catch {
      try {
        fs.renameSync(file, `${file}.corrupt-${this.now().getTime()}`);
      } catch {
        /* @silent-fallback-ok: quarantine rename can lose a race; the fresh re-pull below proceeds either way (MULTI-MACHINE-SEAMLESSNESS-SPEC §WS2.1) */
      }
      this.logger(`preference replica for ${owner} unreadable — quarantined; full re-pull will rebuild it`);
      return null;
    }
  }

  private persist(owner: string, replica: ReplicaFileShape): void {
    fs.mkdirSync(this.dir, { recursive: true });
    const file = this.fileFor(owner);
    const tmp = `${file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(replica, null, 2));
    fs.renameSync(tmp, file);
    this.cache.set(owner, replica);
  }
}

// ── The merged read (collapse by dedupeKey) ─────────────────────────

export interface MergedPreference extends PreferenceEntry {
  /** Every machine that has observed this dedupeKey (own included). */
  contributingMachines: string[];
  /** Newest contributor — whose fields won. */
  winningMachineId: string;
  /** True when ≥1 contributing row was credential-redacted. */
  textRedacted?: boolean;
}

export interface MergeDeps {
  ownMachineId: string;
  own: PreferenceEntry[];
  replicas: { ownerMachineId: string; receivedAt: string; records: ReplicatedPreference[] }[];
  /** Injectable clock for the skew cap (default `new Date()`). Tests pass a fixed now. */
  now?: () => Date;
}

/**
 * Clock-skew tolerance for merge ordering. A peer's `recordedAt` is capped at
 * `now + this` before it can win a dedupeKey collision — so a machine with a
 * fast/hostile clock (e.g. set a year ahead) cannot silently dominate EVERY
 * preference across the pool (review WS2.1 finding #2; the spec's clock-skew
 * requirement). Real-world cross-machine clock drift is seconds-to-minutes; a
 * full day is a generous ceiling that never penalizes honest machines.
 * NOTE: this is the shipped mitigation; full HLC (logical counters) is a tracked
 * follow-up. <!-- tracked: WS2.1 HLC counters -->
 */
export const CLOCK_SKEW_TOLERANCE_MS = 24 * 60 * 60 * 1000;

/**
 * HLC-light ordering: (effective recordedAt-ms, originMachineId) lexicographic,
 * newer wins. `capMs` bounds a future-skewed timestamp so it cannot win on a
 * fabricated/drifted clock.
 */
function isNewer(
  aRecordedAt: string,
  aOrigin: string,
  bRecordedAt: string,
  bOrigin: string,
  capMs: number,
): boolean {
  // A timestamp beyond `now + tolerance` is not merely clamped to ~now (that
  // would still let it beat a genuine recent write); it is UNTRUSTWORTHY — a
  // fabricated/grossly-skewed clock — so it is treated as the OLDEST (0) and
  // loses every collision to any real timestamp. Within tolerance, normal
  // recency applies (review WS2.1 finding #2).
  const pa = Date.parse(aRecordedAt) || 0;
  const pb = Date.parse(bRecordedAt) || 0;
  const at = pa > capMs ? 0 : pa;
  const bt = pb > capMs ? 0 : pb;
  if (at !== bt) return at > bt;
  return aOrigin > bOrigin; // deterministic tiebreak
}

/**
 * Collapse own + replicas by dedupeKey into one merged row per learned
 * preference. Newest (recordedAt, origin) wins the fields; dedupeCount SUMS
 * across the distinct contributing origins (true cross-machine observation
 * count); contributingMachines lists every origin that holds the key.
 */
export function mergePreferenceViews(deps: MergeDeps): MergedPreference[] {
  interface Acc {
    winner: PreferenceEntry;
    winnerOrigin: string;
    winnerRecordedAt: string;
    countByOrigin: Map<string, number>;
    redacted: boolean;
  }
  const byKey = new Map<string, Acc>();
  const capMs = (deps.now?.() ?? new Date()).getTime() + CLOCK_SKEW_TOLERANCE_MS;

  const ingest = (entry: PreferenceEntry, origin: string, redacted: boolean): void => {
    const key = entry.dedupeKey;
    const existing = byKey.get(key);
    const count = typeof entry.dedupeCount === 'number' && entry.dedupeCount >= 1 ? entry.dedupeCount : 1;
    if (!existing) {
      byKey.set(key, {
        winner: entry,
        winnerOrigin: origin,
        winnerRecordedAt: entry.recordedAt,
        countByOrigin: new Map([[origin, count]]),
        redacted,
      });
      return;
    }
    // Each origin contributes ONCE per key (its own upsert collapses dupes);
    // last write from the same origin replaces its count rather than summing.
    existing.countByOrigin.set(origin, count);
    existing.redacted = existing.redacted || redacted;
    if (isNewer(entry.recordedAt, origin, existing.winnerRecordedAt, existing.winnerOrigin, capMs)) {
      existing.winner = entry;
      existing.winnerOrigin = origin;
      existing.winnerRecordedAt = entry.recordedAt;
    }
  };

  for (const p of deps.own) ingest(p, deps.ownMachineId, false);
  for (const rep of deps.replicas) {
    if (rep.ownerMachineId === deps.ownMachineId) continue; // never our own echo
    for (const p of rep.records) ingest(p, p.originMachineId, p.textRedacted === true);
  }

  const out: MergedPreference[] = [];
  for (const acc of byKey.values()) {
    let dedupeCount = 0;
    for (const c of acc.countByOrigin.values()) dedupeCount += c;
    out.push({
      ...acc.winner,
      dedupeCount,
      contributingMachines: [...acc.countByOrigin.keys()].sort(),
      winningMachineId: acc.winnerOrigin,
      ...(acc.redacted ? { textRedacted: true } : {}),
    });
  }
  // Stable, useful order: newest first (the injection block consumes this).
  out.sort((a, b) => (Date.parse(b.recordedAt) || 0) - (Date.parse(a.recordedAt) || 0));
  return out;
}
