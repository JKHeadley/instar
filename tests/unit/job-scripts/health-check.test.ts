import { describe, expect, it } from 'vitest';
import { expectFixture, sharedContractCases, runScript, makeTmp, removeTmp } from './harness.js';

const SLUG = 'health-check';
const healthy = { status: 'ok', degradations: 0, sessions: { current: 2, max: 10 }, llmReliability: { status: 'ok', components: [] } };
const ok = () => ({ status: 200, body: healthy });
const disk = (pct: number) => ['--disk-free-override', String(pct)];

describe('health-check script', () => {
  sharedContractCases(SLUG, ok);

  it('healthy /health with ample disk → ok healthy, no anomalies', async () => {
    const r = await expectFixture(SLUG, ok, 'JOB_RESULT ok healthy', 0, undefined, disk(50));
    expect(r.anomalies).toEqual([]);
    expect(r.requests[0].method).toBe('GET');
    expect(r.requests[0].url).toBe('/health');
    expect(r.fields).toMatchObject({ disk_free_pct: '50.0', sessions_current: '2', sessions_max: '10', llm_status: 'ok' });
  });

  it('the real statfs reading works when no override is given', async () => {
    const r = await expectFixture(SLUG, ok, /^JOB_RESULT ok /, 0);
    expect(Number(r.fields.disk_free_pct)).toBeGreaterThanOrEqual(0);
  });

  it('disk 9% → disk-low 2 (recoverable)', async () => {
    const r = await expectFixture(SLUG, ok, 'JOB_RESULT ok observed 1 condition(s): disk-low', 0, undefined, disk(9));
    expect(r.anomalies).toEqual(['JOB_ANOMALY disk-low 2 9.0% free on the agent volume']);
  });

  it('disk 10% exactly is not low', async () => {
    await expectFixture(SLUG, ok, 'JOB_RESULT ok healthy', 0, undefined, disk(10));
  });

  it('disk 4% → disk-critical 3 only', async () => {
    const r = await expectFixture(SLUG, ok, 'JOB_RESULT ok observed 1 condition(s): disk-critical', 0, undefined, disk(4));
    expect(r.anomalies).toEqual(['JOB_ANOMALY disk-critical 3 4.0% free on the agent volume']);
  });

  it('an invalid disk override fails', async () => {
    await expectFixture(SLUG, ok, 'JOB_RESULT failed disk-free-override-invalid', 1, undefined, disk(140));
  });

  it('--disk-free-override is refused outside canary mode', async () => {
    const cwd = makeTmp('hc');
    try {
      const r = await runScript(SLUG, { args: ['--disk-free-override', '1'], canaryEnv: false, cwd });
      expect(r.resultLine).toBe('JOB_RESULT failed flag-refused --disk-free-override');
      expect(r.exitCode).toBe(2);
    } finally { removeTmp(cwd); }
  });

  it('session limit reached → sessions-exhausted', async () => {
    const r = await expectFixture(SLUG, () => ({ body: { ...healthy, status: 'degraded', sessions: { current: 10, max: 10 } } }),
      'JOB_RESULT ok observed 1 condition(s): sessions-exhausted', 0, undefined, disk(50));
    expect(r.anomalies).toEqual(['JOB_ANOMALY sessions-exhausted 2 10 of 10 sessions in use']);
  });

  it('llmReliability not ok → llm-unreliable; absent llmReliability is not an anomaly', async () => {
    const r = await expectFixture(SLUG, () => ({ body: { ...healthy, llmReliability: { status: 'unavailable', components: [], reason: 'feature metrics query failed' } } }),
      'JOB_RESULT ok observed 1 condition(s): llm-unreliable', 0, undefined, disk(50));
    expect(r.anomalies[0]).toBe('JOB_ANOMALY llm-unreliable 2 LLM reliability is unavailable (feature metrics query failed)');
    const { llmReliability: _drop, ...noLlm } = healthy;
    await expectFixture(SLUG, () => ({ body: noLlm }), 'JOB_RESULT ok healthy', 0, undefined, disk(50));
  });

  it('one degradation:<feature> per degradationFeatures entry, with the summary string as evidence', async () => {
    const body = { ...healthy, degradations: 2, degradationFeatures: ['TelegramAdapter.send', 'Cartographer sweep', 'TelegramAdapter.send'],
      degradationSummary: ['Telegram sends fell back to plain text 3 times', 'Cartographer sweep is paused', 'dup'] };
    const r = await expectFixture(SLUG, () => ({ body }),
      'JOB_RESULT ok observed 2 condition(s): degradation:TelegramAdapter.send degradation:Cartographer_sweep', 0, undefined, disk(50));
    expect(r.anomalies).toEqual([
      'JOB_ANOMALY degradation:TelegramAdapter.send 2 Telegram sends fell back to plain text 3 times',
      'JOB_ANOMALY degradation:Cartographer_sweep 2 Cartographer sweep is paused',
    ]);
  });

  it('tolerates a /health without degradationFeatures (summary strings alone are not keys)', async () => {
    await expectFixture(SLUG, () => ({ body: { ...healthy, degradations: 1, degradationSummary: ['something degraded'] } }), 'JOB_RESULT ok healthy', 0, undefined, disk(50));
  });

  it('consecutiveJobFailures is not an anomaly', async () => {
    await expectFixture(SLUG, () => ({ body: { ...healthy, status: 'degraded', consecutiveJobFailures: 9 } }), 'JOB_RESULT ok healthy', 0, undefined, disk(50));
  });

  it('a degraded must-fail fixture reports every condition at once (critical included)', async () => {
    const body = { status: 'degraded', degradations: 1, sessions: { current: 5, max: 5 }, llmReliability: { status: 'degraded' },
      degradationFeatures: ['x'], degradationSummary: ['x is down'] };
    const r = await expectFixture(SLUG, () => ({ body }),
      'JOB_RESULT ok observed 4 condition(s): disk-critical sessions-exhausted llm-unreliable degradation:x', 0, undefined, disk(2));
    expect(r.anomalies.map((a) => a.split(' ').slice(1, 3).join(' '))).toEqual(['disk-critical 3', 'sessions-exhausted 2', 'llm-unreliable 2', 'degradation:x 2']);
  });

  it('non-200 /health → failed', async () => {
    await expectFixture(SLUG, () => ({ status: 500, body: { error: 'boom' } }), 'JOB_RESULT failed health-http-500 boom', 1);
    await expectFixture(SLUG, () => ({ status: 503, body: {} }), 'JOB_RESULT failed health-http-503', 1);
  });

  it('malformed body → failed', async () => {
    await expectFixture(SLUG, () => ({ status: 200, body: 'not json{' }), 'JOB_RESULT failed health-malformed-response HTTP 200', 1);
  });

  it('unauthenticated /health (no sessions field) → failed, never a false healthy', async () => {
    await expectFixture(SLUG, () => ({ body: { status: 'ok', degradations: 0 } }), /^JOB_RESULT failed health-unauthenticated/, 1, undefined, disk(50));
  });
});
