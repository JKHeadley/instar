/** The sign-in sheet's view after a code is sent (operator report 2026-11-10, topic 33890). */
import { describe, it, expect } from 'vitest';
import { submitView, completionView, workingView, GIVE_UP_VIEW } from '../../dashboard/console/signin-progress-model.js';

const ok = (data: unknown) => ({ ok: true, status: 200, data });

describe('sign-in progress model', () => {
  it('a submitted code is a working view, never a faint line under a live form', () => {
    expect(submitView(ok({ outcome: 'submitted' }), 'Mac Studio')).toEqual(workingView('Mac Studio', 'finishing'));
  });
  it('validated names the account; held names both accounts', () => {
    expect(submitView(ok({ outcome: 'validated', email: 'a@x.io' }), 'Mac Studio')).toEqual({ kind: 'done', title: 'Signed in as a@x.io on Mac Studio.' });
    const held = submitView(ok({ outcome: 'held', expected: 'a@x.io', got: 'b@x.io' }), 'Mac Studio');
    expect(held.kind).toBe('failed');
    expect(held.sub).toBe('It signed in as b@x.io, but this account is a@x.io, so it was not added.');
  });
  it('a refused code returns the form with the server words, carrying a fresh login when one was minted', () => {
    const v = submitView({ ok: false, status: 409, data: { code: 'login-expired-fresh-ready', error: 'fresh one ready', freshLogin: { id: 'L2' } } }, 'M');
    expect(v).toEqual({ kind: 'form', error: 'fresh one ready', freshLogin: { id: 'L2' } });
  });
  it('completion: finishing or unreachable keeps waiting; done and failed are terminal', () => {
    expect(completionView(ok({ completion: { state: 'finishing' } }), 'M')).toBeNull();
    expect(completionView({ ok: false, status: 502, data: {} }, 'M')).toBeNull();
    expect(completionView(ok({ completion: { state: 'done', email: 'a@x.io' } }), 'M')!.kind).toBe('done');
    expect(completionView(ok({ completion: { state: 'failed', reason: 'timed-out' } }), 'M')!.sub).toMatch(/^The sign-in did not finish in time\./);
    expect(completionView(ok({ completion: { state: 'failed', reason: 'wrong-account', expected: 'a@x.io', got: 'b@x.io' } }), 'M')!.sub).toMatch(/b@x.io/);
  });
  it('a machine with no live watch (it restarted mid-finish) is not final: the page keeps asking until its own bound', () => {
    expect(completionView(ok({ completion: { state: 'waiting-for-code' } }), 'Mac Studio')).toBeNull();
    expect(completionView(ok({ completion: { state: 'unknown' } }), 'Mac Studio')).toBeNull();
    expect(GIVE_UP_VIEW.kind).toBe('failed');
  });
});
