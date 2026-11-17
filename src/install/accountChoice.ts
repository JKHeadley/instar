/**
 * The installer's account choice (docs/specs/create-agent-accounts-and-always-on.md §A.2): after the
 * AI is installed and before sign-in, offer the accounts of that AI already signed in on this Mac.
 * Pure over its inputs: the caller passes the discovery result and the saved progress.
 */
import type { WizardAnswers } from '../commands/setup-wizard/state-machine.js';
import type { FoundAccount } from './accounts.js';
import type { AccountCard, StepResult } from './doorSteps.js';

export const ACCOUNT_CHOICE_STATE = 'do-account-choice';

function cards(accounts: FoundAccount[]): AccountCard[] {
  return accounts.map((a) => ({ id: a.id, label: a.label, plan: a.plan, borrowedFrom: a.borrowedFrom, isDefault: a.isDefault }));
}

export function accountChoiceStep(
  answers: WizardAnswers,
  awaiting: { state: string } | undefined,
  accounts: FoundAccount[],
  /** Makes the folder a new sign-in goes into (accountEnroll.newAccountFolder). */
  newFolder: () => string,
): StepResult {
  const choice = answers.accountChoice;
  if (choice && 'new' in choice) {
    return { kind: 'done', updates: { accountNew: true, accountIsDefault: false, accountConfigHome: answers.accountConfigHome && answers.accountNew ? answers.accountConfigHome : newFolder(), accountBorrowedFrom: null }, note: 'a new account' };
  }
  if (choice && 'use' in choice) {
    const hit = accounts.find((a) => a.id === choice.use);
    if (hit) {
      return { kind: 'done', updates: { accountNew: false, accountIsDefault: hit.isDefault, accountConfigHome: hit.configHome, accountBorrowedFrom: hit.borrowedFrom }, note: hit.label };
    }
    // The pick no longer matches a signed-in account (signed out, folder gone): ask again with the current list.
    if (accounts.length) {
      return { kind: 'awaiting-person', instruction: "That account isn't signed in on this Mac any more. Choose another, or sign in to a different account.", accounts: cards(accounts) };
    }
    return { kind: 'done', updates: { accountNew: true, accountIsDefault: false, accountConfigHome: newFolder(), accountBorrowedFrom: null }, note: 'the chosen account is gone; signing in to a new one' };
  }
  if (!accounts.length) return { kind: 'done', note: 'no accounts on this Mac yet' };
  // Resumed without an answer: an older app that doesn't know this question. Keep today's behaviour,
  // the default folder when it is signed in, and otherwise sign in.
  if (awaiting?.state === ACCOUNT_CHOICE_STATE) {
    const def = accounts.find((a) => a.isDefault);
    return def
      ? { kind: 'done', updates: { accountNew: false, accountIsDefault: true, accountConfigHome: def.configHome, accountBorrowedFrom: null }, note: `${def.label} (no choice given)` }
      : { kind: 'done', note: 'no choice given; signing in as usual' };
  }
  return { kind: 'awaiting-person', instruction: 'Choose which account this agent should use, or sign in to a different one.', accounts: cards(accounts) };
}
