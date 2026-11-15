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
 * HOLDINGS (Echo Bugs topic 10000002770, 2026-11-15): the agent asked its
 * operator for an Apple password and a manual certificate upload while its own
 * vault held that password and a browser profile was signed in to that Apple
 * account. The profile was registered under "google" only and the vault was
 * never shown to the gate, so the ask read as genuine. The reach now also says
 * which accounts have a stored password or code generator (from the registry's
 * role bindings) and lists the vault entry NAMES not tied to any account, so the
 * gate judges by meaning whether the agent already holds the asked-for access.
 *
 * DATA ONLY, NO AUTHORITY. Nothing here decides anything. Login state is
 * last-asserted (the registry's own staleness rule), and a vault name only
 * suggests a holding, so the gate is told to treat reach as plausible, never
 * proven. No secret VALUE or folder path is ever included. Vault entry names go
 * only into the gate's own prompt (least revelation): the gate is told never to
 * quote one back. Everything is sanitized and clamped, with omitted counts shown.
 */

/** The minimal registry surface this module reads (keeps it unit-testable). */
export interface AgentReachRegistry {
  listProfiles(): Array<{
    id: string;
    accounts: Array<{
      service: string;
      identity: string;
      owner: 'agent' | 'operator';
      lastVerifiedAt?: string | null;
      /** Vault secret NAMES tied to this account (never values). */
      vaultRefs?: string[];
      /** Role bindings (password / totp / passkey / backupCode) → vault names. */
      vaultBindings?: { password?: string; totp?: string; passkey?: string; backupCode?: string };
    }>;
  }>;
  /** Live vault secret NAMES (never values); null when unreadable. Optional. */
  vaultNames?(): string[] | null;
}

/** What the vault stores for one account, as plain role words (never names). */
export type StoredCredentialRole = 'password' | 'code generator' | 'passkey' | 'backup codes';

export interface AgentReachAccount {
  profileId: string;
  service: string;
  identity: string;
  owner: 'agent' | 'operator';
  /** Roles the vault holds for this account (from the registry's bindings). Absent when none. */
  stored?: StoredCredentialRole[];
}

export interface AgentReach {
  /** Accounts signed in to this machine's browser profiles (last-asserted). */
  browserAccounts: AgentReachAccount[];
  /** How many accounts were dropped by the size cap. */
  omittedAccounts: number;
  /** Read surfaces the agent's own server key covers. */
  keyReads: readonly string[];
  /**
   * Vault entry NAMES not tied to any registered account (never values). Absent
   * when the vault was not read; empty when it holds nothing unbound.
   */
  vaultEntries?: string[];
  /** How many unbound vault names were dropped by the size cap. */
  omittedVaultEntries?: number;
  /** True when the vault could not be read (the gate is told holdings are unknown). */
  vaultUnreadable?: boolean;
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
/** Unbound vault names shown to the gate; the rest are counted, never cut silently. */
export const MAX_VAULT_ENTRIES = 80;
/** Width of one rendered vault-name line (below the gate's 400-char per-line belt). */
const VAULT_LINE_CHARS = 200;

const ROLE_WORDS: ReadonlyArray<['password' | 'totp' | 'passkey' | 'backupCode', StoredCredentialRole]> = [
  ['password', 'password'],
  ['totp', 'code generator'],
  ['passkey', 'passkey'],
  ['backupCode', 'backup codes'],
];

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
  const boundNames = new Set<string>();
  let total = 0;
  try {
    const profiles = registry ? registry.listProfiles() : [];
    for (const p of profiles) {
      for (const a of p.accounts ?? []) {
        for (const ref of a.vaultRefs ?? []) if (typeof ref === 'string') boundNames.add(ref);
        for (const v of Object.values(a.vaultBindings ?? {})) if (typeof v === 'string') boundNames.add(v);
        const service = clean(a.service, 64);
        const identity = clean(a.identity, 128);
        if (!service || !identity) continue;
        total++;
        if (accounts.length < MAX_ACCOUNTS) {
          const stored = ROLE_WORDS.filter(([key]) => !!a.vaultBindings?.[key]).map(([, word]) => word);
          accounts.push({
            profileId: clean(p.id, 64),
            service,
            identity,
            owner: a.owner === 'operator' ? 'operator' : 'agent',
            ...(stored.length > 0 ? { stored } : {}),
          });
        }
      }
    }
  } catch {
    // @silent-fallback-ok — reach is context for a judgment; an unreadable registry
    // means "no browser accounts known", which only makes the gate less likely to fire.
  }
  const reach: AgentReach = {
    browserAccounts: accounts,
    omittedAccounts: Math.max(0, total - accounts.length),
    keyReads: AGENT_KEY_READS,
  };
  if (registry && typeof registry.vaultNames === 'function') {
    let names: string[] | null = null;
    try {
      names = registry.vaultNames();
    } catch {
      // @silent-fallback-ok — an unreadable vault is reported to the gate as unknown
      // holdings (vaultUnreadable), never as "holds nothing".
      names = null;
    }
    if (names === null) {
      reach.vaultUnreadable = true;
    } else {
      const unbound = [...new Set(names.filter((n) => typeof n === 'string' && !boundNames.has(n)).map((n) => clean(n, 64)).filter(Boolean))].sort();
      reach.vaultEntries = unbound.slice(0, MAX_VAULT_ENTRIES);
      reach.omittedVaultEntries = Math.max(0, unbound.length - reach.vaultEntries.length);
    }
  }
  return reach;
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
      const stored = a.stored && a.stored.length > 0 ? `; the vault stores its ${a.stored.join(' and ')}` : '';
      lines.push(`- ${a.service} / ${a.identity} in profile ${a.profileId} (${owner}${stored})`);
    }
    if (reach.omittedAccounts > 0) lines.push(`- …and ${reach.omittedAccounts} more`);
  }
  if (reach.vaultUnreadable) {
    lines.push('Vault: could not be read just now, so what it holds is UNKNOWN (not empty).');
  } else if (reach.vaultEntries) {
    if (reach.vaultEntries.length === 0) {
      lines.push('Vault entries not tied to a browser account: none.');
    } else {
      lines.push('Vault entries not tied to a browser account (NAMES only, values never shown; a name suggests a holding, it does not prove the value works; never quote a name back):');
      // One name list per line, each kept well under the gate's per-line belt so no
      // name is ever cut (names are clamped to 64 at build).
      let line = '';
      for (const name of reach.vaultEntries) {
        if (line && line.length + name.length + 2 > VAULT_LINE_CHARS) { lines.push(`- ${line}`); line = ''; }
        line = line ? `${line}, ${name}` : name;
      }
      if (line) lines.push(`- ${line}`);
      if ((reach.omittedVaultEntries ?? 0) > 0) lines.push(`- …and ${reach.omittedVaultEntries} more`);
    }
  }
  return lines;
}
