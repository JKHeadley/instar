/**
 * ownershipFollowsLiveWork — pure decision helpers for the Ownership Follows Live
 * Work feature (docs/specs/ownership-follows-live-work.md).
 *
 * Parts A (release-on-complete) and B (claim-on-spawn) are wired into server.ts
 * closures (the only scope where `ownReg`/`emitPlacement`/`_meshSelfId` are all in
 * lexical view). To keep the DECISION logic single-sourced AND unit-testable
 * (Structure > Willpower — a 10-line tested helper beats a 100-line untestable
 * closure), the gate predicates live HERE as pure functions; the server closures
 * call them and then perform the CAS + emitPlacement pairing. Part D's recovery
 * decision lives in SessionRecovery (its deps are injected, so it is testable in
 * place); these helpers cover A + B.
 *
 * Every helper is fail-CLOSED (A & B are uniformly fail-closed per the spec's
 * safe-direction table): any uncertainty resolves to "withhold the write".
 */

import { randomUUID } from 'node:crypto';
import type { SessionOwnershipRecord } from './SessionOwnership.js';

/**
 * FD10 — the SINGLE nonce source for the three new ownership-CAS callsites (Part A
 * release-on-complete, Part B place+claim). The replay-guard key is
 * `(sessionKey, sender, ownershipEpoch)`; the existing release callsite mints a
 * millisecond-resolution nonce, so a release→re-place→release on the SAME
 * sessionKey within one ms could collide and have a legitimately-distinct action
 * dropped as a replay. This helper appends a process-monotonic counter AND a
 * randomUUID, so per-process uniqueness holds regardless of clock resolution. One
 * helper = the format can never drift between callsites.
 */
let _ownershipNonceSeq = 0;
export function ownershipNonce(machineId: string, verb: string, sessionKey: string): string {
  return `${machineId}:${verb}:${sessionKey}:${Date.now()}:${++_ownershipNonceSeq}:${randomUUID()}`;
}

/**
 * Part A — should the COMPLETING session's machine issue a `release`?
 *
 * Release ONLY when ALL hold (fail-closed otherwise):
 *  (a) the feature is on AND this machine has a mesh id,
 *  (b) `owner === self` and the record status is `active`,
 *  (c) the session-identity guard (FD9): no DIFFERENT live session is bound to the
 *      topic — compared by the STABLE per-instance key `startedAt`, NOT the
 *      reusable tmux name. Fail-closed/withhold if instance identity is unprovable
 *      (either `startedAt` missing).
 *
 * @param p.enabled            resolved flag (false ⇒ never release).
 * @param p.selfMachineId      this machine's mesh id (null ⇒ never release).
 * @param p.record             the current ownership record (null ⇒ never release).
 * @param p.completingStartedAt the completing session's stable instance key.
 * @param p.liveStartedAt      the CURRENT live session's stable instance key for
 *   this topic, or null when no live session is bound (⇒ proceed: best-effort safe
 *   direction; Part B's claim-on-spawn re-establishes ownership for a not-yet-bound
 *   respawn). `undefined` is treated the same as `null` (no live session).
 */
export function shouldReleaseOnComplete(p: {
  enabled: boolean;
  selfMachineId: string | null;
  record: SessionOwnershipRecord | null;
  completingStartedAt: string | null | undefined;
  liveStartedAt: string | null | undefined;
}): boolean {
  if (!p.enabled || !p.selfMachineId) return false; // dark / single-machine
  const rec = p.record;
  if (!rec) return false; // no record → nothing to release
  if (rec.ownerMachineId !== p.selfMachineId) return false; // peer-owned / not ours
  if (rec.status !== 'active') return false; // FSM would reject; short-circuit

  // (c) session-identity guard.
  const live = p.liveStartedAt;
  if (live == null) return true; // no live session bound → proceed (best-effort safe direction)
  const completing = p.completingStartedAt;
  // Fail-closed if instance identity is unprovable (either side missing).
  if (!live || !completing) return false;
  // A DIFFERENT live instance is bound (newer startedAt) → withhold the release
  // (it would orphan a live session's record — "released record, live session").
  if (String(live) !== String(completing)) return false;
  // Same instance (the one that just completed) → release.
  return true;
}

/** Part B claim plan — the ordered CAS steps the autonomous spawn should perform. */
export type ClaimOnSpawnPlan =
  | { action: 'place-then-claim' } // never-seen / released → place then claim onto self
  | { action: 'noop' } // already ours (active+self) → nothing to do
  | { action: 'audit-owned-elsewhere'; owner: string | null; status: string }; // peer-owned → withhold + audit

/**
 * Part B — what should an autonomous spawn do for the topic's ownership record?
 *
 * NEVER force-claims a peer-owned topic (FD3): an `active`/`transferring`/`placing`
 * record owned by a PEER yields `audit-owned-elsewhere` (withhold + ONE neutral
 * audit row). Fail-closed when off / single-machine (`noop`).
 */
export function planClaimOnSpawn(p: {
  enabled: boolean;
  selfMachineId: string | null;
  record: SessionOwnershipRecord | null;
}): ClaimOnSpawnPlan {
  if (!p.enabled || !p.selfMachineId) return { action: 'noop' }; // dark / single-machine
  const rec = p.record;
  if (!rec || rec.status === 'released') return { action: 'place-then-claim' };
  if (rec.status === 'active' && rec.ownerMachineId === p.selfMachineId) return { action: 'noop' };
  // active/transferring/placing owned by a PEER → never force-claim.
  return { action: 'audit-owned-elsewhere', owner: rec.ownerMachineId ?? null, status: rec.status };
}
