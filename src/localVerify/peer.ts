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

import type { MachineSignature } from '../core/AppRecordSignatures.js';
import { ATTEMPT_ID_RE, MAIN_VERIFY_PR, isValidSha, validateRecord, type LocalVerifyRecord } from './record.js';
import type { FailureDetail } from './orchestrator.js';

/** The coordinator's durable reservation of one queue entry for one peer attempt. */
export interface RemoteMarker {
  machineId: string;
  attemptId: string;
  leaseEpoch: number | null;
  sentAt: number;
  state: 'sending' | 'accepted';
  /** Immutable snapshot of what was dispatched: every later check compares against this. */
  dispatched: DispatchedInputs;
  /** SEC-113 D1: digest of the exact peer-run body sent; the peer's signed answer must carry it. */
  requestDigest?: string;
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
  attemptId: string;
  coordinatorMachineId: string;
  leaseEpoch: number | null;
  /** The coordinator's isolation input (its last green `main`), so a peer run re-runs flakes exactly as a local run would. */
  isolation?: { allowed: boolean; notCleanOnGreenMain: string[] };
  /** Coordinator attests that its watcher can rediscover this candidate after lease movement. */
  preflightRediscoverable?: boolean;
}

export type PeerRefusal =
  | 'is-lease-holder' | 'peer-disabled' | 'peer-busy' | 'verifier-mismatch' | 'not-coordinator'
  | 'head-moved' | 'untrusted-head' | 'pr-unreadable' | 'attempt-cancelled' | 'invalid-request' | 'state-unwritable';

export type PeerRunAnswer = { ok: true; attemptId: string } | { ok: false; reason: PeerRefusal };

/** The peer's answer to `GET /local-verify/peer-result`. */
export type PeerResult =
  | { state: 'unknown' }
  | { state: 'running' }
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

/** What the coordinator knows about one peer from `GET /local-verify/peer-status`. */
export interface PeerStatus {
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
  status(peer: PeerTarget): Promise<PeerStatus | null>;
  run(peer: PeerTarget, req: PeerRunRequest): Promise<PeerRunAnswer | null>;
  result(peer: PeerTarget, attemptId: string): Promise<PeerResult | null>;
  cancel(peer: PeerTarget, attemptId: string): Promise<void>;
}

export const PEER_LIMITS = Object.freeze({
  /** At most this many peers. */
  maxPeers: 2,
  /** Remote attempts per queue entry before it is only ever run locally. */
  maxAttemptsPerEntry: 2,
  /** A remote attempt not done within this is abandoned on both sides; this, not a lane deadline, is what ends a stuck peer run. */
  maxRunMs: 60 * 60_000,
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

/** Parse and validate a peer-run body. Exactly the fields of PeerRunRequest; nothing else. */
export function parsePeerRunRequest(body: unknown): PeerRunRequest | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const b = body as Record<string, unknown>;
  const keys = ['attemptId', 'pr', 'headSha', 'baseSha', 'baseRefName', 'verifierVersion', 'policyHash', 'coordinatorMachineId', 'leaseEpoch'];
  const extra = Object.keys(b).filter((k) => !keys.includes(k));
  if (!keys.every((k) => k in b) || extra.some((k) => k !== 'isolation' && k !== 'preflightRediscoverable' && k !== 'kind')) return null;
  if (b.kind !== undefined && b.kind !== 'main' && b.kind !== 'main-arbitration') return null;
  if (b.preflightRediscoverable !== undefined && typeof b.preflightRediscoverable !== 'boolean') return null;
  if (b.isolation !== undefined) {
    const iso = b.isolation as { allowed?: unknown; notCleanOnGreenMain?: unknown } | null;
    if (!iso || typeof iso !== 'object' || typeof iso.allowed !== 'boolean' || !Array.isArray(iso.notCleanOnGreenMain)
      || iso.notCleanOnGreenMain.length > 200 || !iso.notCleanOnGreenMain.every((f) => typeof f === 'string' && f.length > 0 && f.length <= 300)) return null;
  }
  if (typeof b.attemptId !== 'string' || !ATTEMPT_ID_RE.test(b.attemptId)) return null;
  if (b.kind === 'main' || b.kind === 'main-arbitration') {
    // A `main` verify (or a SEC-113 arbitration of one): no PR, the head is its own base, and nothing PR-shaped rides along.
    if (b.pr !== MAIN_VERIFY_PR || b.headSha !== b.baseSha || b.baseRefName !== 'main' || b.preflightRediscoverable !== undefined || b.isolation !== undefined) return null;
  } else if (typeof b.pr !== 'number' || !Number.isSafeInteger(b.pr) || b.pr <= 0) return null;
  if (!SHA_LIKE(b.headSha) || !SHA_LIKE(b.baseSha)) return null;
  if (typeof b.baseRefName !== 'string' || !/^[A-Za-z0-9._/-]{1,200}$/.test(b.baseRefName)) return null;
  if (typeof b.verifierVersion !== 'string' || !b.verifierVersion || b.verifierVersion.length > 200) return null;
  if (typeof b.policyHash !== 'string' || !/^[0-9a-f]{64}$/.test(b.policyHash)) return null;
  if (typeof b.coordinatorMachineId !== 'string' || !b.coordinatorMachineId || b.coordinatorMachineId.length > 200) return null;
  if (!(b.leaseEpoch === null || (typeof b.leaseEpoch === 'number' && Number.isSafeInteger(b.leaseEpoch) && b.leaseEpoch >= 0))) return null;
  return b as unknown as PeerRunRequest;
}

/** Why a returned peer record must NOT be imported, or null when it may be. Pure. */
export function importRefusal(
  record: unknown,
  marker: RemoteMarker,
  ctx: { repo: string; verifierVersion: string; policyHash: string; holdsLease: boolean; leaseEpoch: number | null; coordinatorMachineId: string },
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
  if (ctx.leaseEpoch !== marker.leaseEpoch || r.attempt.leaseEpoch !== marker.leaseEpoch) return 'lease-epoch-changed';
  if (Date.parse(r.startedAt) < marker.sentAt - 5 * 60_000) return 'started-before-dispatch';
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
