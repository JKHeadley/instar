// CONTRACT-EVIDENCE: EXEMPT — pure string formatting of already-received message fields (user, text); calls no Slack API method and reads no new parameter or response field.
/**
 * Who a line of injected Slack thread history is attributed to.
 *
 * Each message is labelled with ITS OWN sender. Before this, every non-bot line
 * carried the CURRENT message's sender name, so in a shared thread person A's
 * message read as person B's (topic 136880, 2026-11-04: "Both messages appear
 * under the same Slack user ID"). The current sender's own lines keep their
 * display name, so a one-person conversation reads exactly as before.
 */
export function slackHistoryLabel(
  message: { user?: string | null },
  botUserId: string | null | undefined,
  current: { userId?: string | null; name?: string | null },
  resolvedNames?: ReadonlyMap<string, string>,
): string {
  const user = message.user ?? '';
  if (botUserId && user === botUserId) return 'Agent';
  if (user && current.userId && user === current.userId && current.name) return current.name;
  if (user && resolvedNames?.get(user)) return resolvedNames.get(user)!;
  return user || 'unknown';
}
