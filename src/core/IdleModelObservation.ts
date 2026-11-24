/** Read-only evidence assembled by the conversation owner. No runtime handles cross this boundary. */
export interface IdleModelObservationEvidence {
  /** A cache entry is usable only for the same proof tuple sampled before returning it. */
  readonly captured: IdleModelObservationRevision;
  readonly current: IdleModelObservationRevision;
  readonly policy: 'exact-pin' | 'moving-default' | 'unknown';
  readonly runtime:
    | { kind: 'unsupported' }
    | { kind: 'unknown' }
    | {
        kind: 'verified';
        configuredThreadModel: string;
        selector: 'inherited' | 'explicit' | 'unknown';
        idle: boolean | null;
      };
  readonly optIn: boolean | null;
  readonly target:
    | { kind: 'verified-upgrade'; model: string }
    | { kind: 'no-compatible-upgrade' }
    | { kind: 'unknown' };
}

interface IdleModelObservationRevision {
  readonly ownerEpoch: string;
  readonly processIncarnation: string;
  readonly topicPolicyRevision: string;
  readonly modelPolicyRevision: string;
  readonly runtimeObservationRevision: string | null;
}

type IneligibleReason =
  | 'exact-policy-pin'
  | 'unsupported-runtime'
  | 'explicit-native-selection'
  | 'active-work'
  | 'opt-in-absent'
  | 'no-compatible-upgrade';

type UnknownReason =
  | 'stale-identity-or-policy'
  | 'unverified-runtime'
  | 'unverified-inheritance'
  | 'unknown-opt-in'
  | 'unknown-work-state'
  | 'unknown-target';

interface ObservationDetails {
  readonly policy: IdleModelObservationEvidence['policy'];
  configuredThreadModel: string | null;
}

export type IdleModelObservation = ObservationDetails & (
  | { eligibility: 'ineligible'; reason: IneligibleReason }
  | { eligibility: 'unknown'; reason: UnknownReason }
  | { eligibility: 'candidate'; reason: 'verified-observation'; targetModel: string }
);

/** Classifies evidence for a diagnostic. A candidate is never an authorization to mutate. */
export function classifyIdleModelObservation(evidence: IdleModelObservationEvidence): IdleModelObservation {
  const { captured, current, policy, runtime, target } = evidence;
  if (!current.ownerEpoch || !current.processIncarnation || !current.topicPolicyRevision || !current.modelPolicyRevision
    || captured.ownerEpoch !== current.ownerEpoch
    || captured.processIncarnation !== current.processIncarnation
    || captured.topicPolicyRevision !== current.topicPolicyRevision
    || captured.modelPolicyRevision !== current.modelPolicyRevision) {
    return { eligibility: 'unknown', reason: 'stale-identity-or-policy', policy: 'unknown', configuredThreadModel: null };
  }

  const runtimeIsCurrent = Boolean(current.runtimeObservationRevision)
    && captured.runtimeObservationRevision === current.runtimeObservationRevision;
  const verifiedRuntime = runtime.kind === 'verified' && runtimeIsCurrent && runtime.configuredThreadModel.trim()
    ? runtime : null;
  const details = { policy, configuredThreadModel: verifiedRuntime?.configuredThreadModel ?? null };
  if (policy === 'exact-pin') return { ...details, eligibility: 'ineligible', reason: 'exact-policy-pin' };
  if (runtime.kind === 'unsupported' && runtimeIsCurrent) return { ...details, eligibility: 'ineligible', reason: 'unsupported-runtime' };
  if (!verifiedRuntime) return { ...details, eligibility: 'unknown', reason: 'unverified-runtime' };
  if (verifiedRuntime.selector === 'explicit') return { ...details, eligibility: 'ineligible', reason: 'explicit-native-selection' };
  if (policy !== 'moving-default' || verifiedRuntime.selector !== 'inherited') {
    return { ...details, eligibility: 'unknown', reason: 'unverified-inheritance' };
  }
  if (evidence.optIn === null) return { ...details, eligibility: 'unknown', reason: 'unknown-opt-in' };
  if (!evidence.optIn) return { ...details, eligibility: 'ineligible', reason: 'opt-in-absent' };
  if (verifiedRuntime.idle === false) return { ...details, eligibility: 'ineligible', reason: 'active-work' };
  if (verifiedRuntime.idle === null) return { ...details, eligibility: 'unknown', reason: 'unknown-work-state' };
  if (target.kind === 'no-compatible-upgrade') return { ...details, eligibility: 'ineligible', reason: 'no-compatible-upgrade' };
  if (target.kind === 'unknown' || !target.model.trim()) return { ...details, eligibility: 'unknown', reason: 'unknown-target' };
  // The producer establishes version order and excludes quota substitutions.
  if (target.model === verifiedRuntime.configuredThreadModel) {
    return { ...details, eligibility: 'ineligible', reason: 'no-compatible-upgrade' };
  }
  return { ...details, eligibility: 'candidate', reason: 'verified-observation', targetModel: target.model };
}

export interface OwnerBoundIdleModelSnapshot {
  readonly sessionId: string;
  readonly ownerMachineId: string;
  readonly ownershipStatus: 'placing' | 'active' | 'transferring' | 'released';
  readonly revision: IdleModelObservationRevision;
}

/** Read cached evidence, then check the exact owner and revision again before releasing it. */
export function observeOwnedIdleModel(
  sessionId: string,
  localMachineId: string,
  readSnapshot: (sessionId: string) => OwnerBoundIdleModelSnapshot | null,
  readEvidence: (snapshot: OwnerBoundIdleModelSnapshot) =>
    Omit<IdleModelObservationEvidence, 'current'> | null,
): IdleModelObservation | null {
  if (!sessionId || !localMachineId) return null;
  const initial = readSnapshot(sessionId);
  if (!initial || initial.sessionId !== sessionId || initial.ownershipStatus !== 'active'
    || initial.ownerMachineId !== localMachineId || !initial.revision.ownerEpoch
    || !initial.revision.processIncarnation || !initial.revision.topicPolicyRevision
    || !initial.revision.modelPolicyRevision) return null;

  const captured = { ...initial.revision };
  const evidence = readEvidence(initial);
  const current = readSnapshot(sessionId);
  if (!current || current.sessionId !== sessionId || current.ownershipStatus !== 'active'
    || current.ownerMachineId !== localMachineId || captured.ownerEpoch !== current.revision.ownerEpoch
    || captured.processIncarnation !== current.revision.processIncarnation) return null;

  if (!evidence || evidence.captured.ownerEpoch !== captured.ownerEpoch
    || evidence.captured.processIncarnation !== captured.processIncarnation) {
    return { eligibility: 'unknown', reason: 'stale-identity-or-policy', policy: 'unknown', configuredThreadModel: null };
  }
  return classifyIdleModelObservation({ ...evidence, current: current.revision });
}
