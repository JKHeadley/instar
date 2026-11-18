// The project app wrapper's rules (docs/specs/project-apps-sandbox.md §3.7), kept free of the DOM so
// they are tested on their own. Instar code; the app's code never runs here.

/** Renew this long before a key expires. */
export const RENEW_BEFORE_MS = 2 * 60_000;
/** A failed renewal retries after 30 s, 1, 2, 4 and 8 minutes, then every 15 minutes. */
export const BACKOFF_MS = [30_000, 60_000, 120_000, 240_000, 480_000];
export const BACKOFF_FLOOR_MS = 15 * 60_000;

/** Delay before the next try after `failures` consecutive failed renewals (1 = the first failure). */
export function backoffDelay(failures) {
  if (!Number.isInteger(failures) || failures < 1) return BACKOFF_MS[0];
  return failures <= BACKOFF_MS.length ? BACKOFF_MS[failures - 1] : BACKOFF_FLOOR_MS;
}

/** When to renew a key expiring at `exp`, from `now`: two minutes before, never in the past. */
export function renewDelay(exp, now) {
  return Math.max(0, exp - RENEW_BEFORE_MS - now);
}

/** The only messages the wrapper accepts from the frame. Anything else is ignored. */
export const ACCEPTED = new Set(['ready', 'summary-changed', 'open-conversation']);

/**
 * Judge one message event. The source must be the frame's own window (the origin is opaque, so the
 * source is the check); the data must be a plain `{type}` from the accepted list. open-conversation
 * carries no target: the wrapper always opens the app's own project conversation.
 */
export function acceptMessage(event, frameWindow) {
  if (!event || !frameWindow || event.source !== frameWindow) return null;
  const d = event.data;
  if (!d || typeof d !== 'object' || typeof d.type !== 'string' || !ACCEPTED.has(d.type)) return null;
  return d.type;
}

/**
 * What a key-route answer means for the wrapper:
 *   'ok'      → hand the new key to the frame and schedule the next renewal
 *   'reload'  → the served version changed: reload the frame with a fresh ticket, never re-key it
 *   'stopped' → the app has nothing to run (switched off, no version): stop and say so
 *   'retry'   → a passing failure: back off and show "Reconnecting…"
 */
export function classifyKeyAnswer(status, body) {
  if (status === 200 && body && typeof body.key === 'string') return 'ok';
  if (status === 409 && body && body.error === 'version-changed') return 'reload';
  if (status === 409 && body && body.error === 'not-served') return 'stopped';
  if (status === 404) return 'stopped';
  return 'retry';
}

/** The conversation link must stay on this dashboard: a same-origin path under /dashboard/. */
export function safeConversationHref(href) {
  return typeof href === 'string' && /^\/dashboard\/[^\s\\]*$/.test(href) && !href.startsWith('//') ? href : null;
}
