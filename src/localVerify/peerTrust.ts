/**
 * How far a peer's `main` green is trusted (docs/specs/local-verify-peer-result-trust.md, D2).
 *
 * Lease-holder state, persisted in `state/local-verify/peer-trust.json`:
 *  - the LOCAL ANCHOR: the last main green this machine ran itself on the head current at its start;
 *  - the SECOND CLOCK (`notLocallyVerifiedAt`): when the first merge this machine has not verified
 *    itself was seen. Peers can never move it, so main turns suspect at most `unverifiedSuspectMs`
 *    after that merge whatever peers report;
 *  - `locallyVerified`: heads this machine verified green itself (the only "already covered" set
 *    while main is routed local);
 *  - `peerMainGreens`: which peer reported which head green, under which verifier and policy;
 *  - `quarantine`: peers no longer sent `main` after a same-head disagreement;
 *  - `durations`: this machine's recent local main verify durations (the refresh age is derived from them);
 *  - `holding`: the lease holding this state belongs to (see `holdingDecision`).
 *
 * Pure apart from `readPeerTrust` / `writePeerTrust`.
 */
import fs from 'node:fs';
import path from 'node:path';

export const PEER_TRUST_LIMITS = Object.freeze({
  peerMainGreensKept: 50,
  locallyVerifiedKept: 20,
  durationsKept: 10,
  /** Upper cap on the refresh age (the 3 h suspect bound minus room for a local run). */
  refreshCapMs: 2.5 * 60 * 60 * 1000,
});

export interface PeerMainGreen { head: string; peer: string; verifierVersion: string; policyHash: string; at: number }
export interface QuarantineEntry { head: string; at: number; arbitrated: boolean }
export interface ArbitrationMarker { attemptId: string; peer: string; head: string; forPeer: string; requestDigest: string; sentAt: number }

export interface PeerTrustState {
  v: 1;
  holding: { holder: string | null; epoch: number | null } | null;
  anchor: { head: string; finishedAt: string } | null;
  notLocallyVerifiedAt: number | null;
  locallyVerified: string[];
  peerMainGreens: PeerMainGreen[];
  quarantine: Record<string, QuarantineEntry>;
  arbitration: ArbitrationMarker | null;
  durations: number[];
}

export function emptyPeerTrust(): PeerTrustState {
  return { v: 1, holding: null, anchor: null, notLocallyVerifiedAt: null, locallyVerified: [], peerMainGreens: [], quarantine: {}, arbitration: null, durations: [] };
}

/** The lease-holder state that is reset when holding is broken (everything but the measured durations). */
export function resetHoldingState(s: PeerTrustState, holding: PeerTrustState['holding']): PeerTrustState {
  return { ...emptyPeerTrust(), durations: s.durations, holding };
}

export interface LeaseRead { unreadable?: boolean; holds: boolean; epoch: number | null; holder: string | null }

/**
 * Is this the same unbroken holding the state was recorded under?
 *  - `skip`: the read is unreadable: decide nothing.
 *  - `keep`: holder = self and the epoch is the recorded one or the recorded one + 1 (a server takes a
 *    new epoch on every boot; another machine's acquisition in between would consume at least one more),
 *    or both epochs are null (no lease view: a single machine). The holding record moves to this epoch.
 *  - `other-holder`: a readable read naming another machine (the caller needs two in a row before deleting).
 *  - `reset`: holder = self but the epoch jumped by 2 or more (or went backwards): the holding was broken.
 *  - `not-held`: no one holds it (holder null) or this machine does not: nothing to keep or reset yet.
 */
export function holdingDecision(stored: PeerTrustState['holding'], read: LeaseRead, self: string): 'skip' | 'keep' | 'other-holder' | 'reset' | 'not-held' {
  if (read.unreadable) return 'skip';
  if (read.holder !== null && read.holder !== self) return 'other-holder';
  if (!read.holds || read.holder === null && read.epoch !== null) return 'not-held';
  if (!stored) return 'keep';
  if (stored.holder !== null && stored.holder !== self) return 'reset';
  if (stored.epoch === null && read.epoch === null) return 'keep';
  // A null read while a numbered epoch is on record is a lease view that could not say: decide nothing.
  if (read.epoch === null) return 'skip';
  if (stored.epoch === null) return 'reset';
  const gap = read.epoch - stored.epoch;
  return gap === 0 || gap === 1 ? 'keep' : 'reset';
}

/**
 * When peers stop serving `main` here: `suspectMs` − 1.5 × p90 of the last 10 local main durations,
 * capped at 2.5 h, no floor. `null` = not enough measurements yet (main stays local). `<= 0` = peers
 * never serve main on this machine (its own runs leave no room inside the bound).
 */
export function refreshAgeMs(durations: readonly number[], suspectMs: number): number | null {
  const d = durations.filter((x) => Number.isFinite(x) && x >= 0).slice(-PEER_TRUST_LIMITS.durationsKept);
  if (d.length < PEER_TRUST_LIMITS.durationsKept) return null;
  const sorted = [...d].sort((a, b) => a - b);
  const p90 = sorted[Math.min(sorted.length - 1, Math.ceil(0.9 * sorted.length) - 1)];
  return Math.min(PEER_TRUST_LIMITS.refreshCapMs, suspectMs - 1.5 * p90);
}

/** May a `main` verify go to a peer right now (before the per-peer quarantine check)? */
export function peerMainRoutingAllowed(s: PeerTrustState, now: number, suspectMs: number): { allowed: boolean; why: 'no-anchor' | 'unmeasured' | 'refresh-age' | 'too-slow' | null } {
  if (!s.anchor) return { allowed: false, why: 'no-anchor' };
  const age = refreshAgeMs(s.durations, suspectMs);
  if (age === null) return { allowed: false, why: 'unmeasured' };
  if (age <= 0) return { allowed: false, why: 'too-slow' };
  if (s.notLocallyVerifiedAt !== null && now - s.notLocallyVerifiedAt > age) return { allowed: false, why: 'refresh-age' };
  return { allowed: true, why: null };
}

/** The older of the two unverified clocks (null = nothing unverified). */
export function olderClock(a: number | null, b: number | null): number | null {
  if (a === null) return b;
  if (b === null) return a;
  return Math.min(a, b);
}

/** A peer green to remember for the disagreement rule (bounded, newest last, one per head and peer). */
export function rememberPeerGreen(s: PeerTrustState, g: PeerMainGreen): void {
  s.peerMainGreens = [...s.peerMainGreens.filter((x) => !(x.head === g.head && x.peer === g.peer)), g].slice(-PEER_TRUST_LIMITS.peerMainGreensKept);
}

/** Peers that reported exactly this head green under the same verifier version and policy. */
export function peersGreenOn(s: PeerTrustState, head: string, verifierVersion: string, policyHash: string): string[] {
  return [...new Set(s.peerMainGreens.filter((g) => g.head === head && g.verifierVersion === verifierVersion && g.policyHash === policyHash).map((g) => g.peer))];
}

export function noteLocallyVerified(s: PeerTrustState, head: string): void {
  s.locallyVerified = [...s.locallyVerified.filter((h) => h !== head), head].slice(-PEER_TRUST_LIMITS.locallyVerifiedKept);
}

export function noteDuration(s: PeerTrustState, ms: number): void {
  if (!Number.isFinite(ms) || ms < 0) return;
  s.durations = [...s.durations, ms].slice(-PEER_TRUST_LIMITS.durationsKept);
}

function isState(o: unknown): o is PeerTrustState {
  if (!o || typeof o !== 'object') return false;
  const s = o as Partial<PeerTrustState>;
  return s.v === 1 && Array.isArray(s.locallyVerified) && Array.isArray(s.peerMainGreens) && Array.isArray(s.durations)
    && !!s.quarantine && typeof s.quarantine === 'object';
}

/** Unreadable or malformed reads as empty (no anchor, no quarantine): the safe direction. */
export function readPeerTrust(file: string): PeerTrustState {
  try {
    const o = JSON.parse(fs.readFileSync(file, 'utf-8')) as unknown;
    if (isState(o)) return { ...emptyPeerTrust(), ...o };
  } catch { /* @silent-fallback-ok: no peer-trust state yet, or unreadable: reads as no anchor, which keeps main local */ }
  return emptyPeerTrust();
}

export function writePeerTrust(file: string, s: PeerTrustState): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(s)); /* state-registry: local-verify-peer-trust */
  fs.renameSync(tmp, file);
}
