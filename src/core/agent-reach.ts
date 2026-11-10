/**
 * Agent reach — what this agent can already look at or act through, as plain
 * data for the outbound gate's reach-aware B17_FALSE_BLOCKER judgment and for
 * the session-start browser-profile block.
 *
 * WHY: an agent told its operator "only a browser you've set up can see that
 * list, so I need your eye on it" when its own key read that list, and then
 * "someone has to message me in Slack" when its browser held the operator's
 * signed-in Google and Slack session (Echo Bugs topic 10000002506,
 * 2026-11-09). The gate only saw the message text, so a claimed need for the
 * operator read as a genuine account limit. This module hands the gate the
 * facts it needs to tell the two apart.
 *
 * DATA ONLY, NO AUTHORITY. Nothing here decides anything. Login state is
 * last-asserted (the registry's own staleness rule), so the gate is told to
 * treat reach as plausible, never proven. No secret value, vault name or
 * folder path is ever included — only service, account handle, owner and
 * profile id, each sanitized and clamped.
 */

/** The minimal registry surface this module reads (keeps it unit-testable). */
export interface AgentReachRegistry {
  listProfiles(): Array<{
    id: string;
    accounts: Array<{ service: string; identity: string; owner: 'agent' | 'operator'; lastVerifiedAt?: string | null }>;
  }>;
}

export interface AgentReachAccount {
  profileId: string;
  service: string;
  identity: string;
  owner: 'agent' | 'operator';
}

export interface AgentReach {
  /** Accounts signed in to this machine's browser profiles (last-asserted). */
  browserAccounts: AgentReachAccount[];
  /** How many accounts were dropped by the size cap. */
  omittedAccounts: number;
  /** Read surfaces the agent's own server key covers. */
  keyReads: readonly string[];
}

/**
 * What the agent's own bearer key reads. Everything the dashboard and the app
 * show is served by the agent's own server under that key, so "only your
 * screen can see it" is never true of those views.
 */
export const AGENT_KEY_READS: readonly string[] = [
  'everything the dashboard and the app show (the same server serves both, under the agent key)',
  'the app and dashboard conversation list, including Slack and Telegram conversations and their names',
  'topic and conversation message history, sessions and their output, jobs, attention items, commitments',
  'this agent\'s files, logs and settings',
];

const MAX_ACCOUNTS = 24;
const MAX_FIELD = 80;

function clean(value: unknown, max = MAX_FIELD): string {
  if (typeof value !== 'string') return '';
  // Strip control characters and the boundary-ish characters a prompt section
  // must never carry, then clamp.
  return value.replace(/[\u0000-\u001f\u007f<>`]/g, '').trim().slice(0, max);
}

/**
 * Build the reach record. Never throws: a broken or missing registry yields an
 * empty account list (the key reads are always true of an instar agent).
 */
export function buildAgentReach(registry: AgentReachRegistry | null | undefined): AgentReach {
  const accounts: AgentReachAccount[] = [];
  let total = 0;
  try {
    const profiles = registry ? registry.listProfiles() : [];
    for (const p of profiles) {
      for (const a of p.accounts ?? []) {
        const service = clean(a.service, 64);
        const identity = clean(a.identity, 128);
        if (!service || !identity) continue;
        total++;
        if (accounts.length < MAX_ACCOUNTS) {
          accounts.push({
            profileId: clean(p.id, 64),
            service,
            identity,
            owner: a.owner === 'operator' ? 'operator' : 'agent',
          });
        }
      }
    }
  } catch {
    // @silent-fallback-ok — reach is context for a judgment; an unreadable registry
    // means "no browser accounts known", which only makes the gate less likely to fire.
  }
  return { browserAccounts: accounts, omittedAccounts: Math.max(0, total - accounts.length), keyReads: AGENT_KEY_READS };
}

/** Render the reach as plain lines (no boundary; the caller wraps it). */
export function renderAgentReachLines(reach: AgentReach): string[] {
  const lines: string[] = [];
  lines.push('Your own server key reads:');
  for (const r of reach.keyReads) lines.push(`- ${r}`);
  if (reach.browserAccounts.length === 0) {
    lines.push('Browser profiles on this machine: none registered.');
  } else {
    lines.push('Browser profiles on this machine hold these signed-in accounts (last-asserted, not proven):');
    for (const a of reach.browserAccounts) {
      const owner = a.owner === 'operator' ? "the OPERATOR's own account" : "the agent's account";
      lines.push(`- ${a.service} / ${a.identity} in profile ${a.profileId} (${owner})`);
    }
    if (reach.omittedAccounts > 0) lines.push(`- …and ${reach.omittedAccounts} more`);
  }
  return lines;
}
