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

/** The folder a new sign-in goes into: ~/.instar/accounts/<agent>/<door>-<n>, the next free n. */
export function newAccountFolder(agentName: string, door: string, home: string = os.homedir()): string {
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
  return answers.door === 'codex-cli' ? { CODEX_HOME: answers.accountConfigHome } : { CLAUDE_CONFIG_DIR: answers.accountConfigHome };
}

export interface EnrollDeps {
  machineId: string | null;
  /** register() from SubscriptionAccountEmailRegistrar, bound to this agent's pool. */
  register: (input: { id: string; nickname: string; provider: 'anthropic' | 'openai'; framework: 'claude-code' | 'codex-cli'; configHome: string; status: 'active' }, rawExtra: Record<string, unknown>) => Promise<unknown>;
  has: (id: string) => boolean;
}

export async function enrollChosenAccount(answers: WizardAnswers, deps: EnrollDeps): Promise<{ ok: true; id: string | null } | { ok: false; message: string }> {
  if (!answers.accountConfigHome || answers.accountIsDefault) return { ok: true, id: null };
  const framework = answers.door === 'codex-cli' ? 'codex-cli' : 'claude-code';
  const id = `acct-${accountIdFor(answers.accountConfigHome)}`;
  if (deps.has(id)) return { ok: true, id };
  try {
    await deps.register(
      { id, nickname: answers.accountBorrowedFrom ? `shared with ${answers.accountBorrowedFrom}` : 'this agent\'s account', provider: framework === 'codex-cli' ? 'openai' : 'anthropic', framework, configHome: answers.accountConfigHome, status: 'active' },
      { ...(answers.accountBorrowedFrom ? { borrowed: { from: answers.accountBorrowedFrom } } : {}), ...(deps.machineId ? { machineId: deps.machineId } : {}) },
    );
    return { ok: true, id };
  } catch (err) {
    return { ok: false, message: `The account you chose couldn't be confirmed (${err instanceof Error ? err.message : String(err)}). Sign in to it, then continue.` };
  }
}
