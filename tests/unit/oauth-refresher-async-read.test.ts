/**
 * Unit tests for the NON-BLOCKING credential read added to fix the event-loop freeze:
 * `readClaudeOauthAsync` + `CredentialStore.readAsync` (OAuthRefresher) and
 * `CredentialIdentityOracle.resolveSlotTenant` awaiting the async path.
 *
 * Root cause this guards: the macOS keychain read was a SYNCHRONOUS, un-timeout'd
 * `execFileSync('security', …)` on the event loop, invoked sequentially over all 5 account
 * slots by the credential-audit loop. Under multi-agent `securityd` contention it froze the
 * loop 4–13s per cycle (dashboard flap + false-sleep). The audit loop now reads via
 * `readClaudeOauthAsync`, which yields the loop on each await.
 *
 * Fully hermetic: fake CredentialStore implementations, injected fetch. NO `security` is ever
 * spawned (we never exercise the real `defaultCredentialStore.readAsync` darwin path here —
 * only assert it EXISTS as a function, which is a property check, not an invocation).
 */

import { describe, it, expect } from 'vitest';
import {
  readClaudeOauth,
  readClaudeOauthAsync,
  refreshClaudeToken,
  defaultCredentialStore,
  type CredentialStore,
  type RefreshFetch,
} from '../../src/core/OAuthRefresher.js';
import { CredentialIdentityOracle, type OracleFetch } from '../../src/core/CredentialIdentityOracle.js';

const HOME = '/h/.claude-a';

function oauthBlob(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    claudeAiOauth: {
      accessToken: 'sk-ant-oat0-AAA',
      refreshToken: 'sk-ant-ort0-AAA',
      expiresAt: 1234,
      scopes: ['user:inference'],
      subscriptionType: 'max',
      ...over,
    },
  });
}

/** A store implementing BOTH read (sync) + readAsync, each returning the same fixed blob. */
function dualStore(blob: string | null): CredentialStore {
  return {
    read: () => blob,
    write: () => true,
    readAsync: async () => blob,
  };
}

/** A legacy store implementing ONLY the sync read (no readAsync) — the backward-compat path. */
function syncOnlyStore(blob: string | null): CredentialStore {
  return {
    read: () => blob,
    write: () => true,
  };
}

describe('readClaudeOauthAsync', () => {
  it('returns the SAME parsed result as readClaudeOauth for the same store', async () => {
    const blob = oauthBlob();
    const store = dualStore(blob);
    const sync = readClaudeOauth(HOME, store);
    const async = await readClaudeOauthAsync(HOME, store);
    expect(async).toEqual(sync);
    expect(async?.accessToken).toBe('sk-ant-oat0-AAA');
    expect(async?.refreshToken).toBe('sk-ant-ort0-AAA');
    expect(async?.subscriptionType).toBe('max');
  });

  it('falls back to the sync `read` when the store has no readAsync (backward-compatible)', async () => {
    const blob = oauthBlob();
    const store = syncOnlyStore(blob);
    expect(store.readAsync).toBeUndefined();
    const async = await readClaudeOauthAsync(HOME, store);
    expect(async).toEqual(readClaudeOauth(HOME, store));
    expect(async?.accessToken).toBe('sk-ant-oat0-AAA');
  });

  it('returns null when the async read yields no blob (parity with sync null path)', async () => {
    const store = dualStore(null);
    expect(await readClaudeOauthAsync(HOME, store)).toBeNull();
    expect(readClaudeOauth(HOME, store)).toBeNull();
  });

  it('returns null on an unparseable blob (same @silent-fallback as sync)', async () => {
    const store = dualStore('{ not json');
    expect(await readClaudeOauthAsync(HOME, store)).toBeNull();
  });

  it('prefers readAsync over read when BOTH are present (proves it uses the async path)', async () => {
    const store: CredentialStore = {
      read: () => oauthBlob({ accessToken: 'sk-ant-oat0-SYNC' }),
      write: () => true,
      readAsync: async () => oauthBlob({ accessToken: 'sk-ant-oat0-ASYNC' }),
    };
    const res = await readClaudeOauthAsync(HOME, store);
    expect(res?.accessToken).toBe('sk-ant-oat0-ASYNC');
  });
});

describe('defaultCredentialStore exposes readAsync + writeAsync', () => {
  it('defaultCredentialStore.readAsync is a function', () => {
    expect(typeof defaultCredentialStore.readAsync).toBe('function');
  });

  it('defaultCredentialStore.writeAsync is a function', () => {
    expect(typeof defaultCredentialStore.writeAsync).toBe('function');
  });

  it('still exposes the sync read + write (backward-compatible surface)', () => {
    expect(typeof defaultCredentialStore.read).toBe('function');
    expect(typeof defaultCredentialStore.write).toBe('function');
  });
});

describe('refreshClaudeToken prefers the async keychain read+write (off the event loop)', () => {
  function fetchRefreshOk(): RefreshFetch {
    return async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        access_token: 'sk-ant-oat0-NEW',
        refresh_token: 'sk-ant-ort0-NEW',
        expires_in: 3600,
      }),
    });
  }

  it('uses readAsync for the read and writeAsync for the write when BOTH are present', async () => {
    const calls: string[] = [];
    const store: CredentialStore = {
      read: () => {
        calls.push('read-sync');
        return oauthBlob();
      },
      write: () => {
        calls.push('write-sync');
        return true;
      },
      readAsync: async () => {
        calls.push('read-async');
        return oauthBlob();
      },
      writeAsync: async () => {
        calls.push('write-async');
        return true;
      },
    };

    const res = await refreshClaudeToken(HOME, { store, fetchImpl: fetchRefreshOk(), now: () => 0 });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.accessToken).toBe('sk-ant-oat0-NEW');
    // The sync read/write primitives (the loop-freezing ones) must NEVER be touched on this path.
    expect(calls).toContain('read-async');
    expect(calls).toContain('write-async');
    expect(calls).not.toContain('read-sync');
    expect(calls).not.toContain('write-sync');
  });

  it('falls back to the sync read/write for a legacy store without the async methods', async () => {
    const calls: string[] = [];
    const store: CredentialStore = {
      read: () => {
        calls.push('read-sync');
        return oauthBlob();
      },
      write: () => {
        calls.push('write-sync');
        return true;
      },
    };
    const res = await refreshClaudeToken(HOME, { store, fetchImpl: fetchRefreshOk(), now: () => 0 });
    expect(res.ok).toBe(true);
    expect(calls).toEqual(['read-sync', 'write-sync']);
  });

  it('a write-async failure (false) maps to write-failed, never corrupting the result', async () => {
    const store: CredentialStore = {
      read: () => oauthBlob(),
      write: () => true,
      readAsync: async () => oauthBlob(),
      writeAsync: async () => false, // keychain write failed/timed out
    };
    const res = await refreshClaudeToken(HOME, { store, fetchImpl: fetchRefreshOk(), now: () => 0 });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('write-failed');
  });
});

describe('CredentialIdentityOracle awaits the async read', () => {
  function fetchOk(body: unknown): OracleFetch {
    return async () => ({ ok: true, status: 200, json: async () => body });
  }

  it('resolveSlotTenant does NOT resolve until the async read resolves', async () => {
    let releaseRead!: (v: string) => void;
    const deferred = new Promise<string>((resolve) => {
      releaseRead = resolve;
    });

    let readResolved = false;
    const store: CredentialStore = {
      read: () => {
        throw new Error('sync read must NOT be used on the audit hot path');
      },
      write: () => true,
      readAsync: async () => {
        const blob = await deferred;
        readResolved = true;
        return blob;
      },
    };

    const oracle = new CredentialIdentityOracle({
      store,
      fetchImpl: fetchOk({ account: { email: 'a@example.com' } }),
    });

    let settled = false;
    const promise = oracle.resolveSlotTenant('/h/a').then((r) => {
      settled = true;
      return r;
    });

    // Let the microtask queue drain; the oracle is parked awaiting the deferred async read.
    await Promise.resolve();
    await Promise.resolve();
    expect(readResolved).toBe(false);
    expect(settled).toBe(false);

    // Release the async read → the oracle proceeds to the profile probe and resolves.
    releaseRead(oauthBlob({ accessToken: 'sk-ant-oat0-AAA' }));
    const res = await promise;
    expect(readResolved).toBe(true);
    expect(settled).toBe(true);
    expect(res).toEqual({ email: 'a@example.com' });
  });

  it('uses the injected store (sync read never spawns) and resolves the email', async () => {
    const store = dualStore(oauthBlob());
    const oracle = new CredentialIdentityOracle({
      store,
      fetchImpl: fetchOk({ account: { email: 'b@example.com' } }),
    });
    const res = await oracle.resolveSlotTenant('/h/a');
    expect(res).toEqual({ email: 'b@example.com' });
  });
});
