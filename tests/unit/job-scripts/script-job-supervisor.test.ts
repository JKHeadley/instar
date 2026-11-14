import { describe, expect, it } from 'vitest';
import { expectFixture, sharedContractCases } from './harness.js';

const SLUG = 'script-job-supervisor';
const ok = () => ({ body: { reviewed: 18, flagged: 1, cleared: 0, notReviewed: [] } });

describe('script-job-supervisor script', () => {
  sharedContractCases(SLUG, ok);
  it('posts the supervision pass and reports its counts', async () => {
    const r = await expectFixture(SLUG, ok, 'JOB_RESULT ok reviewed reviewed=18 flagged=1 cleared=0 notReviewed=0', 0);
    expect(r.requests[0]).toMatchObject({ method: 'POST', url: '/jobs/script-supervision/pass' });
  });
  it('an object without known counts is still ok', async () => {
    await expectFixture(SLUG, () => ({ body: {} }), 'JOB_RESULT ok reviewed', 0);
  });
  it('503 / 409 / 429 → skipped', async () => {
    await expectFixture(SLUG, () => ({ status: 503, body: {} }), 'JOB_RESULT skipped feature-dark', 0);
    await expectFixture(SLUG, () => ({ status: 409, body: { error: 'not-lease-holder' } }), 'JOB_RESULT skipped not-lease-holder', 0);
    await expectFixture(SLUG, () => ({ status: 429, body: {} }), 'JOB_RESULT skipped rate-limited', 0);
  });
  it('500 / malformed → failed', async () => {
    await expectFixture(SLUG, () => ({ status: 500, body: { error: 'x' } }), 'JOB_RESULT failed pass-http-500 x', 1);
    await expectFixture(SLUG, () => ({ body: '[1' }), 'JOB_RESULT failed pass-malformed-response HTTP 200', 1);
  });
});
