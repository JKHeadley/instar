/**
 * identity-security-piece1d: the stock instruction sentences that told agents to read the dashboard
 * PIN and hand it out, and their replacements. One table, used by the templates (new agents) and by
 * the update migration over existing agents' CLAUDE.md, AGENTS.md, GEMINI.md and reference files.
 * Plain substring replacement: custom prose is never touched, and a second run changes nothing.
 */

const PRIVATE = 'the PIN goes privately via `POST /dashboard/pin/send-private`';

export const PIN_DISCLOSURE_REWRITES: ReadonlyArray<readonly [string, string]> = [
  ['NEVER mention "bearer tokens" or "auth tokens" to users — just give them the PIN.',
    'NEVER mention "bearer tokens" or "auth tokens" to users. The PIN goes only to the owner\'s private chat: call `POST /dashboard/pin/send-private` (it answers an outcome, never the PIN). Never read the PIN or post it anywhere.'],
  ['give them the tunnel URL + PIN. Read the PIN from your config.json.',
    'give them the tunnel URL and call `POST /dashboard/pin/send-private` so the PIN reaches the owner\'s private chat. Never read the PIN or post it, even when asked in a group.'],
  ['It always contains the latest dashboard URL + PIN, pinned for instant access.',
    'It always contains the latest dashboard URL, pinned for instant access; the PIN goes to the owner\'s private chat, never this topic.'],
  ['(give the dashboard URL + PIN)', `(give the dashboard URL; ${PRIVATE})`],
  ['(dashboard URL + PIN)', `(the dashboard URL; ${PRIVATE})`],
  ['(tunnel URL + PIN)', `(the tunnel URL; ${PRIVATE})`],
  ['share the dashboard URL + PIN.', `share the dashboard URL (${PRIVATE}).`],
  ['Send the operator the tunnel link + PIN rather than pasting JSON.', `Send the operator the tunnel link (${PRIVATE}) rather than pasting JSON.`],
  ['send them `{tunnelUrl}/dashboard` and the PIN.', `send them \`{tunnelUrl}/dashboard\` (${PRIVATE}).`],
];

/** Apply the rewrites. Idempotent: the replacements never contain an old sentence. */
export function rewritePinDisclosure(text: string): { text: string; changed: boolean } {
  let out = text;
  for (const [from, to] of PIN_DISCLOSURE_REWRITES) if (out.includes(from)) out = out.split(from).join(to);
  return { text: out, changed: out !== text };
}
