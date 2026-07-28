/**
 * Unit tests for OAuthRefresher (P1.2 hardening of the Subscription & Auth
 * Standard). Fully hermetic: an in-memory CredentialStore + injected fetch +
 * fixed clock → zero keychain, zero network. The load-bearing property under
 * test is CORRUPTION SAFETY: the credential is written back ONLY on a fully
 * valid exchange, as a read-merge-write that preserves every existing field, and
 * NEVER on any failure path.
 */

import { describe, it, expect } from 'vitest';
import {
  refreshClaudeToken,
  readClaudeOauth,
  claudeCredentialService,
  type CredentialStore,
  type RefreshFetch,
} from '../../src/core/OAuthRefresher.js';

function credRaw(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    claudeAiOauth: {
      accessToken: 'sk-ant-oat0-OLD',
      refreshToken: 'sk-ant-ort0-OLD',
      expiresAt: 1000,
      scopes: ['user:inference', 'user:profile'],
      subscriptionType: 'max',
      rateLimitTier: 'default_claude_max_20x',
      ...over,
    },
  });
}

function fakeStore(initial: Record<string, string> = {}) {
  const m: Record<string, string> = { ...initial };
  let writes = 0;
  const store: CredentialStore = {
    read: (ch) => (ch in m ? m[ch] : null),
    write: (ch, raw) => {
      m[ch] = raw;
      writes += 1;
      return true;
    },
  };
  return { store, dump: () => ({ ...m }), writeCount: () => writes };
}

function tokenFetch(status: number, body: unknown): RefreshFetch {
  return async () => ({ ok: status >= 200 && status < 300, status, json: async () => body });
}

const HOME = '/h/.claude-a';
const FIXED_NOW = () => 5_000_000;

describe('OAuthRefresher.refreshClaudeToken', () => {
  it('refreshes + persists a rotated refresh token, preserving all other fields', async () => {
    const fs = fakeStore({ [HOME]: credRaw() });
    const res = await refreshClaudeToken(HOME, {
      store: fs.store,
      now: FIXED_NOW,
      fetchImpl: tokenFetch(200, {
        access_token: 'sk-ant-oat0-NEW',
        refresh_token: 'sk-ant-ort0-NEW',
        expires_in: 28800,
      }),
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.accessToken).toBe('sk-ant-oat0-NEW');
    expect(res.expiresAt).toBe(5_000_000 + 28800 * 1000);
    expect(res.rotated).toBe(true);

    const written = JSON.parse(fs.dump()[HOME]).claudeAiOauth;
    expect(written.accessToken).toBe('sk-ant-oat0-NEW');
    expect(written.refreshToken).toBe('sk-ant-ort0-NEW'); // rotated token persisted
    expect(written.expiresAt).toBe(5_000_000 + 28800 * 1000);
    // every non-token field preserved verbatim
    expect(written.scopes).toEqual(['user:inference', 'user:profile']);
    expect(written.subscriptionType).toBe('max');
    expect(written.rateLimitTier).toBe('default_claude_max_20x');
  });

  it('keeps the existing refresh token when the server does not rotate it', async () => {
    const fs = fakeStore({ [HOME]: credRaw() });
    const res = await refreshClaudeToken(HOME, {
      store: fs.store,
      now: FIXED_NOW,
      fetchImpl: tokenFetch(200, { access_token: 'sk-ant-oat0-NEW2', expires_in: 100 }),
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.rotated).toBe(false);
    const written = JSON.parse(fs.dump()[HOME]).claudeAiOauth;
    expect(written.accessToken).toBe('sk-ant-oat0-NEW2');
    expect(written.refreshToken).toBe('sk-ant-ort0-OLD'); // old one preserved, never dropped
  });

  it('returns no-refresh-token and writes NOTHING when no refresh token exists', async () => {
    const fs = fakeStore({ [HOME]: credRaw({ refreshToken: undefined }) });
    const res = await refreshClaudeToken(HOME, { store: fs.store, fetchImpl: tokenFetch(200, {}) });
    expect(res).toEqual({ ok: false, reason: 'no-refresh-token' });
    expect(fs.writeCount()).toBe(0);
    // original credential is untouched
    expect(JSON.parse(fs.dump()[HOME]).claudeAiOauth.accessToken).toBe('sk-ant-oat0-OLD');
  });

  it('returns exchange-failed and writes NOTHING on a non-200 (existing login intact)', async () => {
    const fs = fakeStore({ [HOME]: credRaw() });
    const res = await refreshClaudeToken(HOME, { store: fs.store, fetchImpl: tokenFetch(400, { error: 'invalid_grant' }) });
    expect(res).toEqual({ ok: false, reason: 'exchange-failed', status: 400 });
    expect(fs.writeCount()).toBe(0);
    expect(JSON.parse(fs.dump()[HOME]).claudeAiOauth.refreshToken).toBe('sk-ant-ort0-OLD');
  });

  it('returns exchange-failed when the network throws', async () => {
    const fs = fakeStore({ [HOME]: credRaw() });
    const throwFetch: RefreshFetch = async () => {
      throw new Error('network down');
    };
    const res = await refreshClaudeToken(HOME, { store: fs.store, fetchImpl: throwFetch });
    expect(res).toEqual({ ok: false, reason: 'exchange-failed' });
    expect(fs.writeCount()).toBe(0);
  });

  it('rejects a malformed 200 (missing / wrong-shaped access token) and writes NOTHING', async () => {
    for (const body of [
      {}, // no access_token
      { access_token: 'not-an-oauth-token', expires_in: 100 }, // wrong prefix
      { access_token: 'sk-ant-oat0-NEW' }, // no expires_in
      { access_token: 'sk-ant-oat0-NEW', expires_in: -5 }, // non-positive expiry
      { access_token: 'sk-ant-oat0-NEW', expires_in: 'soon' }, // non-numeric expiry
    ]) {
      const fs = fakeStore({ [HOME]: credRaw() });
      const res = await refreshClaudeToken(HOME, { store: fs.store, fetchImpl: tokenFetch(200, body) });
      expect(res).toEqual({ ok: false, reason: 'malformed-response' });
      expect(fs.writeCount()).toBe(0);
    }
  });

  it('returns read-failed when the credential store is empty / unparseable', async () => {
    const empty = fakeStore({});
    expect(await refreshClaudeToken(HOME, { store: empty.store, fetchImpl: tokenFetch(200, {}) })).toEqual({
      ok: false,
      reason: 'read-failed',
    });
    const garbage = fakeStore({ [HOME]: 'not json' });
    expect(await refreshClaudeToken(HOME, { store: garbage.store, fetchImpl: tokenFetch(200, {}) })).toEqual({
      ok: false,
      reason: 'read-failed',
    });
  });

  it('returns write-failed (not ok) when persistence fails after a valid exchange', async () => {
    const store: CredentialStore = { read: () => credRaw(), write: () => false };
    const res = await refreshClaudeToken(HOME, {
      store,
      now: FIXED_NOW,
      fetchImpl: tokenFetch(200, { access_token: 'sk-ant-oat0-NEW', expires_in: 100 }),
    });
    expect(res).toEqual({ ok: false, reason: 'write-failed' });
  });

  it('sends the OAuth refresh-token grant with the client id', async () => {
    let captured: { url: string; body: unknown } | null = null;
    const spyFetch: RefreshFetch = async (url, init) => {
      captured = { url, body: JSON.parse(init.body) };
      return { ok: true, status: 200, json: async () => ({ access_token: 'sk-ant-oat0-NEW', expires_in: 100 }) };
    };
    await refreshClaudeToken(HOME, { store: fakeStore({ [HOME]: credRaw() }).store, fetchImpl: spyFetch });
    expect(captured!.url).toContain('/oauth/token');
    expect(captured!.body).toMatchObject({ grant_type: 'refresh_token', refresh_token: 'sk-ant-ort0-OLD' });
    expect((captured!.body as { client_id: string }).client_id).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe('OAuthRefresher locator + reader', () => {
  it('claudeCredentialService is bare for the default home, hash-suffixed otherwise', () => {
    expect(claudeCredentialService('~/.claude')).toBe('Claude Code-credentials');
    const a = claudeCredentialService('/h/.claude-a');
    const b = claudeCredentialService('/h/.claude-b');
    expect(a).toMatch(/^Claude Code-credentials-[0-9a-f]{8}$/);
    expect(b).toMatch(/^Claude Code-credentials-[0-9a-f]{8}$/);
    expect(a).not.toBe(b); // distinct homes → distinct entries
    expect(claudeCredentialService('/h/.claude-a')).toBe(a); // stable for the same home
  });

  it('readClaudeOauth parses the oauth block and tolerates junk', () => {
    const fs = fakeStore({ [HOME]: credRaw() });
    expect(readClaudeOauth(HOME, fs.store)?.accessToken).toBe('sk-ant-oat0-OLD');
    expect(readClaudeOauth('/nope', fs.store)).toBeNull();
    expect(readClaudeOauth(HOME, { read: () => 'not json', write: () => true })).toBeNull();
  });
});
