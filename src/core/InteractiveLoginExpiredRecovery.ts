/**
 * InteractiveLoginExpiredRecovery — CMT-1008.
 *
 * THE PROBLEM (2026-10-25, sagemind agent "Luna"): a Claude pool account's CLI login had
 * expired, but its stored token still answered the OAuth usage endpoint, so the pool kept it
 * `active`. New Telegram-topic sessions were placed on it and showed "Login expired · Please run
 * /login" (newer Claude Code: "Not logged in · Run /login") on every turn. Nothing recovered them:
 * the expired-login detector only acted on job sessions, and the pool flip needed an UNREADABLE
 * credential. The manual fix that worked was `POST /subscription-pool/swap`.
 *
 * WHAT THIS DOES, once SessionManager reports an interactive session that has sat at that screen
 * past its dwell:
 *   1. Hands the sighting to the QuotaPoller, which (credential readable) moves the account to
 *      needs-reauth with the actionable `cli-login-expired-observed` cause — so placement skips
 *      it, a later usage read does not restore it, and the assisted sign-in repair can open.
 *   2. Swaps the session onto a signed-in account through the SAME reactive funnel the manual
 *      route uses (QuotaAwareScheduler.onQuotaPressure → SessionRefresh: account selection,
 *      anti-thrash observation, the in-flight-work gate, the refresh rate guard). A topic-bound
 *      session resumes its conversation on the new account.
 *
 * Its own brakes: a per-session cooldown (one swap attempt per session per cooldown), protected
 * sessions are never moved, and a live kill switch (`subscriptionPool.loginExpiredSwap.enabled:
 * false`) turns the swap off while leaving the pool marking in place.
 */

/** What SessionManager reports (detection only). */
export interface InteractiveLoginExpiredSignal {
  /** tmux session name — the key the swap funnel uses. */
  session: string;
  /** Display name, for logs. */
  sessionName: string;
  /** The config home the session's CLI actually runs under (null if unreadable). */
  configHome: string | null;
  /** The pool account the session is tagged with at spawn, when it is. */
  accountId: string | null;
  /** The matched CLI frame (audit only). */
  matchedLine: string;
  /** `protectedSessions` member — never moved automatically. */
  protected: boolean;
}

export type InteractiveLoginExpiredOutcome =
  | 'swapped'
  | 'swap-disabled'
  | 'protected'
  | 'cooldown'
  | 'gave-up'
  | 'no-account'
  | 'not-confirmed'
  | 'swap-refused'
  | 'swap-error';

export interface InteractiveLoginExpiredResult {
  outcome: InteractiveLoginExpiredOutcome;
  accountId: string | null;
  toAccountId?: string | null;
  /** The funnel's own refusal reason when it did not swap. */
  reason?: string;
  /** Whether the poller moved the account to needs-reauth on this call. */
  marked: boolean;
}

export interface InteractiveLoginExpiredRecoveryDeps {
  /** QuotaPoller.observeCliLoginExpired — the pool authority. */
  observe: (input: { configHome: string; session: string }) => Promise<{ accountId: string | null; marked: boolean; accountStatus?: string | null }>;
  /** QuotaAwareScheduler.onQuotaPressure (reactive semantics — no explicit target). */
  swap: (args: { sessionName: string; exhaustedAccountId: string; nowMs: number }) => Promise<{
    swapped: boolean; toAccountId: string | null; reason: string;
  }>;
  /** Live kill switch; read at call time. Absent ⇒ enabled. */
  swapEnabled?: () => boolean;
  now?: () => number;
  /** Per-session cooldown between swap attempts. */
  cooldownMs?: number;
  /** Per-session attempt cap (process lifetime). */
  maxAttempts?: number;
  logger?: { log: (m: string) => void; warn: (m: string) => void };
  /** Called once per swap that did not happen for a reason other than the brakes here. */
  onSwapFailed?: (input: { signal: InteractiveLoginExpiredSignal; accountId: string; reason: string }) => void;
}

export const INTERACTIVE_LOGIN_SWAP_COOLDOWN_MS = 10 * 60_000;
/** A session the swap could not move this many times is left alone (loud, once) until restart. */
export const INTERACTIVE_LOGIN_SWAP_MAX_ATTEMPTS = 3;

/**
 * The swap brake, pure (shared with the self-action convergence ratchet in
 * src/testing/selfActionRegistry.ts): one attempt per cooldown, at most `maxAttempts` per session.
 */
export function decideLoginExpiredSwap(input: {
  attempts: number; lastAttemptAtMs: number | null; nowMs: number; cooldownMs: number; maxAttempts: number;
}): 'attempt' | 'cooldown' | 'gave-up' {
  if (input.attempts >= input.maxAttempts) return 'gave-up';
  if (input.lastAttemptAtMs !== null && input.nowMs - input.lastAttemptAtMs < input.cooldownMs) return 'cooldown';
  return 'attempt';
}

/* @self-action-controller: interactive-login-expired-swap */
export class InteractiveLoginExpiredRecovery {
  private readonly attempts = new Map<string, { count: number; lastAt: number }>();
  private readonly maxAttempts: number;
  private readonly now: () => number;
  private readonly cooldownMs: number;
  private readonly logger: { log: (m: string) => void; warn: (m: string) => void };

  constructor(private readonly deps: InteractiveLoginExpiredRecoveryDeps) {
    this.now = deps.now ?? (() => Date.now());
    this.cooldownMs = deps.cooldownMs ?? INTERACTIVE_LOGIN_SWAP_COOLDOWN_MS;
    this.maxAttempts = deps.maxAttempts ?? INTERACTIVE_LOGIN_SWAP_MAX_ATTEMPTS;
    this.logger = deps.logger ?? { log: () => {}, warn: () => {} };
  }

  async handle(signal: InteractiveLoginExpiredSignal): Promise<InteractiveLoginExpiredResult> {
    // 1. The pool authority first, so the swap's account selection (and every later placement)
    //    already sees the dead login as needs-reauth.
    let observed: { accountId: string | null; marked: boolean; accountStatus?: string | null } = { accountId: null, marked: false };
    let observeFailed = false;
    if (signal.configHome) {
      try { observed = await this.deps.observe({ configHome: signal.configHome, session: signal.session }); }
      catch (err) { // @silent-fallback-ok — the swap below does not depend on the marking succeeding
        observeFailed = true;
        this.logger.warn(`[LoginExpiredRecovery] pool marking for ${signal.session} failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    const accountId = signal.accountId ?? observed.accountId;
    const base = { accountId, marked: observed.marked };

    if (signal.protected) return { ...base, outcome: 'protected' };
    if (this.deps.swapEnabled && !this.deps.swapEnabled()) return { ...base, outcome: 'swap-disabled' };
    if (!accountId) {
      this.logger.warn(`[LoginExpiredRecovery] ${signal.session}: no pool account owns ${signal.configHome ?? 'its login'} — cannot swap; the login needs a fresh sign-in`);
      return { ...base, outcome: 'no-account' };
    }
    // Move the session only once the pool AGREES the login is dead (needs-reauth). An unreadable
    // credential is not marked on one screen (a locked keychain fails every account alike, so a
    // swap would only restart the session onto the same failure); the corroborated two-session
    // rule marks it, and the re-offer after the retry interval then moves the session. A failed
    // or unavailable pool read does not block the move (the manual-route behavior).
    if (!observeFailed && observed.accountStatus !== undefined && observed.accountStatus !== 'needs-reauth') {
      this.logger.warn(`[LoginExpiredRecovery] ${signal.session}: ${accountId} is still ${observed.accountStatus ?? 'unknown'} in the pool (credential unreadable) — not moving the session yet`);
      return { ...base, outcome: 'not-confirmed' };
    }
    const nowMs = this.now();
    const prior = this.attempts.get(signal.session);
    const decision = decideLoginExpiredSwap({
      attempts: prior?.count ?? 0, lastAttemptAtMs: prior?.lastAt ?? null, nowMs,
      cooldownMs: this.cooldownMs, maxAttempts: this.maxAttempts,
    });
    if (decision !== 'attempt') return { ...base, outcome: decision };
    this.prune();
    this.attempts.set(signal.session, { count: (prior?.count ?? 0) + 1, lastAt: nowMs });

    try {
      const r = await this.deps.swap({ sessionName: signal.session, exhaustedAccountId: accountId, nowMs });
      if (r.swapped) {
        this.attempts.delete(signal.session); // a moved session starts a fresh budget
        this.logger.log(`[LoginExpiredRecovery] ${signal.session}: moved off expired login ${accountId} → ${r.toAccountId} (conversation resumed)`);
        return { ...base, outcome: 'swapped', toAccountId: r.toAccountId };
      }
      this.logger.warn(`[LoginExpiredRecovery] ${signal.session}: swap off ${accountId} refused (${r.reason})`);
      try { this.deps.onSwapFailed?.({ signal, accountId, reason: r.reason }); } catch { /* @silent-fallback-ok — reporting only */ }
      return { ...base, outcome: 'swap-refused', toAccountId: r.toAccountId, reason: r.reason };
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      this.logger.warn(`[LoginExpiredRecovery] ${signal.session}: swap off ${accountId} errored (${reason})`);
      try { this.deps.onSwapFailed?.({ signal, accountId, reason }); } catch { /* @silent-fallback-ok — reporting only */ }
      return { ...base, outcome: 'swap-error', reason };
    }
  }

  /** Bounded memory: keep at most 256 sessions (oldest attempt evicted first). */
  private prune(): void {
    while (this.attempts.size >= 256) {
      const oldest = [...this.attempts.entries()].sort((a, b) => a[1].lastAt - b[1].lastAt)[0];
      if (!oldest) return;
      this.attempts.delete(oldest[0]);
    }
  }
}
