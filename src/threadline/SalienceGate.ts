/**
 * SalienceGate — Decides whether a threadline reply should surface to the user.
 *
 * Per THREAD-TOPIC-LINKAGE-SPEC.md §5.4.
 *
 * When an agent in a topic-bound session sends a threadline message and a
 * reply later arrives, this gate classifies the reply as either:
 *
 *   - `user-visible` — surface to the originating Telegram topic (final
 *     answer, credentials ask, hard blocker, completion, permanent failure).
 *   - `agent-internal` — deliver to the topic session only; do not ping the
 *     user (acknowledgement, mid-negotiation, routine "received, will work").
 *
 * Architectural notes:
 *
 *  - This is a *smart authority* per docs/signal-vs-authority.md: LLM-backed
 *    with full conversational context (reply text, stated purpose, thread
 *    history). It does not hold blocking authority on the message itself —
 *    the reply is always delivered to the session; this gate only decides
 *    whether the user is also notified.
 *
 *  - It is intentionally separate from `PromiseBeacon.classifyProgress`, which
 *    answers a different question ("is the awaiting agent stalled?"). Mixing
 *    the two risks conceptual drift; keep them apart.
 *
 *  - On classifier error or timeout, falls open with a deterministic rule:
 *    user-visible on first reply (no prior `lastReplyAt`), agent-internal
 *    on subsequent. This biases toward not flooding the user while never
 *    silently swallowing first contact.
 */

export type SalienceVerdict = 'user-visible' | 'agent-internal';

export interface SalienceClassifyInput {
  /** The reply text from the remote agent. */
  replyBody: string;
  /** The stated purpose of the original send, captured at outbound time. */
  purpose?: string;
  /** Thread history, most recent first. Pass [] if not available. */
  history?: Array<{ from: string; body: string; createdAt?: string }>;
  /** True if this is the first reply on the thread (no prior reply seen). */
  isFirstReply: boolean;
  /** The remote agent's name, for context. */
  remoteAgent: string;
}

export interface SalienceClassifyResult {
  verdict: SalienceVerdict;
  reason: string;
  /** True when the result came from the fallback rule, not the LLM. */
  fromFallback: boolean;
}

/**
 * Signature of an injectable LLM classifier. Must return within `timeoutMs`
 * or the SalienceGate will fall back to the deterministic rule.
 */
export type SalienceClassifier = (
  input: SalienceClassifyInput,
  signal: AbortSignal,
) => Promise<{ verdict: SalienceVerdict; reason: string }>;

export interface SalienceGateConfig {
  /** Optional LLM classifier. When absent, the gate uses the fallback rule. */
  classify?: SalienceClassifier;
  /** Max time to wait for the classifier. Default 2000ms. */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 2000;

export const SALIENCE_RUBRIC = `You are deciding whether to surface a threadline reply to the human user
in their topic. The user delegated a task to their agent; the agent is talking
to another agent to complete it.

Mark "user-visible" if the reply:
  - Contains a final answer, deliverable, or data the user asked for.
  - Asks the user a question only the user can answer (credentials, decisions,
    permissions).
  - Reports a hard blocker that the user needs to unblock.
  - Indicates the task is complete or has failed permanently.

Mark "agent-internal" if the reply:
  - Is an acknowledgement, mid-negotiation, clarification between agents, or
    progress check the receiving agent can act on without user involvement.
  - Is a routine "received, will work on it" message.

Respond with exactly one of: user-visible, agent-internal — plus a one-line
reason.`;

export class SalienceGate {
  private readonly classify?: SalienceClassifier;
  private readonly timeoutMs: number;

  constructor(config: SalienceGateConfig = {}) {
    this.classify = config.classify;
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /**
   * Classify an inbound reply. Never throws — always returns a verdict,
   * even on classifier error or timeout.
   */
  async evaluate(input: SalienceClassifyInput): Promise<SalienceClassifyResult> {
    if (!this.classify) {
      return this.fallback(input, 'no-classifier-configured');
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const llm = await this.classify(input, controller.signal);
      return {
        verdict: llm.verdict,
        reason: llm.reason,
        fromFallback: false,
      };
    } catch (err) {
      const reason = err instanceof Error
        ? `classifier-error: ${err.message}`
        : 'classifier-error: unknown';
      return this.fallback(input, reason);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Deterministic fallback. Public so callers can inspect / test it.
   *
   * Rule: user-visible on first reply, agent-internal on subsequent.
   * Biases toward not flooding the user while never silently swallowing
   * the first contact on a thread.
   */
  fallback(input: SalienceClassifyInput, reason: string): SalienceClassifyResult {
    return {
      verdict: input.isFirstReply ? 'user-visible' : 'agent-internal',
      reason: `fallback: ${reason} (first-reply=${input.isFirstReply})`,
      fromFallback: true,
    };
  }
}
