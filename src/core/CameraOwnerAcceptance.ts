export type CameraGrant = Readonly<{
  id: string;
  phone: string;
  computer: string;
  access: string;
  expiresAt: string | null;
  revokedAt: string | null;
}>;

export interface CameraGrantTrial {
  readonly before: readonly CameraGrant[];
  readonly after: readonly CameraGrant[];
  readonly visibleComputer: string | null;
}

export interface CameraOwnerEvidence {
  readonly candidate: string;
  readonly phone: string;
  readonly computer: string;
  readonly expectedGrant: CameraGrant;
  readonly observedAt: string;
  readonly redirected: boolean;
  readonly success: CameraGrantTrial;
  readonly cancellation: CameraGrantTrial;
  readonly expiry: CameraGrantTrial;
  readonly replay: CameraGrantTrial;
}

export type CameraDecision = 'pass' | 'fail' | 'pending';

function grantKeys(grants: readonly CameraGrant[]): string[] {
  return grants.map(({ id, phone, computer, access, expiresAt, revokedAt }) => JSON.stringify([id, phone, computer, access, expiresAt, revokedAt])).sort();
}

function sameGrants(left: readonly CameraGrant[], right: readonly CameraGrant[]): boolean {
  return JSON.stringify(grantKeys(left)) === JSON.stringify(grantKeys(right));
}

function unchangedUnlinked(trial: CameraGrantTrial, computer: string): boolean {
  return trial.visibleComputer === null
    && !trial.before.some(grant => grant.computer === computer)
    && trial.before.some(grant => grant.computer !== computer)
    && sameGrants(trial.before, trial.after);
}

/** Evaluate snapshots of all grants for the tested phone, across computers. */
export function checkCameraOwnerEvidence(
  candidate: string,
  evidence: CameraOwnerEvidence | null,
): CameraDecision {
  if (!evidence || evidence.candidate !== candidate) return 'pending';

  const { phone, computer, expectedGrant, success, cancellation, expiry, replay } = evidence;
  const trials = [success, cancellation, expiry, replay];
  const observedAt = Date.parse(evidence.observedAt);
  const expiresAt = expectedGrant.expiresAt === null ? Infinity : Date.parse(expectedGrant.expiresAt);
  const fixture = success.before.filter(grant => grant.computer !== computer);
  const fixtureKeys = grantKeys(fixture);
  const preservesFixture = trials.every(trial => [trial.before, trial.after].every(snapshot =>
    fixtureKeys.every(key => grantKeys(snapshot).includes(key))));
  if (!Number.isFinite(observedAt) || !(expiresAt > observedAt) || !preservesFixture) return 'fail';
  if (expectedGrant.phone !== phone || expectedGrant.computer !== computer || expectedGrant.revokedAt !== null
    || trials.some(trial => [...trial.before, ...trial.after].some(grant => grant.phone !== phone))) return 'fail';
  const successAddsGrant = success.before.some(grant => grant.computer !== computer)
    && !success.before.some(grant => grant.computer === computer)
    && success.visibleComputer === computer
    && sameGrants([...success.before, expectedGrant], success.after);
  const replayPreservesGrant = replay.visibleComputer === computer
    && sameGrants(success.after, replay.before)
    && sameGrants(replay.before, replay.after);

  return !evidence.redirected
    && successAddsGrant
    && unchangedUnlinked(cancellation, computer)
    && unchangedUnlinked(expiry, computer)
    && replayPreservesGrant
    ? 'pass'
    : 'fail';
}

export interface CameraAcceptanceRequirement {
  readonly candidate: string;
  readonly revision: number;
  readonly verifier: string;
  readonly builders: readonly string[];
}

export interface CameraAcceptanceReceipt {
  readonly candidate: string;
  readonly revision: number;
  readonly verifier: string;
  readonly sequence: number;
  readonly decision: CameraDecision;
}

/** Fold a complete, authority-verified receipt stream for the Camera pilot. */
export function foldCameraReceipts(
  requirement: CameraAcceptanceRequirement,
  receipts: readonly CameraAcceptanceReceipt[] | null,
): { decision: CameraDecision } | null {
  if (!receipts || !requirement.verifier || requirement.builders.includes(requirement.verifier)) return null;

  const current = receipts.filter(receipt => receipt.revision === requirement.revision);
  const bySequence = new Map<number, CameraAcceptanceReceipt>();
  for (const receipt of current) {
    if (receipt.candidate !== requirement.candidate
      || receipt.verifier !== requirement.verifier
      || !Number.isSafeInteger(receipt.sequence)
      || receipt.sequence < 1) return null;
    const previous = bySequence.get(receipt.sequence);
    if (previous && previous.decision !== receipt.decision) return null;
    bySequence.set(receipt.sequence, receipt);
  }

  // Internal sequence gaps hold delivery. The caller must verify coverage through the authoritative head.
  for (let sequence = 1; sequence <= bySequence.size; sequence++) {
    if (!bySequence.has(sequence)) return null;
  }
  return { decision: bySequence.get(bySequence.size)?.decision ?? 'pending' };
}

export function cameraDeliveryDecision(
  requirement: CameraAcceptanceRequirement,
  receipts: readonly CameraAcceptanceReceipt[] | null,
): CameraDecision {
  return foldCameraReceipts(requirement, receipts)?.decision ?? 'pending';
}
