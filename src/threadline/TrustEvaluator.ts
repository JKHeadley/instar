/**
 * TrustEvaluator — Computes trust level from local history + optional network signals.
 *
 * Spec Section 3.2 Layer 2:
 * - Local trust: direct interaction history, circuit breaker state, user-granted upgrades
 * - Network trust: MoltBridge IQS score (advisory only)
 * - Local trust ALWAYS takes precedence over network signals
 *
 * Trust levels: untrusted → verified → trusted (no auto-escalation)
 * Decay: trusted → verified at 90d inactivity, verified → untrusted at 180d
 */

import { TRUST_DECAY } from '../identity/types.js';

// ── Types ────────────────────────────────────────────────────────────

export type TrustLevel = 'untrusted' | 'verified' | 'trusted';

export type TrustSource = 'user-granted' | 'paired-machine-granted' | 'setup-default' | 'invitation' | 'os-verified' | 'agent-proposal';

/** MoltBridge IQS band (advisory only) */
export type IQSBand = 'high' | 'medium' | 'low' | 'unknown';

export interface TrustSignals {
  /** Current local trust level */
  localLevel: TrustLevel;
  /** Source of the local trust level */
  source: TrustSource;
  /** Last interaction timestamp (ISO-8601), null if never interacted */
  lastInteraction: string | null;
  /** Number of successful interactions */
  successCount: number;
  /** Number of failed interactions */
  failureCount: number;
  /** Circuit breaker activations in last 24h */
  circuitBreakerActivations: number;
  /** MoltBridge IQS band (advisory, optional) */
  networkIQS?: IQSBand;
}

export interface TrustEvaluation {
  /** Computed effective trust level */
  level: TrustLevel;
  /** Why this level was computed */
  reason: string;
  /** Network advisory (if available) */
  networkAdvisory?: string;
  /** Whether trust was downgraded by decay or circuit breaker */
  downgraded: boolean;
}

// ── Evaluator ────────────────────────────────────────────────────────

/**
 * Evaluate the effective trust level for an agent.
 *
 * Pure function — no side effects, no state mutation.
 * Deterministic given the same signals.
 */
export function evaluateTrust(signals: TrustSignals, now?: Date): TrustEvaluation {
  const currentTime = (now ?? new Date()).getTime();
  let level = signals.localLevel;
  let reason = `Local trust: ${level} (source: ${signals.source})`;
  let downgraded = false;

  // Circuit breaker auto-downgrade: 3 activations in 24h → untrusted
  if (signals.circuitBreakerActivations >= 3) {
    level = 'untrusted';
    reason = `Auto-downgraded: ${signals.circuitBreakerActivations} circuit breaker activations in 24h`;
    downgraded = true;
  }

  // Trust decay (only if not already downgraded by circuit breaker)
  if (!downgraded && signals.lastInteraction) {
    const lastTime = new Date(signals.lastInteraction).getTime();
    const daysSinceInteraction = (currentTime - lastTime) / (24 * 60 * 60 * 1000);

    if (level === 'trusted' && daysSinceInteraction > TRUST_DECAY.trustedToVerifiedDays) {
      level = 'verified';
      reason = `Trust decayed: no interaction for ${Math.floor(daysSinceInteraction)} days (threshold: ${TRUST_DECAY.trustedToVerifiedDays}d)`;
      downgraded = true;
    }

    const totalDecayDays = TRUST_DECAY.trustedToVerifiedDays + TRUST_DECAY.verifiedToUntrustedDays;
    if ((level === 'verified' || signals.localLevel === 'trusted') && daysSinceInteraction > totalDecayDays) {
      level = 'untrusted';
      reason = `Trust decayed: no interaction for ${Math.floor(daysSinceInteraction)} days (threshold: ${totalDecayDays}d)`;
      downgraded = true;
    }
  }

  // Network advisory (MoltBridge IQS) — advisory only, never overrides local
  let networkAdvisory: string | undefined;
  if (signals.networkIQS) {
    if (signals.networkIQS === 'low' && level !== 'untrusted') {
      networkAdvisory = `Warning: Network trust score is LOW for this agent. Local trust is ${level}.`;
    } else if (signals.networkIQS === 'high' && level === 'untrusted') {
      networkAdvisory = `Note: Network trust score is HIGH but local trust is untrusted. Consider verifying.`;
    }
  }

  return { level, reason, networkAdvisory, downgraded };
}

/**
 * Check if a trust upgrade is allowed.
 *
 * Only user-granted and paired-machine-granted sources can upgrade trust. (or 'agent-proposal', identity-security-piece1b)
 * No auto-escalation ever.
 */
export function canUpgradeTrust(
  currentLevel: TrustLevel,
  targetLevel: TrustLevel,
  source: TrustSource,
): { allowed: boolean; reason: string } {
  const order: TrustLevel[] = ['untrusted', 'verified', 'trusted'];
  const currentIdx = order.indexOf(currentLevel);
  const targetIdx = order.indexOf(targetLevel);

  if (targetIdx <= currentIdx) {
    return { allowed: false, reason: 'Target level is not higher than current level' };
  }

  const allowedSources: TrustSource[] = ['user-granted', 'paired-machine-granted', 'invitation', 'os-verified', 'agent-proposal'];
  if (!allowedSources.includes(source)) {
    return { allowed: false, reason: `Source "${source}" cannot upgrade trust. Requires user or verified source.` };
  }

  return { allowed: true, reason: `Upgrade from ${currentLevel} to ${targetLevel} via ${source}` };
}

/**
 * Determine same-machine trust eligibility.
 * Returns 'verified' if trust-domain criteria are met, null otherwise.
 *
 * Spec Section 3.5: Same OS user + same host + local IPC = auto-verified.
 */
export function evaluateSameMachineTrust(
  localUid: number,
  remoteUid: number,
  isLocalTransport: boolean,
): { eligible: boolean; reason: string } {
  if (!isLocalTransport) {
    return { eligible: false, reason: 'Not a local transport (Unix domain socket or loopback required)' };
  }
  if (localUid !== remoteUid) {
    return { eligible: false, reason: `Different OS user: local=${localUid}, remote=${remoteUid}` };
  }
  return { eligible: true, reason: 'Same OS user, local transport — auto-verified eligible' };
}
