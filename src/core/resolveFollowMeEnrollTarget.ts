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

/**
 * Config-home prefix for a follow-me enrollment slot, by framework.
 *
 * Each CLI reads its own home, so the prefix is not cosmetic: a codex-cli credential written under
 * a `.claude-followme-*` home is invisible to `codex`, and the enrollment can never complete. The
 * default stays `.claude-followme-` so every existing claude-code slot keeps its exact path.
 */
export function followMeConfigHomePrefix(framework: string | undefined): string {
  switch (framework) {
    case 'codex-cli':
      return '.codex-followme-';
    case 'gemini-cli':
      return '.gemini-followme-';
    case 'pi-cli':
      return '.pi-followme-';
    default:
      return '.claude-followme-';
  }
}

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
      code:
        | 'account-record-missing-email'
        | 'account-record-email-conflict'
        | 'account-record-kind-conflict'
        | 'subscription-account-not-found';
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
        // Carry the holder's provider/framework. This machine does not hold a peer-only account,
        // so the holder's row is the ONLY evidence of what kind of account it is.
        candidates.push({
          email: row.email.trim(),
          source: 'peer',
          row: { id: accountId, provider: row.provider, framework: row.framework },
        });
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
  // The account's KIND (provider/framework) decides which sign-in flow runs and which config-home
  // the credential lands in, so it gets the same agreement discipline as the email. Holders that
  // state a kind must agree; a holder that omits it abstains rather than voting for the default.
  const kinds = new Set(
    candidates
      .map((candidate) => candidate.row.provider)
      .filter((provider): provider is string => typeof provider === 'string' && provider.length > 0)
      .map((provider) => provider.toLowerCase()),
  );
  if (kinds.size > 1) {
    return {
      resolved: false,
      code: 'account-record-kind-conflict',
      reason: 'This account is recorded as a different kind of account on different machines. Repair or re-enroll the account records, then try again.',
    };
  }

  const selected = candidates.find((candidate) => candidate.source === 'local') ?? candidates[0]!;
  // Prefer the local row, then ANY holder that states the kind. Falling back to the default only
  // when nobody states it is the whole point: silently defaulting a peer-only Codex account to
  // Claude is what sent it down a sign-in flow it could never complete.
  const kindRow =
    (local?.provider && local.provider.length > 0 ? local : undefined) ??
    candidates.find((candidate) => typeof candidate.row.provider === 'string' && candidate.row.provider.length > 0)?.row;
  return {
    resolved: true,
    expectedEmail: selected.email,
    provider: (kindRow?.provider && kindRow.provider.length > 0) ? kindRow.provider : defaultProvider,
    framework: (kindRow?.framework && kindRow.framework.length > 0) ? kindRow.framework : defaultFramework,
    label: (local?.nickname && local.nickname.trim().length > 0) ? local.nickname.trim() : accountId,
  };
}
