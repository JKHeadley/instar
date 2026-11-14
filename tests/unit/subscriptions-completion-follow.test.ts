/**
 * Legacy Subscriptions tab: after a sent code the row no longer sits at a faint
 * "Code sent — finishing sign-in…" under a live form (operator report 2026-11-10,
 * topic 33890). The input and button go away, the row says it is finishing, and it
 * follows the server's completion read to one terminal answer.
 */
// @ts-nocheck — exercises the browser-native ESM dashboard module.
import { describe, it, expect } from 'vitest';
import { JSDOM } from 'jsdom';
import { createController } from '../../dashboard/subscriptions.js';

function harness(completions) {
  const dom = new JSDOM('<!doctype html><body><div id="fm"></div></body>');
  const doc = dom.window.document;
  const els = { accounts: doc.createElement('div'), pending: doc.createElement('div'), followMe: doc.getElementById('fm') };
  const calls = [];
  const queued = [];
  const fetchImpl = (url, o = {}) => {
    calls.push({ url, method: o.method || 'GET' });
    const ok = (json, status = 200) => Promise.resolve({ ok: true, status, json: () => Promise.resolve(json) });
    if (url.startsWith('/subscription-pool/pending-logins')) return ok({ enabled: true, logins: [{
      id: 'gearfinity3d', label: 'Gearfinity subscription', kind: 'url-code-paste', machineId: 'm_studio', machineNickname: 'Mac Studio',
      verificationUrl: 'https://claude.com/cai/oauth/authorize?code=true&client_id=x', ttlExpiresAt: '2999-01-01T00:00:00Z', reissueCount: 0,
    }] });
    if (url === '/subscription-pool/follow-me/submit-code') return ok({ enabled: true, outcome: 'submitted', completion: { state: 'finishing' } });
    if (url.startsWith('/subscription-pool/follow-me/completion?')) {
      const c = completions.length > 1 ? completions.shift() : completions[0];
      return ok({ enabled: true, completion: c });
    }
    if (url === '/subscription-pool') return ok({ enabled: true, accounts: [] });
    return ok({});
  };
  const ctrl = createController({ doc, els, fetchImpl, schedule: (fn) => { queued.push(fn); return queued.length; }, cancel: () => {} });
  ctrl._state.active = true;
  const flush = async () => { for (let i = 0; i < 4; i++) { await Promise.resolve(); await new Promise((r) => setTimeout(r, 0)); } };
  const runScheduled = async () => { const fns = queued.splice(0); for (const f of fns) await f(); await flush(); };
  return { doc, els, calls, ctrl, flush, runScheduled };
}

async function sendCode(h) {
  await h.ctrl.tick();
  h.els.pending.querySelector('input.sub-pending-code-input').value = 'abc123';
  h.els.pending.querySelector('[data-submit-code]').click();
  await h.flush();
  return h.els.pending.querySelector('.sub-pending');
}

describe('legacy subscriptions row — follows a sent code to the end', () => {
  it('finishing replaces the form, then done names the account', async () => {
    const h = harness([{ state: 'finishing' }, { state: 'done', email: 'gearfinity3d@gmail.com' }]);
    const row = await sendCode(h);
    expect(row.className).toContain('sub-pending-finishing');
    expect(row.querySelector('input')).toBeNull();
    expect(row.querySelector('[data-submit-code]')).toBeNull();
    expect(row.querySelector('.sub-pending-status').textContent).toMatch(/Finishing the sign-in/);
    await h.runScheduled(); // still finishing
    expect(row.className).toContain('sub-pending-finishing');
    await h.runScheduled();
    expect(row.className).toContain('sub-pending-done');
    expect(row.querySelector('.sub-pending-status').textContent).toBe('✓ Done — gearfinity3d@gmail.com is set up on this machine.');
    expect(h.calls.some((c) => c.url === '/subscription-pool/follow-me/completion?machineId=m_studio&id=gearfinity3d')).toBe(true);
  });

  it('a failed completion says why and where to start again', async () => {
    const h = harness([{ state: 'failed', reason: 'window-closed' }]);
    const row = await sendCode(h);
    await h.runScheduled();
    expect(row.className).toContain('sub-pending-failed');
    expect(row.querySelector('.sub-pending-status').textContent).toBe('✗ The sign-in window closed before the sign-in finished. Start a fresh sign-in from its grid cell.');
  });
});
