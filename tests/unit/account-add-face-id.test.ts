/**
 * Adding a Claude or Codex account from the owner's phone (docs/specs/account-add-face-id.md): the signed
 * action names only the kind, and the server picks a fresh pool id that no account, waiting sign-in, other
 * machine or login folder already holds.
 */
import { describe, it, expect } from 'vitest';
import { buildAction, actionLine } from '../../src/server/mobilePermissionsRoutes.js';
import { deriveNewAccountId, idNamePart, isNewAccountKind, NEW_ACCOUNT_KINDS, MAX_ID_ATTEMPTS } from '../../src/core/newSubscriptionAccountId.js';

const seq = (...xs: string[]) => { let i = 0; return () => xs[i++] ?? 'ffff'; };

describe('account-add action', () => {
  it('signs exactly "account-add <kind>" for claude and codex', () => {
    for (const k of ['claude', 'codex'] as const) {
      const b = buildAction('account-add', k, {});
      expect(b).toEqual({ ok: true, action: { kind: 'account-add', target: k } });
      if (b.ok) expect(actionLine(b.action)).toBe(`account-add ${k}`);
    }
  });
  it('refuses any other kind', () => {
    for (const t of ['gemini', 'Claude', 'anthropic', 'codex-cli', '', 'claude codex', 7, null]) expect(buildAction('account-add', t, {}), String(t)).toEqual({ ok: false, error: 'bad-target' });
    expect(isNewAccountKind('claude')).toBe(true);
    expect(isNewAccountKind('openai')).toBe(false);
  });
  it('maps each kind to the pool provider and framework', () => {
    expect(NEW_ACCOUNT_KINDS.claude).toEqual({ provider: 'anthropic', framework: 'claude-code' });
    expect(NEW_ACCOUNT_KINDS.codex).toEqual({ provider: 'openai', framework: 'codex-cli' });
  });
});

describe('deriveNewAccountId', () => {
  it('slugs the nickname, else the email local part, and adds a 4-hex suffix', () => {
    expect(deriveNewAccountId('claude', 'Gearfinity 3D', 'g@example.com', () => false, seq('a1b2'))).toBe('gearfinity-3d-a1b2');
    expect(deriveNewAccountId('claude', null, 'Justin.Headley+work@example.com', () => false, seq('0001'))).toBe('justin-headley-work-0001');
    expect(deriveNewAccountId('claude', 'Café ☕', 'x@example.com', () => false, seq('0002'))).toBe('cafe-0002');
    expect(deriveNewAccountId('claude', '!!!', '...@example.com', () => false, seq('0003'))).toBe('account-0003');
  });
  it('prefixes Codex ids with codex- once, like the existing Codex accounts', () => {
    expect(deriveNewAccountId('codex', 'Sagemind AI', 's@example.com', () => false, seq('beef'))).toBe('codex-sagemind-ai-beef');
    expect(deriveNewAccountId('codex', 'Codex Dawn', 'd@example.com', () => false, seq('beef'))).toBe('codex-dawn-beef');
  });
  it('steps past taken ids and returns null when every attempt is taken', () => {
    const taken = new Set(['gear-aaaa', 'gear-bbbb']);
    expect(deriveNewAccountId('claude', 'gear', 'g@example.com', (id) => taken.has(id), seq('aaaa', 'bbbb', 'cccc'))).toBe('gear-cccc');
    expect(deriveNewAccountId('claude', 'gear', 'g@example.com', () => true, seq())).toBeNull();
    let calls = 0;
    deriveNewAccountId('claude', 'gear', 'g@example.com', () => true, () => { calls++; return 'abcd'; });
    expect(calls).toBe(MAX_ID_ATTEMPTS);
  });
  it('ignores a malformed suffix and always yields the pool id shape', () => {
    expect(deriveNewAccountId('claude', 'gear', 'g@example.com', () => false, seq('XYZ!', 'zz', '00aa'))).toBe('gear-00aa');
    for (const n of ['A'.repeat(200), 'a--b', '-lead', 'trail-']) {
      const id = deriveNewAccountId('claude', n, 'g@example.com', () => false, seq('1234'))!;
      expect(id).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
      expect(idNamePart(n, 'g@example.com').length).toBeLessThanOrEqual(32);
    }
  });
});
