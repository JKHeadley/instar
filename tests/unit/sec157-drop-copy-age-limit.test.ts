/**
 * SEC-157: the encrypted stored copy of a Secret Drop submission has an absolute age limit. Before, an
 * unused copy stayed on disk, retrievable, forever. The rule and the sweep over a store's whole contents.
 */
import { describe, expect, it } from 'vitest';
import { DURABLE_DROP_MAX_AGE_MS, durableDropExpired, sweepExpiredDurableDrops } from '../../src/server/secretDropDurable.js';

const NOW = Date.parse('2026-11-22T16:00:00.000Z');
const ago = (ms: number) => new Date(NOW - ms).toISOString();

describe('durableDropExpired', () => {
  it('a copy within 24 hours is kept; past it, or with no readable time, it is expired', () => {
    expect(DURABLE_DROP_MAX_AGE_MS).toBe(24 * 60 * 60 * 1000);
    expect(durableDropExpired(ago(60_000), NOW)).toBe(false);
    expect(durableDropExpired(ago(DURABLE_DROP_MAX_AGE_MS), NOW)).toBe(false);
    expect(durableDropExpired(ago(DURABLE_DROP_MAX_AGE_MS + 1), NOW)).toBe(true);
    for (const bad of [undefined, null, 42, '', 'not a date']) expect(durableDropExpired(bad, NOW)).toBe(true);
    expect(durableDropExpired(new Date(NOW + 60_000).toISOString(), NOW)).toBe(false); // small clock skew is fine
    expect(durableDropExpired(new Date(NOW + 10 * 60_000).toISOString(), NOW)).toBe(true); // far future is not trusted
  });
});

describe('sweepExpiredDurableDrops', () => {
  function storeWith(secrets: Record<string, unknown>) {
    const writes: Array<Record<string, unknown>> = [];
    return { writes, store: { read: () => structuredClone(secrets), write: (s: Record<string, unknown>) => { writes.push(s); } } };
  }

  it('removes only expired copies, in one write, and keeps every other secret', () => {
    const { store, writes } = storeWith({
      authToken: 'keep-me',
      secretDrops: { fresh: { receivedAt: ago(1000), values: { a: '1' } }, stale: { receivedAt: ago(DURABLE_DROP_MAX_AGE_MS + 5000), values: { a: '2' } }, undated: { values: { a: '3' } } },
    });
    expect(sweepExpiredDurableDrops(store, NOW)).toBe(2);
    expect(writes).toHaveLength(1);
    expect(writes[0]).toEqual({ authToken: 'keep-me', secretDrops: { fresh: { receivedAt: ago(1000), values: { a: '1' } } } });
  });

  it('drops the empty secretDrops branch when nothing is left', () => {
    const { store, writes } = storeWith({ other: 1, secretDrops: { stale: { receivedAt: ago(DURABLE_DROP_MAX_AGE_MS * 2) } } });
    expect(sweepExpiredDurableDrops(store, NOW)).toBe(1);
    expect(writes[0]).toEqual({ other: 1 });
  });

  it('an unreadable store is left untouched: the read throws and nothing is written', () => {
    const writes: unknown[] = [];
    const store = { read: () => { throw new Error('vault key unavailable'); }, write: (s: unknown) => { writes.push(s); } };
    expect(() => sweepExpiredDurableDrops(store as never, NOW)).toThrow('vault key unavailable');
    expect(writes).toHaveLength(0);
  });

  it('writes nothing when nothing is expired, or when there are no stored copies', () => {
    for (const secrets of [{ secretDrops: { fresh: { receivedAt: ago(1) } } }, {}, { secretDrops: 'x' }, { secretDrops: [1] }]) {
      const { store, writes } = storeWith(secrets as never);
      expect(sweepExpiredDurableDrops(store, NOW)).toBe(0);
      expect(writes).toHaveLength(0);
    }
  });
});

describe('the form says what happens to the secret (SEC-157)', () => {
  it('a normal request says it is kept encrypted for at most 24 hours; a browser request says it is never saved', async () => {
    const { SecretDrop } = await import('../../src/server/SecretDrop.js');
    const drop = new SecretDrop('TestAgent');
    const plain = drop.create({ label: 'API Key', mintAuth: 'master' });
    const html = drop.renderForm(drop.getPending(plain.token)!);
    expect(html).toContain('It stays only on this computer until the agent uses it, and never longer than 24 hours.'); // true with persistDrops on or off
    expect(html).not.toContain('not stored on disk');
    const browser = drop.create({ label: 'Site', mintAuth: 'master', browserHost: 'accounts.example.com', fields: [{ name: 'password', label: 'Password', masked: true }] });
    const bhtml = drop.renderForm(drop.getPending(browser.token)!);
    expect(bhtml).toContain('It is never saved to disk.');
    drop.shutdown?.();
  });
});
