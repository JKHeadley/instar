import { describe, it, expect, vi } from 'vitest';
import { liveCopyInList, probeLiveCopyOnPeer } from '../../src/core/sessionLiveProbe.js';

describe('probeLiveCopyOnPeer', () => {
  const never = vi.fn(async () => { throw new Error('should not be called'); });

  it.each([true, false])('a signed answer of %s decides, with no bearer call', async (live) => {
    const out = await probeLiveCopyOnPeer({ signed: async () => ({ ok: true, result: { ok: true, live } }), bearer: never });
    expect(out).toEqual({ ok: true, live });
    expect(never).not.toHaveBeenCalled();
  });
  it('an older peer without the verb answers over bearer', async () => {
    expect(await probeLiveCopyOnPeer({ signed: async () => ({ ok: false }), bearer: async () => true })).toEqual({ ok: true, live: true });
  });
  it('a peer that cannot read its own list falls through, not to "no copy"', async () => {
    const out = await probeLiveCopyOnPeer({
      signed: async () => ({ ok: true, result: { ok: false, reason: 'HTTP 500' } }),
      bearer: async () => { throw new Error('HTTP 401'); },
    });
    expect(out).toEqual({ ok: false, live: false });
  });
  it('different tokens: bearer refused, signed still answers', async () => {
    const out = await probeLiveCopyOnPeer({
      signed: async () => ({ ok: true, result: { ok: true, live: true } }),
      bearer: async () => { throw new Error('HTTP 401'); },
    });
    expect(out).toEqual({ ok: true, live: true });
  });
  it('a thrown signed call still tries bearer', async () => {
    expect(await probeLiveCopyOnPeer({ signed: async () => { throw new Error('mesh'); }, bearer: async () => false }))
      .toEqual({ ok: true, live: false });
  });
});

describe('liveCopyInList', () => {
  it('matches platform and id, as strings', () => {
    expect(liveCopyInList([{ platform: 'telegram', platformId: 7 }], 'telegram', '7')).toBe(true);
    expect(liveCopyInList([{ platform: 'slack', platformId: 7 }], 'telegram', '7')).toBe(false);
    expect(liveCopyInList('not a list', 'telegram', '7')).toBe(false);
  });
});
