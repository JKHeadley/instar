/**
 * Unit — PendingApprovalRegistry (SEC-018, docs/specs/owner-approved-sensitive-action.md).
 */
import { describe, it, expect } from 'vitest';
import { PendingApprovalRegistry } from '../../src/server/PendingApprovalRegistry.js';

function clock(start = 1_000_000) { let t = start; return { now: () => t, advance: (ms: number) => { t += ms; } }; }
const req = (purpose: string, actionKey: string) => ({ purpose, actionKey, title: `${purpose} ${actionKey}?`, why: 'asked by a session', machine: 'Mac Studio' });

describe('PendingApprovalRegistry', () => {
  it('registers, is discoverable via has()/list(), and clears on remove()', () => {
    const r = new PendingApprovalRegistry();
    r.register(req('thread-delete', 'thr_1'));
    expect(r.has('thread-delete', 'thr_1')).toBe(true);
    expect(r.list().map((p) => p.actionKey)).toEqual(['thr_1']);
    expect(r.list()[0]!.title).toBe('thread-delete thr_1?'); // server-written
    r.remove('thread-delete', 'thr_1');
    expect(r.has('thread-delete', 'thr_1')).toBe(false);
    expect(r.list()).toEqual([]);
  });

  it('has() is exact: a different action or purpose is not pending', () => {
    const r = new PendingApprovalRegistry();
    r.register(req('thread-delete', 'thr_1'));
    expect(r.has('thread-delete', 'thr_2')).toBe(false);
    expect(r.has('trust-grant', 'thr_1')).toBe(false);
  });

  it('expires (fail-safe): a stale request is not discoverable and drops from the list', () => {
    const c = clock();
    const r = new PendingApprovalRegistry(c.now, 5 * 60_000);
    r.register(req('thread-delete', 'thr_1'));
    c.advance(5 * 60_000 + 1);
    expect(r.has('thread-delete', 'thr_1')).toBe(false);
    expect(r.list()).toEqual([]);
  });

  it('re-registering the same action refreshes, not duplicates', () => {
    const r = new PendingApprovalRegistry();
    r.register(req('thread-delete', 'thr_1'));
    r.register(req('thread-delete', 'thr_1'));
    expect(r.size()).toBe(1);
  });

  it('lists multiple pending requests oldest-first', () => {
    const c = clock();
    const r = new PendingApprovalRegistry(c.now);
    r.register(req('thread-delete', 'thr_1'));
    c.advance(10);
    r.register(req('trust-grant', 'fp|trusted'));
    expect(r.list().map((p) => p.actionKey)).toEqual(['thr_1', 'fp|trusted']);
  });

  it('bounds its size', () => {
    const r = new PendingApprovalRegistry(Date.now, 5 * 60_000, 8);
    for (let i = 0; i < 50; i++) r.register(req('thread-delete', `thr_${i}`));
    expect(r.size()).toBeLessThanOrEqual(8);
  });
});
