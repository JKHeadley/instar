/**
 * Agent awareness for native-conversation-any-machine-access §3e (the dashboard
 * never loses a reply quietly). One paragraph, shared by `generateClaudeMd()` for
 * new agents and `PostUpdateMigrator.migrateClaudeMd()` for existing ones.
 */

export const DASHBOARD_INPUT_AWARENESS_MARKER = 'Dashboard reply box:';

export function dashboardInputAwareness(): string {
  return `${DASHBOARD_INPUT_AWARENESS_MARKER} a message typed into a session from the dashboard keeps its text until the machine running that session acknowledges that exact message by its id; nothing else clears it. A second send is offered only where that machine recognises a repeat, so the same text is never typed twice. When a dashboard message cannot be confirmed, the dashboard types one line into the session itself, starting \`[dashboard] A message typed in the dashboard at HH:MM (input \\\`<id>\\\`) could not be confirmed\`. That line is from the dashboard, not from the user: in your next reply to the user, say whether a dashboard message reached you around that time and what it said; if you do not recall one, say only that you cannot confirm it. Never say it was lost and never ask for it again. Typing into a session on another machine stays off unless that machine sets \`dashboard.poolStream.allowRemoteInput\`. Counters (privacy-safe, this machine): \`GET /sessions/dashboard-input-status\` → \`inputIdsEvicted\`, \`inputRetryUnknown\`, \`inputIdsRepeated\`. **When to use** (PROACTIVE): the user says a reply typed in the dashboard did not arrive or arrived twice → read that route on the machine running the session, and tell them plainly what it shows.\n`;
}
