/**
 * Account discovery for Create my agent (docs/specs/create-agent-accounts-and-always-on.md §A.1).
 */
import { afterAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { accountIdFor, discoverAccounts } from '../../src/install/accounts.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/unit/install-accounts.test.ts' }); });

function write(file: string, body: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof body === 'string' ? body : JSON.stringify(body));
}

/** A JWT-shaped id token whose payload names an email and plan (what Codex keeps in auth.json). */
function codexAuth(email: string, plan: string): unknown {
  const payload = Buffer.from(JSON.stringify({ email, 'https://api.openai.com/auth': { chatgpt_plan_type: plan, chatgpt_account_id: 'acct-1' } })).toString('base64url');
  return { tokens: { id_token: `e30.${payload}.sig`, account_id: 'acct-1' } };
}

function fixtureHome(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'inst-acct-'));
  dirs.push(home);
  // Default Claude folder, signed in as personal@example.com (a credentials file proves the sign-in).
  write(path.join(home, '.claude', '.claude.json'), { oauthAccount: { emailAddress: 'personal@example.com' } });
  write(path.join(home, '.claude', '.credentials.json'), '{}');
  // Another agent's pool: one work account, one duplicate of personal, one on another machine.
  const signedIn = (dir: string, email: string) => {
    write(path.join(dir, '.claude.json'), { oauthAccount: { emailAddress: email } });
    write(path.join(dir, '.credentials.json'), '{}');
  };
  // luna: the machine-bound store, stamped for this machine. One work account, one duplicate of personal,
  // and one folder that only has an account file (signed out).
  const work = path.join(home, '.instar', 'agents', 'luna', '.instar', 'accounts', 'claude-1');
  signedIn(work, 'work@example.com');
  const dup = path.join(home, '.instar', 'agents', 'luna', '.instar', 'accounts', 'claude-2');
  signedIn(dup, 'Personal@example.com');
  const signedOut = path.join(home, '.instar', 'agents', 'luna', '.instar', 'accounts', 'claude-4');
  write(path.join(signedOut, '.claude.json'), { oauthAccount: { emailAddress: 'gone@example.com' } });
  write(path.join(home, '.instar', 'agents', 'luna', '.instar', 'state', 'subscription-pool', 'accounts.json'), {
    accounts: [{ configHome: work, framework: 'claude-code' }, { configHome: dup, framework: 'claude-code' }, { configHome: signedOut, framework: 'claude-code' }],
  });
  write(path.join(home, '.instar', 'agents', 'luna', '.instar', 'state', 'subscription-pool.initialized.json'), { machineId: 'm_here' });
  // mars: a store stamped for another machine is skipped.
  const remote = path.join(home, '.instar', 'agents', 'mars', '.instar', 'accounts', 'claude-1');
  signedIn(remote, 'remote@example.com');
  write(path.join(home, '.instar', 'agents', 'mars', '.instar', 'state', 'subscription-pool', 'accounts.json'), { accounts: [{ configHome: remote, framework: 'claude-code' }] });
  write(path.join(home, '.instar', 'agents', 'mars', '.instar', 'state', 'subscription-pool.initialized.json'), { machineId: 'm_other' });
  // Default Codex folder.
  write(path.join(home, '.codex', 'auth.json'), codexAuth('chat@example.com', 'plus'));
  return home;
}

describe('discoverAccounts', () => {
  it('lists Claude accounts: default first, a borrowed folder, same email once, signed-out and other-machine folders skipped', () => {
    const home = fixtureHome();
    const found = discoverAccounts('claude-code', { home, machineId: 'm_here', env: {}, keychainHas: () => false });
    expect(found.map((a) => a.email)).toEqual(['personal@example.com', 'work@example.com']);
    expect(found[0]).toMatchObject({ isDefault: true, borrowedFrom: null });
    expect(found[1]).toMatchObject({ isDefault: false, borrowedFrom: 'luna' });
  });

  it('lists the Codex account with its plan, and nothing for an AI with no folder', () => {
    const home = fixtureHome();
    const codex = discoverAccounts('codex-cli', { home, env: {} });
    expect(codex).toHaveLength(1);
    expect(codex[0]).toMatchObject({ isDefault: true, borrowedFrom: null });
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'inst-acct-empty-'));
    dirs.push(empty);
    expect(discoverAccounts('claude-code', { home: empty, env: {}, keychainHas: () => false })).toEqual([]);
  });

  it('an account id is a stable hash of the real folder path', () => {
    const home = fixtureHome();
    const a = discoverAccounts('claude-code', { home, machineId: 'm_here', env: {}, keychainHas: () => false })[0]!;
    expect(a.id).toBe(accountIdFor(path.join(home, '.claude')));
    expect(a.id).toMatch(/^[0-9a-f]{16}$/);
  });

  it('a folder signed in only through the keychain counts; the check never reads the secret', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'inst-acct-kc-'));
    dirs.push(home);
    write(path.join(home, '.claude', '.claude.json'), { oauthAccount: { emailAddress: 'kc@example.com' } });
    const asked: string[] = [];
    const found = discoverAccounts('claude-code', { home, env: {}, keychainHas: (svc) => { asked.push(svc); return true; } });
    expect(found.map((a) => a.email)).toEqual(['kc@example.com']);
    expect(asked[0]).toMatch(/^Claude Code-credentials/);
  });
});
