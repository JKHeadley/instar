import { describe, expect, it } from 'vitest';
import { expectFixture, sharedContractCases } from './harness.js';

const SLUG = 'benchmark-divergence-analysis';
const ok = () => ({ body: { dryRun: true, wouldUpsert: 3 } });

describe('benchmark-divergence-analysis script', () => {
  sharedContractCases(SLUG, ok);
  it('posts only the trigger kind and reports a dry-run pass', async () => {
    const r = await expectFixture(SLUG, ok, 'JOB_RESULT ok analyzed dry-run findings=3', 0);
    expect(r.requests[0]).toMatchObject({ method: 'POST', url: '/benchmark-divergence/analyze', body: '{"trigger":"cadence"}' });
  });
  it('live pass and jitter-scheduled pass → ok', async () => {
    await expectFixture(SLUG, () => ({ body: { findingsUpserted: 2 } }), 'JOB_RESULT ok analyzed findings=2', 0);
    await expectFixture(SLUG, () => ({ body: { scheduled: true, delayMs: 1200 } }), 'JOB_RESULT ok scheduled delayMs=1200', 0);
  });
  it('healthy non-runs → skipped', async () => {
    await expectFixture(SLUG, () => ({ status: 503, body: {} }), 'JOB_RESULT skipped feature-dark', 0);
    await expectFixture(SLUG, () => ({ status: 409, body: { error: 'not-lease-holder' } }), 'JOB_RESULT skipped not-lease-holder', 0);
    await expectFixture(SLUG, () => ({ status: 429, body: { error: 'rate-limited' } }), 'JOB_RESULT skipped rate-limited', 0);
  });
  it('500 / malformed → failed', async () => {
    await expectFixture(SLUG, () => ({ status: 500, body: { error: 'benchmark-divergence analyze failed: x' } }), 'JOB_RESULT failed analyze-http-500 benchmark-divergence analyze failed: x', 1);
    await expectFixture(SLUG, () => ({ body: 'x{' }), 'JOB_RESULT failed analyze-malformed-response HTTP 200', 1);
  });
});
