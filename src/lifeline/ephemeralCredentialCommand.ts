/** Commands carrying one-use credentials must never enter the durable queue. */
export function isEphemeralCredentialCommand(text: string): boolean {
  const t = text.trim();
  // `approve <code>` (trust-journey decision 5) is bound to one live platform receipt; a replay after
  // an outage carries no chat type or reply-to, so it could never approve, and must not be queued.
  return /^\/desktop(?:\s|$)/i.test(t) || /^approve\s+[0-9a-z]{6}$/i.test(t);
}
