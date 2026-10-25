/**
 * Identity re-announce challenge protocol and fail-closed acceptance authority.
 * Cheap counters/observations are inputs only; this composite is the one writer.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { IdentityStore, IdentityStoreRefusal, type IdentityProjection } from './IdentityStore.js';
import {
  verifyRecoveryContinuity,
  verifySigningPossession,
  type RotationBinding,
} from './MachineRecoveryKey.js';
import type { MachineIdentity } from './types.js';

export interface IssuedRefusalEvidence {
  machineId: string;
  consecutive: number;
  firstAt: number;
  lastAt: number;
}

interface IssuedRefusalFile {
  version: 1;
  machines: Record<string, IssuedRefusalEvidence>;
}

interface ChallengeRecord {
  id: string;
  nonce: string;
  sourceKey: string;
  issuedAt: number;
  expiresAt: number;
  usedAt?: number;
  proposed: MachineIdentity;
}

export interface QuarantinedIdentityClaim {
  id: string;
  claimHash: string;
  machineId: string;
  keyEpoch: number;
  newSigningFingerprint: string;
  proposed: MachineIdentity;
  createdAt: string;
  reasons: string[];
  status: 'pending' | 'approved' | 'denied' | 'superseded';
  decidedAt?: string;
}

interface ReannounceFile {
  version: 1;
  challenges: Record<string, ChallengeRecord>;
  attemptsByMachine: Record<string, number[]>;
  attemptsBySource: Record<string, number[]>;
  quarantines: Record<string, QuarantinedIdentityClaim>;
  conflictNoticeAtByMachine: Record<string, number>;
}

export interface IdentityReannounceClaim {
  challengeId: string;
  possessionSignature: string;
  continuitySignature?: string;
}

export interface ReannounceEvaluationContext {
  /** First-hand incumbent-key-bound authenticated address or Tailscale whois evidence. */
  sourceVerifiedUnderIncumbent: boolean;
  /** Recovery-root agreement among live peers; false means equal-epoch divergence. */
  recoveryAgreement: 'consistent' | 'divergent' | 'unverifiable' | 'below-max';
  /** Signing-key equal-epoch agreement among live peers. */
  signingAgreement: 'consistent' | 'divergent';
  /** Rate/governor floor. */
  governorAllowed: boolean;
  /** Whether an accepted rotation still awaits operator acknowledgement. */
  unackedAcceptedRotation: boolean;
}

export type ReannounceResult =
  | { outcome: 'accepted' | 'would-accept'; identity: MachineIdentity; claimHash: string }
  | { outcome: 'quarantined' | 'would-quarantine'; quarantine: QuarantinedIdentityClaim }
  | { outcome: 'refused'; reason: string };

const DEFAULT_K = 10;
const DEFAULT_M_MS = 15 * 60_000;
const CHALLENGE_TTL_MS = 60_000;
const ATTEMPT_WINDOW_MS = 24 * 60 * 60_000;
const CONFLICT_SETTLE_MS = 10 * 60_000;
export const IDENTITY_REANNOUNCE_PROTOCOL_VERSION = 1;

function atomicWrite(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp.${process.pid}.${crypto.randomBytes(4).toString('hex')}`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

function fp(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex').slice(0, 32);
}

function canonicalClaimHash(identity: MachineIdentity): string {
  const canonical = JSON.stringify({
    machineId: identity.machineId,
    signingPublicKey: identity.signingPublicKey,
    encryptionPublicKey: identity.encryptionPublicKey,
    keyEpoch: identity.keyEpoch ?? 0,
    recoveryPublicKey: identity.recoveryPublicKey ?? null,
    recoveryEpoch: identity.recoveryEpoch ?? 0,
  });
  return crypto.createHash('sha256').update(canonical).digest('hex');
}

export function projectProposedIdentity(identity: MachineIdentity): IdentityProjection {
  return {
    machineId: identity.machineId,
    keyEpoch: Number(identity.keyEpoch ?? 0),
    signingFingerprint: fp(identity.signingPublicKey),
    recoveryEpoch: Number(identity.recoveryEpoch ?? 0),
    recoveryFingerprint: identity.recoveryPublicKey ? fp(identity.recoveryPublicKey) : undefined,
    recoveryAnchorProvenance: identity.recoveryAnchorProvenance,
    registryStatus: 'active',
  };
}

/**
 * Compare a proposed target to CURRENT promoted projections returned by peers.
 * Audit rows are deliberately excluded: a historical matching row cannot prove
 * what a peer trusts now.
 */
export function evaluateIdentityPoolAgreement(input: {
  target: IdentityProjection;
  localCurrent: IdentityProjection;
  peers: IdentityProjection[];
}): Pick<ReannounceEvaluationContext, 'recoveryAgreement' | 'signingAgreement'> {
  const activePeers = input.peers.filter((peer) => peer.machineId === input.target.machineId && peer.registryStatus === 'active');
  const currentViews = [input.localCurrent, ...activePeers];

  let signingAgreement: ReannounceEvaluationContext['signingAgreement'] = 'consistent';
  const maxSigningEpoch = Math.max(...currentViews.map((view) => view.keyEpoch));
  if (maxSigningEpoch > input.target.keyEpoch) signingAgreement = 'divergent';
  for (const epoch of new Set(currentViews.map((view) => view.keyEpoch))) {
    const fingerprints = new Set(currentViews.filter((view) => view.keyEpoch === epoch).map((view) => view.signingFingerprint));
    if (fingerprints.size > 1) signingAgreement = 'divergent';
  }
  const atTarget = activePeers.filter((view) => view.keyEpoch === input.target.keyEpoch);
  if (atTarget.some((view) => view.signingFingerprint !== input.target.signingFingerprint)) signingAgreement = 'divergent';

  const maxRecoveryEpoch = Math.max(input.target.recoveryEpoch, ...currentViews.map((view) => view.recoveryEpoch));
  let recoveryAgreement: ReannounceEvaluationContext['recoveryAgreement'] = 'unverifiable';
  if (maxRecoveryEpoch > input.target.recoveryEpoch) {
    recoveryAgreement = 'below-max';
  } else {
    const maxViews = currentViews.filter((view) => view.recoveryEpoch === maxRecoveryEpoch);
    const fingerprints = new Set(maxViews.map((view) => view.recoveryFingerprint ?? 'none'));
    if (fingerprints.size > 1 || [...fingerprints][0] !== (input.target.recoveryFingerprint ?? 'none')) {
      recoveryAgreement = 'divergent';
    } else if (input.localCurrent.recoveryAnchorProvenance === 'first-hand'
      || activePeers.some((view) => view.recoveryEpoch === input.target.recoveryEpoch
        && view.recoveryFingerprint === input.target.recoveryFingerprint)) {
      recoveryAgreement = 'consistent';
    }
  }
  return { recoveryAgreement, signingAgreement };
}

export class IssuedRefusalStore {
  private readonly file: string;
  private readonly now: () => number;
  constructor(options: { stateDir: string; now?: () => number }) {
    this.file = path.join(options.stateDir, 'state', 'identity-issued-refusals.json');
    this.now = options.now ?? Date.now;
  }

  recordSignatureInvalid(machineId: string): IssuedRefusalEvidence {
    const data = this.read();
    const now = this.now();
    const prior = data.machines[machineId];
    const next: IssuedRefusalEvidence = prior
      ? { ...prior, consecutive: prior.consecutive + 1, lastAt: now }
      : { machineId, consecutive: 1, firstAt: now, lastAt: now };
    data.machines[machineId] = next;
    atomicWrite(this.file, data);
    return next;
  }

  recordSuccess(machineId: string): void {
    const data = this.read();
    if (!data.machines[machineId]) return;
    delete data.machines[machineId];
    atomicWrite(this.file, data);
  }

  get(machineId: string): IssuedRefusalEvidence | null {
    return this.read().machines[machineId] ?? null;
  }

  eligible(machineId: string, k = DEFAULT_K, minSpanMs = DEFAULT_M_MS): boolean {
    const row = this.get(machineId);
    return Boolean(row && row.consecutive >= k && row.lastAt - row.firstAt >= minSpanMs);
  }

  private read(): IssuedRefusalFile {
    if (!fs.existsSync(this.file)) return { version: 1, machines: {} };
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8')) as IssuedRefusalFile;
      if (parsed?.version === 1 && parsed.machines) return parsed;
    } catch { /* fail closed below */ }
    throw new Error('issued-refusal-store-corrupt');
  }
}

export class IdentityReannounceService {
  private readonly statePath: string;
  private readonly store: IdentityStore;
  private readonly refusals: IssuedRefusalStore;
  private readonly challengerMachineId: string;
  private readonly now: () => number;
  private readonly dryRun: () => boolean;
  private readonly onAccepted?: (identity: MachineIdentity) => void;
  private readonly onConflict?: (event: { machineId: string; claims: QuarantinedIdentityClaim[] }) => void;

  constructor(options: {
    stateDir: string;
    identityStore: IdentityStore;
    issuedRefusals: IssuedRefusalStore;
    challengerMachineId: string;
    now?: () => number;
    dryRun?: () => boolean;
    onAccepted?: (identity: MachineIdentity) => void;
    onConflict?: (event: { machineId: string; claims: QuarantinedIdentityClaim[] }) => void;
  }) {
    this.statePath = path.join(options.stateDir, 'state', 'identity-reannounce.json');
    this.store = options.identityStore;
    this.refusals = options.issuedRefusals;
    this.challengerMachineId = options.challengerMachineId;
    this.now = options.now ?? Date.now;
    this.dryRun = options.dryRun ?? (() => true);
    this.onAccepted = options.onAccepted;
    this.onConflict = options.onConflict;
  }

  issueChallenge(proposed: MachineIdentity, sourceKey: string): { challengeId: string; nonce: string; expiresAt: string; challengerMachineId: string; protocolVersion: number } {
    this.store.assertActive(proposed.machineId);
    const current = this.store.loadIdentity(proposed.machineId, 'remote');
    if (!current) throw new IdentityStoreRefusal('unknown-machine', 'Identity re-announce cannot enroll a new machine');
    const data = this.read();
    const now = this.now();
    this.prune(data, now);
    const machineAttempts = data.attemptsByMachine[proposed.machineId] ?? [];
    const sourceAttempts = data.attemptsBySource[sourceKey] ?? [];
    if (machineAttempts.length >= 3 || sourceAttempts.length >= 12) {
      throw new IdentityStoreRefusal('challenge-rate-limited', 'Identity re-announce challenge budget exhausted');
    }
    const id = crypto.randomUUID();
    const nonce = crypto.randomBytes(32).toString('hex');
    data.challenges[id] = { id, nonce, sourceKey, issuedAt: now, expiresAt: now + CHALLENGE_TTL_MS, proposed: { ...proposed } };
    data.attemptsByMachine[proposed.machineId] = [...machineAttempts, now];
    data.attemptsBySource[sourceKey] = [...sourceAttempts, now];
    this.write(data);
    return {
      challengeId: id,
      nonce,
      expiresAt: new Date(now + CHALLENGE_TTL_MS).toISOString(),
      challengerMachineId: this.challengerMachineId,
      protocolVersion: IDENTITY_REANNOUNCE_PROTOCOL_VERSION,
    };
  }

  challengeMachineId(challengeId: string): string | null {
    return this.read().challenges[challengeId]?.proposed.machineId ?? null;
  }

  challengeProposed(challengeId: string): MachineIdentity | null {
    const proposed = this.read().challenges[challengeId]?.proposed;
    return proposed ? { ...proposed } : null;
  }

  identityProjection(machineId: string): IdentityProjection | null {
    return this.store.projection(machineId);
  }

  identityProjections(): IdentityProjection[] {
    return this.store.listProjections();
  }

  evaluate(claim: IdentityReannounceClaim, ctx: ReannounceEvaluationContext): ReannounceResult {
    const data = this.read();
    const challenge = data.challenges[claim.challengeId];
    const now = this.now();
    if (!challenge) return { outcome: 'refused', reason: 'challenge-unknown' };
    if (challenge.usedAt) return { outcome: 'refused', reason: 'challenge-replayed' };
    if (challenge.expiresAt < now) return { outcome: 'refused', reason: 'challenge-expired' };
    challenge.usedAt = now;
    this.write(data); // burn before crypto/authority evaluation

    const proposed = challenge.proposed;
    try {
      this.store.assertActive(proposed.machineId);
    } catch (err) {
      return { outcome: 'refused', reason: err instanceof IdentityStoreRefusal ? err.code : 'registry-unreadable' };
    }
    const current = this.store.loadIdentity(proposed.machineId, 'remote');
    if (!current) return { outcome: 'refused', reason: 'unknown-machine' };
    const nextEpoch = Number(proposed.keyEpoch ?? 0);
    const storedEpoch = this.store.getEpoch(proposed.machineId);
    if (nextEpoch !== storedEpoch.keyEpoch + 1) return { outcome: 'refused', reason: 'key-epoch-not-next' };

    const binding: RotationBinding = {
      nonce: challenge.nonce,
      claimantMachineId: proposed.machineId,
      newSigningPublicKey: proposed.signingPublicKey,
      newEncryptionPublicKey: proposed.encryptionPublicKey,
      challengerMachineId: this.challengerMachineId,
      keyEpoch: nextEpoch,
      recoveryEpoch: Number(proposed.recoveryEpoch ?? current.recoveryEpoch ?? 0),
      newRecoveryPublicKey: proposed.recoveryPublicKey,
    };
    if (!verifySigningPossession(binding, claim.possessionSignature)) {
      return { outcome: 'refused', reason: 'new-key-possession-invalid' };
    }

    const reasons: string[] = [];
    const recoveryKey = current.recoveryPublicKey;
    let continuityValid = false;
    if (recoveryKey) {
      if (ctx.recoveryAgreement === 'below-max') {
        return { outcome: 'refused', reason: 'recovery-root-below-live-peer-maximum' };
      }
      if (!claim.continuitySignature || !verifyRecoveryContinuity(binding, claim.continuitySignature, recoveryKey)) {
        reasons.push('recovery-continuity-required');
      } else {
        continuityValid = true;
      }
      if (current.recoveryAnchorProvenance !== 'first-hand' && ctx.recoveryAgreement !== 'consistent') {
        reasons.push(ctx.recoveryAgreement === 'divergent' ? 'recovery-root-divergent' : 'recovery-root-unverifiable');
      }
      if (ctx.recoveryAgreement === 'divergent') reasons.push('recovery-root-divergent');
    } else if (!ctx.sourceVerifiedUnderIncumbent) {
      reasons.push('incumbent-source-unverified');
    }

    // A valid pinned recovery-root signature is stronger than an accumulated
    // refusal run and is specifically the escape hatch after total local key
    // loss, when ordinary machine-auth cannot yet succeed. Bare claims retain
    // the full typed-refusal floor.
    if (!continuityValid && !this.refusals.eligible(proposed.machineId)) reasons.push('issued-refusal-floor-unmet');
    if (ctx.signingAgreement === 'divergent' && !continuityValid) reasons.push('signing-fingerprint-divergent');
    if (!ctx.governorAllowed) reasons.push('governor-denied');
    if (ctx.unackedAcceptedRotation && !(continuityValid && ctx.recoveryAgreement === 'consistent')) {
      reasons.push('prior-accepted-rotation-unacknowledged');
    }

    const claimHash = canonicalClaimHash(proposed);
    if (reasons.length > 0) return this.quarantine(data, proposed, claimHash, [...new Set(reasons)]);

    // A bare (non-recovery-continuity) claim gets a durable settle window.  The
    // first valid claimant therefore cannot win merely by arriving first; a
    // second distinct valid claim in the window quarantines both.  A recovery-
    // continuous claim may bypass this race because it proves the pre-existing
    // offline root rather than just possession of a newly minted key.
    const pendingForMachine = Object.values(data.quarantines)
      .filter((row) => row.status === 'pending' && row.machineId === proposed.machineId);
    if (!continuityValid) {
      const same = pendingForMachine.find((row) => row.claimHash === claimHash);
      const conflicting = pendingForMachine.filter((row) => row.claimHash !== claimHash);
      if (conflicting.length > 0 || same?.reasons.includes('conflicting-claim')) {
        return this.quarantine(data, proposed, claimHash, ['conflicting-claim']);
      }
      if (!same || now - Date.parse(same.createdAt) < CONFLICT_SETTLE_MS) {
        return this.quarantine(data, proposed, claimHash, ['conflict-settle-window']);
      }
    }

    if (this.dryRun()) {
      try {
        const validated = this.store.validate({
          identity: proposed,
          scope: 'remote',
          actor: 'reannounce',
          path: 'signing-rotation',
          acceptedBy: this.challengerMachineId,
          corroboration: recoveryKey ? ['recovery-continuity'] : ['incumbent-source', 'issued-refusals'],
        });
        return { outcome: 'would-accept', identity: validated, claimHash };
      } catch (err) {
        return { outcome: 'refused', reason: err instanceof IdentityStoreRefusal ? err.code : 'identity-store-error' };
      }
    }
    try {
      const accepted = this.store.apply({
        identity: proposed,
        scope: 'remote',
        actor: 'reannounce',
        path: 'signing-rotation',
        acceptedBy: this.challengerMachineId,
        corroboration: recoveryKey ? ['recovery-continuity'] : ['incumbent-source', 'issued-refusals'],
      });
      this.onAccepted?.(accepted);
      for (const row of pendingForMachine) {
        row.status = 'superseded';
        row.decidedAt = new Date(now).toISOString();
      }
      if (pendingForMachine.length > 0) this.write(data);
      return { outcome: 'accepted', identity: accepted, claimHash };
    } catch (err) { // @silent-fallback-ok: the store returns a typed fail-closed refusal to the caller; no mutation is acknowledged
      return { outcome: 'refused', reason: err instanceof IdentityStoreRefusal ? err.code : 'identity-store-error' };
    }
  }

  approve(quarantineId: string, claimHash: string): ReannounceResult {
    const data = this.read();
    const row = data.quarantines[quarantineId];
    if (!row || row.status !== 'pending') return { outcome: 'refused', reason: 'quarantine-unavailable' };
    if (row.claimHash !== claimHash || canonicalClaimHash(row.proposed) !== claimHash) {
      return { outcome: 'refused', reason: 'claim-hash-mismatch' };
    }
    // Observe-only/dry-run is a hard no-mutation boundary.  An operator tap may
    // exercise the full decision path, but it must not silently turn a dark
    // rollout into a live trust mutation or clear the pending evidence.
    if (this.dryRun()) {
      return { outcome: 'would-accept', identity: { ...row.proposed }, claimHash };
    }
    try {
      const accepted = this.store.apply({
        identity: row.proposed,
        scope: 'remote',
        actor: 'operator',
        path: 'signing-rotation',
        acceptedBy: 'operator',
        corroboration: ['dashboard-operator-approval'],
      });
      this.onAccepted?.(accepted);
      row.status = 'approved';
      row.decidedAt = new Date(this.now()).toISOString();
      this.write(data);
      return { outcome: 'accepted', identity: accepted, claimHash };
    } catch (err) { // @silent-fallback-ok: approval fails closed as a typed refusal; the store commits no mutation
      return { outcome: 'refused', reason: err instanceof IdentityStoreRefusal ? err.code : 'identity-store-error' };
    }
  }

  deny(quarantineId: string, claimHash: string): boolean {
    const data = this.read();
    const row = data.quarantines[quarantineId];
    if (!row || row.status !== 'pending' || row.claimHash !== claimHash) return false;
    row.status = 'denied';
    row.decidedAt = new Date(this.now()).toISOString();
    this.write(data);
    return true;
  }

  status(): { pending: QuarantinedIdentityClaim[]; recent: QuarantinedIdentityClaim[] } {
    const rows = Object.values(this.read().quarantines).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return { pending: rows.filter((r) => r.status === 'pending'), recent: rows.slice(0, 50) };
  }

  private quarantine(data: ReannounceFile, proposed: MachineIdentity, claimHash: string, reasons: string[]): ReannounceResult {
    const now = this.now();
    const pending = Object.values(data.quarantines).filter((q) => q.status === 'pending' && q.machineId === proposed.machineId);
    const existing = pending.find((q) => q.claimHash === claimHash);
    const conflicts = pending.filter((q) => q.claimHash !== claimHash && now - Date.parse(q.createdAt) <= CONFLICT_SETTLE_MS);
    const effectiveReasons = conflicts.length > 0 ? [...reasons, 'conflicting-claim'] : reasons;
    for (const conflict of conflicts) conflict.reasons = [...new Set([...conflict.reasons, 'conflicting-claim'])];
    const id = existing?.id ?? crypto.randomUUID();
    const row: QuarantinedIdentityClaim = existing ?? {
      id,
      claimHash,
      machineId: proposed.machineId,
      keyEpoch: Number(proposed.keyEpoch ?? 0),
      newSigningFingerprint: fp(proposed.signingPublicKey),
      proposed: { ...proposed },
      createdAt: new Date(now).toISOString(),
      reasons: effectiveReasons,
      status: 'pending',
    };
    row.reasons = [...new Set([...row.reasons, ...effectiveReasons])];
    data.quarantines[id] = row;
    if (conflicts.length > 0 && now - (data.conflictNoticeAtByMachine[proposed.machineId] ?? 0) >= CONFLICT_SETTLE_MS) {
      data.conflictNoticeAtByMachine[proposed.machineId] = now;
      this.onConflict?.({ machineId: proposed.machineId, claims: [...conflicts, row] });
    }
    this.write(data);
    return { outcome: this.dryRun() ? 'would-quarantine' : 'quarantined', quarantine: row };
  }

  private read(): ReannounceFile {
    if (!fs.existsSync(this.statePath)) return { version: 1, challenges: {}, attemptsByMachine: {}, attemptsBySource: {}, quarantines: {}, conflictNoticeAtByMachine: {} };
    try {
      const parsed = JSON.parse(fs.readFileSync(this.statePath, 'utf8')) as ReannounceFile;
      if (parsed?.version === 1 && parsed.challenges && parsed.quarantines) {
        parsed.conflictNoticeAtByMachine ??= {};
        return parsed;
      }
    } catch { /* fail closed below */ }
    throw new Error('identity-reannounce-store-corrupt');
  }

  private write(data: ReannounceFile): void { atomicWrite(this.statePath, data); }

  private prune(data: ReannounceFile, now: number): void {
    for (const [id, challenge] of Object.entries(data.challenges)) {
      if (challenge.expiresAt + ATTEMPT_WINDOW_MS < now) delete data.challenges[id];
    }
    for (const map of [data.attemptsByMachine, data.attemptsBySource]) {
      for (const [key, rows] of Object.entries(map)) map[key] = rows.filter((at) => at >= now - ATTEMPT_WINDOW_MS);
    }
  }
}
