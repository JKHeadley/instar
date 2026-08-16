/**
 * The Spend tab's paid-door arming controls.
 *
 * The failure this screen exists to fix: the money routes existed with no UI, while the
 * tab said caps and go-live were "a later increment". An operator told arming was "one
 * tap, enter your PIN" went looking for a PIN box that had never been built.
 *
 * So the tests that matter most are not "the form works". They are:
 *   - a switched-off money layer is explained honestly, not as a generic error
 *   - the PIN never travels with the preview
 *   - the commit carries the PLAN, never the form fields
 */
// @ts-nocheck — browser-native ESM module, no types.
import { describe, it, expect, beforeEach } from 'vitest';
import { JSDOM } from 'jsdom';
import fs from 'node:fs';
import path from 'node:path';
import {
  moneyLayerNote,
  validateCaps,
  planRequest,
  commitRequest,
  renderPlanPreview,
  armableDoors,
  doorStateWords,
} from '../../dashboard/spend-arming.js';

let doc: Document;
beforeEach(() => {
  doc = new JSDOM('<!doctype html><body></body>').window.document;
});

describe('moneyLayerNote — the message that caused the original confusion', () => {
  it('THE POINT: a switched-off money layer names WHOSE switch it is', () => {
    const note = moneyLayerNote('routing-spend money layer not enabled (routingSpend.money.enabled)');
    expect(note).toMatch(/your decision/i);
    // The operator must not be left hunting for what they did wrong.
    expect(note).not.toMatch(/something went wrong|unexpected error/i);
  });

  it('says plainly that nothing here can arm while it is off', () => {
    expect(moneyLayerNote('HTTP 503')).toMatch(/nothing here can arm/i);
  });

  it('CONTROL: an ordinary failure does NOT claim the money layer is off', () => {
    // Without this, every failure would read as "your switch is off", which would send
    // the operator to flip a switch that is already on.
    const note = moneyLayerNote('network timeout');
    expect(note).not.toMatch(/your decision/i);
    expect(note).toMatch(/nothing has changed/i);
  });

  it('an unreadable caps store reports refusing-to-guess, not a wrong cap', () => {
    expect(moneyLayerNote('caps store unreadable — money surfaces fail closed'))
      .toMatch(/refusing to act rather than guess/i);
  });

  it('a rejected PIN says nothing changed', () => {
    expect(moneyLayerNote('bad pin')).toMatch(/not accepted[\s\S]*nothing has changed/i);
  });

  it('never throws on a missing or non-string message', () => {
    expect(typeof moneyLayerNote(undefined)).toBe('string');
    expect(typeof moneyLayerNote(null)).toBe('string');
    expect(typeof moneyLayerNote({} as unknown as string)).toBe('string');
  });
});

describe('validateCaps — both ceilings are required', () => {
  it('accepts a lifetime and a daily ceiling', () => {
    expect(validateCaps({ lifetimeCapUsd: 100, dailyCapUsd: 3.3 })).toEqual({ ok: true });
  });

  it('THE ONE THAT MATTERS: a missing ceiling is refused, not defaulted', () => {
    // A monthly intent has to be expressed as BOTH. Silently defaulting one produces a
    // different product: a daily rate with no lifetime bound is a tap left running.
    expect(validateCaps({ lifetimeCapUsd: 100 }).ok).toBe(false);
    expect(validateCaps({ dailyCapUsd: 3.3 }).ok).toBe(false);
    expect(validateCaps({ lifetimeCapUsd: 100, dailyCapUsd: '' }).error).toMatch(/requires both/i);
  });

  it('refuses a daily ceiling above the lifetime ceiling, and says why', () => {
    const r = validateCaps({ lifetimeCapUsd: 50, dailyCapUsd: 80 });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/could never bind/i);
  });

  it.each([
    ['zero', 0],
    ['negative', -5],
    ['NaN', NaN],
    ['a numeric string', '100'],
  ])('refuses %s rather than coercing it', (_label, bad) => {
    expect(validateCaps({ lifetimeCapUsd: bad, dailyCapUsd: 3 }).ok).toBe(false);
  });

  it('never throws on junk input', () => {
    expect(validateCaps(undefined).ok).toBe(false);
    expect(validateCaps(null).ok).toBe(false);
  });
});

describe('the PIN boundary', () => {
  it('THE SECURITY PROPERTY: a plan preview carries NO pin', () => {
    // The operator must see what they are approving before any secret leaves the page.
    const body = planRequest('caps-adjust', {
      keyRef: 'metered_openrouter_bench', provider: 'openrouter',
      lifetimeCapUsd: 100, dailyCapUsd: 3.3, pin: '123456',
    });
    expect(JSON.stringify(body)).not.toContain('123456');
    expect('pin' in body).toBe(false);
  });

  it('the go-live preview carries no pin either', () => {
    const body = planRequest('go-live', { door: 'openrouter-api', keyRef: 'k', enabled: true, pin: '999999' });
    expect(JSON.stringify(body)).not.toContain('999999');
  });

  it('the COMMIT carries the plan identity and the pin — and NOT the form fields', () => {
    // The server derives what to apply solely from the plan it rendered, so a value the
    // operator never saw on screen cannot be committed by editing the form afterwards.
    const body = commitRequest(
      { planId: 'PLAN-1', nonce: 'n-1', renderedText: 'set caps to ...' },
      '123456',
    );
    expect(body).toEqual({ planId: 'PLAN-1', nonce: 'n-1', pin: '123456' });
    expect('lifetimeCapUsd' in body).toBe(false);
    expect('keyRef' in body).toBe(false);
  });

  it('go-live must be explicit — enabled is never truthy by accident', () => {
    expect(planRequest('go-live', { keyRef: 'k' }).enabled).toBe(false);
    expect(planRequest('go-live', { keyRef: 'k', enabled: 'yes' }).enabled).toBe(false);
    expect(planRequest('go-live', { keyRef: 'k', enabled: true }).enabled).toBe(true);
  });

  it('an unknown action produces no request at all', () => {
    expect(planRequest('delete-everything', { keyRef: 'k' })).toBeNull();
  });
});

describe('renderPlanPreview', () => {
  it('shows the SERVER text verbatim, as text', () => {
    const t = doc.createElement('div');
    renderPlanPreview(doc, t, { renderedText: 'Set metered_openrouter_bench to $100 lifetime.', expiresAt: '2026-08-16T04:00:00Z' });
    expect(t.textContent).toContain('Set metered_openrouter_bench to $100 lifetime.');
    expect(t.textContent).toContain('expires');
  });

  it('a hostile plan text cannot become markup', () => {
    // The plan text is server-authored, but it is still rendered as text — the module's
    // contract is textContent everywhere, with no exception for "trusted" strings.
    const t = doc.createElement('div');
    renderPlanPreview(doc, t, { renderedText: '<img src=x onerror=alert(1)>' });
    expect(t.querySelector('img')).toBeNull();
    for (const n of Array.from(t.querySelectorAll('*'))) {
      expect(n.hasAttribute('onerror')).toBe(false);
    }
  });

  it('with no plan it says so rather than showing a stale one', () => {
    const t = doc.createElement('div');
    renderPlanPreview(doc, t, { renderedText: 'old plan' });
    renderPlanPreview(doc, t, null);
    expect(t.textContent).not.toContain('old plan');
    expect(t.textContent).toMatch(/no plan/i);
  });
});

describe('armableDoors + doorStateWords', () => {
  const caps = {
    keys: [
      { keyRef: 'metered_gemini_bench', provider: 'google', door: 'gemini-api', lifetimeCapUsd: 40, dailyCapUsd: 15, frozen: false, goLiveState: 'not-live' },
      { keyRef: 'metered_openrouter_bench', provider: 'openrouter', door: 'openrouter-api', lifetimeCapUsd: 60, dailyCapUsd: 25, frozen: true, goLiveState: 'not-live' },
      { keyRef: '', provider: 'broken' },
    ],
  };

  it('lists the real metered doors and drops a malformed row', () => {
    const rows = armableDoors(caps);
    expect(rows.map((r) => r.keyRef)).toEqual(['metered_gemini_bench', 'metered_openrouter_bench']);
  });

  it('survives an empty or missing caps payload', () => {
    expect(armableDoors(null)).toEqual([]);
    expect(armableDoors({})).toEqual([]);
  });

  it('states live/not-live/frozen in words the operator can act on', () => {
    const rows = armableDoors(caps);
    expect(doorStateWords(rows[0])).toMatch(/not live/i);
    expect(doorStateWords(rows[1])).toMatch(/frozen/i);
    expect(doorStateWords({ live: true })).toMatch(/can spend/i);
  });

  it('CONTROL: frozen takes precedence over live — a frozen door must never read as spendable', () => {
    expect(doorStateWords({ live: true, frozen: true })).toMatch(/frozen/i);
  });
});

/**
 * Wiring — the layer that has burned this feature repeatedly tonight.
 *
 * A module the page imports but that does not exist on disk, or a control the page
 * never calls, is the exact "built but unreachable" shape that made an operator hunt
 * for a PIN box that was never there. These are cheap and they close that gap.
 */
describe('spend arming — production wiring', () => {
  const html = fs.readFileSync('dashboard/index.html', 'utf8');

  it('every dashboard module the page imports EXISTS on disk', () => {
    // Serving is express.static over the whole dashboard dir, so presence is the
    // only thing standing between an import and a 404 at runtime.
    const refs = [...html.matchAll(/import\(['"]\/dashboard\/([\w.-]+)['"]\)/g)].map((m) => m[1]);
    expect(refs).toContain('spend-arming.js');
    for (const r of refs) {
      expect(fs.existsSync(path.join('dashboard', r)), `${r} is imported but missing`).toBe(true);
    }
  });

  it('the arming panel is rendered from the spend loader, not orphaned', () => {
    expect(html).toContain('renderSpendArming(caps)');
    expect(html).toContain('id="spendArming"');
  });

  it('the tab no longer tells the operator that money controls do not exist', () => {
    // The old copy said caps and go-live were "a later increment". Leaving that while
    // shipping the controls would reproduce the original confusion exactly.
    expect(html).not.toContain('money caps and the\n        go-live control are a later increment');
    expect(html).not.toMatch(/go-live control are a later increment/);
  });

  it('the commit posts to the PIN-gated route, and the preview does not', () => {
    expect(html).toContain("apiFetch('/routing-spend/caps/adjust'");
    expect(html).toContain("apiFetch('/routing-spend/plan'");
  });

  it('the PIN field is a password input and is cleared after use', () => {
    expect(html).toContain("p.type = 'password'");
    expect(html).toMatch(/pinEl\.value = ''/);
  });
});
