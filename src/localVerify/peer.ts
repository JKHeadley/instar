/**
 * A peer's preflight evidence is imported for diagnosis, never as standalone green authority.
 * Peer verifiers (spec docs/specs/local-verify-capacity.md Part D): a second machine runs
 * single PR verifies the serving-lease holder (the coordinator) hands it, and the
 * coordinator imports the records. This module holds the pure decisions and the
 * coordinator's HTTP client seam; the service owns the state.
 *
 * The decisions are deliberately narrow: a peer record can only ever be imported for the
 * exact attempt the coordinator dispatched, with exactly the inputs it dispatched, by the
 * same verifier code and policy, while the coordinator still holds the lease at the epoch it
 * dispatched under. Everything else is refused and the entry stays in the coordinator's queue.
 */

import { parseSmallPeerTrialPolicy, type SmallPeerTrialPolicy } from './smallPeerMemory.js';
import type { MachineSignature } from '../core/AppRecordSignatures.js';
import { ATTEMPT_ID_RE, MAIN_VERIFY_PR, isValidSha, validateRecord, type LocalVerifyRecord } from './record.js';
import type { FailureDetail, IsolationInput } from './orchestrator.js';
import { IMPORT_RELATED_RERUN } from './policy.js';
import { parseLikelyFailingWire, type FirstPartGroup, type LikelyFailingWire } from './firstPart.js';

/** The coordinator's durable reservation of one queue entry for one peer attempt. */
export interface RemoteMarker {
  /** Capacity and completed receipts both bind this trial dispatch. */
  trialReceiptExpected?: true;
  machineId: string;
  attemptId: string;
  leaseEpoch: number | null;
  sentAt: number;
  state: 'sending' | 'accepted';
  /** Immutable snapshot of what was dispatched: every later check compares against this. */
  dispatched: DispatchedInputs;
  /** SEC-113 D1: digest of the exact peer-run body sent; the peer's signed answer must carry it. */
  requestDigest?: string;
  /**
   * docs/specs/local-verify-peer-works-through-restart.md B: the coordinator's restart-episode id when
   * this attempt was sent during a restart pause (it does not hold that episode's restart).
   */
  sentDuringPause?: string;
  /**
   * Same spec, C: the later lease epoch of this machine's unbroken holding the attempt was adopted
   * under. Only `markerCurrent` / `markerEpochDecision` read it; the record check in `importRefusal`
   * still compares the peer's signed `attempt.leaseEpoch` with `leaseEpoch`.
   */
  adoptedEpoch?: number;
  /**
   * The main-flaky list this attempt was offered: file paths and test names only (no failure
   * lines). Beside `dispatched`, never inside it (that is spread into the request body). A
   * missing or malformed list reads as empty (`offeredFlakyOnMain()`), so a restored marker
   * without one accepts no import-related clear (spec local-verify-import-related-rerun.md).
   */
  offeredFlakyOnMain?: Array<{ file: string; tests: string[] }>;
}

/** The offered list of a marker as file → names; anything missing or malformed is an EMPTY list. Pure. */
export function offeredFlakyOnMain(marker: { offeredFlakyOnMain?: unknown }): Map<string, Set<string>> {
  const v = marker.offeredFlakyOnMain;
  const out = new Map<string, Set<string>>();
  if (!Array.isArray(v)) return out;
  for (const e of v) {
    const x = e as { file?: unknown; tests?: unknown } | null;
    if (!x || typeof x !== 'object' || typeof x.file !== 'string' || !Array.isArray(x.tests) || !x.tests.every((t) => typeof t === 'string')) return new Map();
    out.set(x.file, new Set(x.tests as string[]));
  }
  return out;
}

export interface DispatchedInputs {
  pr: number;
  headSha: string;
  baseSha: string;
  baseRefName: string;
  verifierVersion: string;
  policyHash: string;
  /** Present when the dispatched entry is a `main` verify (pr 0, head == base, base ref `main`). */
  /** `main-arbitration` (SEC-113 D2.4): run exactly like `main`, but the coordinator only uses the answer to settle a disagreement. */
  kind?: 'main' | 'main-arbitration';
}

/** The body of `POST /local-verify/peer-run`. */
export interface PeerRunRequest extends DispatchedInputs {
  smallPeerTrial?: SmallPeerTrialPolicy;
  attemptId: string;
  coordinatorMachineId: string;
  leaseEpoch: number | null;
  /**
   * The coordinator's isolation input (its last green `main`), so a peer run re-runs flakes exactly
   * as a local run would; with `importRelatedRerun` and `flakyOnMain` it also carries the
   * coordinator's switch and its list of main-flaky tests (the peer never computes a list).
   */
  isolation?: IsolationInput;
  /** Coordinator attests that its watcher can rediscover this candidate after lease movement. */
  preflightRediscoverable?: boolean;
  /**
   * PR verifies (spec local-verify-likely-failing-first.md B): the coordinator's likely-failing
   * list in use and the change's previous failures, at most 100 paths of at most 300 characters.
   * Sent only when not empty; a peer never builds its own list.
   */
  likelyFailing?: LikelyFailingWire;
  /** PR verifies: the coordinator's assignment of this pull request for the first-part trial. */
  firstPartGroup?: FirstPartGroup;
}

export type PeerRefusal =
  | 'is-lease-holder' | 'peer-disabled' | 'peer-busy' | 'verifier-mismatch' | 'not-coordinator'
  | 'head-moved' | 'untrusted-head' | 'pr-unreadable' | 'attempt-cancelled' | 'invalid-request' | 'state-unwritable';

export type PeerRunAnswer = { ok: true; attemptId: string } | { ok: false; reason: PeerRefusal };

/** The peer's answer to `GET /local-verify/peer-result`. */
export type PeerResult =
  | { state: 'unknown' }
  | { state: 'running'; progress?: PeerProgress | null }
  | { state: 'done'; record: LocalVerifyRecord; run?: PeerMainRun; requestDigest?: string; sig?: MachineSignature; raw?: { record: unknown; run?: unknown; requestDigest?: unknown; sig?: unknown } };

/**
 * Why a peer-run `main` verify went red. A main record carries no failed files, and the
 * coordinator's main-red hold needs them to tell a repair from a doomed run.
 */
export interface PeerMainRun {
  reasons: string[];
  failures: FailureDetail[];
}

const PEER_MAIN_RUN_LIMITS = Object.freeze({ reasons: 50, reasonChars: 500, failures: 30, fileChars: 300, messageChars: 2000 });

/** Bound and shape-check a peer's `run` detail; anything malformed is dropped, never trusted. Pure. */
export function parsePeerMainRun(v: unknown): PeerMainRun | undefined {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined;
  const x = v as { reasons?: unknown; failures?: unknown };
  const L = PEER_MAIN_RUN_LIMITS;
  const reasons = (Array.isArray(x.reasons) ? x.reasons : [])
    .filter((r): r is string => typeof r === 'string' && r.length > 0).slice(0, L.reasons).map((r) => r.slice(0, L.reasonChars));
  const failures: FailureDetail[] = [];
  for (const f of Array.isArray(x.failures) ? x.failures : []) {
    if (failures.length >= L.failures) break;
    const r = f as Partial<FailureDetail> | null;
    if (!r || typeof r.file !== 'string' || r.file.length === 0 || r.file.length > L.fileChars) continue;
    failures.push({
      file: r.file, lane: typeof r.lane === 'string' ? r.lane.slice(0, 100) : '',
      failed: typeof r.failed === 'number' && Number.isSafeInteger(r.failed) && r.failed >= 0 ? r.failed : 0,
      message: typeof r.message === 'string' ? r.message.slice(0, L.messageChars) : '',
      ...(typeof r.rerunMessage === 'string' ? { rerunMessage: r.rerunMessage.slice(0, L.messageChars) } : {}),
    });
  }
  return reasons.length === 0 && failures.length === 0 ? undefined : { reasons, failures };
}

/**
 * docs/specs/local-verify-peer-works-through-restart.md E: what a running peer attempt has done so far,
 * read from the run's per-lane `*.progress.json` files. Metadata only: it decides when an attempt is
 * ended, never a verdict. `recordedMs` is the file's recorded duration on the machine running it (null =
 * no history; the lane's hang deadline is used); `slowdown` is this run's measured slowdown (>= 1).
 */
export interface PeerProgress {
  finishedFiles: number;
  lastFinishedAt: number | null;
  running: Array<{ file: string; seconds: number; lane: string; recordedMs: number | null }>;
  slowdown: number;
}

const PROGRESS_LIMITS = Object.freeze({ running: 40, fileChars: 300, laneChars: 40, maxSlowdown: 100 });

/** Bound and shape-check a peer's reported progress; anything malformed reads as null (unmeasurable). Pure. */
export function parsePeerProgress(v: unknown): PeerProgress | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const x = v as Record<string, unknown>;
  if (!Number.isSafeInteger(x.finishedFiles) || (x.finishedFiles as number) < 0) return null;
  if (!(x.lastFinishedAt === null || (typeof x.lastFinishedAt === 'number' && Number.isFinite(x.lastFinishedAt)))) return null;
  if (typeof x.slowdown !== 'number' || !Number.isFinite(x.slowdown) || x.slowdown < 1) return null;
  if (!Array.isArray(x.running) || x.running.length > PROGRESS_LIMITS.running) return null;
  const running: PeerProgress['running'] = [];
  for (const r of x.running) {
    const f = r as Record<string, unknown> | null;
    if (!f || typeof f.file !== 'string' || !f.file || f.file.length > PROGRESS_LIMITS.fileChars) return null;
    if (typeof f.lane !== 'string' || f.lane.length > PROGRESS_LIMITS.laneChars) return null;
    if (typeof f.seconds !== 'number' || !Number.isFinite(f.seconds) || f.seconds < 0) return null;
    if (!(f.recordedMs === null || (typeof f.recordedMs === 'number' && Number.isFinite(f.recordedMs) && f.recordedMs >= 0))) return null;
    running.push({ file: f.file, seconds: f.seconds, lane: f.lane, recordedMs: f.recordedMs as number | null });
  }
  return { finishedFiles: x.finishedFiles as number, lastFinishedAt: x.lastFinishedAt as number | null, running, slowdown: Math.min(PROGRESS_LIMITS.maxSlowdown, x.slowdown) };
}

export type PeerAttemptVerdict = 'progressing' | 'stalled' | 'unknown' | 'backstop';

/**
 * A lane key (`unit`, `integration-2`, `e2e-1`, and a lane's first part `e2e-first`,
 * docs/specs/local-verify-likely-failing-first.md) → its lane name. A first part must read as its
 * lane: a running file with no recorded duration takes its lane's hang deadline as its stall window,
 * and an unknown lane name would make a healthy first part unmeasurable at the review point.
 */
export function laneOfKey(key: string): string { return key.replace(/-(?:\d+|first)$/, ''); }

/**
 * Same spec, E: the stall window for a running attempt. Twice the longest recorded duration among the
 * files still running (a file with no history uses its lane's hang deadline), times this run's own
 * measured slowdown. null = nothing is running that could be measured (unmeasurable). Pure.
 */
export function stallWindowMs(p: PeerProgress, laneDeadlines: Readonly<Record<string, number>>): number | null {
  let longest = -1;
  for (const r of p.running) {
    // The lane is read through laneOfKey here too: a peer may report a raw key (`e2e-first`, `integration-2`).
    const d = r.recordedMs ?? laneDeadlines[r.lane] ?? laneDeadlines[laneOfKey(r.lane)] ?? null;
    if (d !== null && Number.isFinite(d) && d > longest) longest = d;
  }
  if (longest < 0) return null;
  return 2 * longest * Math.max(1, p.slowdown);
}

/**
 * Same spec, E: an attempt at or past the review point (`maxRunMs`) is judged, not killed. It ends
 * (`stalled`, `unknown`, `backstop`) unless a file finished within the stall window (`progressing`).
 * `childGone`: the run child is no longer alive (peer side only). Pure.
 */
export function judgePeerAttempt(input: {
  ageMs: number; progress: PeerProgress | null; startedAt: number; now: number; childGone?: boolean;
  laneDeadlines: Readonly<Record<string, number>>;
}): { verdict: PeerAttemptVerdict; finishedFiles: number | null; lastFinishedAgoMs: number | null; stallMs: number | null } {
  const p = input.progress;
  const lastFinishedAgoMs = p ? Math.max(0, input.now - (p.lastFinishedAt ?? input.startedAt)) : null;
  const stallMs = p ? stallWindowMs(p, input.laneDeadlines) : null;
  const base = { finishedFiles: p ? p.finishedFiles : null, lastFinishedAgoMs, stallMs };
  if (input.ageMs >= PEER_LIMITS.backstopMs) return { verdict: 'backstop', ...base };
  if (input.childGone || !p || stallMs === null || lastFinishedAgoMs === null) return { verdict: 'unknown', ...base };
  return { verdict: lastFinishedAgoMs > stallMs ? 'stalled' : 'progressing', ...base };
}

/** What the coordinator knows about one peer from `GET /local-verify/peer-status`. */
export interface PeerStatus {
  smallPeerTrial?: SmallPeerTrialPolicy;
  inFlight: { attemptId: string; pr: number } | null;
  verifierVersion: string;
  policyHash: string;
  slotBusy: boolean;
  /** SEC-113 D1: the hash of the key this peer signs with now (a hint the coordinator checks against its own pins). */
  signerKeyHash?: string;
}

/** One configured peer. */
export interface PeerTarget {
  machineId: string;
  /** Base URL of the peer's agent server, e.g. `http://192.168.87.30:4042`. */
  url: string;
}

/** The coordinator's narrow HTTP seam to its peers (Bearer auth lives in the implementation). */
export interface PeerClient {
  trialReceipts?(peer: PeerTarget, coordinator: string, attemptIds: string[]): Promise<import('./smallPeerReceipts.js').TrialPacket[]>;
  acknowledgeTrial?(peer: PeerTarget, ack: import('./smallPeerReceipts.js').TrialAck): Promise<boolean>;
  status(peer: PeerTarget): Promise<PeerStatus | null>;
  run(peer: PeerTarget, req: PeerRunRequest): Promise<PeerRunAnswer | null>;
  result(peer: PeerTarget, attemptId: string): Promise<PeerResult | null>;
  cancel(peer: PeerTarget, attemptId: string): Promise<void>;
  trialLease?(peer: PeerTarget, request: { attemptId: string; coordinatorMachineId: string; leaseEpoch: number; nonce?: string }): Promise<string | null>;
}

export const PEER_LIMITS = Object.freeze({
  /** At most this many peers. */
  maxPeers: 2,
  /** Remote attempts per queue entry before it is only ever run locally. */
  maxAttemptsPerEntry: 2,
  /** A remote attempt not done within this is abandoned on both sides; this, not a lane deadline, is what ends a stuck peer run. */
  maxRunMs: 60 * 60_000,
  /**
   * docs/specs/local-verify-peer-works-through-restart.md E: with `peerWorksThroughRestart` on, `maxRunMs`
   * is a review point and a progressing attempt keeps running, up to this absolute backstop: the longest
   * a run child can live under its own deadlines (fetch 5 + npm ci 10 + build/lint 15 + totalActiveMs 120).
   */
  backstopMs: 150 * 60_000,
  /**
   * A `main` verify on a peer that has not answered a poll for this long is taken back (and
   * cancelled there): while it is reserved no other `main` verify may start, and a suspect or
   * red main cannot wait out the run bound for a peer that went away.
   */
  mainSilentMs: 5 * 60_000,
  /** Consecutive `main` requests a peer could not confirm before it is offered none, and for how long. */
  mainUnconfirmedLimit: 3,
  mainUnconfirmedPauseMs: 30 * 60_000,
  /** `unknown` for an attempt older than this means the peer has no such attempt. */
  unknownGraceMs: 2 * 60_000,
  /** Result polls at most this often per attempt. */
  pollMs: 60_000,
  /** Status reads at most this often per peer. */
  statusMs: 30_000,
  /** Consecutive transport/execution failures that open a peer's breaker, and how long it stays open. */
  breakerFailures: 3,
  breakerOpenMs: 30 * 60_000,
  /** Tombstones (cancelled/abandoned attempt ids) are kept this long on the peer. */
  tombstoneMs: 7 * 24 * 60 * 60_000,
});

const SHA_LIKE = (v: unknown): v is string => typeof v === 'string' && isValidSha(v);

const onlyKeys = (o: Record<string, unknown>, keys: readonly string[]) => Object.keys(o).every((k) => keys.includes(k));
const isIsoTime = (v: unknown) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(v) && !Number.isNaN(Date.parse(v));

/**
 * The import-related part of an isolation block (spec local-verify-import-related-rerun.md):
 * `importRelatedRerun` a boolean, `flakyOnMain` at most 200 files of at most 40 tests, every
 * string bounded. Exactly these keys, at every level. Pure.
 */
function importRelatedIsolationOk(iso: Record<string, unknown>): boolean {
  const L = IMPORT_RELATED_RERUN;
  if (!onlyKeys(iso, ['allowed', 'notCleanOnGreenMain', 'importRelatedRerun', 'flakyOnMain'])) return false;
  if (typeof iso.importRelatedRerun !== 'boolean' || !Array.isArray(iso.flakyOnMain) || iso.flakyOnMain.length > L.wireFiles) return false;
  return iso.flakyOnMain.every((e) => {
    const f = e as Record<string, unknown> | null;
    if (!f || typeof f !== 'object' || Array.isArray(f) || !onlyKeys(f, ['file', 'tests', 'namesCut'])) return false;
    if (typeof f.file !== 'string' || f.file.length < 1 || f.file.length > 300) return false;
    if (f.namesCut !== undefined && f.namesCut !== true) return false;
    return Array.isArray(f.tests) && f.tests.length <= L.namesPerFile && f.tests.every((x) => {
      const t = x as Record<string, unknown> | null;
      return !!t && typeof t === 'object' && !Array.isArray(t) && onlyKeys(t, ['test', 'at', 'line', 'lineCut', 'setHash', 'runLog'])
        && typeof t.test === 'string' && t.test.length >= 1 && t.test.length <= L.nameChars
        && isIsoTime(t.at) && typeof t.line === 'string' && t.line.length <= L.lineChars
        && (t.lineCut === undefined || t.lineCut === true)
        && typeof t.setHash === 'string' && /^[0-9a-f]{64}$/.test(t.setHash)
        && typeof t.runLog === 'string' && /^[0-9a-f]{0,64}(\.log)?$/.test(t.runLog);
    });
  });
}

/** Parse and validate a peer-run body. Exactly the fields of PeerRunRequest; nothing else. */
export function parsePeerRunRequest(body: unknown): PeerRunRequest | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const b = body as Record<string, unknown>;
  const keys = ['attemptId', 'pr', 'headSha', 'baseSha', 'baseRefName', 'verifierVersion', 'policyHash', 'coordinatorMachineId', 'leaseEpoch'];
  const extra = Object.keys(b).filter((k) => !keys.includes(k));
  if (!keys.every((k) => k in b) || extra.some((k) => k !== 'isolation' && k !== 'preflightRediscoverable' && k !== 'kind' && k !== 'likelyFailing' && k !== 'firstPartGroup' && k !== 'smallPeerTrial')) return null;
  if (b.smallPeerTrial !== undefined && (b.kind !== undefined || !parseSmallPeerTrialPolicy(b.smallPeerTrial))) return null;
  // The likely-failing field is bounded and strict: a malformed one refuses the whole request.
  if (b.likelyFailing !== undefined && parseLikelyFailingWire(b.likelyFailing) === null) return null;
  if (b.firstPartGroup !== undefined && b.firstPartGroup !== 'with' && b.firstPartGroup !== 'without') return null;
  if (b.kind !== undefined && b.kind !== 'main' && b.kind !== 'main-arbitration') return null;
  if (b.preflightRediscoverable !== undefined && typeof b.preflightRediscoverable !== 'boolean') return null;
  if (b.isolation !== undefined) {
    const iso = b.isolation as { allowed?: unknown; notCleanOnGreenMain?: unknown } | null;
    if (!iso || typeof iso !== 'object' || typeof iso.allowed !== 'boolean' || !Array.isArray(iso.notCleanOnGreenMain)
      || iso.notCleanOnGreenMain.length > 200 || !iso.notCleanOnGreenMain.every((f) => typeof f === 'string' && f.length > 0 && f.length <= 300)) return null;
    // Strict keys and the new fields' shape apply only when the switch field is present: a block
    // without it parses as before, so a staggered install needs no flag day.
    if ('importRelatedRerun' in (iso as object) && !importRelatedIsolationOk(iso as Record<string, unknown>)) return null;
  }
  if (typeof b.attemptId !== 'string' || !ATTEMPT_ID_RE.test(b.attemptId)) return null;
  if (b.kind === 'main' || b.kind === 'main-arbitration') {
    // A `main` verify (or a SEC-113 arbitration of one): no PR, the head is its own base, and nothing PR-shaped rides along.
    if (b.pr !== MAIN_VERIFY_PR || b.headSha !== b.baseSha || b.baseRefName !== 'main' || b.preflightRediscoverable !== undefined || b.isolation !== undefined
      || b.likelyFailing !== undefined || b.firstPartGroup !== undefined) return null;
  } else if (typeof b.pr !== 'number' || !Number.isSafeInteger(b.pr) || b.pr <= 0) return null;
  if (!SHA_LIKE(b.headSha) || !SHA_LIKE(b.baseSha)) return null;
  if (typeof b.baseRefName !== 'string' || !/^[A-Za-z0-9._/-]{1,200}$/.test(b.baseRefName)) return null;
  if (typeof b.verifierVersion !== 'string' || !b.verifierVersion || b.verifierVersion.length > 200) return null;
  if (typeof b.policyHash !== 'string' || !/^[0-9a-f]{64}$/.test(b.policyHash)) return null;
  if (typeof b.coordinatorMachineId !== 'string' || !b.coordinatorMachineId || b.coordinatorMachineId.length > 200) return null;
  if (!(b.leaseEpoch === null || (typeof b.leaseEpoch === 'number' && Number.isSafeInteger(b.leaseEpoch) && b.leaseEpoch >= 0))) return null;
  return b as unknown as PeerRunRequest;
}

/**
 * docs/specs/local-verify-peer-works-through-restart.md C.2: the ONE test of whether a reservation is
 * current under the live lease. With the setting off (`adoptionOn` false) `adoptedEpoch` is ignored, so
 * every epoch change abandons exactly as before. Pure.
 */
export function markerCurrent(m: RemoteMarker, lease: { epoch: number | null }, adoptionOn: boolean): boolean {
  return (adoptionOn && m.adoptedEpoch !== undefined ? m.adoptedEpoch : m.leaseEpoch) === lease.epoch;
}

export type LeaseChangedReason = 'lease-changed:holding-broken' | 'lease-changed:entry-moved' | 'lease-changed:verifier' | 'lease-changed:main' | 'lease-changed:disabled';

export type MarkerEpochDecision =
  | { action: 'current' }
  | { action: 'wait'; why: 'unreadable' | 'not-held' | 'not-caught-up' }
  | { action: 'adopt'; fromEpoch: number | null; toEpoch: number }
  | { action: 'abandon'; reason: LeaseChangedReason };

/**
 * Same spec, C.3: what the coordinator does with a reservation on this tick's lease read. `holding` is
 * PR 3451's persisted holding record as `checkTrustHolding` left it this tick (it runs before the poll).
 * Every branch that cannot prove one unbroken holding of this machine since the dispatch epoch waits or
 * abandons; it never adopts. Pure.
 */
export function markerEpochDecision(m: RemoteMarker, i: {
  enabled: boolean;
  lease: { holds: boolean; epoch: number | null; holder: string | null; unreadable?: boolean };
  self: string;
  holding: { holder: string | null; epoch: number | null; since?: number | null } | null;
  entry: { kind?: 'main'; pr: number; headSha: string; baseSha: string; baseRefName: string } | null;
  verifierVersion: string;
  policyHash: string;
}): MarkerEpochDecision {
  const { lease } = i;
  if (!i.enabled) return markerCurrent(m, lease, false) && lease.holds && !lease.unreadable ? { action: 'current' } : { action: 'abandon', reason: 'lease-changed:disabled' };
  if (lease.unreadable) return { action: 'wait', why: 'unreadable' };
  if (lease.holder !== null && lease.holder !== i.self) return { action: 'abandon', reason: 'lease-changed:holding-broken' };
  if (!lease.holds) return { action: 'wait', why: 'not-held' };
  if (markerCurrent(m, lease, true)) return { action: 'current' };
  const h = i.holding;
  if (!h || h.holder !== i.self || h.epoch !== lease.epoch) return { action: 'wait', why: 'not-caught-up' };
  const since = h.since;
  const from = m.leaseEpoch;
  if (typeof since !== 'number' || !Number.isSafeInteger(since) || typeof from !== 'number' || !Number.isSafeInteger(from)
    || typeof lease.epoch !== 'number' || since > from || from >= lease.epoch) return { action: 'abandon', reason: 'lease-changed:holding-broken' };
  const d = m.dispatched;
  if (d.kind === 'main' || i.entry?.kind === 'main') return { action: 'abandon', reason: 'lease-changed:main' };
  const e = i.entry;
  if (!e || e.pr !== d.pr || e.headSha !== d.headSha || e.baseSha !== d.baseSha || e.baseRefName !== d.baseRefName) return { action: 'abandon', reason: 'lease-changed:entry-moved' };
  if (d.verifierVersion !== i.verifierVersion || d.policyHash !== i.policyHash) return { action: 'abandon', reason: 'lease-changed:verifier' };
  return { action: 'adopt', fromEpoch: m.adoptedEpoch ?? from, toEpoch: lease.epoch };
}

/** The optional marker fields, validated on read: a malformed one is dropped alone, never the marker. Pure. */
export function cleanMarkerExtras(m: RemoteMarker): RemoteMarker {
  const out: RemoteMarker = { ...m };
  if (out.sentDuringPause !== undefined && !(typeof out.sentDuringPause === 'string' && /^[0-9a-f]{32}$/.test(out.sentDuringPause))) delete out.sentDuringPause;
  if (out.adoptedEpoch !== undefined && !(typeof out.adoptedEpoch === 'number' && Number.isSafeInteger(out.adoptedEpoch) && out.adoptedEpoch >= 0)) delete out.adoptedEpoch;
  return out;
}

/** Why a returned peer record must NOT be imported, or null when it may be. Pure. */
export function importRefusal(
  record: unknown,
  marker: RemoteMarker,
  ctx: { repo: string; verifierVersion: string; policyHash: string; holdsLease: boolean; leaseEpoch: number | null; coordinatorMachineId: string; adoptionOn?: boolean },
): string | null {
  const v = validateRecord(record);
  if (!v.ok) return `invalid-record:${v.errors.slice(0, 5).join(',')}`;
  const r = v.record;
  const d = marker.dispatched;
  if (!r.attempt) return 'no-attempt';
  if ((r.kind === 'main') !== (d.kind === 'main')) return 'wrong-kind';
  if (r.attempt.id !== marker.attemptId) return 'wrong-attempt';
  if (r.attempt.coordinatorMachineId !== ctx.coordinatorMachineId) return 'wrong-coordinator';
  if (r.machineId !== marker.machineId) return 'wrong-peer';
  if (r.repo !== ctx.repo) return 'wrong-repo';
  if (r.pr !== d.pr) return 'wrong-pr';
  if (r.headSha !== d.headSha) return 'wrong-head';
  if (r.baseSha !== d.baseSha) return 'wrong-base';
  if (r.baseRefName !== d.baseRefName) return 'wrong-base-ref';
  if (r.verifierVersion !== d.verifierVersion || r.verifierVersion !== ctx.verifierVersion) return 'verifier-mismatch';
  if (r.policyHash !== d.policyHash || r.policyHash !== ctx.policyHash) return 'policy-mismatch';
  if (!ctx.holdsLease) return 'not-lease-holder';
  // The reservation must be current under the live lease (an adopted one, at its adopted epoch), while
  // the peer's signed record still names the epoch the attempt was dispatched under.
  if (!markerCurrent(marker, { epoch: ctx.leaseEpoch }, ctx.adoptionOn === true) || r.attempt.leaseEpoch !== marker.leaseEpoch) return 'lease-epoch-changed';
  if (Date.parse(r.startedAt) < marker.sentAt - 5 * 60_000) return 'started-before-dispatch';
  // A clear on main evidence must be one this coordinator offered for this attempt: the file and
  // every cleared test name. A consistency check between two machines on one build.
  const cleared = (r.flakyRetried ?? []).filter((f) => f.importRelated === true);
  if (cleared.length > 0) {
    const offered = offeredFlakyOnMain(marker);
    for (const f of cleared) {
      const names = offered.get(f.file);
      if (!names || !(f.failedTests ?? []).every((t) => names.has(t))) return 'import-related-not-offered';
    }
  }
  return null;
}

/** Per-peer health for dispatch: a breaker over transport/execution failures only. */
export interface PeerHealth {
  consecutiveFailures: number;
  /** Last peer/coordinator version pair recorded as mismatched; audit dedupe only. */
  skewKey?: string | null;
  openUntil: number | null;
  status: PeerStatus | null;
  statusAt: number;
}

export function peerHealthy(h: PeerHealth | undefined, now: number): boolean {
  return !h || h.openUntil === null || now >= h.openUntil;
}

/** Record one failure; returns true when the breaker just opened. Busy is never passed here. */
export function noteFailure(h: PeerHealth, now: number): boolean {
  h.consecutiveFailures++;
  if (h.consecutiveFailures >= PEER_LIMITS.breakerFailures && (h.openUntil === null || now >= h.openUntil)) {
    h.openUntil = now + PEER_LIMITS.breakerOpenMs;
    h.consecutiveFailures = 0;
    return true;
  }
  return false;
}

export function noteSuccess(h: PeerHealth): void {
  h.consecutiveFailures = 0;
  h.openUntil = null;
}

/** Validate a configured peer list (at most PEER_LIMITS.maxPeers; http(s) URLs; distinct ids). */
export function parsePeers(v: unknown, selfMachineId: string): PeerTarget[] {
  if (!Array.isArray(v)) return [];
  const out: PeerTarget[] = [];
  for (const p of v) {
    if (!p || typeof p !== 'object') continue;
    const { machineId, url } = p as { machineId?: unknown; url?: unknown };
    if (typeof machineId !== 'string' || !machineId || machineId === selfMachineId) continue;
    if (typeof url !== 'string' || !/^https?:\/\/[^\s/]+(:\d+)?\/?$/.test(url)) continue;
    if (out.some((o) => o.machineId === machineId)) continue;
    out.push({ machineId, url: url.replace(/\/$/, '') });
    if (out.length >= PEER_LIMITS.maxPeers) break;
  }
  return out;
}
