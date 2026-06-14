/**
 * Reap-notice delivery-id prefix — the ONE place the `reap-notify:` origin
 * tag on PendingRelayStore `delivery_id` primary keys is built and parsed.
 *
 * Spec: docs/specs/reap-notify-per-topic-and-midwork-resume-queue.md R1.3.
 *
 * The origin tag rides the delivery_id PK as a prefix (`reap-notify:<noticeId>`)
 * — zero DDL, PK-dedupe for free. Both drains scope their claim QUERIES on it:
 * ReapNoticeDrain claims rows inside the prefix range, DeliveryFailureSentinel
 * claims rows outside it. The range bounds below are written so SQLite can
 * serve the filter from the PK index (`delivery_id >= lower AND delivery_id <
 * upper`), never a bare LIKE.
 *
 * The tag is a routing label inside the trusted local process boundary, not an
 * auth boundary — anything that can write this store can already read the bot
 * token.
 *
 * No caller hand-assembles the string: ReapNotifier builds ids here, both
 * drains take the range bounds from here, and the contract tests assert every
 * store path preserves prefix semantics.
 */

export const REAP_NOTIFY_DELIVERY_PREFIX = 'reap-notify:';

/**
 * Exclusive upper bound of the prefix's PK range. ';' is ':' + 1 in ASCII, so
 * `delivery_id >= 'reap-notify:' AND delivery_id < 'reap-notify;'` matches
 * exactly the ids carrying the prefix — an index-compatible range predicate.
 */
export const REAP_NOTIFY_DELIVERY_PREFIX_UPPER = 'reap-notify;';

/** Charset clamp for notice ids embedded in the PK — keeps ids unambiguous
 *  and the range predicate airtight (no separator collisions). */
const NOTICE_ID_RE = /^[A-Za-z0-9._-]+$/;

/** Build a reap-notice delivery id. Throws on an id that would break the
 *  prefix contract (empty, or containing characters outside the clamp). */
export function buildReapNotifyDeliveryId(noticeId: string): string {
  if (!NOTICE_ID_RE.test(noticeId)) {
    throw new Error(
      `reap-notice-delivery-id: invalid noticeId ${JSON.stringify(noticeId)} — must match ${NOTICE_ID_RE}`,
    );
  }
  return `${REAP_NOTIFY_DELIVERY_PREFIX}${noticeId}`;
}

/** True when a delivery id carries the reap-notify origin prefix. */
export function isReapNotifyDeliveryId(deliveryId: string): boolean {
  return (
    deliveryId >= REAP_NOTIFY_DELIVERY_PREFIX && deliveryId < REAP_NOTIFY_DELIVERY_PREFIX_UPPER
  );
}

/** Extract the noticeId from a reap-notice delivery id; null when the id is
 *  not in the prefix range (or the embedded id violates the clamp). */
export function parseReapNotifyDeliveryId(deliveryId: string): string | null {
  if (!isReapNotifyDeliveryId(deliveryId)) return null;
  const noticeId = deliveryId.slice(REAP_NOTIFY_DELIVERY_PREFIX.length);
  return NOTICE_ID_RE.test(noticeId) ? noticeId : null;
}
