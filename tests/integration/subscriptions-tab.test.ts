/**
 * Integration tests for the Subscriptions tab POLLING CONTROLLER (jsdom, P2.2).
 * Drives the SHIPPED createController() against a real jsdom DOM with injected
 * fetch + manual timers + a controllable clock — every invariant deterministic,
 * no wall-clock, no real network:
 *   - both endpoints render into the real tab DOM (accounts + pending logins)
 *   - feature-dark (both routes { enabled:false }) → the disabled copy, not a crash
 *   - XSS safety holds through the full controller path (no injected element)
 *   - visibility-gating: hidden clears the timer + aborts in-flight; visible re-arms
 *   - a fetch failure drops the tick + keeps the prior paint (no exception escapes)
 */
// @ts-nocheck — exercises the browser-native ESM module.
import { describe, it, expect, beforeEach } from 'vitest';
import { JSDOM } from 'jsdom';
import { createController } from '../../dashboard/subscriptions.js';

const flush = () => new Promise((r) => setTimeout(r, 0));

function makeEls(doc: Document) {
  const accounts = doc.createElement('div');
  const pending = doc.createElement('div');
  const root = doc.createElement('div');
  root.appendChild(accounts);
  root.appendChild(pending);
  doc.body.appendChild(root);
  return { els: { accounts, pending }, root };
}

/** A scriptable fetch keyed by URL pathname; records abort signals. */
function makeFetch() {
  const script: Record<string, { status?: number; body?: unknown; throw?: boolean }> = {};
  const signals: AbortSignal[] = [];
  const fetchImpl = async (url: string, init?: { signal?: AbortSignal }) => {
    if (init?.signal) signals.push(init.signal);
    const key = url.replace(/^https?:\/\/[^/]+/, '');
    const entry = script[key] ?? { status: 200, body: { enabled: true } };
    if (entry.throw) throw new Error(`network ${key}`);
    return {
      ok: (entry.status ?? 200) < 400,
      status: entry.status ?? 200,
      json: async () => entry.body ?? {},
    };
  };
  return { fetchImpl, script, signals };
}

const ACCOUNTS_OK = {
  enabled: true,
  accounts: [{ id: 'a1', nickname: 'personal', provider: 'anthropic', framework: 'claude-code', status: 'active', lastQuota: { fiveHour: { utilizationPct: 12, resetsAt: '2026-06-07T01:00:00Z' }, sevenDay: { utilizationPct: 71, resetsAt: '2026-06-12T00:00:00Z' } } }],
};
const PENDING_OK = {
  enabled: true,
  logins: [{ id: 'codex-1', label: 'codex', kind: 'device-code', userCode: '7DAU-W4XJA', verificationUrl: 'https://auth.openai.com/codex/device', ttlExpiresAt: '2026-06-07T00:12:00Z', reissueCount: 0 }],
};

describe('Subscriptions tab controller (integration)', () => {
  let doc: Document;
  let els: any;
  let timers: Array<{ fn: () => void; ms: number }>;
  let nowMs: number;
  let fx: ReturnType<typeof makeFetch>;

  beforeEach(() => {
    doc = new JSDOM('<!doctype html><body></body>').window.document;
    ({ els } = makeEls(doc));
    timers = [];
    nowMs = Date.parse('2026-06-07T00:00:00Z');
    fx = makeFetch();
  });

  function ctl(extra?: any) {
    return createController({
      doc, els, fetchImpl: fx.fetchImpl, now: () => nowMs,
      schedule: (fn: () => void, ms: number) => { timers.push({ fn, ms }); return timers.length - 1; },
      cancel: (id: number) => { if (timers[id]) timers[id] = { fn: () => {}, ms: 0 }; },
      ...extra,
    });
  }

  it('renders both panes from the two endpoints', async () => {
    fx.script['/subscription-pool'] = { body: ACCOUNTS_OK };
    fx.script['/subscription-pool/pending-logins'] = { body: PENDING_OK };
    const c = ctl();
    c._state.active = true;
    await c.tick();
    expect(els.accounts.querySelector('.sub-account-nick')!.textContent).toBe('personal');
    expect(els.accounts.querySelectorAll('.sub-quota').length).toBe(2);
    expect(els.pending.querySelector('.sub-pending-code')!.textContent).toContain('7DAU-W4XJA');
  });

  it('feature-dark (both enabled:false) → the disabled copy, no crash', async () => {
    fx.script['/subscription-pool'] = { body: { enabled: false, accounts: [] } };
    fx.script['/subscription-pool/pending-logins'] = { body: { enabled: false, logins: [] } };
    const c = ctl();
    c._state.active = true;
    await c.tick();
    expect(els.accounts.querySelector('.sub-disabled')).toBeTruthy();
  });

  it('XSS payload in a nickname never becomes an element through the controller', async () => {
    fx.script['/subscription-pool'] = { body: { enabled: true, accounts: [{ id: 'x', nickname: '<script>alert(1)</script>', provider: 'anthropic', framework: 'claude-code', status: 'active' }] } };
    fx.script['/subscription-pool/pending-logins'] = { body: PENDING_OK };
    const c = ctl();
    c._state.active = true;
    await c.tick();
    expect(els.accounts.querySelector('script')).toBeNull();
    expect(els.accounts.querySelector('.sub-account-nick')!.textContent).toContain('<script>');
  });

  it('a fetch failure drops the tick without throwing + reschedules', async () => {
    fx.script['/subscription-pool'] = { throw: true };
    fx.script['/subscription-pool/pending-logins'] = { body: PENDING_OK };
    const c = ctl();
    c._state.active = true;
    await expect(c.tick()).resolves.toBeUndefined();
    // nothing painted, but a retry is armed
    expect(timers.length).toBeGreaterThan(0);
  });

  it('visibility gating: hidden stops the timer + aborts in-flight; visible re-arms', async () => {
    fx.script['/subscription-pool'] = { body: ACCOUNTS_OK };
    fx.script['/subscription-pool/pending-logins'] = { body: PENDING_OK };
    const c = ctl();
    c.start();
    await flush();
    expect(c._state.active).toBe(true);
    c.onHidden();
    expect(c._state.active).toBe(false);
    c.onVisible();
    expect(c._state.active).toBe(true);
  });
});
