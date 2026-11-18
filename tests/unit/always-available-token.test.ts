/**
 * The before-login Claude sign-in for Always available (docs/specs/create-agent-accounts-and-always-on.md
 * §B.4): the code is checked against the chosen account's email, stored where sessions read it, and
 * turning off puts the earlier sign-in back only while the stored code is still the one set here.
 */
import { afterAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { alwaysAvailableTokenStatus, clearAlwaysAvailableToken, setAlwaysAvailableToken } from '../../src/core/alwaysAvailableToken.js';
import { emailForClaudeToken } from '../../src/core/CredentialIdentityOracle.js';
import { fileVaultState } from '../../src/commands/alwaysAvailable.js';
import { writeClaudeKeyToConfig } from '../../src/core/claudeChildAuth.js';
import { KEY_MATERIAL_FILES, KEY_MATERIAL_NEVER_SERVED_PREFIXES } from '../../src/core/keyMaterialPaths.js';
import { SessionManager } from '../../src/core/SessionManager.js';
import { StateManager } from '../../src/core/StateManager.js';

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/unit/always-available-token.test.ts' }); });

const CODE_A = `sk-ant-oat01-${'a'.repeat(40)}`;
const CODE_B = `sk-ant-oat01-${'b'.repeat(40)}`;
const EARLIER = `sk-ant-oat01-${'e'.repeat(40)}`;

function agent(credential?: unknown): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aa-token-'));
  dirs.push(dir);
  const stateDir = path.join(dir, '.instar');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({ projectName: 'scout', ...(credential ? { sessions: { credentials: { anthropic: credential } } } : {}) }));
  return stateDir;
}
const creds = (stateDir: string) => (JSON.parse(fs.readFileSync(path.join(stateDir, 'config.json'), 'utf-8')).sessions?.credentials ?? null) as Record<string, unknown> | null;

/** A fake OAuth profile endpoint: each code signs in as one email. */
const profile = (emails: Record<string, string>) => async (_url: string, init?: { headers?: Record<string, string> }) => {
  const token = (init?.headers?.Authorization ?? '').replace('Bearer ', '');
  const email = emails[token];
  return email
    ? { ok: true, status: 200, json: async () => ({ account: { email } }) }
    : { ok: false, status: 401, json: async () => ({}) };
};
const fetchImpl = profile({ [CODE_A]: 'Person@Example.com', [CODE_B]: 'other@example.com' });

describe('setting the Always available code', () => {
  it('stores a code that signs in as the chosen account (email case ignored), at mode 0600', async () => {
    const s = agent();
    expect(await setAlwaysAvailableToken({ stateDir: s, token: `${CODE_A}\n`, expectEmail: 'person@example.com', fetchImpl })).toEqual({ ok: true, email: 'Person@Example.com' });
    expect(creds(s)).toEqual({ anthropic: { kind: 'oauth-token', value: CODE_A } });
    expect(fs.statSync(path.join(s, 'config.json')).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.join(s, 'state', 'always-available-token.json')).mode & 0o777).toBe(0o600);
    expect(fs.readFileSync(path.join(s, 'state', 'always-available-token.json'), 'utf-8')).not.toContain(CODE_A);
    expect(alwaysAvailableTokenStatus(s)).toEqual({ set: true, email: 'Person@Example.com' });
  });

  it('refuses a code for another account, one that cannot be checked, or one of the wrong shape, changing nothing', async () => {
    const s = agent();
    const other = await setAlwaysAvailableToken({ stateDir: s, token: CODE_B, expectEmail: 'person@example.com', fetchImpl });
    expect(other).toMatchObject({ ok: false, message: expect.stringContaining('signs in as other@example.com, not person@example.com') });
    const unknown = await setAlwaysAvailableToken({ stateDir: s, token: `sk-ant-oat01-${'z'.repeat(40)}`, expectEmail: 'person@example.com', fetchImpl });
    expect(unknown).toMatchObject({ ok: false, message: expect.stringContaining("couldn't be checked") });
    expect(await setAlwaysAvailableToken({ stateDir: s, token: 'hello', expectEmail: 'person@example.com', fetchImpl })).toMatchObject({ ok: false });
    expect(creds(s)).toBeNull();
    expect(fs.existsSync(path.join(s, 'state', 'always-available-token.json'))).toBe(false);
  });
});

describe('turning Always available off', () => {
  it('puts the earlier sign-in back, even after the code was set twice', async () => {
    const s = agent({ kind: 'oauth-token', value: EARLIER, baseUrl: 'https://proxy.example' });
    await setAlwaysAvailableToken({ stateDir: s, token: CODE_A, expectEmail: 'person@example.com', fetchImpl });
    await setAlwaysAvailableToken({ stateDir: s, token: CODE_A, expectEmail: 'person@example.com', fetchImpl });
    expect(clearAlwaysAvailableToken(s)).toEqual({ ok: true, restored: true });
    expect(creds(s)).toEqual({ anthropic: { kind: 'oauth-token', value: EARLIER, baseUrl: 'https://proxy.example' } });
    expect(alwaysAvailableTokenStatus(s)).toEqual({ set: false, email: null });
  });

  it('with nothing there before, removes the code; the agent goes back to its account folder', async () => {
    const s = agent();
    await setAlwaysAvailableToken({ stateDir: s, token: CODE_A, expectEmail: 'person@example.com', fetchImpl });
    expect(clearAlwaysAvailableToken(s)).toEqual({ ok: true, restored: true });
    expect(creds(s)).toBeNull();
  });

  it('a code the person changed since is theirs and stays', async () => {
    const s = agent();
    await setAlwaysAvailableToken({ stateDir: s, token: CODE_A, expectEmail: 'person@example.com', fetchImpl });
    writeClaudeKeyToConfig(path.join(s, 'config.json'), CODE_B);
    expect(clearAlwaysAvailableToken(s)).toEqual({ ok: true, restored: false });
    expect(creds(s)).toEqual({ anthropic: { kind: 'oauth-token', value: CODE_B } });
    expect(fs.existsSync(path.join(s, 'state', 'always-available-token.json'))).toBe(false);
  });

  it('a key the person set by hand between two sets is the one restored', async () => {
    const s = agent({ kind: 'oauth-token', value: EARLIER });
    await setAlwaysAvailableToken({ stateDir: s, token: CODE_A, expectEmail: 'person@example.com', fetchImpl });
    writeClaudeKeyToConfig(path.join(s, 'config.json'), CODE_B);
    await setAlwaysAvailableToken({ stateDir: s, token: CODE_A, expectEmail: 'person@example.com', fetchImpl });
    clearAlwaysAvailableToken(s);
    expect(creds(s)).toEqual({ anthropic: { kind: 'oauth-token', value: CODE_B } });
  });

  it('with no record, changes nothing', () => {
    const s = agent({ kind: 'oauth-token', value: EARLIER });
    expect(clearAlwaysAvailableToken(s)).toEqual({ ok: true, restored: false });
    expect(creds(s)).toEqual({ anthropic: { kind: 'oauth-token', value: EARLIER } });
  });
});

describe('where the earlier sign-in is kept', () => {
  it('the record is key material: the file routes, backups, gitignore and sync classifier refuse it', () => {
    expect(KEY_MATERIAL_NEVER_SERVED_PREFIXES.some((p) => '.instar/state/always-available-token.json'.startsWith(p))).toBe(true);
    expect(KEY_MATERIAL_NEVER_SERVED_PREFIXES.some((p) => '.instar/state/always-available-token.json.123.abcd.tmp'.startsWith(p))).toBe(true);
    expect(KEY_MATERIAL_FILES).toContain('state/always-available-token.json');
  });
});

describe('the code overrides the pool', () => {
  it('while the code is in use, new sessions are not pinned to a pool account; after turn-off they are again', async () => {
    const s = agent();
    const sm = new SessionManager({
      tmuxPath: '/usr/bin/false', claudePath: '/usr/local/bin/claude', projectDir: path.dirname(s), stateDir: s,
      maxSessions: 1, protectedSessions: [], completionPatterns: [],
    } as never, new StateManager(s));
    try {
      sm.setSpawnAccountResolver(() => ({ configHome: '/pool/one', accountId: 'acct-1' }));
      const pick = () => (sm as unknown as { poolAccountForSpawn(): unknown }).poolAccountForSpawn();
      expect(pick()).toEqual({ configHome: '/pool/one', accountId: 'acct-1' });
      await setAlwaysAvailableToken({ stateDir: s, token: CODE_A, expectEmail: 'person@example.com', fetchImpl });
      // Until the server picks the code up, sessions still launch on the old sign-in, so they stay pinned.
      expect(pick()).toEqual({ configHome: '/pool/one', accountId: 'acct-1' });
      sm.setAnthropicKey(CODE_A); // what the server's key watch does within a minute
      expect(pick()).toBeNull();
      clearAlwaysAvailableToken(s);
      sm.setAnthropicKey(null);
      expect(pick()).toEqual({ configHome: '/pool/one', accountId: 'acct-1' });
    } finally { sm.stopMonitoring(); }
  });
});

describe('helpers', () => {
  it('emailForClaudeToken never guesses: a failed or odd answer is unavailable', async () => {
    expect(await emailForClaudeToken(CODE_A, { fetchImpl })).toEqual({ email: 'Person@Example.com' });
    expect((await emailForClaudeToken('x', { fetchImpl })).unavailable).toBe(true);
    const odd = async () => ({ ok: true, status: 200, json: async () => ({ account: {} }) });
    expect((await emailForClaudeToken(CODE_A, { fetchImpl: odd })).unavailable).toBe(true);
  });

  it('FileVault state from fdesetup\'s exit code', () => {
    if (process.platform !== 'darwin') { expect(fileVaultState()).toBe('unknown'); return; }
    expect(fileVaultState(() => ({ status: 0 }))).toBe('on');
    expect(fileVaultState(() => ({ status: 1 }))).toBe('off');
    expect(fileVaultState(() => ({ status: null }))).toBe('unknown');
  });
});
