import { describe, expect, it } from 'vitest';
import { expectFixture, sharedContractCases } from './harness.js';

const SLUG = 'release-readiness-check';
const ok = () => ({ body: { ok: true } });

describe('release-readiness-check script', () => {
  sharedContractCases(SLUG, ok);
  it('200 ok:true → ok ticked', async () => {
    const r = await expectFixture(SLUG, ok, 'JOB_RESULT ok ticked', 0);
    expect(r.requests[0]).toMatchObject({ method: 'POST', url: '/release-readiness/tick' });
  });
  it('503 → skipped feature-dark', async () => {
    await expectFixture(SLUG, () => ({ status: 503, body: { error: 'release-readiness watchdog not configured' } }), 'JOB_RESULT skipped feature-dark', 0);
  });
  it('500 / malformed / wrong shape → failed', async () => {
    await expectFixture(SLUG, () => ({ status: 500, body: {} }), 'JOB_RESULT failed tick-http-500', 1);
    await expectFixture(SLUG, () => ({ body: 'nope' }), 'JOB_RESULT failed tick-malformed-response HTTP 200', 1);
    await expectFixture(SLUG, () => ({ body: { ok: false } }), 'JOB_RESULT failed tick-malformed-response: expected ok:true', 1);
  });
});
