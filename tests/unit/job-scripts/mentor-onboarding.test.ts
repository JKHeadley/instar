import { describe, expect, it } from 'vitest';
import { expectFixture, sharedContractCases } from './harness.js';

const SLUG = 'mentor-onboarding';
const ok = () => ({ status: 202, body: { accepted: true, reason: null } });

describe('mentor-onboarding script', () => {
  sharedContractCases(SLUG, ok);

  it('202 accepted → ok accepted (POST /mentor/tick)', async () => {
    const r = await expectFixture(SLUG, ok, 'JOB_RESULT ok accepted', 0);
    expect(r.requests[0]).toMatchObject({ method: 'POST', url: '/mentor/tick' });
  });
  it('202 not accepted → ok not-accepted <reason>', async () => {
    await expectFixture(SLUG, () => ({ status: 202, body: { accepted: false, reason: 'tick-in-flight' } }), 'JOB_RESULT ok not-accepted tick-in-flight', 0);
  });
  it('200 disabled → skipped disabled', async () => {
    await expectFixture(SLUG, () => ({ body: { ran: false, reason: 'disabled' } }), 'JOB_RESULT skipped disabled', 0);
  });
  it('ran:false budget → ok tick-skipped; ran:true → ok ran', async () => {
    await expectFixture(SLUG, () => ({ body: { ran: false, reason: 'budget' } }), 'JOB_RESULT ok tick-skipped budget', 0);
    await expectFixture(SLUG, () => ({ body: { ran: true, leakDetected: false, observationsWritten: 3 } }), 'JOB_RESULT ok ran leakDetected=false observations=3', 0);
  });
  it('503 → skipped feature-dark', async () => {
    await expectFixture(SLUG, () => ({ status: 503, body: { error: 'mentor runner unavailable' } }), 'JOB_RESULT skipped feature-dark', 0);
  });
  it('500 / malformed / unknown shape → failed', async () => {
    await expectFixture(SLUG, () => ({ status: 500, body: {} }), 'JOB_RESULT failed tick-http-500', 1);
    await expectFixture(SLUG, () => ({ status: 202, body: 'x' }), 'JOB_RESULT failed tick-malformed-response HTTP 202', 1);
    await expectFixture(SLUG, () => ({ body: { other: 1 } }), 'JOB_RESULT failed tick-malformed-response: no ran/accepted field', 1);
  });
});
