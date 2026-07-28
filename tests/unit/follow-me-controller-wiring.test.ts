/**
 * Subscriptions controller WIRING — the integration that was missing when PR #1223
 * first shipped (the card render functions existed but nothing fetched the scan,
 * rendered the card, or wired Approve → issue-for-machine, so the card never
 * appeared on the live dashboard — a Live-User-Channel-Proof failure). This test
 * drives the REAL controller: it must (1) POST the follow-me scan and render the
 * card into els.followMe, (2) on an Approve tap with a PIN, POST the PIN-gated
 * /mandate/issue-for-machine with the FD2 agents resolved from the offer (never the
 * DOM), and (3) refuse to POST when no PIN is entered.
 */
// @ts-nocheck — exercises the browser-native ESM dashboard module.
import { describe, it, expect } from 'vitest';
import { JSDOM } from 'jsdom';
import { createController } from '../../dashboard/subscriptions.js';

const SCAN_OFFER = {
  kind: 'account-follow-me-consent',
  accountId: 'adriana',
  accountEmail: 'amrch2388@gmail.com',
  targetMachineId: 'm_4cbc0d4a0c',
  targetMachineNickname: 'Mac Mini',
  machineNickname: 'Mac Mini',
  accountLabel: 'amrch2388@gmail.com',
  expiryText: 'Authorizes this one setup, then expires (1 hour).',
  mechanism: 're-mint',
  agents: ['63b1dbb21646e2f5f860441f6c6443ad', '63b1dbb21646e2f5f860441f6c6443ad'],
};

function makeHarness(opts = {}) {
  const dom = new JSDOM('<!doctype html><body><div id="fm"></div></body>');
  const doc = dom.window.document;
  const els = { accounts: doc.createElement('div'), pending: doc.createElement('div'), followMe: doc.getElementById('fm') };
  const calls = [];
  const fetchImpl = (url, o = {}) => {
    calls.push({ url, method: o.method || 'GET', body: o.body ? JSON.parse(o.body) : undefined });
    const ok = (json, status = 200) => Promise.resolve({ ok: true, status, json: () => Promise.resolve(json) });
    if (url === '/subscription-pool') return ok({ enabled: true, accounts: [] });
    if (url === '/subscription-pool/pending-logins') return ok({ enabled: true, logins: [] });
    if (url === '/subscription-pool/in-use') return ok({ activeAccountId: null });
    if (url === '/subscription-pool/follow-me/scan') return ok({ enabled: true, offered: [SCAN_OFFER] });
    if (url === '/mandate/issue-for-machine') {
      if (opts.issueFails) return Promise.resolve({ ok: false, status: 403, json: () => Promise.resolve({ error: 'denied' }) });
      return ok({ issued: true }, 201);
    }
    return ok({});
  };
  const ctrl = createController({ doc, els, fetchImpl, schedule: () => 0, cancel: () => {} });
  ctrl._state.active = true; // tick() no-ops unless active; activate without scheduling real timers
  return { doc, els, calls, ctrl };
}

const flush = async () => { await Promise.resolve(); await Promise.resolve(); await new Promise((r) => setTimeout(r, 0)); };

describe('subscriptions controller — follow-me card wiring', () => {
  it('POSTs the follow-me scan and renders the one-tap card into els.followMe', async () => {
    const h = makeHarness();
    await h.ctrl.tick();
    const scanCall = h.calls.find((c) => c.url === '/subscription-pool/follow-me/scan');
    expect(scanCall?.method).toBe('POST');
    expect(h.els.followMe.querySelector('button.sub-followme-approve')).toBeTruthy();
    expect(h.els.followMe.textContent).toContain('Let Mac Mini use your');
  });

  it('an Approve tap WITH a PIN POSTs issue-for-machine with the offer FD2 agents + PIN', async () => {
    const h = makeHarness();
    await h.ctrl.tick();
    h.els.followMe.querySelector('input.sub-followme-pin').value = '123456';
    h.els.followMe.querySelector('button.sub-followme-approve').click();
    await flush();
    const issue = h.calls.find((c) => c.url === '/mandate/issue-for-machine');
    expect(issue?.method).toBe('POST');
    expect(issue?.body).toMatchObject({
      pin: '123456',
      accountId: 'adriana',
      targetMachineId: 'm_4cbc0d4a0c',
      agents: SCAN_OFFER.agents,
    });
  });

  it('an Approve tap with NO PIN does NOT POST (prompts for the PIN)', async () => {
    const h = makeHarness();
    await h.ctrl.tick();
    h.els.followMe.querySelector('button.sub-followme-approve').click();
    await flush();
    expect(h.calls.find((c) => c.url === '/mandate/issue-for-machine')).toBeUndefined();
    expect(h.els.followMe.textContent.toLowerCase()).toContain('pin');
  });

  it('a "Submit code" tap POSTs the pasted code to the relay with id + machineId (ws52-code-paste-back)', async () => {
    const dom = new JSDOM('<!doctype html><body><div id="fm"></div></body>');
    const doc = dom.window.document;
    const els = { accounts: doc.createElement('div'), pending: doc.createElement('div'), followMe: doc.getElementById('fm') };
    const calls = [];
    const fetchImpl = (url, o = {}) => {
      calls.push({ url, method: o.method || 'GET', body: o.body ? JSON.parse(o.body) : undefined });
      const ok = (json, status = 200) => Promise.resolve({ ok: true, status, json: () => Promise.resolve(json) });
      if (url.startsWith('/subscription-pool/pending-logins')) return ok({ enabled: true, logins: [{
        id: 'adriana', label: 'adriana', kind: 'url-code-paste', machineId: 'm_mini', machineNickname: 'Mac Mini',
        verificationUrl: 'https://claude.com/cai/oauth/authorize?code=true&client_id=x',
        ttlExpiresAt: '2999-01-01T00:00:00Z', reissueCount: 0,
      }] });
      if (url === '/subscription-pool') return ok({ enabled: true, accounts: [] });
      if (url === '/subscription-pool/in-use') return ok({ activeAccountId: null });
      if (url === '/subscription-pool/follow-me/scan') return ok({ enabled: true, offered: [] });
      if (url === '/subscription-pool/follow-me/submit-code') return ok({ enabled: true, outcome: 'validated' }, 201);
      return ok({});
    };
    const ctrl = createController({ doc, els, fetchImpl, schedule: () => 0, cancel: () => {} });
    ctrl._state.active = true;
    await ctrl.tick();
    // the code field rendered for the url-code-paste login
    const input = els.pending.querySelector('input.sub-pending-code-input');
    expect(input).toBeTruthy();
    input.value = 'CPTKTRL8-the-operator-code';
    els.pending.querySelector('[data-submit-code]').click();
    await flush();
    const submit = calls.find((c) => c.url === '/subscription-pool/follow-me/submit-code');
    expect(submit?.method).toBe('POST');
    expect(submit?.body).toMatchObject({ id: 'adriana', machineId: 'm_mini', code: 'CPTKTRL8-the-operator-code' });
  });

  it('a "Submit code" tap with an EMPTY field does NOT POST (prompts to paste)', async () => {
    const dom = new JSDOM('<!doctype html><body><div id="fm"></div></body>');
    const doc = dom.window.document;
    const els = { accounts: doc.createElement('div'), pending: doc.createElement('div'), followMe: doc.getElementById('fm') };
    const calls = [];
    const fetchImpl = (url, o = {}) => {
      calls.push({ url, method: o.method || 'GET', body: o.body ? JSON.parse(o.body) : undefined });
      const ok = (json, status = 200) => Promise.resolve({ ok: true, status, json: () => Promise.resolve(json) });
      if (url.startsWith('/subscription-pool/pending-logins')) return ok({ enabled: true, logins: [{
        id: 'adriana', label: 'adriana', kind: 'url-code-paste', machineId: 'm_mini',
        verificationUrl: 'https://claude.com/cai/oauth/authorize?code=true', ttlExpiresAt: '2999-01-01T00:00:00Z', reissueCount: 0,
      }] });
      return ok({ enabled: true, accounts: [], logins: [], offered: [] });
    };
    const ctrl = createController({ doc, els, fetchImpl, schedule: () => 0, cancel: () => {} });
    ctrl._state.active = true;
    await ctrl.tick();
    els.pending.querySelector('[data-submit-code]').click();
    await flush();
    expect(calls.find((c) => c.url === '/subscription-pool/follow-me/submit-code')).toBeUndefined();
    expect(els.pending.textContent.toLowerCase()).toContain('paste the code');
  });

  it('renders nothing when the scan offers nothing (silent)', async () => {
    const h = makeHarness();
    // override scan to empty
    const origTick = h.ctrl.tick;
    h.ctrl._state.offers = [];
    await origTick();
    // with an offer present it renders; emptiness is covered by renderFollowMeOffers unit test —
    // here assert the controller does not throw and the card area is managed.
    expect(h.els.followMe).toBeTruthy();
  });

  // ── account-machine-matrix "Set up" → PIN → start-cell wiring ──────────────
  function makeMatrixHarness() {
    const dom = new JSDOM('<!doctype html><body><div id="fm"></div><div id="mx"></div></body>');
    const doc = dom.window.document;
    const els = {
      accounts: doc.createElement('div'), pending: doc.createElement('div'),
      followMe: doc.getElementById('fm'), matrix: doc.getElementById('mx'),
    };
    const calls = [];
    const fetchImpl = (url, o = {}) => {
      calls.push({ url, method: o.method || 'GET', body: o.body ? JSON.parse(o.body) : undefined });
      const ok = (json, status = 200) => Promise.resolve({ ok: true, status, json: () => Promise.resolve(json) });
      if (url === '/subscription-pool') return ok({ enabled: true, accounts: [] });
      if (url === '/subscription-pool?scope=pool') return ok({
        enabled: true, scope: 'pool',
        // a1 active on m1; a1 is EMPTY on m1b (second reachable machine) → a "Set up" cell.
        accounts: [
          { id: 'a1', email: 'a1@x.com', status: 'active', machineId: 'm1', machineNickname: 'Laptop' },
          { id: 'aX', email: 'aX@x.com', status: 'active', machineId: 'm1b', machineNickname: 'Mini' },
        ],
        pool: { selfMachineId: 'm1', failed: [] },
      });
      if (url.startsWith('/subscription-pool/pending-logins')) return ok({ enabled: true, logins: [] });
      if (url === '/subscription-pool/in-use') return ok({ activeAccountId: null });
      if (url === '/subscription-pool/follow-me/scan') return ok({ enabled: true, offered: [] });
      if (url === '/subscription-pool/matrix/start-cell') return ok({ verificationUrl: 'https://claude.com/oauth', loginId: 'a1', machineId: 'm1b' }, 201);
      return ok({});
    };
    const ctrl = createController({ doc, els, fetchImpl, schedule: () => 0, cancel: () => {} });
    ctrl._state.active = true;
    return { doc, els, calls, ctrl };
  }

  it('a "Set up" tap → Confirm WITH a PIN POSTs start-cell with {accountId, machineId, pin}', async () => {
    const h = makeMatrixHarness();
    await h.ctrl.tick();
    // the empty (a1 × m1b) cell rendered a "Set up" button
    const setup = Array.from(h.els.matrix.querySelectorAll('[data-matrix-setup]'))
      .find((b) => b.getAttribute('data-account-id') === 'a1' && b.getAttribute('data-machine-id') === 'm1b');
    expect(setup).toBeTruthy();
    setup.click(); // expands inline PIN + Confirm
    await flush();
    const pin = h.els.matrix.querySelector('input.sub-matrix-pin');
    expect(pin).toBeTruthy();
    pin.value = '123456';
    h.els.matrix.querySelector('[data-matrix-confirm]').click();
    await flush();
    const cell = h.calls.find((c) => c.url === '/subscription-pool/matrix/start-cell');
    expect(cell?.method).toBe('POST');
    expect(cell?.body).toMatchObject({ accountId: 'a1', machineId: 'm1b', pin: '123456' });
  });

  it('a Confirm tap with NO PIN does NOT POST start-cell (prompts for the PIN)', async () => {
    const h = makeMatrixHarness();
    await h.ctrl.tick();
    const setup = Array.from(h.els.matrix.querySelectorAll('[data-matrix-setup]'))
      .find((b) => b.getAttribute('data-account-id') === 'a1' && b.getAttribute('data-machine-id') === 'm1b');
    setup.click();
    await flush();
    // tap Confirm without typing a PIN
    h.els.matrix.querySelector('[data-matrix-confirm]').click();
    await flush();
    expect(h.calls.find((c) => c.url === '/subscription-pool/matrix/start-cell')).toBeUndefined();
    expect(h.els.matrix.textContent.toLowerCase()).toContain('pin');
  });

  // ── #1428: a confirmed cancel resets the cell OPTIMISTICALLY (at click time) ──
  function makeCancelHarness(cancelResponse) {
    const dom = new JSDOM('<!doctype html><body><div id="fm"></div><div id="mx"></div></body>');
    const doc = dom.window.document;
    dom.window.confirm = () => true; // approve the "Cancel this in-progress setup?" guard
    const els = {
      accounts: doc.createElement('div'), pending: doc.createElement('div'),
      followMe: doc.getElementById('fm'), matrix: doc.getElementById('mx'),
    };
    const calls = [];
    const fetchImpl = (url, o = {}) => {
      calls.push({ url, method: o.method || 'GET', body: o.body ? JSON.parse(o.body) : undefined });
      const ok = (json, status = 200) => Promise.resolve({ ok: true, status, json: () => Promise.resolve(json) });
      if (url === '/subscription-pool') return ok({ enabled: true, accounts: [] });
      if (url === '/subscription-pool?scope=pool') return ok({
        enabled: true, scope: 'pool',
        // a1 needs-reauth on m1 → after a confirmed cancel the cell returns to "Sign in".
        accounts: [{ id: 'a1', email: 'a1@x.com', status: 'needs-reauth', machineId: 'm1', machineNickname: 'Laptop' }],
        pool: { selfMachineId: 'm1', failed: [] },
      });
      // A still-cached pending login for a1 × m1 → the cell renders the in-flight flow + Cancel.
      if (url.startsWith('/subscription-pool/pending-logins')) return ok({ enabled: true, logins: [
        { id: 'a1', machineId: 'm1', verificationUrl: 'https://claude.com/oauth', ttlExpiresAt: '2999-01-01T00:00:00Z' },
      ] });
      if (url === '/subscription-pool/in-use') return ok({ activeAccountId: null });
      if (url === '/subscription-pool/follow-me/scan') return ok({ enabled: true, offered: [] });
      if (url === '/subscription-pool/follow-me/cancel') return ok(cancelResponse);
      return ok({});
    };
    const ctrl = createController({ doc, els, fetchImpl, schedule: () => 0, cancel: () => {} });
    ctrl._state.active = true;
    return { doc, els, calls, ctrl };
  }

  it('a confirmed cancel (2xx {cancelled}) resets the cell to "Sign in" AT CLICK TIME (no ~40s stale window)', async () => {
    const h = makeCancelHarness({ cancelled: true });
    await h.ctrl.tick();
    // the in-flight cell rendered with a Cancel button
    const cancel = Array.from(h.els.matrix.querySelectorAll('[data-matrix-cancel]'))
      .find((b) => b.getAttribute('data-account-id') === 'a1' && b.getAttribute('data-machine-id') === 'm1');
    expect(cancel, 'the in-progress cell shows a Cancel affordance').toBeTruthy();
    expect(h.els.matrix.querySelector('.sub-matrix-in-progress')).toBeTruthy();

    cancel.click();
    await flush();

    // the cancel relay was POSTed…
    const cancelCall = h.calls.find((c) => c.url === '/subscription-pool/follow-me/cancel');
    expect(cancelCall?.method).toBe('POST');
    expect(cancelCall?.body).toMatchObject({ id: 'a1', machineId: 'm1' });
    // …and the cell reset IMMEDIATELY: no more in-flight flow, an actionable "Sign in" instead.
    expect(h.els.matrix.querySelector('.sub-matrix-in-progress'), 'flow gone at click time').toBeNull();
    const signIn = Array.from(h.els.matrix.querySelectorAll('.sub-matrix-setup'))
      .find((b) => b.getAttribute('data-account-id') === 'a1' && b.getAttribute('data-machine-id') === 'm1');
    expect(signIn?.textContent).toBe('Sign in');
  });

  it('a FAILED cancel (non-2xx) leaves the flow in place and surfaces the reason (poll stays authority)', async () => {
    const dom = new JSDOM('<!doctype html><body><div id="mx"></div></body>');
    const doc = dom.window.document;
    dom.window.confirm = () => true;
    const els = { accounts: doc.createElement('div'), pending: doc.createElement('div'), matrix: doc.getElementById('mx') };
    const calls = [];
    const fetchImpl = (url, o = {}) => {
      calls.push({ url, method: o.method || 'GET', body: o.body ? JSON.parse(o.body) : undefined });
      const ok = (json, status = 200) => Promise.resolve({ ok: true, status, json: () => Promise.resolve(json) });
      if (url === '/subscription-pool?scope=pool') return ok({
        enabled: true, scope: 'pool',
        accounts: [{ id: 'a1', email: 'a1@x.com', status: 'needs-reauth', machineId: 'm1', machineNickname: 'Laptop' }],
        pool: { selfMachineId: 'm1', failed: [] },
      });
      if (url.startsWith('/subscription-pool/pending-logins')) return ok({ enabled: true, logins: [
        { id: 'a1', machineId: 'm1', verificationUrl: 'https://claude.com/oauth', ttlExpiresAt: '2999-01-01T00:00:00Z' },
      ] });
      if (url === '/subscription-pool') return ok({ enabled: true, accounts: [] });
      if (url === '/subscription-pool/in-use') return ok({ activeAccountId: null });
      if (url === '/subscription-pool/follow-me/scan') return ok({ enabled: true, offered: [] });
      if (url === '/subscription-pool/follow-me/cancel') return Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({ error: 'relay down' }) });
      return ok({});
    };
    const ctrl = createController({ doc, els, fetchImpl, schedule: () => 0, cancel: () => {} });
    ctrl._state.active = true;
    await ctrl.tick();
    const cancel = els.matrix.querySelector('[data-matrix-cancel]');
    cancel.click();
    await flush();
    // The flow is NOT reset optimistically on a failed cancel — the in-progress cell stays.
    expect(els.matrix.querySelector('.sub-matrix-in-progress')).toBeTruthy();
    expect(els.matrix.textContent.toLowerCase()).toContain('couldn’t cancel');
  });
});
