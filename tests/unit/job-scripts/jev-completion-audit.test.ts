import { describe, expect, it } from 'vitest';
import { expectFixture, sharedContractCases } from './harness.js';

const SLUG = 'jev-completion-audit';
const ok = () => ({ body: { audited: 3, skipped: {}, retentionRemoved: 0 } });

describe('jev-completion-audit script', () => {
  sharedContractCases(SLUG, ok);
  it('200 → ok audited=N', async () => {
    const r = await expectFixture(SLUG, ok, 'JOB_RESULT ok audited=3', 0);
    expect(r.requests[0]).toMatchObject({ method: 'POST', url: '/jev-audit/batch' });
  });
  it('disabled / soak-expired with nothing audited → skipped', async () => {
    await expectFixture(SLUG, () => ({ body: { audited: 0, skipped: { disabled: 4 } } }), 'JOB_RESULT skipped feature-dark', 0);
    await expectFixture(SLUG, () => ({ body: { audited: 0, skipped: { 'soak-expired': 1 } } }), 'JOB_RESULT skipped soak-expired', 0);
  });
  it('503 → skipped feature-dark', async () => {
    await expectFixture(SLUG, () => ({ status: 503, body: {} }), 'JOB_RESULT skipped feature-dark', 0);
  });
  it('500 / malformed → failed', async () => {
    await expectFixture(SLUG, () => ({ status: 500, body: { error: 'jev-audit batch failed: x' } }), 'JOB_RESULT failed batch-http-500 jev-audit batch failed: x', 1);
    await expectFixture(SLUG, () => ({ body: { audited: 'many' } }), 'JOB_RESULT failed batch-malformed-response: expected audited, skipped', 1);
  });
});
