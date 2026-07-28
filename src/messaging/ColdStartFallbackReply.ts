/**
 * Cold-Start Lifeline Fallback Reply (G1 — "The Agent Is Always Reachable")
 *
 * When a user messages a topic and the system genuinely cannot start (or restart)
 * a session for it, the user must never get silence — nor a bare, unhelpful error.
 * Per the constitutional standard "The Agent Is Always Reachable" corollary (2),
 * *no silent resource rejection*: any session denied / held / killed for a resource
 * reason emits ONE clear, plain-English notice (what, why, guidance) on a
 * DETERMINISTIC delivery path (`telegram.sendToTopic`, NOT the LLM tone gate that
 * can fail closed under the very pressure it would report).
 *
 * This builder produces that notice for the inbound cold-start/restart-failure path:
 *   (a) plainly says WHY the session couldn't start (classified, no dev jargon),
 *   (b) points the user to the always-alive Lifeline topic, and
 *   (c) hands them a ready copy-paste debug message to drop in the Lifeline — so the
 *       agent (which holds the tools to free resources) can diagnose it fast.
 *
 * Deliberately a pure function with no I/O so it is unit-testable in isolation, and
 * deliberately free of config keys / file paths / endpoints (the message is for a
 * human, and the standard routes the fix through the agent, never "edit your config").
 */

/** Whether the failed attempt was a fresh spawn or a restart of an existing session. */
export type ColdStartFailureKind = 'spawn' | 'restart';

/** The classified reason a cold-start failed — drives the plain-English "why". */
export type ColdStartReason = 'session-limit' | 'resource-pressure' | 'start-failure';

export interface ColdStartFallbackInput {
  /** The raw error thrown by the spawn/restart attempt. */
  error: unknown;
  /** The topic the user messaged (that couldn't get a session). */
  topicId: number;
  /** Human topic name if known (falls back to "#<id>"). */
  topicName?: string;
  /** This machine's label (id or nickname) for the debug message. Optional. */
  machineLabel?: string;
  /** The always-alive Lifeline topic id, if configured (undefined/null = none). */
  lifelineTopicId?: number | null;
  /** Whether this was a cold spawn or a restart. */
  kind: ColdStartFailureKind;
}

export interface ColdStartFallbackReply {
  /** The classified reason. */
  reason: ColdStartReason;
  /** The message to send to the FAILED topic (deterministic delivery path). */
  userMessage: string;
  /** The copy-paste block for the Lifeline (also embedded in userMessage when a Lifeline is known). */
  debugMessage: string;
  /** Lifeline topic id echoed back (null when not configured). */
  lifelineTopicId: number | null;
}

/** Honest custody notice for a message that collided with an active respawn. */
export const RESPAWN_COLLISION_NOTICE =
  `I got this message while the session was already restarting, so it was not queued or delivered. ` +
  `Please resend it once the restart finishes.`;

/**
 * Route the collision notice through the adapter's deterministic topic-send
 * funnel. Kept injectable so the exact user-visible send is behaviorally tested.
 */
export async function sendRespawnCollisionNotice(
  sendToTopic: (topicId: number, text: string) => Promise<unknown>,
  topicId: number,
): Promise<void> {
  await sendToTopic(topicId, RESPAWN_COLLISION_NOTICE);
}

/**
 * Classify a spawn/restart error into a user-facing reason. String inspection is
 * acceptable here because this is a SIGNAL (a help message), not an authority gate —
 * a misclassification only changes the wording, never whether the notice fires.
 */
export function classifyColdStartFailure(error: unknown): ColdStartReason {
  const msg = (error instanceof Error ? error.message : String(error ?? '')).toLowerCase();
  if (/session limit|max sessions|sessions?\s*\(.*\)\s*reached|\blimit reached\b|\blimit\b/.test(msg)) {
    return 'session-limit';
  }
  if (/memory|pressure|resource|quota|rate.?limit(?:ed)?|\bload\b|\bcpu\b|out of memory|oom/.test(msg)) {
    return 'resource-pressure';
  }
  return 'start-failure';
}

function reasonSentence(reason: ColdStartReason, kind: ColdStartFailureKind): string {
  const verb = kind === 'restart' ? 'restart' : 'start';
  switch (reason) {
    case 'session-limit':
      return `I couldn't ${verb} a session for this topic — I'm already running the maximum number of sessions at once.`;
    case 'resource-pressure':
      return `I couldn't ${verb} a session for this topic — the machine is under resource pressure right now.`;
    case 'start-failure':
    default:
      return `I couldn't ${verb} a session for this topic right now — an unexpected start-up error.`;
  }
}

/**
 * The copy-paste block the user drops into the Lifeline topic so the agent can
 * diagnose. Plain English only — no paths, keys, or endpoints.
 */
export function buildColdStartDebugMessage(input: ColdStartFallbackInput): string {
  const topicLabel = input.topicName
    ? `"${input.topicName}" (#${input.topicId})`
    : `#${input.topicId}`;
  const reason = classifyColdStartFailure(input.error);
  const where = input.machineLabel ? ` on ${input.machineLabel}` : '';
  const verb = input.kind === 'restart' ? 'restart' : 'start';
  const reasonWord =
    reason === 'session-limit' ? 'the session limit was reached'
      : reason === 'resource-pressure' ? 'the machine was under resource pressure'
        : 'an unexpected start-up error';
  return (
    `I tried to message topic ${topicLabel}${where} but the session couldn't ${verb} ` +
    `(${reasonWord}). Please free up resources and get that topic reachable again.`
  );
}

/**
 * Build the full cold-start fallback reply. Pure — caller delivers `userMessage`
 * on the deterministic path. When a Lifeline is configured the message points the
 * user there and embeds the copy-paste debug block; when it isn't, the message
 * still says why and gives honest retry guidance (messages aren't lost).
 */
export function buildColdStartFallbackReply(input: ColdStartFallbackInput): ColdStartFallbackReply {
  const reason = classifyColdStartFailure(input.error);
  const debugMessage = buildColdStartDebugMessage(input);
  const lifelineTopicId = input.lifelineTopicId ?? null;

  const lines: string[] = [`⚠️ ${reasonSentence(reason, input.kind)}`];

  if (lifelineTopicId && lifelineTopicId === input.topicId) {
    // The failing topic IS the Lifeline — don't send them elsewhere.
    lines.push(
      '',
      `This is your Lifeline topic, so you're in the right place — I'll work on freeing resources now. ` +
      `If it persists, paste this to flag it:`,
      '',
      debugMessage,
    );
  } else if (lifelineTopicId) {
    lines.push(
      '',
      `I always stay reachable in your Lifeline topic — head there and paste this so I can look into it:`,
      '',
      debugMessage,
    );
  } else {
    // No Lifeline configured — still give why + honest guidance.
    lines.push(
      '',
      `Your message isn't lost — try again in a moment, or resend once things settle.`,
    );
  }

  return { reason, userMessage: lines.join('\n'), debugMessage, lifelineTopicId };
}
