/**
 * After the new agent exists, puts the account chosen at the account choice into its pool
 * (docs/specs/create-agent-accounts-and-always-on.md §A.3-§A.5). Through the email registrar only:
 * the identity is read from the folder's own sign-in, never typed in. Insert-if-absent.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { WizardAnswers } from '../commands/setup-wizard/state-machine.js';
import { accountIdFor } from './accounts.js';
import { CLAUDE_CODE_FRAMEWORK, CODEX_CLI_FRAMEWORK, type ClaudeOrCodexEngine } from '../core/frameworkFacts.js';

/** The folder a new sign-in goes into: ~/.instar/accounts/<agent>/<door>-<n>, the next free n. */
export function newAccountFolder(agentName: string, door: string, home: string = os.homedir()): string {
  // The name was validated when asked; refuse anything that could leave ~/.instar/accounts anyway.
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(agentName) || agentName.includes('..') || !/^[a-z0-9-]+$/.test(door)) {
    throw new Error('not a usable agent name for an account folder');
  }
  const base = path.join(home, '.instar', 'accounts', agentName);
  fs.mkdirSync(base, { recursive: true, mode: 0o700 });
  for (let n = 1; ; n++) {
    const dir = path.join(base, `${door}-${n}`);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { mode: 0o700 });
      return dir;
    }
  }
}

/** Points this install's sign-in at the chosen folder (the default folder is left as it is). */
export function signInEnvFor(answers: WizardAnswers): Record<string, string> {
  if (!answers.accountConfigHome || answers.accountIsDefault) return {};
  return answers.door === CODEX_CLI_FRAMEWORK ? { CODEX_HOME: answers.accountConfigHome } : { CLAUDE_CONFIG_DIR: answers.accountConfigHome };
}

export interface EnrollDeps {
  machineId: string | null;
  /** register() from SubscriptionAccountEmailRegistrar, bound to this agent's pool. */
  register: (input: { id: string; nickname: string; provider: 'anthropic' | 'openai'; framework: ClaudeOrCodexEngine; configHome: string; status: 'active' }, rawExtra: Record<string, unknown>) => Promise<unknown>;
  has: (id: string) => boolean;
  /** Records where a shared account came from (the pool keeps no extra fields). */
  recordBorrowed: (id: string, from: string) => void;
}

/** <stateDir>/state/account-sources.json: { [accountId]: { borrowedFrom } } for shared accounts (§A.3). */
export function recordBorrowedAccount(stateDir: string, id: string, from: string): void {
  const file = path.join(stateDir, 'state', 'account-sources.json');
  let cur: Record<string, { borrowedFrom: string }> = {};
  try { cur = JSON.parse(fs.readFileSync(file, 'utf-8')); } catch { /* @silent-fallback-ok: first shared account */ }
  cur[id] = { borrowedFrom: from };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(cur, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

export async function enrollChosenAccount(answers: WizardAnswers, deps: EnrollDeps): Promise<{ ok: true; id: string | null } | { ok: false; message: string }> {
  if (!answers.accountConfigHome || answers.accountIsDefault) return { ok: true, id: null };
  const framework = answers.door === CODEX_CLI_FRAMEWORK ? CODEX_CLI_FRAMEWORK : CLAUDE_CODE_FRAMEWORK;
  const id = `acct-${accountIdFor(answers.accountConfigHome)}`;
  if (deps.has(id)) {
    if (answers.accountBorrowedFrom) deps.recordBorrowed(id, answers.accountBorrowedFrom);
    return { ok: true, id };
  }
  try {
    await deps.register(
      { id, nickname: answers.accountBorrowedFrom ? `shared with ${answers.accountBorrowedFrom}` : 'this agent\'s account', provider: framework === CODEX_CLI_FRAMEWORK ? 'openai' : 'anthropic', framework, configHome: answers.accountConfigHome, status: 'active' },
      {},
    );
    if (answers.accountBorrowedFrom) deps.recordBorrowed(id, answers.accountBorrowedFrom);
    return { ok: true, id };
  } catch (err) {
    return { ok: false, message: `The account you chose couldn't be confirmed (${err instanceof Error ? err.message : String(err)}). Sign in to it, then continue.` };
  }
}
