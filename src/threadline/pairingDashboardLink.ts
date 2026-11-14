/**
 * The "do this on the dashboard" sentence for pairing messages, with a direct link.
 *
 * An agent always gives the operator a direct link; the operator never navigates by hand
 * (Echo Bugs topic 10000002573, Instar feedback fb-300d9f7d-6d3). Every pairing message that
 * sends the operator to the dashboard builds its sentence here, from the agent's real address:
 *
 * - the tunnel is up: the public link, which opens on a phone;
 * - no tunnel at all, or the tunnel has stayed down too long: the local link, and the sentence
 *   says plainly that it opens only on the computer the agent runs on;
 * - a tunnel is configured but still starting: no link, and the sentence says so;
 * - the address is unknown: no link, and the sentence says so.
 *
 * The invite itself is NEVER put in a link: it is a one-time secret, and a link ends up in
 * message history, browser history and the server's request log (spec a2a-pairing-invite-link
 * §6.1; the dashboard's own rule: "never turned into a link"). The paste link opens the
 * dashboard's "Connect another agent" sheet with its "I was sent one" box ready instead.
 */

import { consolePageUrl, type OperatorLinkOrigin } from '../server/dashboardPaths.js';

/** The console's Other agents page: waiting approvals and Finish decisions are at its top. */
export const PAIRING_PAGE_ROUTE = '#/people/agents';
/** The same page with "Connect another agent" open, for pasting an invite (dashboard/console/agents.js). */
export const PAIRING_PASTE_ROUTE = '#/people/agents?connect=paste';

/** The link for a route on this origin, or null when there is no origin to use. */
export function pairingDashboardUrl(origin: OperatorLinkOrigin | null | undefined, route: string): string | null {
  if (!origin || origin.kind === 'pending') return null;
  return consolePageUrl(origin.origin, route);
}

/**
 * One sentence: `lead` ("Paste the invite") on the dashboard with the PIN, then the link or the
 * plain reason there is none. A sentence that ends in a link has no full stop after it, so the
 * link is never copied with a stray character.
 */
export function pairingDashboardLine(origin: OperatorLinkOrigin | null | undefined, lead: string, route: string): string {
  const head = `${lead} on the dashboard with your PIN`;
  if (!origin) return `${head}, on its Other agents page. I don't know this agent's dashboard address, so I can't give you a link.`;
  if (origin.kind === 'pending') return `${head}, on its Other agents page. I can't give you a link yet because the dashboard's public address is still starting; try again in a few minutes.`;
  const url = consolePageUrl(origin.origin, route);
  if (origin.kind === 'public') return `${head}: ${url}`;
  const why = origin.reason === 'no-tunnel'
    ? 'This agent has no public address, so this link opens only on the computer it runs on'
    : 'The dashboard\'s public address is down, so this link opens only on the computer this agent runs on';
  return `${head}. ${why}: ${url}`;
}

/** The origin from a resolver that may be missing or may throw; null means "unknown". */
export function readPairingOrigin(resolve: (() => OperatorLinkOrigin) | null | undefined): OperatorLinkOrigin | null {
  if (!resolve) return null;
  try { return resolve(); } catch { return null; } // @silent-fallback-ok — an unreadable address is said plainly in the sentence
}
