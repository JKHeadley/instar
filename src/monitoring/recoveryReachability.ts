/**
 * recoveryReachability — single delivery policy for sentinel user-facing
 * notices. Closes the silent-no-op class of bugs where a sentinel detects
 * a failure correctly but its notify path returns null because no Telegram
 * topic is bound to the failing session.
 *
 * Spec: docs/specs/SENTINEL-REACHABILITY-SPEC.md (A1, A4).
 *
 * Routing order:
 *   1. topic-bound session  → that topic
 *   2. lifeline topic       → the agent's single always-available system topic
 *   3. audit-only fallback  → write a structured `recovery-unreachable` event
 *                             so the failure surfaces in logs + the dashboard
 *                             alerts panel rather than being silently dropped
 *
 * The audit-only fallback never throws — recovery delivery is best-effort by
 * contract, but it MUST leave a trace under every condition. A silent return
 * is forbidden.
 *
 * This is a delivery sink (no blocking authority). The caller — the sentinel —
 * owns the decision to send. See SentinelNotifier for the housekeeping vs
 * escalation policy that wraps this on the silently-stopped trio.
 */

export type Reached = 'topic' | 'lifeline' | 'audit-only';

export interface ReachabilityResult {
  reached: Reached;
  topicId?: number;
  fallbackTried: string[];
  error?: string;
}

export interface ReachabilityDeps {
  /** The topic bound to this session, if any. */
  topicForSession: (sessionName: string) => number | undefined;
  /** The agent's lifeline (system) topic id, if configured. */
  lifelineTopicId: () => number | undefined;
  /** Send a message to a specific topic. Resolves on delivery, rejects on failure. */
  sendToTopic: (topicId: number, text: string) => Promise<void>;
  /**
   * Record a `recovery-unreachable` audit event. Called when both the
   * session topic and the lifeline are unavailable, so the failure is never
   * silently dropped. Implementations should append to the sentinel JSONL
   * audit log + surface to the dashboard.
   */
  auditUnreachable: (sessionName: string, sentinel: string, text: string, fallbackTried: string[]) => void;
  /** Optional: a hook the caller can use to mark delivery succeeded (e.g. for metrics). */
  auditReached?: (sessionName: string, sentinel: string, reached: Reached, topicId?: number) => void;
}

export async function deliverReachable(
  sessionName: string,
  sentinel: string,
  text: string,
  deps: ReachabilityDeps,
): Promise<ReachabilityResult> {
  const tried: string[] = [];

  // 1. Topic binding (if present)
  const topicId = deps.topicForSession(sessionName);
  tried.push('topic');
  if (topicId != null) {
    try {
      await deps.sendToTopic(topicId, text);
      deps.auditReached?.(sessionName, sentinel, 'topic', topicId);
      return { reached: 'topic', topicId, fallbackTried: tried };
    } catch (err) {
      // Fall through to lifeline. Topic-send failures are expected when the
      // topic was deleted or the bot was kicked — exactly the case where
      // we want the lifeline backstop to fire.
      tried.push(`topic-error:${shortErr(err)}`);
    }
  }

  // 2. Lifeline fallback
  const lifeline = deps.lifelineTopicId();
  tried.push('lifeline');
  if (lifeline != null) {
    try {
      // Prefix the per-session label so the operator can tell which session
      // a lifeline-routed notice is about, since they all land in one topic.
      const labelled = `[${sentinel}/${friendly(sessionName)}] ${text}`;
      await deps.sendToTopic(lifeline, labelled);
      deps.auditReached?.(sessionName, sentinel, 'lifeline', lifeline);
      return { reached: 'lifeline', topicId: lifeline, fallbackTried: tried };
    } catch (err) {
      tried.push(`lifeline-error:${shortErr(err)}`);
    }
  }

  // 3. Audit-only (never silent)
  tried.push('audit');
  deps.auditUnreachable(sessionName, sentinel, text, tried);
  return { reached: 'audit-only', fallbackTried: tried };
}

function friendly(sessionName: string): string {
  return sessionName.replace(/^ai\.instar\./, '').replace(/-server$/, '').replace(/-lifeline$/, '');
}

function shortErr(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.slice(0, 60).replace(/[\n\r]/g, ' ');
}
