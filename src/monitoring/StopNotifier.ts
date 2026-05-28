/**
 * StopNotifier — Layer B of notify-on-stop (docs/specs/NOTIFY-ON-STOP-SPEC.md,
 * Task 2 of the 2026-05-27 silent-stalls postmortem).
 *
 * The UnjustifiedStopGate evaluate route classifies every Stop. In `shadow`
 * mode the gate can judge a stop unjustified (decision `continue`) but CANNOT
 * block it — so the session goes silent anyway. And an `escalate` decision means
 * the gate couldn't even tell. Either way, an UNATTENDED session can stall
 * mid-task and the user never hears about it. StopNotifier turns those specific
 * classifications into ONE plain-English heads-up.
 *
 * It is a thin DECISION layer; delivery discipline (coalescing into one message,
 * the single system/lifeline topic, log-always) is reused from SentinelNotifier
 * via the injected `escalate` sink — StopNotifier never invents a second
 * notification path (post-2026-05-22 topic-spam fix).
 *
 * Signal-vs-authority: the Stop-hook router is a dumb thin client; the decision
 * about whether to ALARM the user lives here on the server, where the gate
 * decision, the session's attended-state, and the dedup ledger all exist.
 *
 * Spam controls (all enforced here):
 *   1. notify-worthy decision set ONLY (shadow+continue, or escalate).
 *   2. attended-gate — by default, only UNATTENDED (autonomous) sessions; an
 *      interactive session with the user present doesn't need a ping.
 *   3. per-session dedup — at most one notice per session per cooldown window.
 *   4. master enable flag (default ON — Justin explicitly asked to be told when
 *      a session stops; the gates above keep it near-silent in practice).
 */

export type StopGateMode = 'off' | 'shadow' | 'enforce';
export type StopGateDecision = 'continue' | 'allow' | 'escalate' | 'force_allow' | null;

export type StopNotifyOutcome =
  | 'sent'
  | 'disabled'
  | 'not-worthy'
  | 'skipped-attended'
  | 'skipped-dedup';

export interface StopNotifierConfig {
  /** Master gate. Default true (Justin's explicit "tell me why it stopped"). */
  enabled?: boolean;
  /** Only notify for unattended (autonomous) sessions. Default true. */
  unattendedOnly?: boolean;
  /** Per-session dedup window in ms. Default 30 min. */
  cooldownMs?: number;
}

export interface StopNotifierDeps {
  /**
   * Delegated delivery — coalesced, single system topic, log-always. Wired in
   * server.ts to a SentinelNotifier.escalate bound to the stop-notify channel.
   * Synchronous fire-and-forget (SentinelNotifier batches + sends async).
   */
  escalate: (sessionName: string, text: string) => void;
  now?: () => number;
}

export interface MaybeNotifyInput {
  sessionId: string;
  mode: StopGateMode;
  decision: StopGateDecision;
  /** Whether the stopping session is an autonomous (unattended) run. */
  autonomousActive: boolean;
  /** Optional short, already-sanitized context for the message (no raw logs). */
  detail?: string;
}

const DEFAULTS: Required<StopNotifierConfig> = {
  enabled: true,
  unattendedOnly: true,
  cooldownMs: 30 * 60_000,
};

/**
 * True for the stop classifications that mean "an unjustified/ambiguous stop the
 * user should hear about". Deliberately narrow:
 *   - shadow + `continue`: gate believes the stop was unjustified but can't block
 *     it (shadow) → the silent stall. THE core incident case.
 *   - `escalate`: gate couldn't determine justification → surface it.
 * Everything else stays silent: `allow` (routine/legit completion or awaiting
 * user), `continue` in ENFORCE (the session is blocked & continues — not
 * stopping), `force_allow` (continue-ceiling; operator already has the stuck
 * flag), and the fail-open/null cases (transient; DegradationReporter covers).
 */
export function isNotifyWorthyStop(mode: StopGateMode, decision: StopGateDecision): boolean {
  if (decision === 'escalate') return true;
  if (decision === 'continue' && mode === 'shadow') return true;
  return false;
}

export class StopNotifier {
  private readonly cfg: Required<StopNotifierConfig>;
  private readonly lastNotified = new Map<string, number>();

  constructor(
    private readonly deps: StopNotifierDeps,
    cfg: StopNotifierConfig = {},
  ) {
    this.cfg = { ...DEFAULTS, ...cfg };
  }

  get enabled(): boolean {
    return this.cfg.enabled === true;
  }

  /**
   * Evaluate a stop-gate decision and, if it is a notify-worthy unattended
   * stall not seen recently, hand a fixed-template heads-up to the delegated
   * sink. Pure-ish: returns the outcome for tests; the only side effect is the
   * (coalesced, log-always) escalate call. Never throws.
   */
  maybeNotify(input: MaybeNotifyInput): StopNotifyOutcome {
    if (!this.enabled) return 'disabled';
    if (!isNotifyWorthyStop(input.mode, input.decision)) return 'not-worthy';
    if (this.cfg.unattendedOnly && !input.autonomousActive) return 'skipped-attended';

    const now = (this.deps.now ?? Date.now)();
    const last = this.lastNotified.get(input.sessionId);
    if (last !== undefined && now - last < this.cfg.cooldownMs) return 'skipped-dedup';
    this.lastNotified.set(input.sessionId, now);

    try {
      this.deps.escalate(this.sessionName(input.sessionId), this.composeMessage(input));
    } catch {
      // Delivery is best-effort; a sink failure must never disturb the route.
    }
    return 'sent';
  }

  private sessionName(sessionId: string): string {
    // SentinelNotifier.friendly() trims platform prefixes; pass the id through.
    return sessionId || 'a background session';
  }

  private composeMessage(input: MaybeNotifyInput): string {
    const why =
      input.decision === 'escalate'
        ? "stopped mid-task and I couldn't confirm it was a justified place to stop"
        : 'stopped mid-task when it looked like there was still work to do';
    const detail = input.detail ? `\n\n${input.detail}` : '';
    return `A background run ${why}. Want me to pick it back up?${detail}`;
  }

  /** Test seam. */
  _resetForTests(): void {
    this.lastNotified.clear();
  }
}
