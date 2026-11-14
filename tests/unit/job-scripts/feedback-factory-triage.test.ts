import { describe, expect, it } from 'vitest';
import { expectFixture, sharedContractCases, type StubRequest } from './harness.js';

const SLUG = 'feedback-factory-triage';
const RUN = 'triage-run:11111111-2222-3333-4444-555555555555';
const POLL = { INSTAR_SCRIPT_POLL_MS: '1500' };

/** tick → 202 runId; summary → lastTick (after `lag` polls, an older run first). */
function flow(lastTick: Record<string, unknown>, lag = 1) {
  let polls = 0;
  return (r: StubRequest) => {
    if (r.url === '/feedback-factory/triage/tick') return { status: 202, body: { runId: RUN, accepted: true } };
    polls++;
    return { body: { lastTick: polls <= lag ? { runId: 'triage-run:older', result: 'succeeded' } : { runId: RUN, ...lastTick } } };
  };
}

describe('feedback-factory-triage script', () => {
  sharedContractCases(SLUG, flow({ result: 'succeeded', decided: 2 }));

  it('202 then a terminal succeeded run → ok succeeded, with structured fields pinned', async () => {
    const r = await expectFixture(SLUG, flow({ result: 'succeeded', decided: 2 }), 'JOB_RESULT ok succeeded', 0, POLL);
    expect(r.requests[0]).toMatchObject({ method: 'POST', url: '/feedback-factory/triage/tick' });
    expect(r.requests[0].headers['x-instar-request']).toBe('1');
    expect(r.fields).toEqual({ http_status: '202', run_id: RUN, outcome: 'succeeded', decided: '2' });
  });

  it('a no-op run with an informational reason → ok, reason kept in the result text', async () => {
    const r = await expectFixture(SLUG, flow({ result: 'no-op', reason: 'nothing due', decided: 0 }), 'JOB_RESULT ok no-op (nothing due)', 0, POLL);
    expect(r.fields.server_reason).toBe('nothing');
  });

  it('degraded with a self-managed reason → ok degraded-self-managed', async () => {
    await expectFixture(SLUG, flow({ result: 'degraded', reason: 'authority-paused spend cap' }), 'JOB_RESULT ok degraded-self-managed authority-paused spend cap', 0, POLL);
    await expectFixture(SLUG, flow({ result: 'degraded', reason: 'call-cap-reached' }), 'JOB_RESULT ok degraded-self-managed call-cap-reached', 0, POLL);
  });

  it('degraded with any other reason → failed', async () => {
    const r = await expectFixture(SLUG, flow({ result: 'degraded', reason: 'store write failed' }), 'JOB_RESULT failed run-degraded store write failed', 1, POLL);
    expect(r.fields.outcome).toBe('degraded');
  });

  it('a run still in flight after the poll window → failed', async () => {
    await expectFixture(SLUG, flow({ result: 'succeeded' }, 10_000), `JOB_RESULT failed still-in-flight triage run ${RUN} after 150 s`, 1, { INSTAR_SCRIPT_POLL_MS: '400' });
  });

  it('503 → skipped feature-dark', async () => {
    const r = await expectFixture(SLUG, () => ({ status: 503, body: { error: 'feedback triage unavailable' } }), 'JOB_RESULT skipped feature-dark', 0);
    expect(r.fields).toEqual({ http_status: '503', outcome: 'dark' });
  });

  it('409 / 429 → ok no-op, as the server classifies them', async () => {
    const r = await expectFixture(SLUG, () => ({ status: 409, body: { error: 'not-canonical-owner', owner: 'm_abc' } }), 'JOB_RESULT ok no-op not-canonical-owner', 0);
    expect(r.fields).toEqual({ http_status: '409', outcome: 'no-op', server_reason: 'not-canonical-owner', owner: 'm_abc' });
    await expectFixture(SLUG, () => ({ status: 409, body: { error: 'tick-in-flight' } }), 'JOB_RESULT ok no-op tick-in-flight', 0);
    await expectFixture(SLUG, () => ({ status: 429, body: { error: 'rate-limited' } }), 'JOB_RESULT ok rate-limited', 0);
  });

  it('a refused tick (403, or 202 without runId, or malformed) → failed', async () => {
    await expectFixture(SLUG, () => ({ status: 403, body: { error: 'X-Instar-Request: 1 required' } }), 'JOB_RESULT failed tick-refused HTTP 403 X-Instar-Request: 1 required', 1);
    await expectFixture(SLUG, () => ({ status: 202, body: { accepted: true } }), 'JOB_RESULT failed tick-refused HTTP 202', 1);
    await expectFixture(SLUG, () => ({ status: 202, body: 'oops' }), 'JOB_RESULT failed tick-refused HTTP 202 malformed body', 1);
  });

  it('JOB_FIELD values never carry prose (spaces) and stay within the value rule', async () => {
    const r = await expectFixture(SLUG, flow({ result: 'degraded', reason: 'quota-paused until 10:00 tomorrow' }), /^JOB_RESULT ok degraded-self-managed/, 0, POLL);
    for (const v of Object.values(r.fields)) expect(v).toMatch(/^[A-Za-z0-9_.:/-]{1,64}$/);
  });
});
