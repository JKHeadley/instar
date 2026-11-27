/**
 * Which subscription account serves a feedback readiness call.
 *
 * Readiness reuses the triage account selector and its fresh, local verification (an active
 * codex-cli pool account, subscription-only credentials, a live quota read below 75%, the same
 * credential identity before and after the read). It never widens the readiness authority: the
 * operator-rooted record, provider, model family, batch and spend bounds stay exactly as they are.
 *
 * - `feedbackFactory.readiness.account` set (a pool account id): that verified account, or a
 *   named refusal. Never another account and never the shared default.
 * - no pin: `feedbackFactory.triage.accountSelectionMode` decides. `off` (the default) keeps the
 *   shared provider exactly as before; `observe` records which account would be chosen but still
 *   uses the shared provider; `on` uses the selected verified account, or refuses when none is.
 *
 * Signal, not authority: an admission refusal defers the rows to the next review. It never
 * demotes the readiness authority and never approves anything.
 */
import { CODEX_CLI_FRAMEWORK } from '../../core/frameworkFacts.js';
import type { SubscriptionPool } from '../../core/SubscriptionPool.js';
import {
  revalidateTriageAccount, verifyTriageExecutionIdentity,
  type FeedbackTriageAccountSelector, type VerifiedTriageAccount,
} from '../triage/FeedbackTriageAccountSelector.js';

export type ReadinessAccountMode = 'off' | 'observe' | 'on';

export interface ReadinessAccountConfig {
  mode: ReadinessAccountMode;
  /** The pinned pool account id, or null when none is pinned. */
  pinnedAccountId: string | null;
}

const ACCOUNT_ID = /^[A-Za-z0-9._@+-]{1,120}$/;

export function resolveReadinessAccountConfig(feedbackFactory: {
  triage?: { accountSelectionMode?: unknown } | undefined;
  readiness?: { account?: unknown } | undefined;
} | undefined): ReadinessAccountConfig {
  const mode = feedbackFactory?.triage?.accountSelectionMode;
  const pin = typeof feedbackFactory?.readiness?.account === 'string' ? feedbackFactory.readiness.account.trim() : '';
  return {
    mode: mode === 'observe' || mode === 'on' ? mode : 'off',
    pinnedAccountId: pin.length > 0 ? pin : null,
  };
}

export type ReadinessRefusalReason =
  | 'pinned-account-invalid-id'
  | 'pinned-account-provider-mismatch'
  | 'pinned-account-missing'
  | 'pinned-account-unverified'
  | 'pinned-account-saturated'
  | 'pinned-account-quota-unreadable'
  | 'account-selection-unavailable'
  | 'all-accounts-saturated'
  | 'no-verified-account';

export type ReadinessAdmission =
  | { kind: 'shared'; reason: 'selection-off' | 'observe-only' | 'non-codex-provider'; observedAccountId: string | null }
  | { kind: 'account'; account: VerifiedTriageAccount; pinned: boolean }
  | { kind: 'refused'; reason: ReadinessRefusalReason; pinned: boolean };

export interface ReadinessAccountAdmission {
  config(): ReadinessAccountConfig;
  /** Decide the serving account for one readiness call. Never throws. */
  admit(provider: string, deadlineAt: number): Promise<ReadinessAdmission>;
  /** The account is still active, with the same credential, and its quota read is under a minute old. */
  revalidate(account: VerifiedTriageAccount): boolean;
  /** After the call: the same credential identity still holds (quota age does not matter here). */
  verifyExecutionIdentity(account: VerifiedTriageAccount): boolean;
}

export function buildReadinessAccountAdmission(input: {
  config: () => ReadinessAccountConfig;
  selector: FeedbackTriageAccountSelector | null;
  pool: SubscriptionPool | null;
  clock?: () => number;
}): ReadinessAccountAdmission {
  const clock = input.clock ?? Date.now;
  return {
    config: input.config,
    async admit(provider, deadlineAt) {
      const { mode, pinnedAccountId } = input.config();
      try {
        if (pinnedAccountId !== null) {
          if (!ACCOUNT_ID.test(pinnedAccountId)) return { kind: 'refused', reason: 'pinned-account-invalid-id', pinned: true };
          if (provider !== CODEX_CLI_FRAMEWORK) return { kind: 'refused', reason: 'pinned-account-provider-mismatch', pinned: true };
          if (!input.selector) return { kind: 'refused', reason: 'account-selection-unavailable', pinned: true };
          const picked = await input.selector.selectPinned(pinnedAccountId, deadlineAt);
          if (picked.state === 'eligible') return { kind: 'account', account: picked.account, pinned: true };
          const reason: ReadinessRefusalReason = picked.state === 'missing' ? 'pinned-account-missing'
            : picked.state === 'unverified' ? 'pinned-account-unverified'
              : picked.state === 'saturated' ? 'pinned-account-saturated' : 'pinned-account-quota-unreadable';
          return { kind: 'refused', reason, pinned: true };
        }
        if (mode === 'off') return { kind: 'shared', reason: 'selection-off', observedAccountId: null };
        if (provider !== CODEX_CLI_FRAMEWORK) return { kind: 'shared', reason: 'non-codex-provider', observedAccountId: null };
        if (!input.selector) {
          return mode === 'observe'
            ? { kind: 'shared', reason: 'observe-only', observedAccountId: null }
            : { kind: 'refused', reason: 'account-selection-unavailable', pinned: false };
        }
        const selected = await input.selector.select(deadlineAt);
        if (mode === 'observe') {
          return { kind: 'shared', reason: 'observe-only', observedAccountId: selected.state === 'eligible' ? selected.account.accountId : null };
        }
        if (selected.state === 'eligible') return { kind: 'account', account: selected.account, pinned: false };
        return { kind: 'refused', reason: selected.state === 'saturated' ? 'all-accounts-saturated' : 'no-verified-account', pinned: false };
      } catch {
        // @silent-fallback-ok: not a fallback; the refusal is recorded and shown in drain status
        return { kind: 'refused', reason: pinnedAccountId !== null ? 'pinned-account-quota-unreadable' : 'no-verified-account', pinned: pinnedAccountId !== null };
      }
    },
    revalidate: (account) => Boolean(input.pool && revalidateTriageAccount(input.pool, account, clock())),
    verifyExecutionIdentity: (account) => Boolean(input.pool && verifyTriageExecutionIdentity(input.pool, account)),
  };
}
