/**
 * WS5.2 §5.3 / S7 — resolve the OPERATOR-APPROVED enrollment target for an account, AUTHORITATIVELY,
 * from real pool state — NEVER from the request body. This is the keystone of the email-safety gate:
 * `expectedEmail` MUST be what the operator approved (the account's known email across the mesh), so
 * `completeFollowMe` can later validate the freshly-minted login against it. A self-asserted email in
 * the request body would defeat the gate entirely (S7), so this function only ever reads from the same
 * authoritative source the scan uses: the local SubscriptionPool + the per-peer pool views (which
 * carry each account's id + email from the replicated `subscription-account-meta` projection).
 *
 * FAIL-CLOSED by construction: if the account's email cannot be resolved from any holder, this returns
 * `{ resolved: false }` and the caller MUST refuse (409) rather than starting an enrollment with a
 * blank/wrong expectedEmail. Pure (no I/O) ⇒ unit-testable; the route supplies the fetched views.
 */

import type { MachinePoolView } from './accountFollowMeDepth.js';

/** A local SubscriptionPool account row, as the resolver needs it. */
export interface LocalAccountRow {
  id: string;
  email?: string;
  nickname?: string;
  provider?: string;
  framework?: string;
}

export interface ResolveFollowMeEnrollTargetInput {
  accountId: string;
  /** This machine's local SubscriptionPool accounts (authoritative when the account is held here). */
  localAccounts: LocalAccountRow[];
  /** Cross-machine per-peer pool views (the same source the scan uses — carries id + email). */
  peerViews: MachinePoolView[];
  /** Fallbacks when the meta does not carry provider/framework (it usually does). */
  defaultProvider?: string;
  defaultFramework?: string;
}

export type ResolveFollowMeEnrollTargetResult =
  | {
      resolved: true;
      /** The OPERATOR-APPROVED account email (authoritative; never from the request body). */
      expectedEmail: string;
      provider: string;
      framework: string;
      /** Operator-facing label for the new pending login. */
      label: string;
    }
  | {
      resolved: false;
      code: 'account-record-missing-email' | 'account-record-email-conflict' | 'subscription-account-not-found';
      reason: string;
    };

/**
 * Resolve the approved email + provider/framework + label for `accountId`.
 *
 * Resolution order (authoritative-first):
 *   1. the LOCAL SubscriptionPool (if this machine already holds/knows the account) — most trustworthy;
 *   2. any PEER pool view that reports the account with a non-empty email (the replicated meta).
 * The email MUST be a non-empty string for the result to be `resolved` — otherwise fail-closed.
 */
export function resolveFollowMeEnrollTarget(
  input: ResolveFollowMeEnrollTargetInput,
): ResolveFollowMeEnrollTargetResult {
  const { accountId } = input;
  const defaultProvider = input.defaultProvider ?? 'anthropic';
  const defaultFramework = input.defaultFramework ?? 'claude-code';

  const candidates: Array<{ email: string; source: 'local' | 'peer'; row: LocalAccountRow }> = [];

  // Local and peer metadata are holder evidence. Resolution requires agreement:
  // first-holder-wins can silently target the wrong provider account.
  const local = input.localAccounts.find((a) => a.id === accountId);
  if (local && typeof local.email === 'string' && local.email.trim().length > 0) {
    candidates.push({ email: local.email.trim(), source: 'local', row: local });
  }

  let found = !!local;
  for (const view of input.peerViews) {
    for (const row of view.accounts) {
      if (row.accountId !== accountId) continue;
      found = true;
      if (typeof row.email === 'string' && row.email.trim().length > 0) {
        candidates.push({ email: row.email.trim(), source: 'peer', row: { id: accountId } });
      }
    }
  }

  if (!found) {
    return {
      resolved: false,
      code: 'subscription-account-not-found',
      reason: 'This subscription account is no longer registered.',
    };
  }
  if (candidates.length === 0) {
    return {
      resolved: false,
      code: 'account-record-missing-email',
      reason: 'This subscription account record is missing its email. Repair or re-enroll the account, then try again.',
    };
  }
  const keys = new Set(candidates.map((candidate) => candidate.email.toLowerCase()));
  if (keys.size !== 1) {
    return {
      resolved: false,
      code: 'account-record-email-conflict',
      reason: 'This account has conflicting emails on your machines. Repair or re-enroll the account records, then try again.',
    };
  }
  const selected = candidates.find((candidate) => candidate.source === 'local') ?? candidates[0]!;
  return {
    resolved: true,
    expectedEmail: selected.email,
    provider: (local?.provider && local.provider.length > 0) ? local.provider : defaultProvider,
    framework: (local?.framework && local.framework.length > 0) ? local.framework : defaultFramework,
    label: (local?.nickname && local.nickname.trim().length > 0) ? local.nickname.trim() : accountId,
  };
}
