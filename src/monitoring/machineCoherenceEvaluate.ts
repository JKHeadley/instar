/**
 * Machine-coherence evaluator — PURE helpers (machine-coherence-guard §3.3).
 *
 * This module holds the deterministic, dependency-free pieces of the evaluator:
 * peer classification and the canonical skew-row identity (+ its truncated
 * marker hash). The tick-driven `MachineCoherenceSentinel` (increment C)
 * composes these; nothing wires this module in production yet.
 *
 * Supervision tier (spec N6): Tier 0, explicitly — fully deterministic
 * (classification, string comparison, hashing); no LLM call anywhere.
 */

import crypto from 'node:crypto';
import type { MachineCapacity } from '../core/types.js';
import { MC_ROW_HASH_LEN } from '../core/machineCoherenceManifest.js';

/**
 * Peer classification (spec §3.3 — each class has pinned handling):
 * - `compared`        online, fresh clamp-passed advert → enters all dimensions
 * - `unknown`         online but NO advert (older version / pre-advert boot /
 *                     missing from the comparison set) → version-class skew
 *                     ("the peer predates the guard"), confirmed only after
 *                     `versionSkewGraceMs` (M3 — mid-update-wave honesty)
 * - `advert-stale`    advert older than `advertStaleMs` (M5) → treated like
 *                     `unknown` (carry-forward must never impersonate freshness)
 * - `advert-rejected` clamp-rejected advert (M4) → the version-class
 *                     confirmation path with its own named reason — persistent
 *                     malformation is LOUD, never silence
 */
export type PeerClass = 'compared' | 'unknown' | 'advert-stale' | 'advert-rejected';

export interface ClassifiedPeer {
  machineId: string;
  cls: PeerClass;
  /** Present iff cls === 'compared' (fresh + clamp-passed). */
  advert?: NonNullable<MachineCapacity['coherenceAdvert']>;
  /** Named rejection reason iff cls === 'advert-rejected'. */
  rejectedReason?: string;
}

/**
 * Classify one ONLINE machine's capacity for the comparison set. The caller
 * owns the ONLINE filter (offline peers are a liveness problem with existing
 * owners — §3.3 scope) and the M11 universe accounting.
 */
export function classifyPeer(
  cap: Pick<MachineCapacity, 'machineId' | 'coherenceAdvert' | 'coherenceAdvertReceivedAt' | 'coherenceAdvertRejected'>,
  nowMs: number,
  advertStaleMs: number,
): ClassifiedPeer {
  // Rejection first: rejected ≠ absent, by construction (M4). The registry
  // already suppresses the advert while a rejection stands, but the order here
  // makes the invariant hold even against a widened future capacity shape.
  if (cap.coherenceAdvertRejected) {
    return { machineId: cap.machineId, cls: 'advert-rejected', rejectedReason: cap.coherenceAdvertRejected.reason };
  }
  if (!cap.coherenceAdvert || !cap.coherenceAdvertReceivedAt) {
    return { machineId: cap.machineId, cls: 'unknown' };
  }
  const receivedMs = Date.parse(cap.coherenceAdvertReceivedAt);
  // An unparseable receipt time cannot prove freshness — degrade, never trust.
  if (!Number.isFinite(receivedMs) || nowMs - receivedMs > advertStaleMs) {
    return { machineId: cap.machineId, cls: 'advert-stale' };
  }
  return { machineId: cap.machineId, cls: 'compared', advert: cap.coherenceAdvert };
}

/** The four skew dimensions (spec §3.3). */
export type SkewDimension = 'flag' | 'version' | 'manifest' | 'protocol';

/**
 * Canonical skew-row identity (spec N1): `dimension + '|' + key + '|' +
 * sorted('<machineId>=<valueClass>')` — stable machine ids and clamped value
 * classes ONLY. Never nicknames (renamable mid-episode), never raw table rows.
 * Confirmation counters, episode membership, the recurrence damper (§4.5), the
 * takeover/fallback latches, and the advert alarm-marker hashes all key on
 * this identity.
 */
export function skewRowIdentity(
  dimension: SkewDimension,
  key: string,
  perMachineValueClass: Record<string, string>,
): string {
  const parts = Object.entries(perMachineValueClass)
    .map(([machineId, valueClass]) => `${machineId}=${valueClass}`)
    .sort();
  return `${dimension}|${key}|${parts.join(',')}`;
}

/**
 * The per-row truncated hash carried in the advert `alarm.rowIdentityHashes`
 * list (spec §3.2): the first 16 lowercase hex chars of sha256 over the N1 row
 * identity. Content-free by construction (ids + clamped value classes only —
 * no free text crosses the mesh in the marker). A LIST of these, not a
 * set-level hash, so coverage checks are INTERSECTION tests (R3-M4/N2).
 */
export function rowIdentityHash(rowIdentity: string): string {
  return crypto.createHash('sha256').update(rowIdentity).digest('hex').slice(0, MC_ROW_HASH_LEN);
}
