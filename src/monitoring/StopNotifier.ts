import { mergeDefaults } from '../core/mergeDefaults.js';
/**
 * StopNotifier — Layer B of notify-on-stop (docs/specs/NOTIFY-ON-STOP-SPEC.md,
 * Task 2 of the 2026-05-27 silent-stalls postmortem).
 *
 * The UnjustifiedStopGate evaluate route classifies every Stop. In `shadow`
 * mode the gate can judge a stop unjustified (decision `continue`) but CANNOT
 * block it — so an UNATTENDED run can stall mid-task and the user never hears
 * about it. StopNotifier turns that classification into ONE plain-English
 * heads-up in the run's OWN topic, naming the run and its last activity, so the
 * user's reply reaches the session that stopped.
 *
 * Narrowed 2026-11-01 (Lifeline noise bug): the first version also notified on
 * `escalate` and sent an unnamed "a background run stopped" line to the
 * lifeline. `escalate` is the gate's "not sure" answer (its prompt says to
 * prefer it when unsure) — about 1 stop in 9, mostly ordinary turn-ends — and an
 * unnamed lifeline notice cannot be acted on (a reply there reaches no run).
 * Both are now log-only: every classification is still recorded in
 * logs/sentinel-events.jsonl.
 *
 * Signal-vs-authority: the Stop-hook router is a dumb thin client; the decision
 * about whether to ALARM the user lives here on the server, where the gate
 * decision, the session's attended-state, and the dedup ledger all exist.
 *
 * Spam controls (all enforced here):
 *   1. notify-worthy decision set ONLY (shadow+continue).
 *   2. attended-gate — by default, only UNATTENDED (autonomous) sessions.
 *   3. named-run gate — the session must resolve to a topic with a live
 *      autonomous run (its goal names it); otherwise log-only.
 *   4. per-session dedup — at most one notice per session per cooldown window.
 *   5. master enable flag (default ON — Justin explicitly asked to be told when
 *      a session stops).
 */

export type StopGateMode = 'off' | 'shadow' | 'enforce';
export type StopGateDecision = 'continue' | 'allow' | 'escalate' | 'force_allow' | null;

export type StopNotifyOutcome =
  | 'sent'
  | 'disabled'
  | 'not-worthy'
  | 'logged-unsure'
  | 'skipped-attended'
  | 'logged-unnamed'
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
   * Deliver the notice into the run's own topic (where a reply reaches the
   * session). Synchronous fire-and-forget; server.ts sends async and logs the
   * delivery result.
   */
  notifyTopic: (topicId: string, sessionId: string, text: string) => void;
  /** Log-only record for a classification that does not reach the user. */
  log: (kind: 'escalation-suppressed', sessionId: string, detail: string) => void;
  now?: () => number;
}

export interface MaybeNotifyInput {
  sessionId: string;
  mode: StopGateMode;
  decision: StopGateDecision;
  /** Whether the stopping session is an autonomous (unattended) run. */
  autonomousActive: boolean;
  /** The topic the session serves, when resolved. */
  topicId?: string | null;
  /** Goal of the topic's LIVE autonomous run (names the run), when there is one. */
  runGoal?: string | null;
  /** The session's last message before stopping (untrusted; sanitized here). */
  lastActivity?: string | null;
}

const DEFAULTS: Required<StopNotifierConfig> = {
  enabled: true,
  unattendedOnly: true,
  cooldownMs: 30 * 60_000,
};

/**
 * True for the one stop classification the user should hear about:
 * shadow + `continue` — the gate believes the stop was unjustified (with an
 * evidence pointer to a plan/commit) but can't block it, so the session
 * silently stalls. THE core incident case.
 * Everything else stays silent: `escalate` (the gate's "not sure" — logged),
 * `allow` (routine/legit completion or awaiting user), `continue` in ENFORCE
 * (the session is blocked & continues — not stopping), `force_allow`
 * (continue-ceiling; operator already has the stuck flag), and the
 * fail-open/null cases (transient; DegradationReporter covers).
 */
export function isNotifyWorthyStop(mode: StopGateMode, decision: StopGateDecision): boolean {
  return decision === 'continue' && mode === 'shadow';
}

/** One line, bounded, safe inside an inline-code span. */
function clip(value: string, max: number): string {
  const flat = value.replace(/\s+/g, ' ').trim().replace(/`/g, "'");
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

export class StopNotifier {
  private readonly cfg: Required<StopNotifierConfig>;
  private readonly lastNotified = new Map<string, number>();

  constructor(
    private readonly deps: StopNotifierDeps,
    cfg: StopNotifierConfig = {},
  ) {
    this.cfg = mergeDefaults(DEFAULTS, cfg);
  }

  get enabled(): boolean {
    return this.cfg.enabled === true;
  }

  /**
   * Evaluate a stop-gate decision and, if it is a notify-worthy stall of a
   * named unattended run not seen recently, send a fixed-template heads-up to
   * that run's topic. Returns the outcome for tests. Never throws.
   */
  maybeNotify(input: MaybeNotifyInput): StopNotifyOutcome {
    if (!this.enabled) return 'disabled';
    if (input.decision === 'escalate') {
      this.safeLog(input.sessionId, 'gate unsure (escalate) — log-only');
      return 'logged-unsure';
    }
    if (!isNotifyWorthyStop(input.mode, input.decision)) return 'not-worthy';
    if (this.cfg.unattendedOnly && !input.autonomousActive) return 'skipped-attended';

    const topicId = input.topicId ? String(input.topicId).trim() : '';
    const goal = input.runGoal ? clip(input.runGoal, 120) : '';
    if (!topicId || !goal) {
      this.safeLog(input.sessionId, 'stopped with work left, but no named run/topic to tell — log-only');
      return 'logged-unnamed';
    }

    const now = (this.deps.now ?? Date.now)();
    const last = this.lastNotified.get(input.sessionId);
    if (last !== undefined && now - last < this.cfg.cooldownMs) return 'skipped-dedup';
    this.lastNotified.set(input.sessionId, now);

    try {
      this.deps.notifyTopic(topicId, input.sessionId, this.composeMessage(goal, input.lastActivity));
    } catch {
      // Delivery is best-effort; a sink failure must never disturb the route.
    }
    return 'sent';
  }

  private safeLog(sessionId: string, detail: string): void {
    try {
      this.deps.log('escalation-suppressed', sessionId, detail);
    } catch {
      // @silent-fallback-ok — the log is the audit trail; a write failure must
      // never disturb the stop-gate route.
    }
  }

  private composeMessage(goal: string, lastActivity?: string | null): string {
    const activity = lastActivity ? clip(lastActivity, 200) : '';
    const lines = [
      `⏸ Your background run \`${goal}\` stopped mid-task while there still looked to be work left.`,
    ];
    if (activity) lines.push(`Its last message: \`${activity}\``);
    lines.push('Reply here if you want it picked back up.');
    return lines.join('\n');
  }

  /** Test seam. */
  _resetForTests(): void {
    this.lastNotified.clear();
  }
}
