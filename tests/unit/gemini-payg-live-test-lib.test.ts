/**
 * The pure parts of the Gemini pay-per-use user-role live test
 * (scripts/gemini-payg-live-test-lib.mjs): the honesty layer of the live-user-channel
 * proof standard (§4.4–4.6) and the throwaway config transform.
 */
// @ts-nocheck — plain ESM script module, no types.
import { describe, it, expect } from 'vitest';
import {
  ScenarioMatrix, Blocked, CheckFailed, check, expectEqual, REQUIRED_RISK_CATEGORIES,
  throwawayConfig, handoffBody, missingPlanLines, committedMoneyFigures, restartWindow,
  FEATURE_SETUP_FLOW, FEATURE_HOLDER_DEATH,
} from '../../scripts/gemini-payg-live-test-lib.mjs';
import { REQUIRED_RISK_CATEGORIES as STORE_CATEGORIES } from '../../src/core/LiveTestArtifactStore.js';
import { renderGeminiPaygPlanText, GEMINI_PAYG_FIRST_SCREEN_LINE } from '../../src/core/geminiPaygGoLive.js';

const spec = (id: string, riskCategory: string) => ({ id, description: id, riskCategory });

describe('ScenarioMatrix — the verdict honesty layer', () => {
  it('its risk categories are the artifact store\'s', () => {
    expect(REQUIRED_RISK_CATEGORIES).toEqual(STORE_CATEGORIES);
  });

  it('PASS needs evidence; a body that recorded nothing is a FAIL', async () => {
    const m = new ScenarioMatrix();
    expect((await m.run(spec('a', 'happy-path'), (e) => { e.status = 200; })).verdict).toBe('PASS');
    const empty = await m.run(spec('b', 'lifecycle'), () => {});
    expect(empty.verdict).toBe('FAIL');
    expect(empty.evidence.failedCheck).toMatch(/no evidence/);
  });

  it('a failed check is a FAIL that keeps its evidence and detail; an unexpected throw is a FAIL', async () => {
    const m = new ScenarioMatrix();
    const r = await m.run(spec('c', 'idempotency'), (e) => { e.calls = 2; expectEqual(e.calls, 1, 'one paid call'); });
    expect(r.verdict).toBe('FAIL');
    expect(r.evidence.calls).toBe(2);
    expect(r.evidence.failedCheck).toBe('one paid call');
    expect(r.evidence.failedDetail).toEqual({ expected: 1, actual: 2 });
    const boom = await m.run(spec('d', 'regression'), () => { throw new TypeError('x is undefined'); });
    expect(boom.verdict).toBe('FAIL');
    expect(boom.evidence.failedCheck).toMatch(/unexpected error: x is undefined/);
  });

  it('BLOCKED needs a known kind and a reason, and is never accepted for happy-path or channel-parity', async () => {
    const m = new ScenarioMatrix();
    const ok = await m.run(spec('e', 'concurrency'), () => { throw new Blocked('platform-error', 'the Work Board is off'); });
    expect(ok.verdict).toBe('BLOCKED');
    expect(ok.blockedKind).toBe('platform-error');
    expect((await m.run(spec('f', 'happy-path'), () => { throw new Blocked('platform-error', 'x'); })).verdict).toBe('FAIL');
    expect((await m.run(spec('g', 'channel-parity'), () => { throw new Blocked('timeout', 'x'); })).verdict).toBe('FAIL');
    expect((await m.run(spec('h', 'lifecycle'), () => { throw new Blocked('made-up', 'x'); })).verdict).toBe('FAIL');
    expect((await m.run(spec('i', 'lifecycle'), () => { throw new Blocked('timeout', '  '); })).verdict).toBe('FAIL');
  });

  it('allPass needs every category covered and every row PASS — a BLOCKED row is not a pass', async () => {
    const m = new ScenarioMatrix();
    for (const c of REQUIRED_RISK_CATEGORIES.slice(0, -1)) await m.run(spec(c, c), (e) => { e.ok = true; });
    expect(m.allPass()).toBe(false);
    expect(m.missingCategories()).toEqual(['regression']);
    await m.run(spec('regression', 'regression'), (e) => { e.ok = true; });
    expect(m.allPass()).toBe(true);
    expect(m.allRowsPass()).toBe(true);
    await m.run(spec('blocked', 'concurrency'), () => { throw new Blocked('timeout', 'slow'); });
    expect(m.allPass()).toBe(false);
    expect(m.allRowsPass()).toBe(false);
    const drillLike = new ScenarioMatrix();
    await drillLike.run(spec('only', 'failure-rollback'), (e) => { e.ok = 1; });
    expect(drillLike.allRowsPass()).toBe(true);
    expect(drillLike.allPass()).toBe(false);
  });

  it('refuses duplicate ids and unknown categories', async () => {
    const m = new ScenarioMatrix();
    await m.run(spec('x', 'lifecycle'), (e) => { e.ok = 1; });
    await expect(m.run(spec('x', 'lifecycle'), () => {})).rejects.toThrow(/duplicate/);
    await expect(m.run(spec('y', 'vibes'), () => {})).rejects.toThrow(/unknown risk category/);
  });

  it('builds a store-shaped artifact with plain-JSON evidence', async () => {
    const m = new ScenarioMatrix({ surface: 'dashboard' });
    const shared = { a: 1 };
    await m.run(spec('p', 'happy-path'), (e) => { e.one = shared; e.two = shared; e.skip = undefined; });
    const art = m.toArtifact({ featureId: FEATURE_SETUP_FLOW, runId: 'r1', runnerFingerprint: 'm_x', createdAt: '2026-11-20T00:00:00Z' });
    expect(art).toMatchObject({ featureId: 'routingSpend.geminiPaygLane.setupFlow', runId: 'r1', surfaces: ['dashboard'], riskCategories: ['happy-path'], runnerFingerprint: 'm_x' });
    expect(art.scenarios[0].evidence).toEqual({ one: { a: 1 }, two: { a: 1 } });
    expect(art.scenarios[0].evidence.one).not.toBe(art.scenarios[0].evidence.two);
    expect(FEATURE_HOLDER_DEATH).toBe('routingSpend.geminiPaygLane.holderDeathDrill');
  });

  it('check/CheckFailed carry the detail', () => {
    expect(() => check(false, 'nope', { k: 1 })).toThrow(CheckFailed);
    try { check(false, 'nope', { k: 1 }); } catch (err) { expect((err as CheckFailed).detail).toEqual({ k: 1 }); }
  });
});

describe('throwawayConfig', () => {
  it('turns every outward piece off and the driven pieces on; a pair gets the pool and the mesh', () => {
    const base = { projectName: 'x', tunnel: { enabled: true, type: 'quick' }, updates: { autoApply: true }, feedback: { enabled: true, webhookUrl: 'https://x' }, dispatches: { enabled: true }, threadline: { relayEnabled: true } };
    const c = throwawayConfig(base, { pin: '123456', pair: true });
    expect(c).toMatchObject({
      dashboardPin: '123456', tunnel: { enabled: false }, updates: { autoApply: false }, feedback: { enabled: false, webhookUrl: 'https://x' }, dispatches: { enabled: false },
      threadline: { relayEnabled: false }, workBoard: { enabled: true }, routingSpend: { enabled: true }, mobilePairing: { enabled: true, native: { enabled: true } },
      monitoring: { liveTestGate: { enabled: true }, liveTestRunner: { enabled: true } },
      multiMachine: { sessionPool: { enabled: true }, meshTransport: { enabled: true }, failoverTimeoutMinutes: 15 },
    });
    expect(base.tunnel.enabled).toBe(true); // not mutated
    expect(throwawayConfig(base, { pin: '1', pair: false }).multiMachine).toBeUndefined();
  });
});

describe('the plan-page checks', () => {
  const setup = {
    schema: 'gemini-payg-setup/v1', door: 'gemini-api', keyRef: 'gemini_api_key_payg', provider: 'google',
    designatedMachineId: 'm_holder', designatedMachineName: 'LT-Holder', designationEpoch: 1,
    monthlyCapUsd: 50, dailyCapUsd: 10, periodTimeZone: 'America/Los_Angeles', perCallCeilingUsd: 2.5, provisionalCeilingUsd: 10,
    e2MonthSharePct: 40, e2DayCapUsd: 4, e1PassesPerRound: 1, callers: ['spec-review', 'second-opinion'], e3Components: [],
    doorwayLivenessOn: false, models: ['gemini-4-neon', 'gemini-4-hydrogen'], keyGeneration: 'f'.repeat(64), providerKeyId: 'projects/p/keys/k',
    googleSpendLimitKind: 'budget-alert-only', googleSpendLimitUsd: 50, reconcileJobEnabled: true, transfer: null,
  };
  const text = renderGeminiPaygPlanText(setup as never, { modelVerified: () => false }, 'a'.repeat(64));

  it('every plan line found on a page that wraps it; a dropped line is named', () => {
    const wrapped = text.split('\n').map((l) => l.replace(/ /g, ' \n  ')).join('\n\n');
    expect(missingPlanLines(text, wrapped)).toEqual([]);
    const dropped = text.split('\n').filter((l) => !l.startsWith('Callers — background')).join('\n');
    expect(missingPlanLines(text, dropped)).toEqual(['Callers — background checks: none.']);
  });

  it('the committed money figures are printed by the real renderer, independently derived', () => {
    const figures = committedMoneyFigures(setup);
    expect(figures).toEqual(['$50.00', '$10.00', '$2.50', '$10.00', '$20.00', '$4.00']);
    for (const f of figures) expect(text).toContain(f);
    expect(text.split('\n')[0]).toBe(GEMINI_PAYG_FIRST_SCREEN_LINE);
  });
});

describe('handoffBody and restartWindow', () => {
  it('builds a handoff the server validates (same shape the account lane writes)', async () => {
    const { validateKeyHandoffBody } = await import('../../src/core/geminiPaygGoLive.js');
    const b = handoffBody({ keyFingerprint: 'a'.repeat(64), readAt: '2026-11-20T00:00:00Z', shots: { oneKey: { path: '/x/one.png', sha256: 'b'.repeat(64) }, limit: { path: '/x/l.png', sha256: 'c'.repeat(64) } }, transcriptPath: '/x/t.jsonl' });
    expect(validateKeyHandoffBody(b)).toBeNull();
    expect(b.oneKeyArtifact.keyCount).toBe(1);
  });
  it('restartWindow is arithmetic over recorded times, null when any is missing', () => {
    expect(restartWindow({ commitAt: 1000, exitAt: 4000, readyAt: 9000 })).toEqual({ exitAfterCommitMs: 3000, downMs: 5000, totalMs: 8000 });
    expect(restartWindow({ commitAt: 1000, exitAt: undefined, readyAt: 9000 })).toBeNull();
  });
});
