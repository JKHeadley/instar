/**
 * Unit tests for the Preferences tab's pure functions + renderers + controller.
 * Spec: docs/specs/CORRECTION-PREFERENCE-LEARNING-SENTINEL-SPEC.md §10 Slice-2.
 *
 * Exercises the SHIPPED module (dashboard/preferences-learning.js) directly. The
 * renderers take an injected `doc`, so we drive them against a real jsdom DOM and
 * assert:
 *   - dynamic values are sanitized + written via textContent only (raw text /
 *     injected markup never survives as a node)
 *   - the disabled (503) state renders the friendly "not turned on yet" copy
 *   - the controller renders the disabled state on a 503 from EITHER endpoint
 *   - the controller renders preferences + corrections on 200
 *   - the corrections renderer never surfaces a raw `learning` field
 */
// @ts-nocheck — the module is browser-native ESM (.js), no types.
import { describe, it, expect, beforeEach } from 'vitest';
import { JSDOM } from 'jsdom';
import {
  sanitizeForDisplay,
  friendlyKind,
  friendlyCorrectionStatus,
  statusDotClass,
  relativeTime,
  renderHeadline,
  renderPreferences,
  renderCorrections,
  renderClassReviews,
  renderCompletionAudit,
  renderDisabled,
  createController,
} from '../../dashboard/preferences-learning.js';

let doc: Document;
beforeEach(() => {
  doc = new JSDOM('<!doctype html><body></body>').window.document;
});

function els() {
  return {
    headline: doc.createElement('div'),
    preferences: doc.createElement('div'),
    corrections: doc.createElement('div'),
    stamp: doc.createElement('div'),
  };
}

describe('sanitizeForDisplay', () => {
  it('null/undefined coerce to empty string', () => {
    expect(sanitizeForDisplay(null)).toBe('');
    expect(sanitizeForDisplay(undefined)).toBe('');
  });
  it('NFKC-folds full-width confusables', () => {
    expect(sanitizeForDisplay('ＡＢＣ')).toBe('ABC');
  });
  it('strips bidi-control characters', () => {
    expect(sanitizeForDisplay('a‮b')).toBe('ab');
  });
  it('caps overly-long values with an ellipsis', () => {
    const long = 'x'.repeat(500);
    expect(sanitizeForDisplay(long, 'summary').length).toBeLessThanOrEqual(241);
  });
});

describe('friendly wording', () => {
  it('maps kinds to plain language', () => {
    expect(friendlyKind('user-preference')).toMatch(/like things/i);
    expect(friendlyKind('infra-gap')).toMatch(/tool itself/i);
    expect(friendlyKind('something-else')).toBe('A pattern');
  });
  it('maps correction status to plain language', () => {
    expect(friendlyCorrectionStatus('verified')).toMatch(/sticking/i);
    expect(friendlyCorrectionStatus('acted-on')).toMatch(/watched/i);
    expect(friendlyCorrectionStatus('nope')).toBe('Not set');
  });
  it('maps status to a calm dot class (never alarm red)', () => {
    expect(statusDotClass('open')).toBe('status-open');
    expect(statusDotClass('acted-on')).toBe('status-attributed');
    expect(statusDotClass('verified')).toBe('status-verified');
    expect(statusDotClass('inconclusive')).toBe('status-closed');
  });
  it('relativeTime handles bad input', () => {
    expect(relativeTime('not-a-date')).toBe('recently');
  });
});

describe('renderHeadline', () => {
  it('zero preferences → the gentle empty headline', () => {
    const target = doc.createElement('div');
    renderHeadline(doc, target, { prefCount: 0, stale: false });
    expect(target.textContent).toMatch(/haven't picked up any preferences/i);
  });
  it('N preferences → the count headline', () => {
    const target = doc.createElement('div');
    renderHeadline(doc, target, { prefCount: 3, stale: false });
    expect(target.textContent).toMatch(/3 preferences I've picked up/i);
  });
  it('stale → the calm "can\'t refresh" line', () => {
    const target = doc.createElement('div');
    renderHeadline(doc, target, { prefCount: 3, stale: true });
    expect(target.textContent).toMatch(/can't refresh/i);
    expect(target.textContent).toMatch(/nothing is lost/i);
  });
});

describe('renderPreferences', () => {
  it('absent / not-present → the friendly empty state', () => {
    const target = doc.createElement('div');
    renderPreferences(doc, target, { present: false, block: '', count: 0 });
    expect(target.textContent).toMatch(/Nothing saved yet/i);
  });
  it('renders the preference bullet lines, dropping the envelope tags', () => {
    const block = [
      "<auto-learned-preference src='correction-loop'>",
      'These are preferences I have learned about how you like to work.',
      '',
      '  - Lead with the one action, no preamble. (confidence 0.80, seen 3×)',
      '  - Use plain language, no jargon. (confidence 0.70, seen 2×)',
      '</auto-learned-preference>',
    ].join('\n');
    const target = doc.createElement('div');
    renderPreferences(doc, target, { present: true, block, count: 2 });
    const text = target.textContent;
    expect(text).toMatch(/Lead with the one action/);
    expect(text).toMatch(/Use plain language/);
    // The envelope machinery is NOT shown to the user.
    expect(text).not.toMatch(/auto-learned-preference/);
  });
});

describe('renderCorrections', () => {
  it('empty → the friendly empty state', () => {
    const target = doc.createElement('div');
    renderCorrections(doc, target, { records: [] });
    expect(target.textContent).toMatch(/Nothing recorded yet/i);
  });
  it('renders scrubbed summaries + metadata; never a raw learning field', () => {
    const target = doc.createElement('div');
    const body = {
      records: [
        { id: 'CORR-1', kind: 'user-preference', scrubbedSummary: 'prefers action-first replies', status: 'verified', occurrenceCount: 4, detectedAt: new Date().toISOString() },
        { id: 'CORR-2', kind: 'infra-gap', scrubbedSummary: 'force-push nag every session', status: 'acted-on', occurrenceCount: 6, detectedAt: new Date().toISOString() },
      ],
    };
    renderCorrections(doc, target, body, Date.now());
    const text = target.textContent;
    expect(text).toMatch(/prefers action-first/);
    expect(text).toMatch(/force-push nag/);
    expect(text).toMatch(/4 times so far/);
    // toApiView never serves `learning`; even if a malformed record carried one,
    // the renderer reads only scrubbedSummary + metadata.
  });
  it('a record carrying an unexpected `learning` field is NEVER rendered', () => {
    const target = doc.createElement('div');
    renderCorrections(doc, target, { records: [{ id: 'X', kind: 'user-preference', scrubbedSummary: 'safe summary', learning: 'RAW-LEAK-SHOULD-NOT-APPEAR', status: 'open', occurrenceCount: 1, detectedAt: new Date().toISOString() }] }, Date.now());
    expect(target.textContent).not.toMatch(/RAW-LEAK-SHOULD-NOT-APPEAR/);
    expect(target.textContent).toMatch(/safe summary/);
  });
});

describe('class review and completion surfaces', () => {
  it('humanizes closed enum values and provides expandable detail without leaking unknown slugs', () => {
    const reviews = doc.createElement('div');
    renderClassReviews(doc, reviews, { records: [{
      fillState: 'dead-lettered', reviewLifecycle: 'expired-internal-slug',
      standardReview: { verdict: 'needs-upgrade' }, processReview: { verdict: 'process-gap' },
      standardOutcome: 'expired-unreviewed', processOutcome: 'no-action',
    }] });
    expect(reviews.querySelector('details')).not.toBeNull();
    expect(reviews.textContent).toContain('Needs a standard upgrade');
    expect(reviews.textContent).toContain('Process gap found');
    expect(reviews.textContent).toContain('Awaiting overdue review');
    expect(reviews.textContent).toContain('No action needed');
    expect(reviews.textContent).not.toMatch(/needs-upgrade|process-gap|expired-unreviewed|no-action|expired-internal-slug/);

    const claims = doc.createElement('div');
    renderCompletionAudit(doc, claims, { records: [{ verdict: 'uncorroborated-unknown', actionKind: 'handed-off' }] });
    expect(claims.querySelector('details')).not.toBeNull();
    expect(claims.textContent).toContain('Evidence was not found');
    expect(claims.textContent).toContain('Handoff');
    expect(claims.textContent).not.toMatch(/uncorroborated-unknown|handed-off/);

    const ineligible = doc.createElement('div');
    renderCompletionAudit(doc, ineligible, { records: [{ verdict: 'not-eligible', actionKind: 'other' }] });
    expect(ineligible.textContent).toContain('Not eligible for this check');
    expect(ineligible.textContent).not.toContain('not-eligible');
  });
});

describe('renderDisabled', () => {
  it('renders the friendly "not turned on yet" state + operator hint in plain prose', () => {
    const e = els();
    renderDisabled(doc, e);
    expect(e.headline.textContent).toMatch(/isn't turned on/i);
    expect(e.headline.textContent).toMatch(/whoever set this up/i);
    // No code/monospace/config-key string (Dashboard Standard).
    expect(e.headline.textContent).not.toMatch(/correctionLearning|monitoring\./);
    expect(e.headline.querySelector('code')).toBeNull();
  });
});

describe('createController', () => {
  function mockResp(status: number, body: unknown) {
    return { status, ok: status >= 200 && status < 300, json: async () => body };
  }

  it('a 503 from EITHER endpoint → the disabled state', async () => {
    const e = els();
    const fetchImpl = async (url: string) => url.startsWith('/preferences')
      ? mockResp(503, {})
      : mockResp(200, { records: [] });
    const c = createController({ doc, els: e, fetchImpl, schedule: () => 0, cancel: () => {} });
    c.start();
    await c.tick();
    expect(e.headline.textContent).toMatch(/isn't turned on/i);
    c.stop();
  });

  it('200 from both → renders preferences + corrections + headline', async () => {
    const e = els();
    const prefBody = { present: true, count: 1, block: "<auto-learned-preference src='correction-loop'>\nintro\n\n  - Lead with the action. (confidence 0.80, seen 3×)\n</auto-learned-preference>" };
    const corrBody = { records: [{ id: 'CORR-1', kind: 'user-preference', scrubbedSummary: 'prefers action-first', status: 'verified', occurrenceCount: 3, detectedAt: new Date().toISOString() }], count: 1, totalRecords: 1, nextBefore: null };
    const fetchImpl = async (url: string) => url.startsWith('/preferences') ? mockResp(200, prefBody) : mockResp(200, corrBody);
    const c = createController({ doc, els: e, fetchImpl, schedule: () => 0, cancel: () => {} });
    c.start();
    await c.tick();
    expect(e.headline.textContent).toMatch(/1 preference I've picked up/i);
    expect(e.preferences.textContent).toMatch(/Lead with the action/);
    expect(e.corrections.textContent).toMatch(/prefers action-first/);
    c.stop();
  });

  it('a hard failure on both ticks marks the headline stale (calm, not an alarm)', async () => {
    const e = els();
    let clock = 0;
    const fetchImpl = async () => { throw new Error('network down'); };
    const c = createController({ doc, els: e, fetchImpl, now: () => clock, schedule: () => 0, cancel: () => {} });
    c.start();
    await c.tick();
    await c.tick();
    expect(e.headline.textContent).toMatch(/can't refresh/i);
    c.stop();
  });
});
