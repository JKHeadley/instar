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
  // Default Claude folder, signed in as personal@example.com.
  write(path.join(home, '.claude', '.claude.json'), { oauthAccount: { emailAddress: 'personal@example.com' } });
  // Another agent's pool: one work account, one duplicate of personal, one on another machine.
  const work = path.join(home, '.instar', 'agents', 'luna', '.instar', 'accounts', 'claude-1');
  write(path.join(work, '.claude.json'), { oauthAccount: { emailAddress: 'work@example.com' } });
  const dup = path.join(home, '.instar', 'agents', 'luna', '.instar', 'accounts', 'claude-2');
  write(path.join(dup, '.claude.json'), { oauthAccount: { emailAddress: 'Personal@example.com' } });
  const elsewhere = path.join(home, '.instar', 'agents', 'luna', '.instar', 'accounts', 'claude-3');
  write(path.join(elsewhere, '.claude.json'), { oauthAccount: { emailAddress: 'remote@example.com' } });
  write(path.join(home, '.instar', 'agents', 'luna', '.instar', 'subscription-pool.json'), {
    accounts: [
      { configHome: work, framework: 'claude-code', machineId: 'm_here' },
      { configHome: dup, framework: 'claude-code', machineId: 'm_here' },
      { configHome: elsewhere, framework: 'claude-code', machineId: 'm_other' },
    ],
  });
  // Default Codex folder.
  write(path.join(home, '.codex', 'auth.json'), codexAuth('chat@example.com', 'plus'));
  return home;
}

describe('discoverAccounts', () => {
  it('lists Claude accounts: default first, a borrowed pool folder, same email once, other machines skipped', () => {
    const home = fixtureHome();
    const found = discoverAccounts('claude-code', { home, machineId: 'm_here', env: {} });
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
    expect(discoverAccounts('claude-code', { home: empty, env: {} })).toEqual([]);
  });

  it('an account id is a stable hash of the real folder path', () => {
    const home = fixtureHome();
    const a = discoverAccounts('claude-code', { home, machineId: 'm_here', env: {} })[0]!;
    expect(a.id).toBe(accountIdFor(path.join(home, '.claude')));
    expect(a.id).toMatch(/^[0-9a-f]{16}$/);
  });
});
