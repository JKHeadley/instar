/**
 * Robust consolidated-escalation send for SentinelNotifier.
 *
 * Background (incident 2026-06-09): the sentinel's `sendConsolidated` closures
 * did `try { sendToTopic(lifelineTopicId) } catch { return false }`. The
 * configured lifeline/system topic had been DELETED on the Telegram side, so
 * every send returned `400: message thread not found` — and the bare `catch`
 * black-holed it. 41 stall escalations in one day failed silently; the user got
 * pure silence and could not tell a stalled session from a working one.
 *
 * `TelegramAdapter.ensureLifelineTopic()` already knows how to recreate a
 * deleted lifeline topic and persist the new id — the send path just never
 * invoked it. This helper closes that gap: send to the lifeline topic; on
 * failure, self-heal via ensureLifelineTopic() and retry once; and NEVER
 * swallow the error silently (it is always logged).
 *
 * Pure + adapter-injected so it is unit-testable without a live Telegram.
 */

export interface ConsolidatedSendTelegram {
  getLifelineTopicId(): number | undefined | null;
  sendToTopic(topicId: number, text: string): Promise<unknown>;
  /** Recreates the lifeline/system topic if deleted, persists the new id, returns it (or null). */
  ensureLifelineTopic(): Promise<number | null>;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * True when the send error means the target topic is GONE (deleted/closed) — the
 * only case where the message definitely did NOT land, so recreating + retrying
 * is safe. We deliberately do NOT retry other (transient/network) errors: those
 * may have landed at Telegram before the response was lost, and a blind retry
 * would double-post the escalation (this path bypasses the /telegram/reply
 * content-dedup). A transient failure is recovered by the sentinel's next sweep.
 */
function isTopicGone(msg: string): boolean {
  return /message thread not found|thread not found|topic[ _-]?deleted|topic[ _-]?closed|chat not found/i.test(msg);
}

export async function sendConsolidatedWithSelfHeal(
  tg: ConsolidatedSendTelegram,
  text: string,
  log: (line: string) => void,
): Promise<boolean> {
  const topicId = tg.getLifelineTopicId();

  // Fast path: send to the currently-configured lifeline topic.
  if (topicId) {
    try {
      await tg.sendToTopic(topicId, text);
      return true;
    } catch (err) {
      // De-swallow (the original `catch { return false }` black-holed this).
      const msg = errMsg(err);
      if (!isTopicGone(msg)) {
        // Not a deleted-topic error — could be transient and may have partially
        // landed. Do NOT retry (avoid a duplicate escalation); the sentinel
        // re-escalates on its next sweep if the condition persists.
        log(`escalation send to lifeline topic ${topicId} failed (${msg}) — transient/non-topic-gone, not retrying`);
        return false;
      }
      log(`escalation send to lifeline topic ${topicId} failed (${msg}: topic gone) — self-healing`);
    }
  } else {
    log('escalation has no lifeline topic configured — establishing one');
  }

  // Self-heal: (re)establish the lifeline/system topic (recreates if deleted,
  // persists the new id) and retry the send once.
  let healed: number | null;
  try {
    healed = await tg.ensureLifelineTopic();
  } catch (err) {
    log(`escalation self-heal (ensureLifelineTopic) threw (${errMsg(err)}) — alert NOT delivered`);
    return false;
  }
  if (!healed) {
    log('escalation self-heal could not establish a lifeline topic — alert NOT delivered');
    return false;
  }

  try {
    await tg.sendToTopic(healed, text);
    return true;
  } catch (err) {
    log(`escalation retry to healed lifeline topic ${healed} failed (${errMsg(err)}) — alert NOT delivered`);
    return false;
  }
}
