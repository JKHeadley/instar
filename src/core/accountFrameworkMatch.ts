/**
 * accountFrameworkMatch — does a caller-supplied pool account (or config home) belong to the
 * session's own framework?
 *
 * Origin: 2026-11-28, Mama topic 144319. A Codex-pinned topic respawned tagged with a Claude
 * account (justin-gmail) and landed on the Codex sign-in menu, because neither SessionRefresh nor
 * the interactive spawn checked an explicit account's framework. The spawn now drops such an
 * account and re-selects placement for its own framework.
 *
 * Pure. Unknown (no lookup, not a pool account, a lookup fault) is never a mismatch, so a missing
 * pool keeps today's behaviour exactly.
 */

export type AccountFrameworkLookup = (ref: { accountId?: string; configHome?: string }) => string | null;

/** A one-line reason when the account or home is of another framework, else null. */
export function accountFrameworkMismatch(
  lookup: AccountFrameworkLookup | null,
  framework: string,
  accountId: string | undefined,
  configHome: string | undefined,
): string | null {
  if (!lookup || (!accountId && !configHome)) return null;
  let byId: string | null = null;
  let byHome: string | null = null;
  try {
    byId = accountId ? lookup({ accountId }) : null;
    byHome = configHome ? lookup({ configHome }) : null;
  } catch {
    return null; // @silent-fallback-ok — a lookup fault keeps today's behaviour (no new refusal)
  }
  if (byId && byId !== framework) return `account ${accountId} is ${byId}`;
  if (byHome && byHome !== framework) return `config home belongs to a ${byHome} account`;
  return null;
}
