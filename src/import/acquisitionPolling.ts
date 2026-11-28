const MINUTE = 60_000;
export const DELIVERY_WINDOW_MS = 8 * 24 * 60 * MINUTE;
export const MAX_NOTICE_ATTEMPTS = 5;

/** One slot per observation, with the job's original deadline surviving clock ticks and restarts. */
export function nextDeliveryObservation(requestedAt: number, nextCheck: number, deadline: number, now: number): number | null {
  if (now < nextCheck || now >= deadline) return null;
  const elapsed = Math.max(0, now - requestedAt);
  const minutes = elapsed < 2 * 60 * MINUTE ? 15 : elapsed < 24 * 60 * MINUTE ? 30 : 60;
  return now + minutes * MINUTE;
}

export interface NoticeAttempts { attempts: number; nextAt: number }

/** Reserve before publishing. A process that dies with an unknown outcome spends that attempt. */
export function nextNoticeAttempt(previous: NoticeAttempts, now: number): NoticeAttempts | null {
  if (previous.attempts >= MAX_NOTICE_ATTEMPTS || now < previous.nextAt) return null;
  return {attempts:previous.attempts + 1, nextAt:now + MINUTE * 2 ** previous.attempts};
}
