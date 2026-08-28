import { createHash } from 'node:crypto';
import type {
  SubscriptionLoginCauseClass,
  SubscriptionLoginEpisode,
} from './SubscriptionLoginLedger.js';
import type { SubscriptionReloginMode } from './SubscriptionReloginStore.js';

const ACTIONABLE_CAUSES = new Set<SubscriptionLoginCauseClass>([
  'no-refresh-token',
  'exchange-failed',
  'malformed-response',
  'still-authfailed-after-refresh',
]);
const SUPPORTED_FRAMEWORKS = new Set(['claude-code']);
const SUPPORTED_LOGIN_METHODS = new Set(['session-cookie', 'password', 'password+totp']);

export type SubscriptionReloginRefusal =
  | 'feature-off'
  | 'pool-authority-not-ready'
  | 'account-not-needs-reauth'
  | 'source-episode-closed'
  | 'source-episode-wrong-cell'
  | 'source-not-exchange-corroborated'
  | 'source-not-directly-observed'
  | 'cause-not-actionable'
  | 'repair-already-live'
  | 'pending-login-already-live'
  | 'profile-unresolved'
  | 'profile-ambiguous'
  | 'profile-directory-missing'
  | 'profile-not-dedicated'
  | 'profile-identity-mismatch'
  | 'vault-reference-missing'
  | 'login-method-not-autonomous'
  | 'framework-not-supported'
  | 'breaker-open';

export interface SubscriptionReloginAdmissionInput {
  configuredMode: 'off' | SubscriptionReloginMode;
  poolAuthority: 'ready' | 'unconfigured' | 'invalid' | 'unavailable';
  account: {
    id: string;
    machineId: string;
    status: string;
    framework: string;
    provider: string;
    identityHash: string;
  };
  sourceEpisode: SubscriptionLoginEpisode;
  hasLiveRepair: boolean;
  hasLivePendingLogin: boolean;
  profile: null | {
    id: string;
    ambiguous: boolean;
    dirExists: boolean;
    dedicated: boolean;
    identityHash: string;
    loginMethod: string;
    danglingRefs: string[];
  };
  breakerOpen: boolean;
  unattended?: {
    explicitlyEnabled: boolean;
    successfulRepairs: number;
    evidenceDays: number;
    identityMismatches: number;
    unexpectedOrigins: number;
  };
}

export type SubscriptionReloginAdmission =
  | { admitted: false; reason: SubscriptionReloginRefusal }
  | {
      admitted: true;
      mode: SubscriptionReloginMode;
      unattendedHeld: boolean;
      inputDigest: string;
      profileId: string;
    };

/** Pure, deterministic admission. Metrics and LLM judgment are never action authority. */
export function evaluateSubscriptionReloginAdmission(
  input: SubscriptionReloginAdmissionInput,
): SubscriptionReloginAdmission {
  if (input.configuredMode === 'off') return refuse('feature-off');
  if (input.poolAuthority !== 'ready') return refuse('pool-authority-not-ready');
  if (input.account.status !== 'needs-reauth') return refuse('account-not-needs-reauth');
  if (input.sourceEpisode.closedAt !== null) return refuse('source-episode-closed');
  if (input.sourceEpisode.accountId !== input.account.id || input.sourceEpisode.machineId !== input.account.machineId)
    return refuse('source-episode-wrong-cell');
  if (input.sourceEpisode.corroboration !== 'exchange-corroborated')
    return refuse('source-not-exchange-corroborated');
  if (input.sourceEpisode.provenance !== 'observed') return refuse('source-not-directly-observed');
  if (!ACTIONABLE_CAUSES.has(input.sourceEpisode.causeClass)) return refuse('cause-not-actionable');
  if (input.hasLiveRepair) return refuse('repair-already-live');
  if (input.hasLivePendingLogin) return refuse('pending-login-already-live');
  if (!SUPPORTED_FRAMEWORKS.has(input.account.framework)) return refuse('framework-not-supported');
  if (!input.profile) return refuse('profile-unresolved');
  if (input.profile.ambiguous) return refuse('profile-ambiguous');
  if (!input.profile.dirExists) return refuse('profile-directory-missing');
  if (!input.profile.dedicated) return refuse('profile-not-dedicated');
  if (input.profile.identityHash !== input.account.identityHash) return refuse('profile-identity-mismatch');
  if (input.profile.danglingRefs.length > 0) return refuse('vault-reference-missing');
  if (!SUPPORTED_LOGIN_METHODS.has(input.profile.loginMethod)) return refuse('login-method-not-autonomous');
  if (input.breakerOpen) return refuse('breaker-open');

  let mode: SubscriptionReloginMode = input.configuredMode;
  let unattendedHeld = false;
  if (mode === 'unattended' && !unattendedGraduated(input.unattended)) {
    mode = 'approval';
    unattendedHeld = true;
  }
  return {
    admitted: true,
    mode,
    unattendedHeld,
    profileId: input.profile.id,
    inputDigest: digest({
      sourceEpisodeId: input.sourceEpisode.id,
      accountId: input.account.id,
      machineId: input.account.machineId,
      framework: input.account.framework,
      provider: input.account.provider,
      identityHash: input.account.identityHash,
      profileId: input.profile.id,
      mode,
    }),
  };
}

function unattendedGraduated(value: SubscriptionReloginAdmissionInput['unattended']): boolean {
  return value?.explicitlyEnabled === true
    && value.successfulRepairs >= 10
    && value.evidenceDays >= 30
    && value.identityMismatches === 0
    && value.unexpectedOrigins === 0;
}

function refuse(reason: SubscriptionReloginRefusal): SubscriptionReloginAdmission {
  return { admitted: false, reason };
}

function digest(value: Record<string, unknown>): string {
  const canonical = Object.keys(value).sort().map((key) => `${key}=${String(value[key])}`).join('\n');
  return `sha256:${createHash('sha256').update(canonical).digest('hex')}`;
}
