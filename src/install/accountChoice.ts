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
    return { kind: 'failed', message: "The account you chose isn't signed in on this computer any more, and there's no other account to offer.", nextStep: 'Choose "Sign in to a different account" and continue.' };
  }
  if (!accounts.length) return { kind: 'done', note: 'no accounts on this Mac yet' };
  // Resumed without an answer (an app from before this question existed, or a resume that lost the
  // pick): never choose for the person. Ask again, and say plainly how to get the choice shown.
  // Justin, 2026-11-19: setup "should NOT just assume and claim an account".
  if (awaiting?.state === ACCOUNT_CHOICE_STATE) {
    return {
      kind: 'awaiting-person',
      instruction: 'Setup needs you to choose which account this agent should use, or to sign in to a different one. If no choice appears, update the Instar app and try again.',
      accounts: cards(accounts),
    };
  }
  return { kind: 'awaiting-person', instruction: 'Choose which account this agent should use, or sign in to a different one.', accounts: cards(accounts) };
}
