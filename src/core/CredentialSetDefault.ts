/**
 * The one set-default operation shared by the HTTP lever and autonomous callers.
 * It only resolves ledger slots and delegates the exchange to CredentialSwapExecutor;
 * it owns no credential state and creates no parallel store.
 */

import { credentialSlotKey } from './OAuthRefresher.js';
import type { CredentialLocationLedger } from './CredentialLocationLedger.js';
import type { CredentialSwapExecutor, SwapResult, SwapOutcome } from './CredentialSwapExecutor.js';
import type { CredentialManualLevers } from './CredentialManualLevers.js';
import type { CredentialAuditEmit } from './CredentialAuditEmit.js';

export type SetDefaultCredentialResult =
  | ({ ok: true; accountId: string; forced: boolean; outcome: SwapOutcome | 'noop' } & Omit<SwapResult, 'outcome'>)
  | { ok: false; accountId: string; status: 400 | 429; code: string; reason: string };

export interface SetDefaultCredentialDeps {
  ledger: CredentialLocationLedger;
  swapExecutor: CredentialSwapExecutor;
  levers: CredentialManualLevers;
  audit: CredentialAuditEmit;
}

export async function setDefaultCredentialAccount(
  deps: SetDefaultCredentialDeps,
  accountId: string,
  opts: { force?: boolean; sourceContext?: 'credential-set-default' | 'proactive-default-slot' } = {},
): Promise<SetDefaultCredentialResult> {
  const assignments = deps.ledger.getAssignments();
  const sourceSlot = assignments.find((a) => a.accountId === accountId)?.slot;
  if (!sourceSlot) {
    return { ok: false, accountId, status: 400, code: 'unknown-account', reason: `unknown account — ${accountId} is not a known ledger tenant` };
  }
  const defaultKey = credentialSlotKey('~/.claude');
  const defaultSlot = assignments.find((a) => credentialSlotKey(a.slot) === defaultKey)?.slot;
  if (!defaultSlot) {
    return { ok: false, accountId, status: 400, code: 'missing-default-slot', reason: 'no default (~/.claude) slot is in the ledger — cannot set-default' };
  }
  if (sourceSlot === defaultSlot) {
    return { ok: true, accountId, forced: false, outcome: 'noop', reason: `${accountId} is already the default-slot tenant` };
  }

  const verdict = deps.levers.evaluateSwap(sourceSlot, defaultSlot, opts.force === true);
  if (!verdict.allowed) {
    deps.audit.audit({ event: 'set-default-refused', accountId, code: verdict.code, reason: verdict.reason, sourceContext: opts.sourceContext });
    return { ok: false, accountId, status: 429, code: verdict.code, reason: verdict.reason };
  }

  deps.audit.audit({ event: 'set-default-invoked', accountId, sourceSlot, defaultSlot, forced: verdict.forced, sourceContext: opts.sourceContext });
  try {
    const result = await deps.swapExecutor.swap(sourceSlot, defaultSlot);
    if (result.outcome === 'swapped') deps.levers.recordSwap(sourceSlot, defaultSlot, verdict.forced);
    void deps.audit.attention({
      id: `credential-set-default:${accountId}`,
      title: 'The default credential account was flipped',
      summary: `set-default → ${accountId} into ~/.claude: ${result.outcome}${verdict.forced ? ' (FORCED)' : ''}. ${result.reason}`,
      category: 'credential-repointing',
      priority: 'NORMAL',
      sourceContext: opts.sourceContext ?? 'credential-set-default',
    });
    deps.audit.audit({ event: 'set-default-result', accountId, outcome: result.outcome, sourceContext: opts.sourceContext });
    return { ok: true, accountId, forced: verdict.forced, ...result };
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'set-default failed';
    deps.audit.audit({ event: 'set-default-error', accountId, error: reason, sourceContext: opts.sourceContext });
    throw error;
  }
}
