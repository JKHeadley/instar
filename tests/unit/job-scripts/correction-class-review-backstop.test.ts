import { describe, expect, it } from 'vitest';
import { expectFixture, sharedContractCases } from './harness.js';

const SLUG = 'correction-class-review-backstop';
const ok = () => ({ body: { considered: 10, created: 2, retried: 1, aged: 0, dryRun: true } });

describe('correction-class-review-backstop script', () => {
  sharedContractCases(SLUG, ok);
  it('posts limit 100 with X-Instar-Request and reports the counts', async () => {
    const r = await expectFixture(SLUG, ok, 'JOB_RESULT ok considered=10 created=2 retried=1', 0);
    expect(r.requests[0]).toMatchObject({ method: 'POST', url: '/class-reviews/backfill', body: '{"limit":100}' });
    expect(r.requests[0].headers['x-instar-request']).toBe('1');
  });
  it('503 → skipped feature-dark', async () => {
    await expectFixture(SLUG, () => ({ status: 503, body: { error: 'correction-class-review disabled' } }), 'JOB_RESULT skipped feature-dark', 0);
  });
  it('malformed / non-numeric / 403 → failed', async () => {
    await expectFixture(SLUG, () => ({ body: { considered: 1, created: 'x', retried: 0 } }), 'JOB_RESULT failed backfill-malformed-response: expected numeric considered, created, retried', 1);
    await expectFixture(SLUG, () => ({ body: '[' }), 'JOB_RESULT failed backfill-malformed-response HTTP 200', 1);
    await expectFixture(SLUG, () => ({ status: 403, body: { error: 'X-Instar-Request: 1 required' } }), 'JOB_RESULT failed backfill-http-403 X-Instar-Request: 1 required', 1);
  });
});
