/**
 * The installer's account choice (docs/specs/create-agent-accounts-and-always-on.md §A.2).
 */
import { describe, expect, it } from 'vitest';
import { ACCOUNT_CHOICE_STATE, accountChoiceStep } from '../../src/install/accountChoice.js';
import type { FoundAccount } from '../../src/install/accounts.js';
import { answersFileProblem } from '../../src/commands/install.js';
import { enrollChosenAccount, newAccountFolder, signInEnvFor } from '../../src/install/accountEnroll.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll } from 'vitest';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const tmpDirs: string[] = [];
afterAll(() => { for (const d of tmpDirs) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/unit/install-account-choice.test.ts' }); });

const mkFolder = () => '/h/.instar/accounts/testy/claude-code-1';

const personal: FoundAccount = { id: 'a'.repeat(16), label: 'personal@example.com', email: 'personal@example.com', plan: null, configHome: '/h/.claude', borrowedFrom: null, isDefault: true };
const work: FoundAccount = { id: 'b'.repeat(16), label: 'work@example.com', email: 'work@example.com', plan: null, configHome: '/h/.instar/agents/luna/.instar/accounts/claude-1', borrowedFrom: 'luna', isDefault: false };

describe('accountChoiceStep', () => {
  it('asks with the account cards when accounts are found and no choice was given', () => {
    const r = accountChoiceStep({ door: 'claude-code' }, undefined, [personal, work], mkFolder);
    expect(r.kind).toBe('awaiting-person');
    if (r.kind === 'awaiting-person') {
      expect(r.accounts?.map((a) => a.id)).toEqual([personal.id, work.id]);
      expect(r.accounts?.[1]?.borrowedFrom).toBe('luna');
      expect(JSON.stringify(r.accounts)).not.toContain('/h/'); // the app gets identity, not folder paths
    }
  });

  it('nothing to ask when no account is signed in here', () => {
    expect(accountChoiceStep({ door: 'claude-code' }, undefined, [], mkFolder)).toMatchObject({ kind: 'done' });
  });

  it('uses the picked account, including a borrowed one', () => {
    expect(accountChoiceStep({ door: 'claude-code', accountChoice: { use: work.id } }, undefined, [personal, work], mkFolder))
      .toMatchObject({ kind: 'done', updates: { accountNew: false, accountConfigHome: work.configHome, accountBorrowedFrom: 'luna' } });
  });

  it('a new sign-in', () => {
    expect(accountChoiceStep({ door: 'codex-cli', accountChoice: { new: true } }, undefined, [personal], mkFolder))
      .toMatchObject({ kind: 'done', updates: { accountNew: true, accountIsDefault: false, accountConfigHome: '/h/.instar/accounts/testy/claude-code-1' } });
  });

  it('a pick that no longer matches asks again with the current list, or is refused when none is left', () => {
    const r = accountChoiceStep({ door: 'claude-code', accountChoice: { use: 'c'.repeat(16) } }, undefined, [personal], mkFolder);
    expect(r.kind).toBe('awaiting-person');
    expect(accountChoiceStep({ door: 'claude-code', accountChoice: { use: 'c'.repeat(16) } }, undefined, [], mkFolder).kind).toBe('failed');
  });

  it('a new-account folder refuses a name that could leave the accounts folder', () => {
    expect(() => newAccountFolder('../evil', 'claude-code', os.tmpdir())).toThrow();
  });

  it('an older app that resumes without an answer gets today\'s behaviour', () => {
    expect(accountChoiceStep({ door: 'claude-code' }, { state: ACCOUNT_CHOICE_STATE }, [personal, work], mkFolder))
      .toMatchObject({ kind: 'done', updates: { accountConfigHome: personal.configHome, accountNew: false } });
    const none = accountChoiceStep({ door: 'claude-code' }, { state: ACCOUNT_CHOICE_STATE }, [work], mkFolder);
    expect(none).toMatchObject({ kind: 'done' });
    expect((none as { updates?: unknown }).updates).toBeUndefined();
  });

  it('the answers file accepts only a known shape', () => {
    expect(answersFileProblem({ account: { use: 'a'.repeat(16) } })).toBeNull();
    expect(answersFileProblem({ account: { new: true } })).toBeNull();
    expect(answersFileProblem({ account: { use: '../x' } as never })).toContain('account must be');
    expect(answersFileProblem({ account: { use: 'a'.repeat(16), new: true } as never })).toContain('account must be');
  });
});

describe('the chosen account after the choice', () => {
  it('a new sign-in gets the next free folder, never reusing one', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'inst-acct-new-'));
    tmpDirs.push(home);
    const a = newAccountFolder('testy', 'claude-code', home);
    const b = newAccountFolder('testy', 'claude-code', home);
    expect(path.basename(a)).toBe('claude-code-1');
    expect(path.basename(b)).toBe('claude-code-2');
    expect(fs.statSync(a).mode & 0o777).toBe(0o700);
  });

  it('sign-in points at a chosen folder, and leaves the default folder alone', () => {
    expect(signInEnvFor({ door: 'claude-code', accountConfigHome: '/x', accountIsDefault: false })).toEqual({ CLAUDE_CONFIG_DIR: '/x' });
    expect(signInEnvFor({ door: 'codex-cli', accountConfigHome: '/y', accountIsDefault: false })).toEqual({ CODEX_HOME: '/y' });
    expect(signInEnvFor({ door: 'claude-code', accountConfigHome: '/h/.claude', accountIsDefault: true })).toEqual({});
  });

  it('enrolls a borrowed account once, with its owner and machine; a failure says what to do', async () => {
    const added: Array<{ input: { id: string; configHome: string }; extra: Record<string, unknown> }> = [];
    const borrowed: Array<[string, string]> = [];
    const deps = {
      machineId: 'm_here',
      has: (id: string) => added.some((a) => a.input.id === id),
      register: async (input: { id: string; configHome: string }, extra: Record<string, unknown>) => { added.push({ input, extra }); },
      recordBorrowed: (id: string, from: string) => { borrowed.push([id, from]); },
    };
    const answers = { door: 'claude-code', accountConfigHome: work.configHome, accountIsDefault: false, accountBorrowedFrom: 'luna' };
    expect(await enrollChosenAccount(answers, deps)).toMatchObject({ ok: true });
    expect(await enrollChosenAccount(answers, deps)).toMatchObject({ ok: true });
    expect(added).toHaveLength(1);
    expect(borrowed[0]?.[1]).toBe('luna'); // the pool keeps no extra fields, so the source is recorded beside it
    expect(await enrollChosenAccount({ ...answers, accountIsDefault: true }, deps)).toEqual({ ok: true, id: null });
    const failing = { ...deps, has: () => false, register: async () => { throw new Error('not signed in'); } };
    expect(await enrollChosenAccount({ ...answers, accountConfigHome: '/other' }, failing)).toMatchObject({ ok: false });
  });
});
