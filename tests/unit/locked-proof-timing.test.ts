import { describe, expect, it } from 'vitest';
// @ts-expect-error plain script
import { beforeEnterTiming, CASES, judge, runCase } from '../../scripts/locked-proof/lib.mjs';
// @ts-expect-error plain script
import { RealTarget } from '../../scripts/locked-proof/driver.mjs';

const cases = ['15.1', '15.3', '15.5', '15.7'].map(id => CASES.find((c: { id: string }) => c.id === id));
function evidence(c: any, eventAt = 4_830): any {
  const marker = { requestId: 'request-current', createdAt: 4_100, enterPendingAt: 5_000 };
  return { grantRequestId: 'request-current', grantOpenedAt: 4_000, grantExpiresAt: eventAt,
    samples: [{ t: 5_010, dirty: true, markers: { duty: { ...marker, state: 'owed' } } }],
    fired: [{ ...c.inject[0], startedAt: eventAt, t: eventAt }],
    final: { lockState: 'locked', markers: { duty: { ...marker, state: 'relocked' } }, processesGone: true },
    extra: { submissionsAfterClose: 0, relockAfterDropMs: 120_000 }, unfired: [] };
}
const timingReasons = (c: any, ev: any) => judge(c, ev).reasons.filter((r: string) => /before-enter|grant limit/.test(r));

describe('before-Enter timing uses exact-duty raw evidence', () => {
  for (const c of cases) {
    it(`${c.id} rejects late/equal timing regardless of a missing or forged extra metric`, () => {
      for (const eventAt of [5_000, 5_001]) for (const fake of [undefined, NaN, -Infinity, -170]) {
        const ev = evidence(c, eventAt);
        ev.extra.injectMinusEnterMs = fake; ev.extra.limitMinusEnterMs = fake;
        expect(timingReasons(c, ev)).toHaveLength(1);
        expect(judge(c, ev).pass).toBe(false);
      }
    });
    it(`${c.id} accepts finite negative raw timing without trusting extraEvidence`, () => {
      const ev = evidence(c);
      ev.extra.injectMinusEnterMs = 999; ev.extra.limitMinusEnterMs = 999;
      expect(timingReasons(c, ev)).toEqual([]);
      expect(judge(c, ev).pass).toBe(true);
      expect(beforeEnterTiming(ev, c.inject[0].action)).toMatchObject({ measured: true, gap: -170, dutyKey: 'duty' });
    });
    it(`${c.id} never interprets absent Enter plus aborted and zero submissions as proof`, () => {
      const ev = evidence(c);
      delete ev.samples[0].markers.duty.enterPendingAt; delete ev.final.markers.duty.enterPendingAt;
      ev.secretResult = { refused: 'aborted' }; ev.extra.submissions = 0;
      expect(timingReasons(c, ev)[0]).toMatch(/unmeasured/);
    });
  }
  it('rejects non-finite times, missing identity, conflicts and unrelated Enter evidence', () => {
    const c = cases[0];
    const mutations = [
      (ev: any) => { delete ev.grantRequestId; },
      (ev: any) => { ev.grantOpenedAt = NaN; },
      ...[undefined, NaN, Infinity, -Infinity].map(t => (ev: any) => { ev.fired[0].startedAt = t; }),
      ...[undefined, NaN, Infinity, -Infinity].map(t => (ev: any) => { ev.fired[0].t = t; }),
      (ev: any) => { ev.fired[0].startedAt = ev.fired[0].t + 1; },
      ...[undefined, NaN, Infinity, -Infinity].map(t => (ev: any) => { ev.samples[0].markers.duty.enterPendingAt = t; }),
      (ev: any) => { ev.final.markers.duty.enterPendingAt++; },
      (ev: any) => { ev.final.markers.duty.requestId = 'other'; },
      (ev: any) => { ev.final.markers.duty.createdAt++; },
      (ev: any) => { ev.final.markers.second = { ...ev.final.markers.duty }; },
      (ev: any) => { ev.fired.push({ ...ev.fired[0] }); },
      (ev: any) => { ev.fired[0].action = 'wrong-action'; },
      (ev: any) => {
        for (const sample of [...ev.samples, ev.final]) {
          sample.markers.other = { ...sample.markers.duty, requestId: 'old-request' };
          delete sample.markers.duty.enterPendingAt;
        }
      },
    ];
    for (const mutate of mutations) {
      const ev = evidence(c); mutate(ev);
      expect(timingReasons(c, ev)[0]).toMatch(/unmeasured/);
    }
    for (const expiry of [undefined, NaN, Infinity, -Infinity]) {
      const ev = evidence(cases[1]); ev.grantExpiresAt = expiry;
      expect(timingReasons(cases[1], ev)[0]).toMatch(/unmeasured/);
    }
  });
  it('rejects a revoke or transport change that starts before Enter but completes afterward', () => {
    for (const c of cases.filter((c: any) => c.timing !== 'deadline')) {
      const ev = evidence(c);
      ev.fired[0].startedAt = 4_830; ev.fired[0].t = 5_001;
      expect(timingReasons(c, ev)).toEqual(['before-enter step completed 1 ms after Enter']);
      expect(judge(c, ev).pass).toBe(false);
    }
  });
  it('uses the grant expiry independently of the wait-deadline action duration', () => {
    const c = cases[1]; const ev = evidence(c);
    ev.fired[0].startedAt = 4_000; ev.fired[0].t = 9_000;
    expect(beforeEnterTiming(ev, c.inject[0].action)).toMatchObject({ measured: true, gap: -170 });
  });
  it('does not apply a before-Enter timing requirement to after-Enter cases', () => {
    const c = CASES.find((c: any) => c.id === '15.2');
    expect(timingReasons(c, evidence(c, 5_001))).toEqual([]);
  });
  it('runCase cannot turn a late injection into a pass through target.extraEvidence', async () => {
    const c = cases[1]; let now = 4_000; let closed = false;
    const marker = { requestId: 'request-current', createdAt: 4_100, enterPendingAt: 5_000 };
    const target = {
      now: () => now, prepare: async () => {}, openGrant: async () => ({ requestId: 'request-current', expiresAt: 5_001 }),
      typePassword: async () => { now = 5_001; return { sent: true }; },
      snapshot: async () => ({ now, dirty: true, lockState: 'locked', markers: { duty: { ...marker, state: closed ? 'relocked' : 'owed' } } }),
      act: async () => { closed = true; }, settled: () => closed, recover: async () => [],
      sleep: async (ms: number) => { now += ms; },
      extraEvidence: async () => ({ limitMinusEnterMs: -170, submissionsAfterClose: 0 }),
    };
    const ev = await runCase(c, target);
    expect(ev.extra.limitMinusEnterMs).toBe(-170);
    expect(ev.verdict.pass).toBe(false);
    expect(ev.verdict.reasons).toContain('grant limit arrived 1 ms after Enter');
  });
});


describe('viewer timing identity receipt', () => {
  it('binds expiry to an approved successful exact request GET, not adjacent responses', async () => {
    let response: any;
    const page = { on: (_: string, handler: any) => { response = handler; }, goto: async () => {},
      fill: async () => {}, click: async () => {}, waitForSelector: async () => {} };
    const target = Object.assign(Object.create(RealTarget.prototype), {
      browser: { newContext: async () => ({ newPage: async () => page }) }, viewers: [],
    });
    const viewer = await target.viewer({ port: 1, pin: '000000' });
    const send = (path: string, method: string, ok: boolean, body: any) => response({
      url: () => `http://127.0.0.1:1${path}`, request: () => ({ method: () => method }), ok: () => ok, json: async () => body,
    });
    const approved = { status: 'approved', expiresAt: 9_000 };
    for (const [path, method, ok, body] of [
      ['/desktop/requests', 'POST', true, approved], ['/desktop/requests/other/cursor', 'GET', true, approved],
      ['/desktop/requests/other', 'POST', true, approved], ['/desktop/requests/other', 'GET', false, approved],
      ['/desktop/requests/other', 'GET', true, { status: 'revoked', expiresAt: 9_000 }],
    ] as const) await send(path, method, ok, body);
    expect(viewer.requestId).toBeUndefined(); expect(viewer.expiresAt).toBeUndefined();
    await send('/desktop/requests/current', 'GET', true, approved);
    expect(viewer).toMatchObject({ requestId: 'current', expiresAt: 9_000 });
    await send('/desktop/requests/current/ticket', 'POST', true, { expiresAt: 12_000 });
    expect(viewer.expiresAt).toBe(9_000);
  });
});
