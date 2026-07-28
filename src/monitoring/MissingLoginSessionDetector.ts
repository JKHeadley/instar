/**
 * MissingLoginSessionDetector — signal-only guard that surfaces the
 * "a live session is running on an account whose login has gone missing" gap
 * BEFORE the session dies silently.
 *
 * The failure it closes (2026-07-22, the justin-gmail silent auth-death): a live
 * autonomous session was running on an account whose LOCAL LOGIN went missing
 * (the subscription pool flagged `identityDrift.repairState ===
 * 'owner-relogin-required'`, `actualAccountId === 'missing-local-login'`) while
 * that account still had ~92% of its quota free. The session coasted on a cached
 * credential, then — once that credential expired — every turn began failing on
 * auth and the session went SILENT for ~2.5 hours. NOTHING alerted the operator;
 * they had to notice the silence themselves and re-login by hand. The drift WAS
 * detected by the pool, but it was never raised as an alert, and the reactive
 * standby classifier only fires when the user sends a message (which, for hours,
 * they did not).
 *
 * This detector makes that gap loud + PROACTIVE: when a live session is bound to
 * an account whose login is missing, it raises ONE deduped attention item naming
 * the account and that a re-login is needed. It is SIGNAL-ONLY — it never swaps
 * accounts, never re-logins, never touches a session. It only tells the operator
 * (and future-me) that a running session is about to wall on a missing login.
 *
 * Why it is distinct from the existing surfaces (not a duplicate):
 *   - The subscription pool DETECTS the drift, but raises no alert on it.
 *   - The honest-standby StuckSignatureClassifier can name an auth failure, but
 *     only reactively — when the user messages. A heads-down run with no inbound
 *     message falls through it (exactly what happened). This fires proactively.
 *   - It correlates two facts the others don't join: "login is gone" AND "a live
 *     session depends on that account right now" — drift alone is not urgent;
 *     drift under a live session is.
 *
 * Pure + injected: every environment read is a callback, so this module unit
 * tests with zero real managers and no I/O.
 */

/** An account whose LOCAL login has gone missing (re-login required to recover). */
export interface MissingLoginAccount {
  accountId: string;
  /** The login "slot" (config home) the account serves from — how a session is matched to it. */
  configHome: string;
}

/** A live session and the login slot (config home) it is currently running on. */
export interface LiveSessionBinding {
  sessionName: string;
  configHome: string;
  /** Optional topic id, purely for the operator-facing message (never load-bearing). */
  topicId?: number | null;
}

/** The attention item this detector emits (shape kept minimal + transport-agnostic). */
export interface MissingLoginAttention {
  title: string;
  body: string;
  priority: 'high';
  /** Stable per-episode key so repeated ticks coalesce to ONE item. */
  dedupKey: string;
  source: 'missing-login-session';
}

export interface MissingLoginSessionDetectorDeps {
  /** Dark gate. When false the detector is a strict no-op (never reads, never raises). */
  enabled: () => boolean;
  /**
   * Observe-only mode. When true the detector computes the verdict and audits a
   * would-raise, but does NOT raise the attention item (the graduated-rollout
   * dry-run rung).
   */
  dryRun: () => boolean;
  /** Accounts whose local login is currently missing (owner-relogin-required). */
  getMissingLoginAccounts: () => MissingLoginAccount[];
  /** The live sessions and which login slot (config home) each runs on. */
  getLiveSessions: () => LiveSessionBinding[];
  /** Raise a deduped attention item. Only called on a genuine gap when not in dryRun. */
  raiseAttention: (item: MissingLoginAttention) => void;
  /** Optional structured audit sink (every transition, including no-ops with a reason). */
  audit?: (event: string, detail: Record<string, unknown>) => void;
}

/** One affected pairing: a missing-login account with the live sessions depending on it. */
export interface StrandedSession {
  accountId: string;
  sessionNames: string[];
}

export interface MissingLoginTickResult {
  ran: boolean;
  /** True when at least one live session is running on a missing-login account. */
  gapDetected: boolean;
  /** The affected account→sessions pairings (empty when no gap). */
  stranded: StrandedSession[];
  /** Whether an attention item was actually raised (false in dryRun even on a gap). */
  raised: boolean;
}

const DEDUP_KEY = 'missing-login-session';

// ── Config resolution (dev-gated dark; dry-run first) ───────────────────────

/** The resolved, typed config the detector runs with. */
export interface MissingLoginSessionResolvedConfig {
  /** Dev-agent gate: live on a development agent, dark on the fleet (unless set). */
  enabled: boolean;
  /** Dry-run first even on a dev agent: compute + audit, but do NOT raise. */
  dryRun: boolean;
}

/** The raw config block shape (all optional — everything defaults). */
export interface MissingLoginSessionConfigBlock {
  enabled?: boolean;
  dryRun?: boolean;
}

/**
 * Resolve `monitoring.missingLoginSession` against the dev-agent gate.
 * `resolveEnabled` is the injected `resolveDevAgentGate(explicit, config)` result
 * (kept as a param so this module stays free of a hard import — the server wiring
 * passes the real gate). `dryRun` defaults TRUE (the graduated-rollout first rung).
 */
export function resolveMissingLoginSessionConfig(
  block: MissingLoginSessionConfigBlock | undefined,
  resolveEnabled: (explicit: boolean | undefined) => boolean,
): MissingLoginSessionResolvedConfig {
  const b = block ?? {};
  return {
    enabled: resolveEnabled(typeof b.enabled === 'boolean' ? b.enabled : undefined),
    dryRun: typeof b.dryRun === 'boolean' ? b.dryRun : true,
  };
}

/** The guard-posture grade for `GET /guards`: dark ▸ dry-run ▸ live. */
export function guardStatusFor(cfg: MissingLoginSessionResolvedConfig): 'dark' | 'dry-run' | 'live' {
  return cfg.enabled ? (cfg.dryRun ? 'dry-run' : 'live') : 'dark';
}

/** The `status()` snapshot (the future `GET /pool/missing-login` body core). */
export interface MissingLoginSessionStatus {
  enabled: boolean;
  dryRun: boolean;
  lastTickAt: string | null;
  /** The affected account→sessions pairings seen on the LAST tick. */
  stranded: StrandedSession[];
  counters: { ticks: number; raises: number; wouldRaise: number; errors: number };
}

/**
 * The pure detector. One `tick()` = one evaluation. It raises at most one
 * (deduped) aggregate attention item per episode; the attention layer's own
 * dedup collapses repeated ticks so a persistent gap never floods.
 */
export class MissingLoginSessionDetector {
  private ticks = 0;
  private raises = 0;
  private wouldRaise = 0;
  private errors = 0;
  private lastTickAtMs = 0;
  private lastStranded: StrandedSession[] = [];

  constructor(
    private readonly deps: MissingLoginSessionDetectorDeps,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * One evaluation. Rides an existing shared timer (no timer of its own). Fails
   * toward silence: any internal error increments the error counter and emits
   * nothing — the shared tick must never crash. A dark guard is a strict no-op.
   */
  tick(): MissingLoginTickResult {
    if (!this.deps.enabled()) {
      return { ran: false, gapDetected: false, stranded: [], raised: false };
    }
    this.ticks += 1;
    this.lastTickAtMs = this.now();

    try {
      const missing = this.deps.getMissingLoginAccounts();
      const sessions = this.deps.getLiveSessions();

      const stranded = computeStranded(missing, sessions);
      this.lastStranded = stranded;

      if (stranded.length === 0) {
        this.audit('no-gap', {
          missingLoginAccounts: missing.length,
          liveSessions: sessions.length,
        });
        return { ran: true, gapDetected: false, stranded: [], raised: false };
      }

      if (this.deps.dryRun()) {
        this.wouldRaise += 1;
        this.audit('would-raise', { stranded });
        return { ran: true, gapDetected: true, stranded, raised: false };
      }

      this.deps.raiseAttention(buildAttention(stranded));
      this.raises += 1;
      this.audit('raised', { stranded });
      return { ran: true, gapDetected: true, stranded, raised: true };
    } catch (err) {
      this.errors += 1;
      this.audit('tick-error', { error: err instanceof Error ? err.message : String(err) });
      return { ran: true, gapDetected: false, stranded: [], raised: false };
    }
  }

  /** The read-surface snapshot (feeds the future GET route). */
  status(): MissingLoginSessionStatus {
    return {
      enabled: this.deps.enabled(),
      dryRun: this.deps.dryRun(),
      lastTickAt: this.lastTickAtMs ? new Date(this.lastTickAtMs).toISOString() : null,
      stranded: this.lastStranded,
      counters: { ticks: this.ticks, raises: this.raises, wouldRaise: this.wouldRaise, errors: this.errors },
    };
  }

  private audit(event: string, detail: Record<string, unknown>): void {
    try {
      this.deps.audit?.(event, detail);
    } catch {
      /* audit is best-effort — never let it break the tick */
    }
  }
}

/**
 * Pure correlation: for each missing-login account, collect the live sessions
 * bound to its login slot (config home). Only accounts with ≥1 dependent live
 * session are stranded (drift alone, with no session on it, is not a gap).
 */
export function computeStranded(
  missing: MissingLoginAccount[],
  sessions: LiveSessionBinding[],
): StrandedSession[] {
  const out: StrandedSession[] = [];
  for (const acct of missing) {
    const names = sessions
      .filter((s) => s.configHome && s.configHome === acct.configHome)
      .map((s) => s.sessionName);
    if (names.length > 0) {
      out.push({ accountId: acct.accountId, sessionNames: names });
    }
  }
  return out;
}

/** Build the operator-facing attention item for a confirmed gap. Plain language, no jargon. */
export function buildAttention(stranded: StrandedSession[]): MissingLoginAttention {
  const totalSessions = stranded.reduce((n, s) => n + s.sessionNames.length, 0);
  const sessionWord = totalSessions === 1 ? 'session' : 'sessions';
  const acctList = stranded.map((s) => s.accountId).join(', ');
  const acctWord = stranded.length === 1 ? 'account' : 'accounts';
  const body =
    `${totalSessions} live ${sessionWord} ${totalSessions === 1 ? 'is' : 'are'} running on ${acctWord} ` +
    `whose login has gone missing (${acctList}). The session works only until its cached credential ` +
    `expires — then every turn fails on authentication and it goes silent with no error to you. ` +
    `Re-login to that account now to keep it from going dark.`;
  return {
    title: 'A live session is running on a missing login',
    body,
    priority: 'high',
    dedupKey: DEDUP_KEY,
    source: 'missing-login-session',
  };
}

export const MISSING_LOGIN_SESSION_DEDUP_KEY = DEDUP_KEY;
