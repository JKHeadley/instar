/** Browser-side account-action review signal. Authored in TypeScript so decision-surface
 * review and tests can see it; installBrowserScripts materializes the unchanged
 * script beside chrome-js.sh. No agent-supplied code enters read-only mode. */
export const ACCOUNT_PAGE_SAFETY_SCRIPT = String.raw`/* Evaluated in Chrome's isolated world BEFORE caller code, in the same task.
 * Never receives caller JavaScript. Read mode has no evaluator or DOM writes.
 * The session agent reviews the signal with page and conversation context. */
(function accountPageSafety(readOnly, offset, reviewedPage, reviewReason) {
  const unreadable = !document.body;
  const text = document.body ? document.body.innerText : '';
  const parsedUrl = new URL(location.href);
  const url = parsedUrl.origin + parsedUrl.pathname; // never emit credential-shaped query or fragment values
  // A change detector, not an authorization token. Compare it across chunks.
  let hash = 2166136261;
  const identity = location.href + '\0' + text;
  for (let i = 0; i < identity.length; i++) hash = Math.imul(hash ^ identity.charCodeAt(i), 16777619) >>> 0;
  const pageFingerprint = url + ':' + text.length + ':' + hash.toString(16);
  if (readOnly) {
    if (unreadable) throw new Error('account-page-not-ready: no readable document body; wait and read the page before acting');
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > text.length) throw new Error('invalid-page-offset');
    const end = Math.min(offset + 6000, text.length);
    return JSON.stringify({ url, pageFingerprint, offset, totalChars: text.length, text: text.slice(offset, end),
      complete: end === text.length, nextOffset: end === text.length ? null : end });
  }
  // Inspect the FULL visible text, never just the result the caller chose to read.
  const lockout = /(?:account.{0,80}(?:suspend|lock(?:ed|out))|temporar(?:y|ily).{0,40}suspend|security[\s-]+hold|\b\d+[\s-]*hour.{0,60}(?:hold|suspension)|(?:suspend|lock).{0,60}account)/i.test(text.replace(/\s+/g, ' '));
  const recoveryPath = /\/(?:login|signin|sign-in|account|two-factor|2fa)\/(?:recovery|backup)(?:[/?#]|$)/i.test(new URL(url).pathname);
  const visible = el => !el.hidden && el.getAttribute('type') !== 'hidden'
    && (!el.getClientRects || el.getClientRects().length > 0)
    && (typeof getComputedStyle !== 'function' || !['hidden', 'collapse'].includes(getComputedStyle(el).visibility));
  const codePage = !unreadable && [...document.querySelectorAll('h1,h2,[role="heading"],label,input')].filter(visible).some(el =>
    /(?:recovery|backup)[\s_-]*codes?/i.test([el.textContent || '', el.getAttribute('id') || '',
      el.getAttribute('name') || '', el.getAttribute('aria-label') || '', el.getAttribute('placeholder') || ''].join(' ')));
  if (unreadable || lockout || recoveryPath || codePage) {
    if (reviewedPage === pageFingerprint && typeof reviewReason === 'string' && reviewReason.trim()) return null;
    return { kind: 'account-action-review', url, pageFingerprint,
      signals: { unreadable, lockout, recoveryPath, codePage },
      message: 'Review required before this call runs. Read every --read-page chunk on this page and the conversation. Decide whether this is a legitimate action. Recovery codes and lockout consequences need actual specific informed operator approval; ordinary sign-in approval is insufficient. To proceed after review, resubmit the same action with --reviewed-page <pageFingerprint> --review-reason <your nonsecret reasoning>. A changed page needs a new review. This is a signal for your judgment, not a finding that the action is forbidden.',
      readCommand: 'chrome-js.sh <profile> --read-page ' + parsedUrl.origin + ' 0' };
  }
  return null;
})
`;
