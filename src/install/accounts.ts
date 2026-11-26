/**
 * The AI accounts already signed in on this Mac, for "Create my agent"'s account choice
 * (docs/specs/create-agent-accounts-and-always-on.md §A.1). Reads identity only: a config folder's
 * email (and Codex's plan) from its non-secret files. It never reads a token, password or key.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { readAccountEmail } from '../core/QuotaPoller.js';
import { claudeCredentialService, claudeKeychainAccount, claudeCredentialFilePath } from '../core/OAuthRefresher.js';
import { readCodexSlotIdentity } from '../providers/adapters/openai-codex/codexSlotIdentity.js';
import { CLAUDE_CODE_FRAMEWORK, CODEX_CLI_FRAMEWORK, type ClaudeOrCodexEngine } from '../core/frameworkFacts.js';

export type AccountDoor = ClaudeOrCodexEngine;

export interface FoundAccount {
  /** sha256 of the folder's real path, first 16 hex: a resume can't land on a different folder. */
  id: string;
  /** Plain words for the card: the email, or a stand-in when the folder can't say. */
  label: string;
  email: string | null;
  plan: string | null;
  /** The config folder (CLAUDE_CONFIG_DIR / CODEX_HOME). */
  configHome: string;
  /** Set when the folder belongs to another Instar agent's pool (§A.3). */
  borrowedFrom: string | null;
  isDefault: boolean;
}

export interface DiscoverOptions {
  home?: string;
  /** This machine's id; another agent's pool stamped for a different machine is skipped (§A.5). */
  machineId?: string | null;
  env?: NodeJS.ProcessEnv;
  /** True when the macOS keychain holds an item for this service (existence only, never the secret). */
  keychainHas?: (service: string) => boolean;
}

/** Existence only: `security find-generic-password` without -w prints attributes, never the password. */
export function keychainItemExists(service: string): boolean {
  if (process.platform !== 'darwin') return false;
  const r = spawnSync('security', ['find-generic-password', '-a', claudeKeychainAccount(), '-s', service], { stdio: 'ignore', timeout: 5000 });
  return r.status === 0;
}

export function accountIdFor(configHome: string): string {
  let real = configHome;
  try { real = fs.realpathSync(configHome); } catch { /* @silent-fallback-ok: a missing folder keeps its given path; it is filtered out as not signed in */ }
  return crypto.createHash('sha256').update(real).digest('hex').slice(0, 16);
}

/** True when the folder holds a Claude sign-in: its credentials file, or its keychain item (§A.1). */
function claudeSignedIn(configHome: string, keychainHas: (service: string) => boolean): boolean {
  if (fs.existsSync(claudeCredentialFilePath(configHome))) return true;
  return keychainHas(claudeCredentialService(configHome));
}

function codexSignedIn(codexHome: string): boolean {
  return fs.existsSync(path.join(codexHome, 'auth.json'));
}

interface PoolEntry { configHome: string; agent: string }

/** Config folders named in other Instar agents' subscription pools on this Mac. */
function poolFolders(home: string, door: AccountDoor, machineId: string | null | undefined): PoolEntry[] {
  const out: PoolEntry[] = [];
  const agentsDir = path.join(home, '.instar', 'agents');
  let agents: string[] = [];
  try { agents = fs.readdirSync(agentsDir); } catch { return out; } // @silent-fallback-ok: no agents yet means no pool folders
  for (const agent of agents) {
    const stateDir = path.join(agentsDir, agent, '.instar');
    // The machine-bound store first (SubscriptionPoolAuthorityStore), the legacy file second.
    const authority = path.join(stateDir, 'state', 'subscription-pool', 'accounts.json');
    const witness = path.join(stateDir, 'state', 'subscription-pool.initialized.json');
    let file = path.join(stateDir, 'subscription-pool.json');
    if (fs.existsSync(authority)) {
      let owner: unknown = null;
      try { owner = (JSON.parse(fs.readFileSync(witness, 'utf-8')) as { machineId?: unknown }).machineId; } catch { /* @silent-fallback-ok: an unstamped store is read as this machine's */ }
      if (machineId && typeof owner === 'string' && owner !== machineId) continue; // another machine's accounts
      file = authority;
    }
    let parsed: { accounts?: Array<{ configHome?: unknown; framework?: unknown }> };
    try { parsed = JSON.parse(fs.readFileSync(file, 'utf-8')); } catch { continue; } // @silent-fallback-ok: an agent without a readable pool contributes nothing
    for (const a of parsed.accounts ?? []) {
      if (a.framework !== door || typeof a.configHome !== 'string') continue;
      out.push({ configHome: a.configHome.replace(/^~(?=$|\/)/, home), agent });
    }
  }
  return out;
}

/**
 * The accounts of one AI signed in on this Mac, default folder first. Two folders with the same
 * email are shown once: the default wins, then the first found.
 */
export function discoverAccounts(door: AccountDoor, opts: DiscoverOptions = {}): FoundAccount[] {
  const home = opts.home ?? os.homedir();
  const env = opts.env ?? process.env;
  const defaultHome = door === CLAUDE_CODE_FRAMEWORK
    ? (env.CLAUDE_CONFIG_DIR || path.join(home, '.claude'))
    : (env.CODEX_HOME || path.join(home, '.codex'));
  const candidates: Array<{ configHome: string; borrowedFrom: string | null; isDefault: boolean }> = [
    { configHome: defaultHome, borrowedFrom: null, isDefault: true },
    ...poolFolders(home, door, opts.machineId).map((p) => ({ configHome: p.configHome, borrowedFrom: p.agent, isDefault: false })),
  ];
  const seenIds = new Set<string>();
  const seenEmails = new Set<string>();
  const out: FoundAccount[] = [];
  for (const c of candidates) {
    const id = accountIdFor(c.configHome);
    if (seenIds.has(id)) continue;
    seenIds.add(id);
    let email: string | null = null;
    let plan: string | null = null;
    if (door === CLAUDE_CODE_FRAMEWORK) {
      if (!claudeSignedIn(c.configHome, opts.keychainHas ?? keychainItemExists)) continue;
      email = readAccountEmail(c.configHome);
    } else {
      if (!codexSignedIn(c.configHome)) continue;
      const ident = readCodexSlotIdentity(c.configHome);
      email = ident.email;
      plan = ident.planType;
    }
    const key = email?.toLowerCase() ?? null;
    if (key && seenEmails.has(key)) continue;
    if (key) seenEmails.add(key);
    const label = email ?? (door === CLAUDE_CODE_FRAMEWORK ? 'Claude account (email unknown)' : 'ChatGPT account on this Mac');
    out.push({ id, label, email, plan, configHome: c.configHome, borrowedFrom: c.borrowedFrom, isDefault: c.isDefault });
  }
  return out;
}
