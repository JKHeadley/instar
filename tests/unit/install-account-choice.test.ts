/**
 * The installer's account choice (docs/specs/create-agent-accounts-and-always-on.md §A.2).
 */
import { describe, expect, it } from 'vitest';
import { ACCOUNT_CHOICE_STATE, accountChoiceStep } from '../../src/install/accountChoice.js';
import type { FoundAccount } from '../../src/install/accounts.js';
import { answersFileProblem } from '../../src/commands/install.js';

const personal: FoundAccount = { id: 'a'.repeat(16), label: 'personal@example.com', email: 'personal@example.com', plan: null, configHome: '/h/.claude', borrowedFrom: null, isDefault: true };
const work: FoundAccount = { id: 'b'.repeat(16), label: 'work@example.com', email: 'work@example.com', plan: null, configHome: '/h/.instar/agents/luna/.instar/accounts/claude-1', borrowedFrom: 'luna', isDefault: false };

describe('accountChoiceStep', () => {
  it('asks with the account cards when accounts are found and no choice was given', () => {
    const r = accountChoiceStep({ door: 'claude-code' }, undefined, [personal, work]);
    expect(r.kind).toBe('awaiting-person');
    if (r.kind === 'awaiting-person') {
      expect(r.accounts?.map((a) => a.id)).toEqual([personal.id, work.id]);
      expect(r.accounts?.[1]?.borrowedFrom).toBe('luna');
      expect(JSON.stringify(r.accounts)).not.toContain('/h/'); // the app gets identity, not folder paths
    }
  });

  it('nothing to ask when no account is signed in here', () => {
    expect(accountChoiceStep({ door: 'claude-code' }, undefined, [])).toMatchObject({ kind: 'done' });
  });

  it('uses the picked account, including a borrowed one', () => {
    expect(accountChoiceStep({ door: 'claude-code', accountChoice: { use: work.id } }, undefined, [personal, work]))
      .toMatchObject({ kind: 'done', updates: { accountNew: false, accountConfigHome: work.configHome, accountBorrowedFrom: 'luna' } });
  });

  it('a new sign-in', () => {
    expect(accountChoiceStep({ door: 'codex-cli', accountChoice: { new: true } }, undefined, [personal]))
      .toMatchObject({ kind: 'done', updates: { accountNew: true } });
  });

  it('a pick that no longer matches asks again with the current list', () => {
    const r = accountChoiceStep({ door: 'claude-code', accountChoice: { use: 'c'.repeat(16) } }, undefined, [personal]);
    expect(r.kind).toBe('awaiting-person');
  });

  it('an older app that resumes without an answer gets today\'s behaviour', () => {
    expect(accountChoiceStep({ door: 'claude-code' }, { state: ACCOUNT_CHOICE_STATE }, [personal, work]))
      .toMatchObject({ kind: 'done', updates: { accountConfigHome: personal.configHome, accountNew: false } });
    expect(accountChoiceStep({ door: 'claude-code' }, { state: ACCOUNT_CHOICE_STATE }, [work]))
      .toMatchObject({ kind: 'done', updates: { accountNew: true } });
  });

  it('the answers file accepts only a known shape', () => {
    expect(answersFileProblem({ account: { use: 'a'.repeat(16) } })).toBeNull();
    expect(answersFileProblem({ account: { new: true } })).toBeNull();
    expect(answersFileProblem({ account: { use: '../x' } as never })).toContain('account must be');
    expect(answersFileProblem({ account: { use: 'a'.repeat(16), new: true } as never })).toContain('account must be');
  });
});
