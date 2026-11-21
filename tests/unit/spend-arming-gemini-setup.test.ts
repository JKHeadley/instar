/**
 * The Spend tab's Gemini pay-per-use setup plan (gemini-payg §8 "Delivery").
 *
 * The card for the one-PIN go-live links to the Spend tab, but the tab had no screen for
 * the `gemini-payg-setup` plan: no plan text, no PIN box. The user-role live test found it
 * by driving the real dashboard. What matters:
 *   - the first-screen line leads the panel, the server's text is shown verbatim
 *   - the commit carries the plan identity, the PIN and the proposal hash — no form field
 *   - after the commit the next step is never a second PIN (the commit restarts itself)
 *   - the panel is offered only while a proposal waits and nothing is set up yet
 */
// @ts-nocheck — browser-native ESM module, no types.
import { describe, it, expect, beforeEach } from 'vitest';
import { JSDOM } from 'jsdom';
import fs from 'node:fs';
import path from 'node:path';
import {
  geminiSetupShouldRender,
  geminiSetupCommitRequest,
  renderGeminiSetupPlan,
  geminiSetupAfterCommit,
  geminiSetupRefusalWords,
} from '../../dashboard/spend-arming.js';
import { GEMINI_PAYG_FIRST_SCREEN_LINE } from '../../src/core/geminiPaygGoLive.js';

let doc: Document;
beforeEach(() => { doc = new JSDOM('<!doctype html><body></body>').window.document; });

describe('geminiSetupShouldRender', () => {
  it('renders only while a proposal is present here and no door is set up', () => {
    expect(geminiSetupShouldRender({ present: true }, { here: false, holder: null })).toBe(true);
    expect(geminiSetupShouldRender({ present: true }, { here: true, evaluation: { releaseState: 'not-armed' } })).toBe(true);
    expect(geminiSetupShouldRender({ present: true }, { here: true, evaluation: { releaseState: 'armed-pending-proof' } })).toBe(false);
    expect(geminiSetupShouldRender({ present: true }, { here: true, evaluation: { releaseState: 'live' } })).toBe(false);
    expect(geminiSetupShouldRender({ present: false }, null)).toBe(false);
    expect(geminiSetupShouldRender(null, null)).toBe(false);
  });
});

describe('geminiSetupCommitRequest', () => {
  it('carries the plan identity, the PIN and the proposal hash only', () => {
    const body = geminiSetupCommitRequest({ planId: 'p1', nonce: 'n1', proposalHash: 'h'.repeat(64), renderedText: 'x', action: 'gemini-payg-setup', monthlyCapUsd: 999 }, '123456');
    expect(body).toEqual({ planId: 'p1', nonce: 'n1', pin: '123456', proposalHash: 'h'.repeat(64) });
  });
  it('omits a missing proposal hash rather than sending a placeholder', () => {
    expect(geminiSetupCommitRequest({ planId: 'p', nonce: 'n' }, '1')).toEqual({ planId: 'p', nonce: 'n', pin: '1' });
  });
});

describe('renderGeminiSetupPlan', () => {
  it('leads with the first-screen line, then the rest of the server text verbatim', () => {
    const t = doc.createElement('div');
    const text = `${GEMINI_PAYG_FIRST_SCREEN_LINE}\n\nThe money layer on for this machine.\n$50 per month.`;
    renderGeminiSetupPlan(doc, t, { renderedText: text, expiresAt: '2026-11-20T20:00:00Z' });
    const lead = t.querySelector('.gp-setup-lead');
    expect(lead?.textContent).toBe(GEMINI_PAYG_FIRST_SCREEN_LINE);
    expect(t.firstElementChild).toBe(lead);
    expect(t.querySelector('.spend-arm-plan-text')?.textContent).toBe('The money layer on for this machine.\n$50 per month.');
    expect(t.textContent).toContain('2026-11-20T20:00:00Z');
  });
  it('writes server text as text, never markup', () => {
    const t = doc.createElement('div');
    renderGeminiSetupPlan(doc, t, { renderedText: '<img src=x onerror=alert(1)>\n<b>no</b>' });
    expect(t.querySelector('img')).toBeNull();
    expect(t.querySelector('b')).toBeNull();
  });
  it('says there is nothing to approve without a plan', () => {
    const t = doc.createElement('div');
    renderGeminiSetupPlan(doc, t, null);
    expect(t.textContent).toContain('No Gemini setup to approve yet');
  });
});

describe('geminiSetupAfterCommit', () => {
  it('a scheduled restart is the next step — never a second PIN', () => {
    const r = geminiSetupAfterCommit({ restartRequired: true, restart: { scheduled: true } });
    expect(r.state).toBe('restarting');
    expect(r.words).toContain('no second PIN');
  });
  it('a refused restart shows the server words', () => {
    const r = geminiSetupAfterCommit({ restartRequired: true, restart: { scheduled: false }, message: 'approved and saved — the restart has not happened yet' });
    expect(r.state).toBe('saved');
    expect(r.words).toContain('restart has not happened yet');
  });
  it('a hot apply is done', () => {
    expect(geminiSetupAfterCommit({ appliedHot: true, message: 'applied' }).state).toBe('done');
  });
});

describe('geminiSetupRefusalWords', () => {
  it('names a changed proposal, a missing key and a bad PIN in plain words', () => {
    expect(geminiSetupRefusalWords(new Error('proposal-changed'))).toContain('a new card is needed');
    expect(geminiSetupRefusalWords(new Error('awaiting-key'))).toContain('not ready');
    expect(geminiSetupRefusalWords(new Error('bad-pin'))).toContain('PIN was not accepted');
  });
  it('a plan used up by another approval never says "nothing has changed" (found racing two taps in the live test)', () => {
    for (const code of ['consumed', 'unknown-plan', 'source-state-drift']) {
      const w = geminiSetupRefusalWords(new Error(code));
      expect(w).toContain('already used');
      expect(w).not.toContain('Nothing has changed');
    }
  });
});

describe('geminiSetupRefusalWords — never a raw code, never a false "nothing has changed"', () => {
  it('a lockout says to wait; a lost commit answer says to reload, not that nothing changed; codes stay off screen', () => {
    expect(geminiSetupRefusalWords(new Error('pin-lockout'))).toContain('Wait a few minutes');
    expect(geminiSetupRefusalWords(new Error('plan-render-rate'))).toContain('Wait a few minutes');
    const lost = geminiSetupRefusalWords(new Error('Failed to fetch'), { duringCommit: true });
    expect(lost).toContain('could not be confirmed');
    expect(lost).not.toContain('Nothing has changed');
    const render = geminiSetupRefusalWords(new Error('lock-not-held'));
    expect(render).not.toContain('lock-not-held');
  });
});

describe('the dashboard wires the panel', () => {
  it('a plan rendered on another machine shows its note and no PIN box', () => {
    const html = fs.readFileSync(path.resolve(__dirname, '../../dashboard/index.html'), 'utf-8');
    const i = html.indexOf('plan.forwarded === true');
    expect(i).toBeGreaterThan(0);
    expect(html.indexOf("pin.id = 'gpSetupPin'")).toBeGreaterThan(i);
  });

  const html = fs.readFileSync(path.resolve(__dirname, '../../dashboard/index.html'), 'utf-8');
  it('places the panel before the Spend tab purpose text, so its lead is on the first screen', () => {
    const panel = html.indexOf('id="geminiPaygSetup"');
    const purpose = html.indexOf('What the internal AI calls cost');
    expect(panel).toBeGreaterThan(0);
    expect(panel).toBeLessThan(purpose);
  });
  it('loads it with the Spend tab and commits through the setup route with the module body', () => {
    expect(html).toContain('loadGeminiPaygSetup();');
    expect(html).toMatch(/M\.geminiSetupCommitRequest\(__gpSetupPlan, pinValue\)/);
    expect(html).toMatch(/action: 'gemini-payg-setup', expectedProposalHash: proposal\.proposalHash/);
  });
});
