/**
 * missingLoginSessionWiring — the boot-wiring factory that builds the pure
 * MissingLoginSessionDetector's injected deps from the real server managers.
 *
 * Kept in a SEPARATE module from the detector core (increment 1) so that branch
 * stays cleanly rebasable — the detector module has zero imports of real managers,
 * and this file is the only place the neutral `MissingLoginAttention` shape is
 * adapted into the real attention-queue input, and the only place the two real
 * data sources (the subscription pool + the running-session list) are correlated.
 *
 * The adaptation (the load-bearing mapping the wiring test pins):
 *   MissingLoginAttention { title, body, priority:'high', dedupKey, source }
 *     → AttentionItemInput { id: dedupKey, title, summary: body,
 *                            category: 'monitoring', priority: 'HIGH',
 *                            sourceContext: source }
 *
 * The correlation (the only non-mechanical part):
 *   - Missing-login accounts: the subscription-pool accounts flagged
 *     `identityDrift.repairState === 'owner-relogin-required'` OR
 *     `identityDrift.actualAccountId === 'missing-local-login'` (a local login
 *     that has gone missing → a re-login is required). Mapped to
 *     { accountId: a.id, configHome: a.configHome }.
 *   - Live sessions: each running session carries its REAL login SLOT (its live
 *     `CLAUDE_CONFIG_DIR`, resolved by the server wiring from tmux via
 *     `SessionManager.configHomeForSession`). This is the config home the session
 *     is ACTUALLY running on. It is deliberately NOT resolved from the session's
 *     recorded `subscriptionAccountId`: under identity drift the recorded account
 *     diverges from the config home the session really runs on (2026-07-22
 *     justin-gmail incident — a session recorded `adriana` while its
 *     `CLAUDE_CONFIG_DIR` was the login-missing justin-gmail slot), so resolving
 *     via the account would land on the wrong slot and MISS the exact gap this
 *     guard exists for. A session whose real config home is unresolvable (no
 *     `configHome`) is SKIPPED (a fabricated configHome would be a false
 *     correlation). The detector's `computeStranded` then matches a session to a
 *     missing-login account by that real config home.
 */
import {
  MissingLoginSessionDetector,
  type MissingLoginSessionDetectorDeps,
  type MissingLoginAccount,
  type LiveSessionBinding,
  type MissingLoginAttention,
} from './MissingLoginSessionDetector.js';

/** The attention-item input the real TelegramAdapter.createAttentionItem consumes. */
export interface MissingLoginAttentionItemInput {
  id: string;
  title: string;
  summary: string;
  category: string;
  priority: 'URGENT' | 'HIGH' | 'NORMAL' | 'LOW';
  sourceContext?: string;
}

/** A minimal read over a subscription-pool account (mirrors SubscriptionPool.list()). */
export interface PoolAccountView {
  id: string;
  configHome?: string | null;
  identityDrift?: {
    repairState?: string;
    actualAccountId?: string;
  } | null;
}

/** A minimal read over a running session (mirrors SessionManager.listRunningSessions()). */
export interface RunningSessionView {
  /** The tmux session name (the operator-facing handle). */
  sessionName: string;
  /**
   * The session's REAL login slot — its live `CLAUDE_CONFIG_DIR`, resolved by the
   * server wiring from tmux (`SessionManager.configHomeForSession`). This is the
   * authoritative config home the session is running on, NOT its recorded
   * `subscriptionAccountId` (which diverges from the real slot under identity
   * drift — the exact case this guard exists for). Absent/empty ⇒ unresolvable
   * ⇒ the session is skipped (no false correlation).
   */
  configHome?: string | null;
  /** Optional topic id, purely for the operator-facing message (never load-bearing). */
  topicId?: number | null;
}

/** Real-manager deps the factory maps into the detector's injected callbacks. */
export interface MissingLoginSessionWiringDeps {
  /** Dark gate (the resolved config's `enabled`). */
  enabled: () => boolean;
  /** Dry-run mode (the resolved config's `dryRun`). */
  dryRun: () => boolean;
  /** Live subscription-pool accounts (self machine). Absent pool → treat as empty. */
  getPoolAccounts: () => PoolAccountView[];
  /** Live running sessions and the account each runs under. Absent manager → empty. */
  getRunningSessions: () => RunningSessionView[];
  /** Adapter into the real attention queue (createAttentionItem — fire-and-forget). */
  createAttentionItem: (item: MissingLoginAttentionItemInput) => void;
  /** Optional structured audit sink (forwarded verbatim to the detector). */
  audit?: (event: string, detail: Record<string, unknown>) => void;
}

/** True when the account's local login has gone missing (re-login required). */
function isMissingLogin(a: PoolAccountView): boolean {
  const d = a.identityDrift;
  if (!d) return false;
  return d.repairState === 'owner-relogin-required' || d.actualAccountId === 'missing-local-login';
}

/**
 * Build the injected deps from real managers and return the constructed detector.
 * The missing-login accounts are derived from the pool's identity-drift flags; a
 * session's login slot is its REAL config home (live `CLAUDE_CONFIG_DIR`, resolved
 * by the server wiring from tmux) — NOT its recorded `subscriptionAccountId` (which
 * diverges from the real slot under identity drift). An unresolvable session (no
 * real config home) is skipped, never guessed.
 */
export function makeMissingLoginSessionDetector(
  deps: MissingLoginSessionWiringDeps,
): MissingLoginSessionDetector {
  const injected: MissingLoginSessionDetectorDeps = {
    enabled: deps.enabled,
    dryRun: deps.dryRun,
    getMissingLoginAccounts: (): MissingLoginAccount[] => {
      const out: MissingLoginAccount[] = [];
      for (const a of deps.getPoolAccounts()) {
        const configHome = (a.configHome ?? '').trim();
        if (!configHome) continue; // no slot to strand a session on → skip
        if (isMissingLogin(a)) out.push({ accountId: a.id, configHome });
      }
      return out;
    },
    getLiveSessions: (): LiveSessionBinding[] => {
      // Correlate on each session's REAL config home (its live CLAUDE_CONFIG_DIR,
      // resolved upstream from tmux) — NOT its recorded subscriptionAccountId,
      // which diverges from the real slot under identity drift (the exact gap this
      // guard exists for). A session whose real config home is unresolvable is
      // skipped — a guessed configHome would be a false correlation.
      const out: LiveSessionBinding[] = [];
      for (const s of deps.getRunningSessions()) {
        const configHome = (s.configHome ?? '').trim();
        if (!configHome) continue; // unresolvable real slot → can't place → skip
        out.push({ sessionName: s.sessionName, configHome, topicId: s.topicId ?? null });
      }
      return out;
    },
    raiseAttention: (item: MissingLoginAttention) => {
      deps.createAttentionItem({
        id: item.dedupKey,
        title: item.title,
        summary: item.body,
        category: 'monitoring',
        priority: 'HIGH',
        sourceContext: item.source,
      });
    },
    audit: deps.audit,
  };
  return new MissingLoginSessionDetector(injected);
}
