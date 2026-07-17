/**
 * queuedNotice — the user-facing "your message was queued" text the lifeline
 * sends when it cannot forward a message to the server right now.
 *
 * Why this is its own module (bug fix, reported by peer agent Luna/Sagemind
 * 2026-07-17): the lifeline has TWO distinct "couldn't deliver right now"
 * states, and they must never be conflated in the user-facing text:
 *
 *   - serverHealthy === false → the server is genuinely down / unreachable.
 *       Historical wording: "Server is temporarily down. …" (accurate).
 *
 *   - serverHealthy === true  → the server is confirmed UP, but THIS forward
 *       failed (a transient 10s timeout / 5xx / 503-boot / connection blip).
 *       The old code told the user "Server is restarting." — which is false
 *       and alarming: nothing restarted. This branch is a reconnect, not a
 *       restart, so the notice must say so.
 *
 * Centralizing the wording here (instead of three inline if/else blocks in
 * TelegramLifeline) makes the healthy-vs-down distinction a single, tested
 * decision — the message and photo/file handlers all route through it.
 */

export type QueuedItemKind = 'message' | 'photo' | 'file';

/**
 * Build the user-facing queued-notice text.
 *
 * @param kind          which noun to use ("message" | "photo" | "file")
 * @param queueLength   current number of items in the durable queue
 * @param serverHealthy the supervisor's live health verdict at send time
 */
export function buildQueuedNotice(
  kind: QueuedItemKind,
  queueLength: number,
  serverHealthy: boolean,
): string {
  const noun = kind; // 'message' | 'photo' | 'file' are already the display nouns
  if (serverHealthy) {
    // Healthy server + failed forward → reconnecting, NOT restarting.
    return (
      `I'm having trouble reaching my server right now — your ${noun} is queued ` +
      `(${queueLength} in queue) and I'll deliver it as soon as I reconnect.`
    );
  }
  // Genuinely-down server (unchanged wording — preserves the accurate message).
  return (
    `Server is temporarily down. Your ${noun} has been queued (${queueLength} in queue). ` +
    `It will be delivered when the server recovers.`
  );
}
