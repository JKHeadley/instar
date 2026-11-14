import { describe, expect, it } from 'vitest';
import { expectFixture, sharedContractCases } from './harness.js';

const SLUG = 'feedback-factory-execute';
const ok = () => ({ status: 202, body: { runId: 'exec-run:42' } });

describe('feedback-factory-execute script', () => {
  sharedContractCases(SLUG, ok);
  it('202 → ok accepted, attempt id as a field', async () => {
    const r = await expectFixture(SLUG, ok, 'JOB_RESULT ok accepted', 0);
    expect(r.requests[0]).toMatchObject({ method: 'POST', url: '/feedback-factory/execute/tick' });
    expect(r.requests[0].headers['x-instar-request']).toBe('1');
    expect(r.fields).toEqual({ http_status: '202', outcome: 'accepted', attempt_id: 'exec-run:42' });
  });
  it('503 → skipped with the server reason, or feature-dark', async () => {
    const r = await expectFixture(SLUG, () => ({ status: 503, body: { error: 'feedback executor refuses to run', reason: 'approver-not-independent' } }), 'JOB_RESULT skipped approver-not-independent', 0);
    expect(r.fields).toEqual({ http_status: '503', outcome: 'not-running', server_reason: 'approver-not-independent' });
    await expectFixture(SLUG, () => ({ status: 503, body: { error: 'dark' } }), 'JOB_RESULT skipped feature-dark', 0);
  });
  it('409 / 429 → ok no-op', async () => {
    await expectFixture(SLUG, () => ({ status: 409, body: { error: 'not-canonical-owner', owner: 'm1' } }), 'JOB_RESULT ok no-op not-canonical-owner', 0);
    await expectFixture(SLUG, () => ({ status: 429, body: {} }), 'JOB_RESULT ok rate-limited', 0);
  });
  it('anything else → failed', async () => {
    await expectFixture(SLUG, () => ({ status: 500, body: { error: 'boom' } }), 'JOB_RESULT failed tick-refused HTTP 500 boom', 1);
    await expectFixture(SLUG, () => ({ status: 202, body: '{' }), 'JOB_RESULT failed tick-refused HTTP 202 malformed body', 1);
  });
});
