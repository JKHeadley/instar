/**
 * Audience-safe entry to Conversations. This renderer deliberately has no graph
 * reader, requester title, node ref, or digest input. Shared/unknown audiences
 * therefore cannot cause private hierarchy content to enter a model session.
 * Owner detail lives behind the authenticated owner app/dashboard projection.
 * Spec: conversation-effort-hierarchy-v3 §6, read-before-audience prohibition.
 */
export function conversationsPointer(publicAddress: string | null | undefined): string {
  let link: string | null = null;
  if (typeof publicAddress === 'string') {
    try {
      const address = new URL(publicAddress);
      // Use only the public origin: never propagate a PIN, auth query, source
      // title, fragment, userinfo, or a signed private-view capability into chat.
      if (address.protocol === 'https:' && !address.username && !address.password) {
        link = `${address.origin}/dashboard/console/#/work/conversations`;
      }
    } catch { /* malformed address yields the app pointer, never an unsafe URL */ }
  }
  return link ? `Open Conversations in the Instar app or dashboard:\n${link}`
    : 'Open Conversations in the Instar app to view your conversations.';
}

export interface ConversationsPointerAdapter {
  setConversationsUrlProvider(provider: () => string | null): void;
}

/** Late-bound URL follows tunnel replacement without caching a stale address. */
export function wireConversationsPointers(
  adapters: ReadonlyArray<ConversationsPointerAdapter | null | undefined>,
  publicAddress: () => string | null,
): void {
  for (const adapter of adapters) adapter?.setConversationsUrlProvider(publicAddress);
}

export const CONVERSATIONS_AWARENESS_HEADING = '## Conversations privacy and navigation';
export function conversationsAwareness(): string {
  return `${CONVERSATIONS_AWARENESS_HEADING}

When the user asks where a conversation or effort lives, use Conversations in the authenticated owner app or dashboard. Its hierarchy is separate from original Telegram, Slack and app histories. A missing or disabled hierarchy is not an empty tree; keep the existing flat conversation inventory available. Do not claim the feature is deployed from a prototype, a passing UI test, or a dark API alone.

Telegram /conversations and Slack !conversations return only a neutral app/dashboard pointer. They never read private graph titles, paths, counts, digests, or sources into a shared or unknown-audience session. An owner asking in a forum group is still a shared audience. Use the owner-authenticated Conversations panel for detail; do not copy owner-only reports into an ordinary transcript an MSP might later read. These commands do not move conversations, bind projects, alter platform settings, or send unsolicited worker notices.
`;
}

export const CONVERSATIONS_SUGGESTIONS_AWARENESS_HEADING = '### Conversations suggestions and the Chief of Staff root';
/** docs/specs/conversation-graph-suggestions.md: what the agent tells its owner about the suggestion step. */
export function conversationsSuggestionsAwareness(): string {
  return `${CONVERSATIONS_SUGGESTIONS_AWARENESS_HEADING}

When the owner's Conversations Overview is empty or they ask how to organize their conversations into efforts, point them to "Review suggestions" on the Conversations page: I propose groups of their unassigned conversations, each with Accept and Reject. Suggestions are advice only. Nothing is grouped until the owner taps Accept, which runs the same create, name and move steps as doing it by hand, and a rejected suggestion never comes back. I never accept one for them. The Chief of Staff conversation is always the top of the Overview, with every effort under it, and it cannot be moved under anything. Owner reads: \`GET /conversation-graph/suggestions\` (operator session), \`POST /conversation-graph/suggestions/refresh\`.
`;
}
