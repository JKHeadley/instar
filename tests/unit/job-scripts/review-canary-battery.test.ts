import { describe, expect, it } from 'vitest';
import { expectFixture, sharedContractCases } from './harness.js';

const SLUG = 'review-canary-battery';
const summary = (verdict: string, extra: Record<string, unknown> = {}) => ({ batterySummary: true, t: 'x', verdict, fixtures: [1, 2, 3, 4, 5, 6], ...extra });
const ok = () => ({ body: summary('passed') });

describe('review-canary-battery script', () => {
  sharedContractCases(SLUG, ok);
  it('passed → ok verdict=passed', async () => {
    const r = await expectFixture(SLUG, ok, 'JOB_RESULT ok verdict=passed fixtures=6', 0);
    expect(r.requests[0]).toMatchObject({ method: 'POST', url: '/review/canary-battery/run' });
  });
  it('failed / inconclusive are the server\'s recorded outcome → ok naming it', async () => {
    await expectFixture(SLUG, () => ({ body: summary('failed', { reason: 'trap-2 laundered' }) }), 'JOB_RESULT ok verdict=failed fixtures=6 reason: trap-2 laundered', 0);
    await expectFixture(SLUG, () => ({ body: summary('inconclusive') }), 'JOB_RESULT ok verdict=inconclusive fixtures=6', 0);
  });
  it('503 → skipped feature-dark', async () => {
    await expectFixture(SLUG, () => ({ status: 503, body: {} }), 'JOB_RESULT skipped feature-dark', 0);
  });
  it('not a batterySummary / 500 → failed', async () => {
    await expectFixture(SLUG, () => ({ body: { verdict: 'passed' } }), 'JOB_RESULT failed battery-malformed-response: not a batterySummary', 1);
    await expectFixture(SLUG, () => ({ status: 500, body: { error: 'Battery run failed' } }), 'JOB_RESULT failed battery-http-500 Battery run failed', 1);
  });
});
