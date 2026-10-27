import { describe, expect, it } from 'vitest';
import { expectFixture, sharedContractCases } from './harness.js';

const SLUG = 'feedback-factory-action-list';
const ok = () => ({ body: { sent: true, items: 4 } });

describe('feedback-factory-action-list script', () => {
  sharedContractCases(SLUG, ok);
  it('200 sent → ok sent N item(s)', async () => {
    const r = await expectFixture(SLUG, ok, 'JOB_RESULT ok sent 4 item(s)', 0);
    expect(r.requests[0]).toMatchObject({ method: 'POST', url: '/feedback-factory/triage/action-list' });
    expect(r.fields).toEqual({ http_status: '200', outcome: 'sent', processed: '4' });
  });
  it('200 not sent → ok not-sent <reason>', async () => {
    const r = await expectFixture(SLUG, () => ({ body: { sent: false, reason: 'nothing new since yesterday' } }), 'JOB_RESULT ok not-sent nothing new since yesterday', 0);
    expect(r.fields).toEqual({ http_status: '200', outcome: 'not-sent', server_reason: 'nothing' });
  });
  it('503 / 409 → skipped', async () => {
    await expectFixture(SLUG, () => ({ status: 503, body: {} }), 'JOB_RESULT skipped feature-dark', 0);
    await expectFixture(SLUG, () => ({ status: 409, body: {} }), 'JOB_RESULT skipped not-owner', 0);
  });
  it('502 delivery failure / malformed → failed', async () => {
    await expectFixture(SLUG, () => ({ status: 502, body: { sent: false, error: 'delivery failed' } }), 'JOB_RESULT failed action-list-http-502 delivery failed', 1);
    await expectFixture(SLUG, () => ({ body: 'x' }), 'JOB_RESULT failed action-list-malformed-response HTTP 200', 1);
  });
});
