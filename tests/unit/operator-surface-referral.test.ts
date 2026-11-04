/**
 * B22_SURFACE_REFERRAL (docs/specs/operator-needs-first-screen.md §6): the detector on both
 * sides of its boundary, and the rule wired in as an advisory that the LLM decides.
 */
import { describe, it, expect, vi } from 'vitest';
import { detectSurfaceReferral } from '../../src/core/operatorSurfaceReferral.js';
import { MessagingToneGate, VALID_RULES, RULE_CLASSES, RULE_DISPOSITIONS, detectDeterministicLeak } from '../../src/core/MessagingToneGate.js';

describe('detectSurfaceReferral', () => {
  it.each([
    'Open the Development page and turn it back on.',
    'Go to the dashboard to approve this.',
    'Tap the Accounts tab to sign in again.',
    'Check the console when you get a moment.',
    'On the Development page, tap Turn on.',
  ])('fires: %s', (t) => { expect(detectSurfaceReferral(t).referral).toBe(true); });

  it.each([
    'I fixed the page jump and merged it.',
    'The merge finished at 6pm.',
    'Automatic merging is back on.',
    'Approve, or tell me what to change?',
  ])('stays quiet: %s', (t) => { expect(detectSurfaceReferral(t).referral).toBe(false); });

  it('sees a link and quoted on-screen words, and their absence', () => {
    const none = detectSurfaceReferral('Open the Development page.');
    expect(none).toMatchObject({ hasLink: false, hasOnScreenWords: false });
    const both = detectSurfaceReferral('Open the Development page: https://x.dev/dashboard/console/#/work/development and tap “Turn auto-merge back on”.');
    expect(both).toMatchObject({ referral: true, hasLink: true, hasOnScreenWords: true });
    expect(detectSurfaceReferral('Open the page #/work/plans').hasLink).toBe(true);
  });

  it('apostrophes are not quotes', () => {
    expect(detectSurfaceReferral("Open the Development page, don't wait, it's stopped.").hasOnScreenWords).toBe(false);
  });

  it('stays fast on a long pathological message', () => {
    const t = `Open the page ${"don't ".repeat(30000)}`;
    const at = Date.now();
    detectSurfaceReferral(t);
    expect(Date.now() - at).toBeLessThan(200);
  });

  it('bounds the phrase and never throws on odd input', () => {
    expect((detectSurfaceReferral(`Open ${'x'.repeat(40)} dashboard`).phrase || '').length).toBeLessThanOrEqual(80);
    expect(detectSurfaceReferral(undefined as unknown as string).referral).toBe(false);
  });
});

describe('B22_SURFACE_REFERRAL in the gate', () => {
  it('is an advisory judgment rule, never a wall', () => {
    expect(VALID_RULES.has('B22_SURFACE_REFERRAL')).toBe(true);
    expect(RULE_CLASSES['B22_SURFACE_REFERRAL']).toBe('behavioral-judgment');
    expect(RULE_DISPOSITIONS['B22_SURFACE_REFERRAL']).toBe('advisory');
  });

  it('a referral is not a leak: the outage floor never holds one', () => {
    expect(detectDeterministicLeak('Open the Development page and turn it back on.')).toBeNull();
  });

  it('the prompt carries the signal as inert data, with the rule and its carve-outs', async () => {
    const intelligence = { evaluate: vi.fn(async () => JSON.stringify({ pass: true, rule: '', issue: '', suggestion: '' })) };
    const gate = new MessagingToneGate(intelligence as never);
    await gate.review('Open the Development page.', { channel: 'telegram', signals: { surfaceReferral: { phrase: 'Open the Development page', hasLink: false, hasOnScreenWords: false, renderConfirmed: false } } } as never);
    const prompt = String(intelligence.evaluate.mock.calls[0][0]);
    expect(prompt).toContain('hasLink=false hasOnScreenWords=false renderConfirmed=false');
    expect(prompt).toContain('**B22_SURFACE_REFERRAL**');
    expect(prompt).toContain('only mentions a page in passing');
  });

  it('with no signal the prompt says B22 does not apply beyond its anchor', async () => {
    const intelligence = { evaluate: vi.fn(async () => JSON.stringify({ pass: true, rule: '', issue: '', suggestion: '' })) };
    const gate = new MessagingToneGate(intelligence as never);
    await gate.review('All done.', { channel: 'telegram' } as never);
    const prompt = String(intelligence.evaluate.mock.calls[0][0]);
    expect(prompt).not.toContain('surface-referral detector (signal-only');
    expect(prompt).toContain('Applies ONLY when the surface-referral detector signal is present');
  });
});
