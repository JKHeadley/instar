/**
 * PasskeyCellActions — apply a VERIFIED `passkey-cell` mandate (or the equivalent local PIN action)
 * on THIS machine (spec docs/specs/agent-held-google-passkey.md §3.2 / §3.3).
 *
 * One funnel for both origins so the PIN route and the mesh receiver cannot drift: the route
 * verifies the PIN and calls `applyLocal`; the receiver verifies the signature/issuer/nonce and
 * calls `applyMandate`. Every application follows the same discipline:
 *   1. write the nonce as RECEIVED — for a revoke together with the cutoff it will apply — BEFORE
 *      touching authority (crash-safe: a boot sweep can finish a revoke left `received`);
 *   2. act idempotently (grant / revoke / issuer-add / issuer-remove / revert-method);
 *   3. read back, then mark the nonce APPLIED.
 * A duplicate of a `received` revoke re-applies the STORED cutoff (never recomputed); a duplicate of
 * an `applied` op answers applied without acting.
 *
 * Ops this build applies: grant, revoke (local cell), issuer-add, issuer-remove, revert-method.
 * The remaining ops verify but answer `op-not-available-on-this-build` — they land with the
 * enrollment / health / suspension increments of the same run.
 */
import type { PasskeyGrantStore, PasskeyGrant } from './PasskeyGrantStore.js';
import type { PasskeyIssuerSet } from './PasskeyIssuerSet.js';
import type { PasskeyNonceLedger, NonceRecord } from './PasskeyNonceLedger.js';
import { passkeyCellKey, verifyPasskeyCellMandate, type PasskeyCellMandateBody, type PasskeyCellVerifyDeps, type PasskeyCellVerifyResult } from './PasskeyCellMandate.js';

export interface RevertMethodOutcome { reverted: boolean; to?: string; reason?: string; bindingMissing?: boolean }

export interface PasskeyCellActionDeps {
  selfMachineId: string;
  grants: PasskeyGrantStore;
  issuers: PasskeyIssuerSet;
  nonces: PasskeyNonceLedger;
  /** Revert every browser-profile account for the email back to its prior method (registry-owned). */
  revertMethod: (canonicalEmail: string) => RevertMethodOutcome[];
  /** Drop the passkey binding + credential for the cell after a revoke; returns what changed (names only). */
  onRevoked?: (canonicalEmail: string, covered: PasskeyGrant[]) => { changed: string[] } | Promise<{ changed: string[] }>;
  /** True when at least one OTHER machine is registered and active (issuer bootstrap applies). */
  hasActivePeers: () => boolean;
  log?: (line: string) => void;
}

export type PasskeyCellApplyResult =
  | { applied: true; op: string; duplicate?: boolean; result: Record<string, unknown> }
  | { applied: false; op: string; reason: string; detail?: Record<string, unknown> };

/** Apply a mandate that already passed `verifyPasskeyCellMandate` (or handle its replay honestly). */
export async function applyVerifiedPasskeyCellMandate(deps: PasskeyCellActionDeps, verified: PasskeyCellVerifyResult, issuerMachineIdForReplay?: string): Promise<PasskeyCellApplyResult> {
  if (!verified.ok) {
    if (verified.reason === 'replay' && verified.replayOf) return replay(deps, verified.replayOf);
    return { applied: false, op: 'unknown', reason: verified.reason, ...(verified.detail ? { detail: { detail: verified.detail } } : {}) };
  }
  void issuerMachineIdForReplay;
  return apply(deps, verified.body, verified.issuerMachineId, 'mandate');
}

/** The PIN route's entry: the same funnel, the local machine as issuer, no signature to check. */
export async function applyLocalPasskeyCellAction(deps: PasskeyCellActionDeps, body: PasskeyCellMandateBody): Promise<PasskeyCellApplyResult> {
  if (body.targetMachineId !== deps.selfMachineId) return { applied: false, op: body.op, reason: 'target-not-this-machine' };
  return apply(deps, body, deps.selfMachineId, 'local-pin');
}

/** Verify + apply in one step (the receiver route). */
export async function receivePasskeyCellMandate(deps: PasskeyCellActionDeps & { verify: Omit<PasskeyCellVerifyDeps, 'selfMachineId' | 'issuers' | 'nonces'> }, portable: unknown): Promise<PasskeyCellApplyResult> {
  const verified = verifyPasskeyCellMandate(portable, { ...deps.verify, selfMachineId: deps.selfMachineId, issuers: deps.issuers, nonces: deps.nonces });
  return applyVerifiedPasskeyCellMandate(deps, verified);
}

async function replay(deps: PasskeyCellActionDeps, nonce: string): Promise<PasskeyCellApplyResult> {
  const rec = deps.nonces.get(nonce);
  if (!rec) return { applied: false, op: 'unknown', reason: 'replay' };
  if (rec.state === 'applied') return { applied: true, op: rec.op, duplicate: true, result: { nonce: rec.nonce, appliedAt: rec.appliedAt ?? null } };
  if (rec.state === 'dismissed') return { applied: false, op: rec.op, reason: 'dismissed-by-operator' };
  if (rec.op === 'revoke') {
    // A received-but-unapplied revoke: re-run the idempotent delete with the STORED cutoff.
    const email = rec.cellKey.slice(0, rec.cellKey.lastIndexOf('@'));
    const r = deps.grants.revoke({ email, revokedBy: rec.issuerMachineId, nonce: rec.nonce, cutoffSeq: rec.appliedCutoffSeq ?? 0 });
    const changed = (await deps.onRevoked?.(email, r.covered))?.changed ?? [];
    deps.nonces.markApplied(rec.nonce);
    return { applied: true, op: 'revoke', duplicate: true, result: { covered: r.covered.map((g) => g.localSeq), changed } };
  }
  return { applied: false, op: rec.op, reason: 'replay' };
}

async function apply(deps: PasskeyCellActionDeps, body: PasskeyCellMandateBody, issuerMachineId: string, origin: 'mandate' | 'local-pin'): Promise<PasskeyCellApplyResult> {
  const cellKey = passkeyCellKey(body);
  const record = (extra: Partial<NonceRecord> = {}) => deps.nonces.receive({
    nonce: body.nonce, op: body.op, cellKey, issuerMachineId, expiresAt: body.expiresAt,
    ...(body.replacesNonce ? { replacesNonce: body.replacesNonce } : {}), ...extra,
  });
  switch (body.op) {
    case 'grant': {
      if (!body.canonicalEmail) return { applied: false, op: body.op, reason: 'email-required' };
      // FD21 — no trust-on-first-use: a multi-machine agent refuses its first grant until at least one
      // peer issuer is confirmed on THIS machine's own dashboard.
      if (deps.hasActivePeers() && deps.issuers.peerIssuers().length === 0) {
        return { applied: false, op: body.op, reason: 'issuer-bootstrap-required', detail: { hint: 'confirm at least one peer issuer with the PIN on this machine (POST /passkeys/issuer-add) before the first grant' } };
      }
      const rec = record();
      if (!rec.recorded) return replay(deps, rec.existing!.nonce);
      const r = deps.grants.grant({ email: body.canonicalEmail, grantedBy: body.principal, origin: origin === 'mandate' ? 'mandate' : 'local-pin',
        ...(typeof body.args.googleCreatedAt === 'string' ? { googleCreatedAt: body.args.googleCreatedAt } : {}) });
      if (!deps.grants.has(body.canonicalEmail)) return { applied: false, op: body.op, reason: 'read-back-failed' };
      deps.nonces.markApplied(body.nonce);
      return { applied: true, op: body.op, result: { localSeq: r.grant.localSeq, created: r.created, grantedBy: r.grant.grantedBy } };
    }
    case 'revoke': {
      if (!body.canonicalEmail) return { applied: false, op: body.op, reason: 'email-required' };
      // The cutoff written with the RECEIVED nonce is always CONCRETE: the issuer's sequence when it
      // knew one, else the target's current active instance (0 = nothing to revoke). A replay then
      // re-applies exactly this number — a grant made AFTER the first application can never be caught.
      const seq = body.args.revokesGrantSeq;
      const cutoff = Number.isSafeInteger(seq) ? (seq as number) : (deps.grants.get(body.canonicalEmail)?.localSeq ?? 0);
      const rec = record({ appliedCutoffSeq: cutoff });
      if (!rec.recorded) return replay(deps, rec.existing!.nonce);
      const r = deps.grants.revoke({ email: body.canonicalEmail, revokedBy: body.principal, nonce: body.nonce, cutoffSeq: cutoff });
      const changed = (await deps.onRevoked?.(body.canonicalEmail, r.covered))?.changed ?? [];
      const reverted = deps.revertMethod(body.canonicalEmail);
      if (deps.grants.get(body.canonicalEmail) && deps.grants.get(body.canonicalEmail)!.localSeq <= cutoff) {
        return { applied: false, op: body.op, reason: 'read-back-failed' };
      }
      deps.nonces.markApplied(body.nonce);
      return { applied: true, op: body.op, result: { covered: r.covered.map((g) => g.localSeq), nothingToRevoke: r.nothingToRevoke, appliedCutoffSeq: r.appliedCutoffSeq, changed, reverted,
        note: 'this stops THIS agent\'s passkey path only; the profile\'s live session and any stored password remain' } };
    }
    case 'issuer-add': {
      const machineId = typeof body.args.machineId === 'string' ? body.args.machineId.trim() : '';
      if (!machineId) return { applied: false, op: body.op, reason: 'machine-id-required' };
      // Both origins: only a machine that is ACTIVE in THIS machine's registry can become an issuer.
      if (deps.issuers.status(machineId) !== 'active') return { applied: false, op: body.op, reason: 'machine-not-active', detail: { status: deps.issuers.status(machineId) } };
      const rec = record();
      if (!rec.recorded) return replay(deps, rec.existing!.nonce);
      const r = deps.issuers.add({ machineId, addedVia: origin === 'mandate' ? 'issuer-add' : 'operator-confirmed', ...(origin === 'mandate' ? { addedByIssuer: issuerMachineId } : {}) });
      if (!deps.issuers.isListed(machineId)) return { applied: false, op: body.op, reason: 'read-back-failed' };
      deps.nonces.markApplied(body.nonce);
      return { applied: true, op: body.op, result: { machineId, added: r.added } };
    }
    case 'issuer-remove': {
      const machineId = typeof body.args.machineId === 'string' ? body.args.machineId.trim() : '';
      if (!machineId) return { applied: false, op: body.op, reason: 'machine-id-required' };
      const rec = record();
      if (!rec.recorded) return replay(deps, rec.existing!.nonce);
      const r = deps.issuers.remove(machineId);
      if (deps.issuers.isListed(machineId)) return { applied: false, op: body.op, reason: 'read-back-failed' };
      deps.nonces.markApplied(body.nonce);
      return { applied: true, op: body.op, result: { machineId, removed: r.removed } };
    }
    case 'revert-method': {
      if (!body.canonicalEmail) return { applied: false, op: body.op, reason: 'email-required' };
      const rec = record();
      if (!rec.recorded) return replay(deps, rec.existing!.nonce);
      const reverted = deps.revertMethod(body.canonicalEmail);
      deps.nonces.markApplied(body.nonce);
      return { applied: true, op: body.op, result: { reverted } };
    }
    default: {
      // Verified but not applicable on this build: record the nonce so a later replay is honest, and
      // name the gap rather than pretending the op ran.
      const rec = record();
      if (!rec.recorded) return replay(deps, rec.existing!.nonce);
      deps.log?.(`[passkey-cell] op ${body.op} verified but not available on this build (cell ${cellKey})`);
      return { applied: false, op: body.op, reason: 'op-not-available-on-this-build' };
    }
  }
}

/**
 * Boot sweep (spec §3.2): finish every revoke left `received` (a crash between the ledger write and
 * the read-back). Re-applies each one's STORED cutoff and marks it applied. Idempotent; call before
 * any grant-writing route acts (the routes call it when they build the authority set).
 */
export async function sweepReceivedPasskeyRevokes(deps: PasskeyCellActionDeps): Promise<{ finished: string[] }> {
  const finished: string[] = [];
  for (const rec of deps.nonces.receivedRevokes()) {
    const email = rec.cellKey.slice(0, rec.cellKey.lastIndexOf('@'));
    const r = deps.grants.revoke({ email, revokedBy: rec.issuerMachineId, nonce: rec.nonce, cutoffSeq: rec.appliedCutoffSeq ?? 0 });
    await deps.onRevoked?.(email, r.covered);
    deps.nonces.markApplied(rec.nonce);
    finished.push(rec.nonce);
  }
  return { finished };
}
