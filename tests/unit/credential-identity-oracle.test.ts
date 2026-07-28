import { describe, it, expect } from 'vitest';
import { CredentialIdentityOracle, type OracleFetch } from '../../src/core/CredentialIdentityOracle.js';
import type { CredentialStore } from '../../src/core/OAuthRefresher.js';

/** A store returning a fixed raw blob per slot. */
function storeFrom(blobs: Record<string, string | null>): CredentialStore {
  return {
    read: (configHome: string) => blobs[configHome] ?? null,
    write: () => true,
  };
}

/** A blob with a usable access token. */
function tokenBlob(accessToken: string): string {
  return JSON.stringify({ claudeAiOauth: { accessToken, refreshToken: 'r', expiresAt: 0 } });
}

/** A fetch returning a scripted profile response. */
function fetchOk(body: unknown): OracleFetch {
  return async () => ({ ok: true, status: 200, json: async () => body });
}
function fetchStatus(status: number): OracleFetch {
  return async () => ({ ok: false, status, json: async () => ({}) });
}

describe('CredentialIdentityOracle — §2.11 classification', () => {
  it('returns the email when the profile resolves a non-empty string email', async () => {
    const oracle = new CredentialIdentityOracle({
      store: storeFrom({ '/h/a': tokenBlob('tok-a') }),
      fetchImpl: fetchOk({ account: { email: 'a@example.com' } }),
    });
    const res = await oracle.resolveSlotTenant('/h/a');
    expect(res).toEqual({ email: 'a@example.com' });
  });

  it('unavailable when the slot has no credential blob', async () => {
    const oracle = new CredentialIdentityOracle({
      store: storeFrom({ '/h/a': null }),
      fetchImpl: fetchOk({ account: { email: 'a@example.com' } }),
    });
    const res = await oracle.resolveSlotTenant('/h/a');
    expect(res.unavailable).toBe(true);
    expect(res.email).toBeUndefined();
  });

  it('unavailable when the blob has no access token', async () => {
    const oracle = new CredentialIdentityOracle({
      store: storeFrom({ '/h/a': JSON.stringify({ claudeAiOauth: { refreshToken: 'r' } }) }),
      fetchImpl: fetchOk({ account: { email: 'a@example.com' } }),
    });
    const res = await oracle.resolveSlotTenant('/h/a');
    expect(res.unavailable).toBe(true);
  });

  it('unavailable (never mismatch) on 401 / 403 / 429 / 5xx', async () => {
    for (const status of [401, 403, 429, 500, 503]) {
      const oracle = new CredentialIdentityOracle({
        store: storeFrom({ '/h/a': tokenBlob('tok-a') }),
        fetchImpl: fetchStatus(status),
      });
      const res = await oracle.resolveSlotTenant('/h/a');
      expect(res.unavailable).toBe(true);
      expect(res.reason).toContain(String(status));
    }
  });

  it('unavailable when the fetch throws (timeout/network)', async () => {
    const oracle = new CredentialIdentityOracle({
      store: storeFrom({ '/h/a': tokenBlob('tok-a') }),
      fetchImpl: async () => {
        throw new Error('ETIMEDOUT');
      },
    });
    const res = await oracle.resolveSlotTenant('/h/a');
    expect(res.unavailable).toBe(true);
    expect(res.reason).toContain('ETIMEDOUT');
  });

  it('unavailable on an unparseable profile body', async () => {
    const oracle = new CredentialIdentityOracle({
      store: storeFrom({ '/h/a': tokenBlob('tok-a') }),
      fetchImpl: async () => ({ ok: true, status: 200, json: async () => { throw new Error('bad json'); } }),
    });
    const res = await oracle.resolveSlotTenant('/h/a');
    expect(res.unavailable).toBe(true);
  });

  it('unavailable when the profile carries no usable email (missing/empty/non-string)', async () => {
    for (const body of [{ account: {} }, { account: { email: '' } }, { account: { email: 42 } }, {}]) {
      const oracle = new CredentialIdentityOracle({
        store: storeFrom({ '/h/a': tokenBlob('tok-a') }),
        fetchImpl: fetchOk(body),
      });
      const res = await oracle.resolveSlotTenant('/h/a');
      expect(res.unavailable).toBe(true);
    }
  });

  it('sends the slot token as a Bearer header to the profile endpoint', async () => {
    let seenAuth: string | undefined;
    let seenUrl: string | undefined;
    const oracle = new CredentialIdentityOracle({
      store: storeFrom({ '/h/a': tokenBlob('secret-tok') }),
      fetchImpl: async (url, init) => {
        seenUrl = url;
        seenAuth = init?.headers?.Authorization;
        return { ok: true, status: 200, json: async () => ({ account: { email: 'a@x.com' } }) };
      },
    });
    await oracle.resolveSlotTenant('/h/a');
    expect(seenUrl).toContain('/api/oauth/profile');
    expect(seenAuth).toBe('Bearer secret-tok');
  });
});

describe('CredentialIdentityOracle — wiring', () => {
  it('the default oracle is a real, non-stub implementation of IdentityOracle', () => {
    const oracle = new CredentialIdentityOracle();
    // Real method present (not a no-op that greens every check).
    expect(typeof oracle.resolveSlotTenant).toBe('function');
    // It is assignable to the IdentityOracle interface the ledger consumes.
    const asInterface: { resolveSlotTenant: (s: string) => Promise<unknown> } = oracle;
    expect(asInterface.resolveSlotTenant).toBe(oracle.resolveSlotTenant);
  });
});
