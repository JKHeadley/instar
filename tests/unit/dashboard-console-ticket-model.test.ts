/**
 * The console page's half of console sign-in from an owner phone
 * (docs/specs/mobile-console-device-signin.md §3.5): the ticket is removed before any request, a
 * valid stored token wins, a ticket redeems for the token, and every failure is the PIN box.
 */
import { describe, it, expect } from 'vitest';
import { takeTicket, redeemTicket, signInAtBoot, TICKET_KEY, REDEEM_PATH } from '../../dashboard/console/ticket-model.js';

function storage(initial: Record<string, string> = {}) {
  const m = new Map(Object.entries(initial));
  return { getItem: (k: string) => m.get(k) ?? null, removeItem: (k: string) => { m.delete(k); }, has: (k: string) => m.has(k) };
}
const T = 'A'.repeat(43);

describe('takeTicket', () => {
  it('reads and removes the ticket at once', () => {
    const s = storage({ [TICKET_KEY]: T });
    expect(takeTicket(s)).toBe(T);
    expect(s.has(TICKET_KEY)).toBe(false);
    expect(takeTicket(s)).toBe('');
  });
  it('removes even an oversized value and returns nothing for it', () => {
    const s = storage({ [TICKET_KEY]: 'x'.repeat(200) });
    expect(takeTicket(s)).toBe('');
    expect(s.has(TICKET_KEY)).toBe(false);
  });
  it('survives blocked storage', () => {
    expect(takeTicket({ getItem: () => { throw new Error('blocked'); }, removeItem: () => { throw new Error('blocked'); } })).toBe('');
  });
});

describe('redeemTicket', () => {
  it('posts the ticket once to the redeem route and returns the token', async () => {
    const calls: Array<{ path: string; init: { method: string; body: string } }> = [];
    const fetchFn = async (path: string, init: { method: string; body: string }) => { calls.push({ path, init }); return { ok: true, json: async () => ({ token: 'tok' }) }; };
    expect(await redeemTicket(fetchFn, T)).toBe('tok');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.path).toBe(REDEEM_PATH);
    expect(calls[0]!.init.method).toBe('POST');
    expect(JSON.parse(calls[0]!.init.body)).toEqual({ ticket: T });
  });
  it('returns nothing on a refusal, an unreadable answer, a thrown fetch or no ticket', async () => {
    expect(await redeemTicket(async () => ({ ok: false, json: async () => ({}) }), T)).toBe('');
    expect(await redeemTicket(async () => ({ ok: true, json: async () => { throw new Error('x'); } }), T)).toBe('');
    expect(await redeemTicket(async () => { throw new Error('down'); }, T)).toBe('');
    let called = false;
    expect(await redeemTicket(async () => { called = true; return { ok: true, json: async () => ({ token: 't' }) }; }, '')).toBe('');
    expect(called).toBe(false);
  });
});

describe('signInAtBoot', () => {
  const ok = async () => ({ ok: true, json: async () => ({ token: 'fresh' }) });
  it('a valid stored token wins without a redeem', async () => {
    let redeemed = false;
    const r = await signInAtBoot({ storedToken: 'old', validToken: async () => true, ticket: T, fetchFn: async () => { redeemed = true; return ok(); } });
    expect(r).toEqual({ token: 'old', via: 'stored' });
    expect(redeemed).toBe(false);
  });
  it('an invalid or missing stored token falls to the ticket', async () => {
    expect(await signInAtBoot({ storedToken: 'old', validToken: async () => false, ticket: T, fetchFn: ok })).toEqual({ token: 'fresh', via: 'ticket' });
    expect(await signInAtBoot({ storedToken: '', validToken: async () => false, ticket: T, fetchFn: ok })).toEqual({ token: 'fresh', via: 'ticket' });
  });
  it('anything else is the PIN box', async () => {
    expect(await signInAtBoot({ storedToken: '', validToken: async () => false, ticket: '', fetchFn: ok })).toEqual({ token: '', via: 'pin' });
    expect(await signInAtBoot({ storedToken: '', validToken: async () => false, ticket: T, fetchFn: async () => ({ ok: false, json: async () => ({}) }) })).toEqual({ token: '', via: 'pin' });
  });
});
