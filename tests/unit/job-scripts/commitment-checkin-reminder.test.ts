import { describe, expect, it } from 'vitest';
import { expectFixture, sharedContractCases } from './harness.js';

const SLUG = 'commitment-checkin-reminder';
const report = (over: Record<string, unknown> = {}) => ({ ran: true, dryRun: false, scanned: 3, due: 0, sent: 0, failed: 0, wouldSend: 0, capped: 0, gaveUp: 0, skippedByReason: {}, errors: [], ...over });
const ok = () => ({ body: report() });

describe('commitment-checkin-reminder script', () => {
  sharedContractCases(SLUG, ok);

  it('posts the pass with {} and reports idle', async () => {
    const r = await expectFixture(SLUG, ok, 'JOB_RESULT ok idle', 0);
    expect(r.requests[0]).toMatchObject({ method: 'POST', url: '/commitments/check-in-reminder/pass', body: '{}' });
    expect(r.anomalies).toEqual([]);
  });

  it('dry run → ok dry-run would-send=N', async () => {
    await expectFixture(SLUG, () => ({ body: report({ dryRun: true, wouldSend: 2 }) }), 'JOB_RESULT ok dry-run would-send=2', 0);
  });

  it('sends → ok with counts', async () => {
    const r = await expectFixture(SLUG, () => ({ body: report({ sent: 3, failed: 1 }) }), 'JOB_RESULT ok sent=3 failed=1 gaveUp=0', 0);
    expect(r.fields).toMatchObject({ sent: '3', failed: '1', gave_up: '0', dry_run: 'false' });
  });

  it('gaveUp > 0 → critical undelivered-reminders anomaly', async () => {
    const r = await expectFixture(SLUG, () => ({ body: report({ gaveUp: 2 }) }), 'JOB_RESULT ok sent=0 failed=0 gaveUp=2', 0);
    expect(r.anomalies).toEqual(['JOB_ANOMALY undelivered-reminders 3 2 check-in reminder(s) undelivered after retries; the list is at GET /commitments/check-in-reminder']);
  });

  it('503 feature dark → skipped feature-dark; 503 no-delivery-transport is named', async () => {
    await expectFixture(SLUG, () => ({ status: 503, body: { error: 'check-in-reminder-not-enabled' } }), 'JOB_RESULT skipped feature-dark', 0);
    await expectFixture(SLUG, () => ({ status: 503, body: { error: 'no-delivery-transport' } }), 'JOB_RESULT skipped no-delivery-transport', 0);
  });

  it('500 → failed; malformed → failed; wrong shape → failed', async () => {
    await expectFixture(SLUG, () => ({ status: 500, body: { error: 'check-in-reminder-pass-failed' } }), 'JOB_RESULT failed pass-http-500 check-in-reminder-pass-failed', 1);
    await expectFixture(SLUG, () => ({ body: '<html>' }), 'JOB_RESULT failed pass-malformed-response HTTP 200', 1);
    await expectFixture(SLUG, () => ({ body: { hello: 1 } }), 'JOB_RESULT failed pass-malformed-response: missing ran/sent/gaveUp', 1);
  });
});
