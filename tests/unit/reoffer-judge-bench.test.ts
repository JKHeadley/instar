/**
 * The re-offer judge for reasons 2 and 3 (docs/specs/recommended-services.md, "Re-offering after a no"): the code
 * floor it cannot exceed, the input hash that remembers a verdict, the strict parse, the call's attribution and
 * provenance, and the labelled bench with its gate. LIVE (opt-in, INSTAR_LIVE_REOFFER_JUDGE=1): the same bench
 * against the real shared provider, the graduation gate before the judge may leave shadow.
 */
import { describe, expect, it } from 'vitest';
import type { CatalogRow } from '../../src/recommended/catalog.js';
import { RECOMMENDED_SERVICE_CATALOG } from '../../src/recommended/catalog.js';
import type { LedgerRow, ReofferRow } from '../../src/recommended/RecommendedServicesLedger.js';
import type { IntelligenceOptions, IntelligenceProvider } from '../../src/core/types.js';
import {
  HOLD_WHYS, JUDGED_REOFFER_LIMIT, OFFER_WHYS, REOFFER_JUDGE_BENCH, REOFFER_JUDGE_COMPONENT, judgeInputHash, judgePrompt,
  changeKind, judgeRetryAfterMs, judgedFloor, parseJudgeVerdict, runReofferJudge, scoreBench, type JudgeInput,
} from '../../src/recommended/reofferJudge.js';
import { DP_REOFFER_JUDGE } from '../../src/data/provenanceCoverage.js';

const DAY = 24 * 60 * 60_000;
const NOW = Date.parse('2027-06-01T00:00:00Z');
const iso = (ms: number) => new Date(ms).toISOString();
const ROW: CatalogRow = { ...RECOMMENDED_SERVICE_CATALOG.find((r) => r.id === 'tailscale')! };
const no = (at: number, reason = 'not-needed'): LedgerRow => ({ type: 'choice', eventId: `n${at}`, service: ROW.id, choice: 'no', shutdown: 'none', reason, origin: 'first-offer', offerTextHash: '', supersedes: [], at: iso(at) } as unknown as LedgerRow);
// A real yes lists the nos it saw (RecommendedServicesLedger.recordYes → knownNoIds).
const yes = (at: number, supersedes: string[] = []): LedgerRow => ({ type: 'choice', eventId: `y${at}`, service: ROW.id, choice: 'yes', shutdown: 'none', reason: 'none', origin: 'person-asked', offerTextHash: '', supersedes, at: iso(at) } as unknown as LedgerRow);
const delivered = (at: number, kind = 'cool-off'): ReofferRow => ({ type: 'reoffer', eventId: `d${at}`, service: ROW.id, owner: '42', kind, state: 'offered', evidenceRef: 'x', at: iso(at) } as unknown as ReofferRow);

describe('judgedFloor', () => {
  it('a cool-off opens 90 days after one no and 180 after two, from the later of the no and the last re-offer', () => {
    expect(judgedFloor(ROW, [no(NOW - 89 * DAY)], [], NOW)).toEqual({ blocked: 'cool-off-running' });
    expect(judgedFloor(ROW, [no(NOW - 91 * DAY)], [], NOW)).toMatchObject({ reason: 'cool-off', nos: 1, noReason: 'not-needed' });
    expect(judgedFloor(ROW, [no(NOW - 300 * DAY), no(NOW - 170 * DAY)], [], NOW)).toEqual({ blocked: 'cool-off-running' });
    expect(judgedFloor(ROW, [no(NOW - 300 * DAY), no(NOW - 181 * DAY)], [], NOW)).toMatchObject({ reason: 'cool-off', nos: 2 });
    expect(judgedFloor(ROW, [no(NOW - 200 * DAY)], [delivered(NOW - 30 * DAY)], NOW)).toEqual({ blocked: 'cool-off-running' });
  });

  it('a change after the no opens it at once; one before the no, or already spent on a delivered re-offer, does not', () => {
    const withChange = (at: number, version = '2'): CatalogRow => ({ ...ROW, changes: [{ version, at: iso(at), summary: 'Setup is one tap.', affects: 'setup' }] });
    expect(judgedFloor(withChange(NOW - DAY), [no(NOW - 10 * DAY)], [], NOW)).toMatchObject({ reason: 'change', changes: [{ version: '2' }] });
    expect(judgedFloor(withChange(NOW - 20 * DAY), [no(NOW - 10 * DAY)], [], NOW)).toEqual({ blocked: 'cool-off-running' });
    expect(judgedFloor(withChange(NOW - DAY), [no(NOW - 10 * DAY)], [delivered(NOW - 12 * 60_000, changeKind('2'))], NOW)).toEqual({ blocked: 'cool-off-running' });
  });

  it('never for a yes, an unanswered service, an unavailable one, or after three nos or three re-offers', () => {
    expect(judgedFloor(ROW, [no(NOW - 400 * DAY), yes(NOW - 300 * DAY, [`n${NOW - 400 * DAY}`])], [], NOW)).toEqual({ blocked: 'not-refused' });
    expect(judgedFloor(ROW, [], [], NOW)).toEqual({ blocked: 'not-refused' });
    expect(judgedFloor({ ...ROW, setupRecipe: null }, [no(NOW - 400 * DAY)], [], NOW)).toEqual({ blocked: 'unavailable' });
    const three = Array.from({ length: JUDGED_REOFFER_LIMIT }, (_, i) => no(NOW - (900 - i) * DAY));
    expect(judgedFloor(ROW, three, [], NOW)).toEqual({ blocked: 'limit-reached' });
    const asked = Array.from({ length: JUDGED_REOFFER_LIMIT }, (_, i) => delivered(NOW - (800 - i * 200) * DAY));
    expect(judgedFloor(ROW, [no(NOW - 900 * DAY)], asked, NOW)).toEqual({ blocked: 'limit-reached' });
  });

  it('an imported legacy decline counts as a no whose cool-off starts at the import', () => {
    const legacy = (at: number) => ({ type: 'legacy-import', eventId: 'l', service: ROW.id, at: iso(at) } as unknown as LedgerRow);
    expect(judgedFloor(ROW, [legacy(NOW - 30 * DAY)], [], NOW)).toEqual({ blocked: 'cool-off-running' });
    expect(judgedFloor(ROW, [legacy(NOW - 95 * DAY)], [], NOW)).toMatchObject({ reason: 'cool-off', nos: 1 });
  });
});

describe('the judgment', () => {
  const input: JudgeInput = REOFFER_JUDGE_BENCH[0]!.input;

  it('the hash ignores the order of recent problems and changes with anything the judge reads', () => {
    const a = { ...input, facts: { ...input.facts, recentProblems: ['a', 'b'] } };
    const b = { ...input, facts: { ...input.facts, recentProblems: ['b', 'a'] } };
    expect(judgeInputHash(a)).toBe(judgeInputHash(b));
    expect(judgeInputHash({ ...a, noReason: 'privacy' })).not.toBe(judgeInputHash(a));
  });

  it('parses only a closed verdict with a matching closed reason', () => {
    expect(parseJudgeVerdict('{"verdict":"offer","why":"price-change-meets-cost-reason"}')).toEqual({ verdict: 'offer', why: 'price-change-meets-cost-reason' });
    expect(parseJudgeVerdict('Sure. {"verdict":"hold","why":"unsure"}')).toEqual({ verdict: 'hold', why: 'unsure' });
    expect(parseJudgeVerdict('{"verdict":"offer","why":"unsure"}')).toBeNull();
    expect(parseJudgeVerdict('{"verdict":"maybe","why":"unsure"}')).toBeNull();
    expect(parseJudgeVerdict('offer')).toBeNull();
    // A model that corrects itself: the last well-formed object wins.
    expect(parseJudgeVerdict('{"why":"price-change-meets-cost-reason","verdict":"hold"}\n\nWait, the reason is privacy. {"why":"change-misses-reason","verdict":"hold"}')).toEqual({ verdict: 'hold', why: 'change-misses-reason' });
  });

  it('the prompt carries only categories, and names every allowed reason', () => {
    const p = judgePrompt(input);
    for (const w of [...OFFER_WHYS, ...HOLD_WHYS]) expect(p).toContain(w);
    expect(p).toContain('When unsure, say "hold"');
    expect(p).toContain(input.changes[0]!.summary);
  });

  it('calls the shared provider with its own component key and decision point; any failure is null', async () => {
    let seen: IntelligenceOptions | undefined;
    const ok: IntelligenceProvider = { evaluate: async (_p, o) => { seen = o; return '{"verdict":"hold","why":"change-misses-reason"}'; } };
    expect(await runReofferJudge(ok, input)).toEqual({ verdict: 'hold', why: 'change-misses-reason' });
    expect(seen?.attribution?.component).toBe(REOFFER_JUDGE_COMPONENT);
    expect(seen?.model).toBe('balanced');
    expect(seen?.provenance?.decisionPoint).toBe(DP_REOFFER_JUDGE);
    expect(seen?.provenance?.optionsPresented).toEqual(['offer', 'hold']);
    expect(await runReofferJudge({ evaluate: async () => { throw new Error('down'); } }, input)).toBeNull();
    expect(await runReofferJudge({ evaluate: async () => 'no idea' }, input)).toBeNull();
  });

  it('failures back off from an hour, doubling, up to a day', () => {
    expect(judgeRetryAfterMs(1)).toBe(60 * 60_000);
    expect(judgeRetryAfterMs(3)).toBe(4 * 60 * 60_000);
    expect(judgeRetryAfterMs(20)).toBe(DAY);
  });
});

describe('the labelled bench', () => {
  it('has both kinds, and every case names a reason the floor allows', () => {
    expect(REOFFER_JUDGE_BENCH.filter((c) => c.expected === 'offer').length).toBeGreaterThanOrEqual(5);
    expect(REOFFER_JUDGE_BENCH.filter((c) => c.expected === 'hold').length).toBeGreaterThanOrEqual(5);
    for (const c of REOFFER_JUDGE_BENCH) expect(c.input.reasonKind === 'change' ? c.input.changes.length : 1).toBeGreaterThan(0);
  });

  it('the gate: the right answers pass; the deterministic default (always hold) fails; one false offer fails; failures never pass', () => {
    const right = REOFFER_JUDGE_BENCH.map((c) => ({ verdict: c.expected, why: c.expected === 'offer' ? OFFER_WHYS[0] : HOLD_WHYS[0] }));
    expect(scoreBench(REOFFER_JUDGE_BENCH, right).passes).toBe(true);
    const hold = REOFFER_JUDGE_BENCH.map(() => ({ verdict: 'hold' as const, why: HOLD_WHYS[3] }));
    expect(scoreBench(REOFFER_JUDGE_BENCH, hold)).toMatchObject({ offerRecall: 0, passes: false });
    const oneFalse = right.map((v, i) => (i === REOFFER_JUDGE_BENCH.findIndex((c) => c.expected === 'hold') ? { verdict: 'offer' as const, why: OFFER_WHYS[0] } : v));
    expect(scoreBench(REOFFER_JUDGE_BENCH, oneFalse).passes).toBe(false);
    expect(scoreBench(REOFFER_JUDGE_BENCH, REOFFER_JUDGE_BENCH.map(() => null))).toMatchObject({ passes: false, failures: REOFFER_JUDGE_BENCH.length });
  });
});

const LIVE = process.env.INSTAR_LIVE_REOFFER_JUDGE === '1';
describe.skipIf(!LIVE)('re-offer judge bench, LIVE model', () => {
  it('the real provider passes the bench gate (graduation before leaving shadow)', async () => {
    const { buildIntelligenceProvider, frameworkFromEnv } = await import('../../src/core/intelligenceProviderFactory.js');
    const provider = buildIntelligenceProvider({ framework: frameworkFromEnv() ?? 'claude-code' });
    if (!provider) { console.warn('[live-reoffer-judge] no provider available, skipping'); return; }
    const verdicts = [];
    for (const c of REOFFER_JUDGE_BENCH) verdicts.push(await runReofferJudge(provider, c.input, { timeoutMs: 120_000 }));
    const score = scoreBench(REOFFER_JUDGE_BENCH, verdicts);
    console.log('[live-reoffer-judge]', JSON.stringify(score));
    expect(score.passes).toBe(true);
  }, 30 * 60_000);
});

describe('review fixes', () => {
  it('a change kind is one the ledger accepts, so spending a change can actually be recorded', async () => {
    const fs = await import('node:fs'); const os = await import('node:os'); const path = await import('node:path'); const crypto = await import('node:crypto');
    const { RecommendedServicesLedger } = await import('../../src/recommended/RecommendedServicesLedger.js');
    const { privateKey } = crypto.generateKeyPairSync('ed25519');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'judge-kind-'));
    const l = new RecommendedServicesLedger({ stateDir: dir, signer: { machineId: () => 'm', signerKeyHash: () => 'h', sign: (p: string) => ({ machineId: 'm', signerKeyHash: 'h', sig: crypto.sign(null, Buffer.from(p), privateKey).toString('base64') }) } as never, keyLookup: (() => ({ status: 'unknown' })) as never });
    expect(changeKind('2027.1 Beta')).toBe('change-2027-1-beta');
    const ev = l.recordReofferEvent({ service: 'tailscale', owner: '42', kind: changeKind('2027.1'), evidenceRef: 'catalog' });
    const done = l.recordReofferDelivered(l.recordReofferPending(ev), 7);
    expect(done.kind).toBe('change-2027-1');
    const row = { ...ROW, changes: [{ version: '2027.1', at: iso(NOW - DAY), summary: 'x', affects: 'setup' as const }] };
    expect(judgedFloor(row, [no(NOW - 10 * DAY)], l.reofferRows(), NOW)).toEqual({ blocked: 'cool-off-running' });
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('refused is the ledger fold, not the newest timestamp: a yes that superseded a later-stamped no is a yes', () => {
    const n = { ...(no(NOW - 200 * DAY) as object), eventId: 'n1', at: iso(NOW - 100 * DAY) } as unknown as LedgerRow;
    const y = { ...(yes(NOW - 120 * DAY) as object), supersedes: ['n1'] } as unknown as LedgerRow;
    expect(judgedFloor(ROW, [n, y], [], NOW)).toEqual({ blocked: 'not-refused' });
    // A no the yes never saw stays live: refused again, now with two nos, so the 180-day cool-off applies.
    const concurrent = { ...(no(NOW - 110 * DAY) as object), eventId: 'n2' } as unknown as LedgerRow;
    expect(judgedFloor(ROW, [n, y, concurrent], [], NOW)).toEqual({ blocked: 'cool-off-running' });
    const older = { ...(no(NOW - 190 * DAY) as object), eventId: 'n2' } as unknown as LedgerRow;
    expect(judgedFloor(ROW, [n, y, older], [], NOW)).toMatchObject({ reason: 'cool-off', nos: 2 });
  });
});
