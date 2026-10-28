import { describe, expect, it } from 'vitest';
import { expectFixture, sharedContractCases } from './harness.js';

const SLUG = 'llm-decision-grading';
const ok = () => ({ body: { graded: 4, byRule: { 'hog-sustained-right-v1': 4 }, cursors: { a: 'x', b: 'y' } } });

describe('llm-decision-grading script', () => {
  sharedContractCases(SLUG, ok);
  it('200 well-formed → ok graded=N', async () => {
    const r = await expectFixture(SLUG, ok, 'JOB_RESULT ok graded=4 decision-points=2', 0);
    expect(r.requests[0]).toMatchObject({ method: 'POST', url: '/decision-quality/grade-pass', body: '{}' });
    expect(r.fields).toEqual({ graded: '4', decision_points: '2' });
  });
  it('links a scheduled run to its server-owned receipt', async () => {
    const r = await expectFixture(SLUG, ok, 'JOB_RESULT ok graded=4 decision-points=2', 0,
      { INSTAR_JOB_RUN_ID: 'grade-run-123', INSTAR_JOB_RECEIPT_TOKEN: 'a'.repeat(64) });
    expect(r.requests[0].headers['x-instar-job-run-id']).toBe('grade-run-123');
    expect(r.requests[0].headers['x-instar-job-receipt-token']).toBe('a'.repeat(64));
  });
  it('an idle pass is healthy', async () => {
    await expectFixture(SLUG, () => ({ body: { graded: 0, byRule: {}, cursors: {} } }), 'JOB_RESULT ok graded=0 decision-points=0', 0);
  });
  it('503 → skipped feature-dark', async () => {
    await expectFixture(SLUG, () => ({ status: 503, body: {} }), 'JOB_RESULT skipped feature-dark', 0);
  });
  it('malformed shapes → failed', async () => {
    await expectFixture(SLUG, () => ({ body: { graded: -1, byRule: {}, cursors: {} } }), 'JOB_RESULT failed grade-pass-malformed-response: expected graded, byRule, cursors', 1);
    await expectFixture(SLUG, () => ({ body: { graded: 1.5, byRule: {}, cursors: {} } }), 'JOB_RESULT failed grade-pass-malformed-response: expected graded, byRule, cursors', 1);
    await expectFixture(SLUG, () => ({ body: { graded: 1 } }), 'JOB_RESULT failed grade-pass-malformed-response: expected graded, byRule, cursors', 1);
    await expectFixture(SLUG, () => ({ body: '{' }), 'JOB_RESULT failed grade-pass-malformed-response HTTP 200', 1);
    await expectFixture(SLUG, () => ({ status: 500, body: { error: 'x' } }), 'JOB_RESULT failed grade-pass-http-500 x', 1);
  });
});
