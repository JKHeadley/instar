/**
 * MenteeConfig — public surface for the mentee-side receiver wiring of the
 * Agent-to-Agent Telegram comms primitive (MENTOR-LIVE-READINESS-SPEC
 * §Recipient side).
 *
 * Any instar-hosted agent can act as a mentee by enabling this block. When
 * enabled and properly configured, `AgentServer.start()` installs an
 * agent-message hook on the PRIMARY TelegramAdapter that:
 *
 *   1. Intercepts inbound a2a-marker messages BEFORE normal user routing.
 *   2. Verifies the marker's `from` is in `knownMentors` and the sender bot id
 *      matches (anti-spoof — `from.is_bot===true` or `sender_chat` required).
 *   3. Dispatches to the `mentor` role-handler, which spawns a mentee session
 *      with the body as prompt, bounded-waits, and captures the transcript.
 *   4. Sends the captured reply back via `sendAgentMessage` with
 *      `role='mentor-reply'` and `corr=<incoming marker id>`. Reply-out is
 *      wired at the orchestrator level (not inside the handler) so handlers
 *      stay capture-only per the spec's capability-handle anti-loop design.
 *
 * Ships dormant: `enabled: false` by default. The wiring stays dark even when
 * enabled if `localAgentName` / `knownMentors` / `replyChatId` /
 * `replyTopicId` are missing — each absence logs a one-line skip and bails
 * (no partial wiring).
 */

export interface MenteeKnownMentor {
  /** The mentor's Telegram bot id (as a string — Telegram ids exceed JS number safety). */
  botId: string;
}

export interface MenteeConfig {
  /** Master switch. Default false (ships dormant). */
  enabled: boolean;
  /**
   * The local agent's name as it appears in the a2a marker's `to` field. A
   * marker with `to !== localAgentName` is dropped as
   * `agent-marker-wrong-recipient`.
   */
  localAgentName: string;
  /**
   * Allowlist of mentor agents → their Telegram bot id. The receiver gate
   * checks that an inbound marker's `from` is a key in this map AND that the
   * sender's bot id matches `botId`. Anything else is dropped as
   * `agent-marker-unknown` (spoof defense).
   */
  knownMentors: Record<string, MenteeKnownMentor>;
  /**
   * The Telegram chat id where mentor-replies should be sent. Should be the
   * same supergroup the mentor sent the original marker into (so the round-
   * trip stays visible in one place for human supervision).
   */
  replyChatId: string;
  /** The topic id within `replyChatId`. */
  replyTopicId: number;
  /**
   * Bounded-wait for the mentee session in milliseconds. Default 5 minutes.
   * On timeout, the session is killed and an empty reply is recorded — no
   * partial transcript is sent back. Mirror of the Stage-A spawn pattern.
   */
  sessionTimeoutMs: number;
}

export const DEFAULT_MENTEE_CONFIG: MenteeConfig = {
  enabled: false,
  localAgentName: '',
  knownMentors: {},
  replyChatId: '',
  replyTopicId: 0,
  sessionTimeoutMs: 5 * 60 * 1000,
};
