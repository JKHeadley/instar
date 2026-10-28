import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { expectFixture, makeTmp, removeTmp, runScript, sharedContractCases, startStub, type StubRequest } from './harness.js';

const SLUG = 'feedback-factory-process';
const RUN = 'drain-run:abc';
const POLL = { INSTAR_SCRIPT_POLL_MS: '1500' };

function flow(opts: { state?: string; lastRun?: Record<string, unknown>; tick?: { status: number; body: unknown }; before?: Record<string, unknown>; after?: Record<string, unknown> } = {}) {
  let statusReads = 0;
  return (r: StubRequest) => {
    if (r.url === '/feedback-factory/drain/tick') return opts.tick ?? { status: 202, body: { runId: RUN } };
    statusReads++;
    const base = { posture: { state: opts.state ?? 'live' } };
    if (statusReads === 1) return { body: { ...base, ...(opts.before ?? {}) } };
    return { body: { ...base, lastRun: { runId: RUN, state: 'succeeded', ...(opts.lastRun ?? {}) }, ...(opts.after ?? {}) } };
  };
}

describe('feedback-factory-process script', () => {
  sharedContractCases(SLUG, flow());

  it('live → tick → terminal succeeded → ok succeeded, with fields pinned', async () => {
    const r = await expectFixture(SLUG, flow(), 'JOB_RESULT ok succeeded', 0, POLL);
    const tick = r.requests.find((q) => q.url === '/feedback-factory/drain/tick')!;
    expect(tick.headers['x-instar-request']).toBe('1');
    expect(String(tick.headers['x-instar-request-nonce'])).toMatch(/^feedback-drain-\d+-\d+$/);
    expect(r.fields).toEqual({ http_status: '202', run_id: RUN, outcome: 'succeeded' });
  });

  it('waits past an accepted/running state for the terminal one', async () => {
    let n = 0;
    await expectFixture(SLUG, (q) => {
      if (q.url === '/feedback-factory/drain/tick') return { status: 202, body: { runId: RUN } };
      n++;
      const state = n <= 2 ? 'running' : 'no-op';
      return { body: { posture: { state: 'live' }, lastRun: { runId: RUN, state } } };
    }, 'JOB_RESULT ok no-op', 0, POLL);
  });

  it('posture dark → skipped feature-dark; unavailable → failed', async () => {
    await expectFixture(SLUG, flow({ state: 'dark' }), 'JOB_RESULT skipped feature-dark', 0);
    await expectFixture(SLUG, () => ({ status: 200, body: { posture: { state: 'unavailable', reason: 'store corrupt' } } }), 'JOB_RESULT failed posture-unavailable store corrupt', 1);
  });

  it('unreadable status: skipped on the fleet, failed on a development agent', async () => {
    await expectFixture(SLUG, () => ({ status: 500, body: 'x' }), 'JOB_RESULT skipped status-unreadable-fleet', 0);
    const stub = await startStub(() => ({ status: 500, body: 'x' }));
    const cwd = makeTmp('dev');
    try {
      fs.mkdirSync(path.join(cwd, '.instar'));
      fs.writeFileSync(path.join(cwd, '.instar', 'config.json'), JSON.stringify({ developmentAgent: true }));
      const r = await runScript(SLUG, { serverUrl: stub.url, cwd });
      expect(r.resultLine).toBe('JOB_RESULT failed status-unreadable HTTP 500');
      expect(r.exitCode).toBe(1);
    } finally { await stub.close(); removeTmp(cwd); }
  });

  it('a refused tick → failed, naming a paused authority', async () => {
    const r = await expectFixture(SLUG, flow({ tick: { status: 403, body: { error: 'current registered readiness agent required' } }, before: { authority: { pausedBecause: 'spend cap reached' } } }),
      'JOB_RESULT failed tick-refused HTTP 403 current registered readiness agent required (authority paused: spend cap reached)', 1);
    expect(r.fields).toMatchObject({ outcome: 'tick-refused', server_reason: 'authority-paused' });
  });

  it('a proxied tick → ok proxied', async () => {
    await expectFixture(SLUG, flow({ tick: { status: 202, body: { runId: RUN, proxied: true } } }), 'JOB_RESULT ok proxied', 0);
  });

  it('degraded / failed / abandoned → failed with the drain reason', async () => {
    await expectFixture(SLUG, flow({ lastRun: { state: 'degraded', reason: 'readiness-call-failed timeout' } }), 'JOB_RESULT failed run-degraded readiness-call-failed timeout', 1, POLL);
    await expectFixture(SLUG, flow({ lastRun: { state: 'abandoned' } }), 'JOB_RESULT failed run-abandoned no reason given', 1, POLL);
  });

  it('work advancing while the consumer is in simulation → failed invariant-broken', async () => {
    await expectFixture(SLUG, flow({ before: { drain: { work: { claimed: 1, completed: 0 } } }, after: { consumerLive: false, drain: { work: { claimed: 2, completed: 0 } } } }),
      /^JOB_RESULT failed invariant-broken /, 1, POLL);
  });

  it('still running after the poll window → failed', async () => {
    await expectFixture(SLUG, flow({ lastRun: { state: 'running' } }), /^JOB_RESULT failed still-in-flight drain run drain-run:abc after 180 s/, 1, { INSTAR_SCRIPT_POLL_MS: '400' });
  });
});
