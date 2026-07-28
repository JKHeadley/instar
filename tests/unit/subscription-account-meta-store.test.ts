/**
 * Unit tests for WS5.2 §6.1a — the subscription-account-meta replicated store schema
 * (SubscriptionAccountMetaReplicatedStore.ts) — spec §8.1 accept/reject matrix.
 *
 * Proves the strict whitelist + clamps: a well-formed projection is accepted; over-long /
 * control-char nickname|email, extra/unknown keys (incl. smuggled configHome / credential),
 * out-of-set provider|framework|status, and malformed quota are REJECTED; configHome and
 * credential fields can never appear in the validated output.
 */

import { describe, it, expect } from 'vitest';
import {
  subscriptionAccountMetaStoreSchema,
  SUBSCRIPTION_ACCOUNT_META_KIND_REGISTRATION,
  SUBSCRIPTION_ACCOUNT_META_KIND,
  projectAccountToMeta,
  buildSubscriptionAccountMetaData,
  buildSubscriptionAccountMetaTombstoneData,
} from '../../src/core/SubscriptionAccountMetaReplicatedStore.js';
import { JOURNAL_KINDS } from '../../src/core/CoherenceJournal.js';

const ctx = { countDroppedField: () => {}, countJailReject: () => {} };
const validate = (raw: Record<string, unknown>) => subscriptionAccountMetaStoreSchema.validate(raw, ctx);

function wellFormed(over: Record<string, unknown> = {}) {
  return {
    id: 'acct-personal-1',
    nickname: 'Justin personal',
    email: 'justin@example.com',
    provider: 'anthropic',
    framework: 'claude-code',
    status: 'active',
    quota: { fiveHour: { utilizationPct: 42.5, resetsAt: '2026-06-17T00:00:00Z' }, source: 'oauth-usage-endpoint-fallback' },
    ...over,
  };
}

describe('subscription-account-meta schema (WS5.2 §6.1a)', () => {
  it('accepts a well-formed projection and echoes only whitelisted fields', () => {
    const out = validate(wellFormed());
    expect(out).not.toBeNull();
    expect(out).toEqual(wellFormed());
  });

  it('accepts a minimal projection (no email, no quota)', () => {
    const out = validate({ id: 'a1', nickname: 'n', provider: 'openai', framework: 'codex-cli', status: 'warming' });
    expect(out).toMatchObject({ id: 'a1', nickname: 'n', provider: 'openai', framework: 'codex-cli', status: 'warming' });
    expect(out).not.toHaveProperty('email');
    expect(out).not.toHaveProperty('quota');
  });

  it('REJECTS an id with illegal charset', () => {
    expect(validate(wellFormed({ id: 'Acct With Spaces' }))).toBeNull();
    expect(validate(wellFormed({ id: '../etc/passwd' }))).toBeNull();
  });

  it('REJECTS over-long / control-char nickname or email', () => {
    expect(validate(wellFormed({ nickname: 'x'.repeat(257) }))).not.toBeNull(); // clamped, still valid
    expect(validate(wellFormed({ nickname: 'bad\x00nick' }))).toBeNull();
    expect(validate(wellFormed({ email: 'a\x1bb@x.com' }))).toBeNull();
  });

  it('REJECTS a smuggled configHome or any extra/unknown key', () => {
    expect(validate(wellFormed({ configHome: '/Users/justin/.claude' }))).toBeNull();
    expect(validate(wellFormed({ token: 'sk-secret' }))).toBeNull();
    expect(validate(wellFormed({ somethingNew: 1 }))).toBeNull();
  });

  it('REJECTS an out-of-set provider / framework / status', () => {
    expect(validate(wellFormed({ provider: 'evilcorp' }))).toBeNull();
    expect(validate(wellFormed({ framework: 'bash' }))).toBeNull();
    expect(validate(wellFormed({ status: 'pwned' }))).toBeNull();
  });

  it('REJECTS a malformed quota (non-numeric utilizationPct, unparseable resetsAt, extra key)', () => {
    expect(validate(wellFormed({ quota: { fiveHour: { utilizationPct: 'lots', resetsAt: '2026-06-17T00:00:00Z' } } }))).toBeNull();
    expect(validate(wellFormed({ quota: { fiveHour: { utilizationPct: 1, resetsAt: 'not-a-date' } } }))).toBeNull();
    expect(validate(wellFormed({ quota: { mysteryField: true } }))).toBeNull();
    expect(validate(wellFormed({ quota: { source: 'made-up-source' } }))).toBeNull();
  });

  it('accepts a fable window and round-trips it (so peers keep Fable-5 usage)', () => {
    const projection = wellFormed({
      quota: {
        fiveHour: { utilizationPct: 42.5, resetsAt: '2026-06-17T00:00:00Z' },
        fable: { utilizationPct: 100, resetsAt: '2026-07-15T00:00:00Z' },
        source: 'oauth-usage-endpoint-fallback',
      },
    });
    const out = validate(projection);
    expect(out).not.toBeNull();
    expect((out as Record<string, any>).quota.fable).toEqual({ utilizationPct: 100, resetsAt: '2026-07-15T00:00:00Z' });
  });

  it('REJECTS a malformed fable window (non-numeric pct / bad date / extra key)', () => {
    expect(validate(wellFormed({ quota: { fable: { utilizationPct: 'lots', resetsAt: '2026-07-15T00:00:00Z' } } }))).toBeNull();
    expect(validate(wellFormed({ quota: { fable: { utilizationPct: 1, resetsAt: 'not-a-date' } } }))).toBeNull();
    expect(validate(wellFormed({ quota: { fable: { utilizationPct: 1, resetsAt: '2026-07-15T00:00:00Z', extra: true } } }))).toBeNull();
  });

  it('clamps an over-long nickname to 256 chars rather than rejecting', () => {
    const out = validate(wellFormed({ nickname: 'y'.repeat(300) }));
    expect((out as { nickname: string }).nickname.length).toBe(256);
  });

  it('handles a delete tombstone (only deletedAt survives)', () => {
    const out = validate({ op: 'delete', deletedAt: '2026-06-17T00:00:00Z', id: 'a1', nickname: 'dropped' });
    expect(out).toEqual({ deletedAt: '2026-06-17T00:00:00Z' });
  });

  it('the registration is coupled to JOURNAL_KINDS (no kind without its validator)', () => {
    expect(SUBSCRIPTION_ACCOUNT_META_KIND_REGISTRATION.kind).toBe(SUBSCRIPTION_ACCOUNT_META_KIND);
    expect(JOURNAL_KINDS).toContain(SUBSCRIPTION_ACCOUNT_META_KIND);
  });
});

describe('projectAccountToMeta — credential boundary (R2, the load-bearing security guarantee)', () => {
  const fullAccount = {
    id: 'acct-1',
    nickname: 'Justin personal',
    email: 'justin@example.com',
    provider: 'anthropic',
    framework: 'claude-code',
    status: 'active',
    configHome: '/Users/justin/.claude-acct-1', // the LOGIN LOCATION — must NEVER cross
    lastQuota: { fiveHour: { utilizationPct: 10, resetsAt: '2026-06-17T00:00:00Z' } },
    enrolledAt: '2026-06-01T00:00:00Z',
    version: 3,
    // a hostile/future credential-shaped field — must NEVER cross
    claudeAiOauth: 'sk-secret-token',
  } as unknown as Parameters<typeof projectAccountToMeta>[0];

  it('STRIPS configHome and any credential/extra field (allowlist projection)', () => {
    const meta = projectAccountToMeta(fullAccount);
    expect(meta).not.toHaveProperty('configHome');
    expect(meta).not.toHaveProperty('claudeAiOauth');
    expect(meta).not.toHaveProperty('enrolledAt');
    expect(meta).not.toHaveProperty('version');
    expect(Object.keys(meta).sort()).toEqual(['email', 'framework', 'id', 'nickname', 'provider', 'quota', 'status']);
  });

  it('the projection passes its OWN receive-side schema (round-trip safe)', () => {
    const meta = projectAccountToMeta(fullAccount);
    expect(validate(meta)).not.toBeNull();
  });

  it('the put/tombstone envelope builders carry the projection + envelope fields, never the login location', () => {
    const hlc = { physical: 1000, logical: 0, node: 'm_self' };
    const put = buildSubscriptionAccountMetaData({ account: fullAccount, hlc, origin: 'm_self', observed: hlc });
    expect(put).not.toHaveProperty('configHome');
    expect(put).not.toHaveProperty('claudeAiOauth');
    expect(put).toMatchObject({ id: 'acct-1', op: 'put', recordKey: 'acct-1', hlc, origin: 'm_self' });

    const tomb = buildSubscriptionAccountMetaTombstoneData({ accountId: 'acct-1', hlc, origin: 'm_self', deletedAt: '2026-06-17T01:00:00Z' });
    expect(tomb).toMatchObject({ op: 'delete', recordKey: 'acct-1', deletedAt: '2026-06-17T01:00:00Z' });
    expect(tomb).not.toHaveProperty('configHome');
  });
});
