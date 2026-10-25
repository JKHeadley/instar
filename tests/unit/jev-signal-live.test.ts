/**
 * Jev as a live advisory input to the tone gate's B1–B7 artefact signals.
 * Spec: docs/specs/jev-signal-live.md (Tests — unit tier).
 *
 * No network: every test injects a fetch stub. Both sides of every decision the
 * live path adds are covered: confident vs unsure, detector hit vs miss, live
 * on vs off, answer vs every failure shape, breaker open vs closed.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  JevSignalShadow,
  SHADOW_QUESTIONS,
  mergeLiveSignals,
  buildJevSignalShadow,
  LIVE_BREAKER_FAILURES,
  LIVE_BREAKER_OPEN_MS,
  STALE_SLOT_MS,
  type JevSignalLiveConfig,
} from '../../src/core/JevSignalShadow.js';
import { detectGateSignals, type GateSignal } from '../../src/core/GateSignalDetectors.js';
import { bandFor, DEFAULT_CASCADE_BAND } from '../../src/core/JevCascade.js';
import { MessagingToneGate, TONE_GATE_PROMPT_ID, TONE_GATE_PROMPT_ID_JEV } from '../../src/core/MessagingToneGate.js';
import type { IntelligenceProvider } from '../../src/core/types.js';
import { installDecisionQualityRecorder } from '../../src/core/DecisionQualityRecorderImpl.js';

// Live signals need decision-quality recording to be live (the route otherwise
// turns a migration advisory back into a hard block). Install a stub recorder
// through the production seam; individual tests flip it off.
let recordingLive = true;
beforeEach(() => { recordingLive = true; installDecisionQualityRecorder({ isRecordingLive: () => recordingLive } as never); });
afterEach(() => installDecisionQualityRecorder(null));

const NOW0 = Date.parse('2026-09-29T12:00:00Z');
const PATHY = 'The failure is in /Users/someone/project/src/core/SessionManager.ts around line 400.';
const PLAIN = 'All done — the report is ready for you whenever you want to read it.';
const SECRET = 'ghp_' + 'A'.repeat(36);

const all = (p: number) => Object.fromEntries(SHADOW_QUESTIONS.map((q) => [q.rule, p]));
function okResponse(answers: Record<string, number>, model = 'jev-1.13.0') {
  return {
    ok: true, status: 200,
    json: async () => ({ model, usage: { input_tokens: 10 }, answers: Object.fromEntries(Object.entries(answers).map(([k, v]) => [k, { noul: v }])) }),
  } as unknown as Response;
}

let logPath: string;
let now: number;
beforeEach(() => {
  logPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'jev-live-')), 'logs', 'jev-signal-shadow.jsonl');
  now = NOW0;
});
const rows = () => (fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);

function make(opts: { live?: JevSignalLiveConfig | undefined; fetchImpl?: typeof fetch; key?: string | null; shadowCfg?: Record<string, unknown> } = {}) {
  return new JevSignalShadow({
    // The shadow block itself is OFF: live mode must not depend on it.
    getConfig: () => ({ enabled: false, model: 'jev-1.13.0', ...opts.shadowCfg }) as never,
    getLiveConfig: () => ('live' in opts ? opts.live : { enabled: true, timeoutMs: 50 }),
    readKey: () => (opts.key === undefined ? 'test-key' : opts.key),
    logPath,
    fetchImpl: opts.fetchImpl ?? (async () => okResponse(all(0.02))),
    now: () => now,
  });
}

describe('bandFor — one definition of "unsure" for the referee and the live merge', () => {
  it('per-rule band wins, then the base band, then the default; invalid bands fall through', () => {
    expect(bandFor('x')).toEqual(DEFAULT_CASCADE_BAND);
    expect(bandFor('x', { band: { lo: 0.2, hi: 0.8 } })).toEqual({ lo: 0.2, hi: 0.8 });
    expect(bandFor('x', { band: { lo: 0.2, hi: 0.8 }, bands: { x: { lo: 0.4, hi: 0.6 } } })).toEqual({ lo: 0.4, hi: 0.6 });
    expect(bandFor('x', { bands: { x: { lo: 0.9, hi: 0.1 } } })).toEqual(DEFAULT_CASCADE_BAND);
  });
});

describe('mergeLiveSignals — both sides of every branch', () => {
  const det = detectGateSignals(PATHY); // file-path fires
  it('the fixture fires the file-path detector and nothing else', () => {
    expect(det.map((s) => s.kind)).toEqual(['file-path']);
  });

  it('confident YES with a detector hit keeps the detector evidence, tagged jev', () => {
    const m = mergeLiveSignals(det, { ...all(0.02), raw_path: 0.97 });
    const fp = m.signals.find((s) => s.kind === 'file-path')!;
    expect(fp).toMatchObject({ detected: true, source: 'jev', modelProbability: 0.97 });
    expect(fp.normalizedValue).toBe(det[0].normalizedValue);
    expect(m.sources.raw_path).toBe('jev');
    expect(m.jevUsed).toBe(true);
  });

  it('confident YES without a detector hit ADDS a sample-less model signal', () => {
    const m = mergeLiveSignals([], { ...all(0.02), cron_or_slug: 0.93 });
    expect(m.signals).toEqual([{ kind: 'cron-or-slug', detected: true, source: 'jev', modelProbability: 0.93 }]);
  });

  it('confident NO against a detector hit: the detection STANDS, annotated with the dispute (never hidden or overridden)', () => {
    const m = mergeLiveSignals(det, all(0.03));
    const fp = m.signals.find((s) => s.kind === 'file-path')!;
    expect(fp).toMatchObject({ detected: true, source: 'detector', modelProbability: 0.03 });
    expect(fp.spans?.length).toBeGreaterThan(0);
    expect(m.sources.raw_path).toBe('disputed');
    expect(m.jevUsed).toBe(true);
  });

  it('confident NO without a detector hit adds nothing — and an agreed "nothing here" does not count as shaping', () => {
    const m = mergeLiveSignals([], all(0.03));
    expect(m.signals).toEqual([]);
    expect(m.sources.raw_path).toBe('jev');
    expect(m.jevUsed).toBe(false);
  });

  it('an UNSURE answer falls back to the detector for that kind (tagged, when Jev shaped another kind)', () => {
    const m = mergeLiveSignals(det, { ...all(0.02), raw_path: 0.55, cron_or_slug: 0.95 });
    expect(m.sources.raw_path).toBe('detector-fallback');
    expect(m.signals.find((s) => s.kind === 'file-path')).toMatchObject({ detected: true, source: 'detector' });
  });

  it('a MISSING or non-finite answer falls back to the detector', () => {
    const m = mergeLiveSignals(det, { cli_command: 0.01, raw_path: Number.NaN });
    expect(m.sources.raw_path).toBe('detector-fallback');
    expect(m.sources.config_key).toBe('detector-fallback');
    expect(m.sources.cli_command).toBe('jev');
  });

  it('no confident answer at all ⇒ the detector list comes back untouched (no source tags)', () => {
    const m = mergeLiveSignals(det, all(0.5));
    expect(m.jevUsed).toBe(false);
    expect(m.signals).toBe(det);
  });

  it('a per-rule band override moves the boundary', () => {
    const m = mergeLiveSignals([], { cron_or_slug: 0.65 }, { bands: { cron_or_slug: { lo: 0.4, hi: 0.6 } } });
    expect(m.sources.cron_or_slug).toBe('jev');
    expect(m.signals[0]).toMatchObject({ kind: 'cron-or-slug', detected: true });
  });
});

describe('liveSignals — off means nothing happens', () => {
  it('returns null (no call, no row) when live is off', async () => {
    const f = vi.fn(async () => okResponse(all(0.02)));
    const s = make({ live: { enabled: false }, fetchImpl: f as never });
    expect(s.liveSignals(PATHY)).toBeNull();
    expect(f).not.toHaveBeenCalled();
    expect(rows()).toHaveLength(0);
  });

  it('returns null when there is no live config dependency at all', () => {
    const s = make({ live: undefined });
    expect(s.liveSignals(PATHY)).toBeNull();
  });
});

describe('liveSignals — on', () => {
  it('uses confident answers, writes a live compared row with per-rule sources, and needs no shadow soak', async () => {
    const s = make({ fetchImpl: (async () => okResponse({ ...all(0.02), raw_path: 0.55, cron_or_slug: 0.9 })) as never });
    const r = await s.liveSignals(PATHY)!;
    expect(r.jevUsed).toBe(true);
    expect(r.signals.map((x) => `${x.kind}:${x.detected}:${x.source}`)).toEqual(['file-path:true:detector', 'cron-or-slug:true:jev']);
    const [row] = rows();
    expect(row).toMatchObject({ kind: 'compared', live: true });
    expect(row.liveSources).toMatchObject({ raw_path: 'detector-fallback', cron_or_slug: 'jev', cli_command: 'jev' });
    expect(JSON.stringify(row)).not.toContain('SessionManager');
  });

  it('secret-scrubs the text before it leaves the machine', async () => {
    let sent = '';
    const s = make({ fetchImpl: (async (_u: string, init: RequestInit) => { sent = String(init.body); return okResponse(all(0.02)); }) as never });
    await s.liveSignals(`here is the token ${SECRET} for you`)!;
    expect(sent).not.toContain(SECRET);
    expect(sent).toContain('REDACTED');
  });

  for (const [name, fetchImpl, reason] of [
    ['HTTP error', async () => ({ ok: false, status: 500 }) as Response, 'http-error'],
    ['network throw', async () => { throw new Error('down'); }, 'http-error'],
    ['model mismatch', async () => okResponse(all(0.02), 'jev-2.0.0'), 'model-mismatch'],
  ] as const) {
    it(`${name} ⇒ plain detector signals, row reason ${reason}`, async () => {
      const s = make({ fetchImpl: fetchImpl as never });
      const r = await s.liveSignals(PATHY)!;
      expect(r).toEqual({ signals: detectGateSignals(PATHY), jevUsed: false });
      expect(rows()[0]).toMatchObject({ kind: 'not-compared', reason, live: true });
    });
  }

  it('a response with no usable probabilities is a failure (row no-answers), never an answer', async () => {
    const s = make({ fetchImpl: (async () => okResponse({})) as never });
    const r = await s.liveSignals(PATHY)!;
    expect(r).toEqual({ signals: detectGateSignals(PATHY), jevUsed: false });
    expect(rows()[0]).toMatchObject({ kind: 'not-compared', reason: 'no-answers', live: true });
  });

  it('non-finite probabilities are unusable, not answers (no-answers, counts toward the breaker)', async () => {
    const s = make({ fetchImpl: (async () => okResponse(all(Number.POSITIVE_INFINITY))) as never });
    const r = await s.liveSignals(PATHY)!;
    expect(r.jevUsed).toBe(false);
    expect(rows()[0]).toMatchObject({ kind: 'not-compared', reason: 'no-answers', live: true });
  });

  it('no key ⇒ detector signals and ONE disabled-no-key row per process', async () => {
    const f = vi.fn();
    const s = make({ key: null, fetchImpl: f as never });
    expect((await s.liveSignals(PATHY)!).jevUsed).toBe(false);
    expect((await s.liveSignals(PATHY)!).jevUsed).toBe(false);
    expect(f).not.toHaveBeenCalled();
    expect(rows().map((r) => r.reason)).toEqual(['disabled-no-key']);
  });

  it('a HANGING fetch is bounded: the caller gets detector signals, and the late row says so', async () => {
    let release: (r: Response) => void = () => {};
    const s = make({ live: { enabled: true, timeoutMs: 20 }, fetchImpl: (() => new Promise<Response>((res) => { release = res; })) as never });
    const t0 = Date.now();
    const r = await s.liveSignals(PATHY)!;
    expect(Date.now() - t0).toBeLessThan(2_000);
    expect(r.jevUsed).toBe(false);
    expect(r.signals).toEqual(detectGateSignals(PATHY));
    // The deadline outcome is logged the moment the caller stops waiting.
    expect(rows()).toEqual([expect.objectContaining({ kind: 'not-compared', reason: 'timeout', live: true })]);
    release(okResponse(all(0.9)));
    await s.lastDispatch;
    const row = rows()[1];
    expect(row).toMatchObject({ kind: 'compared', live: true, liveLate: true });
    expect(row.liveSources).toBeUndefined();
  });

  it('a failure landing after the caller deadline does not double-log the candidate', async () => {
    let fail: (e: Error) => void = () => {};
    const s = make({ live: { enabled: true, timeoutMs: 10 }, fetchImpl: (() => new Promise<Response>((_r, rej) => { fail = rej; })) as never });
    await s.liveSignals(PATHY)!;
    fail(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    await s.lastDispatch;
    expect(rows().map((r) => r.reason)).toEqual(['timeout']);
  });

  it('a concurrent candidate falls back (skipped-concurrent); a stuck slot is reclaimed after STALE_SLOT_MS', async () => {
    const f = vi.fn(() => new Promise<Response>(() => {}));
    const s = make({ live: { enabled: true, timeoutMs: 10 }, fetchImpl: f as never });
    await s.liveSignals(PATHY)!;
    await s.liveSignals(PATHY)!;
    expect(f).toHaveBeenCalledTimes(1);
    expect(rows().map((r) => r.reason)).toEqual(['timeout', 'skipped-concurrent']);
    now += STALE_SLOT_MS + 1;
    await s.liveSignals(PATHY)!;
    expect(f).toHaveBeenCalledTimes(2);
  });

  it('retained excerpts stay bound to the shadow soak too', async () => {
    const mk = (shadowCfg: Record<string, unknown>) => make({
      shadowCfg: { retainDisagreementExcerpts: true, ...shadowCfg },
      fetchImpl: (async () => okResponse(all(0.02))) as never, // disagrees with the file-path hit
    });
    const expired = mk({ enabled: true, soakEndsAt: '2026-09-01T00:00:00Z' });
    await expired.liveSignals(PATHY)!;
    const measuring = mk({ enabled: true, soakEndsAt: '2026-12-01T00:00:00Z' });
    await measuring.liveSignals(PATHY)!;
    const [a, b] = rows();
    expect(a.disagree).toContain('raw_path');
    expect(a.excerpt).toBeUndefined();
    expect(b.excerpt).toBeTypeOf('string');
  });

  it('the paid referee stays bound to the shadow soak: live alone never calls it', async () => {
    const referee = { evaluate: vi.fn(async () => '{"raw_path": true}') } as unknown as IntelligenceProvider;
    const mk = (shadowCfg: Record<string, unknown>) => new JevSignalShadow({
      getConfig: () => ({ model: 'jev-1.13.0', referee: { enabled: true, auditRate: 0 }, ...shadowCfg }) as never,
      getLiveConfig: () => ({ enabled: true, timeoutMs: 50 }),
      readKey: () => 'k', logPath, now: () => now, referee,
      fetchImpl: (async () => okResponse({ ...all(0.02), raw_path: 0.5 })) as never,
    });
    const expired = mk({ enabled: true, soakEndsAt: '2026-09-01T00:00:00Z' });
    await expired.liveSignals(PATHY)!; await expired.lastReferee;
    const off = mk({ enabled: false, soakEndsAt: '2026-12-01T00:00:00Z' });
    await off.liveSignals(PATHY)!; await off.lastReferee;
    expect(referee.evaluate).not.toHaveBeenCalled();
    const measuring = mk({ enabled: true, soakEndsAt: '2026-12-01T00:00:00Z' });
    await measuring.liveSignals(PATHY)!; await measuring.lastReferee;
    expect(referee.evaluate).toHaveBeenCalledTimes(1);
  });

  it('a reclaimed stale call that settles later cannot free the slot a newer call holds', async () => {
    const releases: Array<(r: Response) => void> = [];
    const f = vi.fn(() => new Promise<Response>((res) => { releases.push(res); }));
    const s = make({ live: { enabled: true, timeoutMs: 10 }, fetchImpl: f as never });
    await s.liveSignals(PATHY)!;                 // A: hangs
    now += STALE_SLOT_MS + 1;
    await s.liveSignals(PATHY)!;                 // B: reclaims the slot, hangs
    const aDone = s.lastDispatch;
    releases[0](okResponse(all(0.02)));          // A settles late
    await new Promise((r) => setTimeout(r, 0));
    await s.liveSignals(PATHY)!;                 // C: B still holds the slot ⇒ must fall back
    expect(f).toHaveBeenCalledTimes(2);
    expect(rows().some((r) => r.reason === 'skipped-concurrent')).toBe(true);
    void aDone;
  });

  it('missed deadlines count toward the breaker, and a late success resets nothing', async () => {
    const releases: Array<(r: Response) => void> = [];
    const f = vi.fn(() => new Promise<Response>((res) => { releases.push(res); }));
    const s = make({ live: { enabled: true, timeoutMs: 10 }, fetchImpl: f as never });
    for (let i = 0; i < LIVE_BREAKER_FAILURES; i++) {
      await s.liveSignals(PATHY)!;               // deadline wins
      releases[i](okResponse(all(0.02)));        // the answer lands late
      await s.lastDispatch;
    }
    expect(rows().filter((r) => r.reason === 'breaker-open')).toHaveLength(1);
    await s.liveSignals(PATHY)!;
    expect(f).toHaveBeenCalledTimes(LIVE_BREAKER_FAILURES);
  });

  it(`the breaker opens after ${LIVE_BREAKER_FAILURES} failures, skips the vendor, and closes after ${LIVE_BREAKER_OPEN_MS} ms`, async () => {
    const f = vi.fn(async () => ({ ok: false, status: 503 }) as Response);
    const s = make({ fetchImpl: f as never });
    for (let i = 0; i < LIVE_BREAKER_FAILURES; i++) { await s.liveSignals(PATHY)!; await s.lastDispatch; }
    expect(f).toHaveBeenCalledTimes(LIVE_BREAKER_FAILURES);
    const open = await s.liveSignals(PATHY)!;
    expect(open.jevUsed).toBe(false);
    expect(f).toHaveBeenCalledTimes(LIVE_BREAKER_FAILURES);
    expect(rows().filter((r) => r.reason === 'breaker-open')).toHaveLength(1);
    now += LIVE_BREAKER_OPEN_MS;
    await s.liveSignals(PATHY)!;
    expect(f).toHaveBeenCalledTimes(LIVE_BREAKER_FAILURES + 1);
  });

  it('a success resets the failure count (the breaker needs CONSECUTIVE failures)', async () => {
    let fail = true;
    const f = vi.fn(async () => (fail ? ({ ok: false, status: 503 }) as Response : okResponse(all(0.02))));
    const s = make({ fetchImpl: f as never });
    for (let i = 0; i < LIVE_BREAKER_FAILURES - 1; i++) { await s.liveSignals(PATHY)!; }
    fail = false; await s.liveSignals(PATHY)!;
    fail = true;
    for (let i = 0; i < LIVE_BREAKER_FAILURES - 1; i++) { await s.liveSignals(PATHY)!; }
    await s.liveSignals(PATHY)!;
    expect(f).toHaveBeenCalledTimes(2 * LIVE_BREAKER_FAILURES);
    expect(rows().filter((r) => r.reason === 'breaker-open')).toHaveLength(1);
  });
});

describe('MessagingToneGate — live signals reach the judge only where B1–B7 are overridable', () => {
  function gate(shadow: JevSignalShadow, advisoryMigration: boolean) {
    const evaluate = vi.fn(async (_p: string, _o: unknown) => JSON.stringify({ pass: true, rule: '', issue: '', suggestion: '' }));
    const g = new MessagingToneGate({ evaluate } as unknown as IntelligenceProvider, { advisoryMigration });
    g.setSignalShadow(shadow);
    const call = () => ({ prompt: evaluate.mock.calls[0][0] as string, opts: evaluate.mock.calls[0][1] as { provenance: { promptId: string; context: { gateSignalKinds: string[] } } } });
    return { g, call };
  }
  const ctx = { channel: 'telegram', messageKind: 'reply', liveArtefactSignals: true } as never;
  const strip = (p: string) => p.replace(/[A-Z_]+_BOUNDARY_[0-9a-f]{16}/g, 'B');

  it('advisory migration OFF ⇒ liveSignals is never consulted (Jev cannot feed a blocking rule)', async () => {
    const f = vi.fn(async () => okResponse({ ...all(0.02), cron_or_slug: 0.95 }));
    const { g, call } = gate(make({ fetchImpl: f as never }), false);
    await g.review(PATHY, ctx);
    expect(f).not.toHaveBeenCalled();
    expect(call().opts.provenance.promptId).toBe(TONE_GATE_PROMPT_ID);
    expect(call().prompt).toContain('ARTIFACT SIGNALS (B1–B7, deterministic');
  });

  it('a caller that does not opt in (no override path) never gets live signals', async () => {
    const f = vi.fn(async () => okResponse({ ...all(0.02), cron_or_slug: 0.95 }));
    const { g, call } = gate(make({ fetchImpl: f as never }), true);
    await g.review(PATHY, { channel: 'telegram', messageKind: 'reply' } as never);
    expect(f).not.toHaveBeenCalled();
    expect(call().opts.provenance.promptId).toBe(TONE_GATE_PROMPT_ID);
  });

  it('decision-quality recording NOT live ⇒ liveSignals is never consulted (the route would harden the advisory)', async () => {
    // Enforced by the production factory (buildJevSignalShadow), reading the real recorder.
    const build = () => buildJevSignalShadow({
      readLiveIntelligence: () => ({ jevSignalLive: { timeoutMs: 200 } }),
      readSecret: () => 'k',
      stateDir: path.dirname(path.dirname(logPath)),
      fetchImpl: f as never,
      developmentAgent: true,
    });
    const f = vi.fn(async () => okResponse({ ...all(0.02), cron_or_slug: 0.95 }));
    recordingLive = false;
    const off = gate(build(), true);
    await off.g.review(PATHY, ctx);
    expect(f).not.toHaveBeenCalled();
    expect(off.call().opts.provenance.promptId).toBe(TONE_GATE_PROMPT_ID);
    // Control: the same factory with recording live does consult Jev.
    recordingLive = true;
    const on = gate(build(), true);
    await on.g.review(PATHY, ctx);
    expect(f).toHaveBeenCalledTimes(1);
    expect(on.call().opts.provenance.promptId).toBe(TONE_GATE_PROMPT_ID_JEV);
  });

  it('advisory migration ON + confident Jev ⇒ live section, jev promptId, merged provenance kinds', async () => {
    const f = vi.fn(async () => okResponse({ ...all(0.02), cron_or_slug: 0.95 }));
    const { g, call } = gate(make({ fetchImpl: f as never }), true);
    await g.review(PATHY, ctx);
    const { prompt, opts } = call();
    expect(prompt).toContain('the Jev model where it is confident');
    expect(prompt).toContain('- cron-or-slug: detected=true source=jev model_p=0.95 (model judgment; no deterministic match — cite the artifact from the candidate text)');
    // The detector's file-path hit still counts as detected, with Jev's disagreement noted.
    expect(prompt).toMatch(/- file-path: detected=true source=detector model_p=0\.02 spans=1 .*sample=.*model_disagrees/);
    // A model-only line may be cited from the candidate text.
    expect(prompt).toContain('you MAY locate the artifact in the candidate');
    expect(opts.provenance.promptId).toBe(TONE_GATE_PROMPT_ID_JEV);
    expect(opts.provenance.context.gateSignalKinds).toEqual(['file-path', 'cron-or-slug']);
  });

  it('advisory migration ON + confident agreed "nothing here" ⇒ prompt and promptId identical to live off', async () => {
    const agreed = make({ fetchImpl: (async () => okResponse(all(0.02))) as never });
    const off = make({ live: { enabled: false } });
    const a = gate(agreed, true); await a.g.review(PLAIN, ctx);
    const b = gate(off, true); await b.g.review(PLAIN, ctx);
    expect(strip(a.call().prompt)).toBe(strip(b.call().prompt));
    expect(a.call().opts.provenance.promptId).toBe(TONE_GATE_PROMPT_ID);
  });

  it('advisory migration ON but no confident answer ⇒ prompt and promptId identical to live off', async () => {
    const unsure = make({ fetchImpl: (async () => okResponse(all(0.5))) as never });
    const off = make({ live: { enabled: false } });
    const a = gate(unsure, true); await a.g.review(PATHY, ctx);
    const b = gate(off, true); await b.g.review(PATHY, ctx);
    expect(strip(a.call().prompt)).toBe(strip(b.call().prompt));
    expect(a.call().opts.provenance.promptId).toBe(TONE_GATE_PROMPT_ID);
    expect(a.call().opts.provenance.context.gateSignalKinds).toEqual(['file-path']);
  });

  it('live off ⇒ the detached observe() path still runs (measurement continues)', async () => {
    const observe = vi.fn();
    const evaluate = vi.fn(async () => JSON.stringify({ pass: true, rule: '', issue: '', suggestion: '' }));
    const g = new MessagingToneGate({ evaluate } as unknown as IntelligenceProvider, { advisoryMigration: true });
    g.setSignalShadow({ observe, liveSignals: () => null });
    await g.review(PLAIN, ctx);
    expect(observe).toHaveBeenCalledWith(PLAIN);
  });

  it('an operator timeoutMs is clamped: a huge value cannot make the gate wait long', async () => {
    const s = make({ live: { enabled: true, timeoutMs: 600_000 }, fetchImpl: (() => new Promise(() => {})) as never });
    const t0 = Date.now();
    await s.liveSignals(PATHY)!;
    expect(Date.now() - t0).toBeLessThan(5_000);
  });

  it('live on ⇒ observe() is NOT also called (one vendor call per message, not two)', async () => {
    const observe = vi.fn();
    const evaluate = vi.fn(async () => JSON.stringify({ pass: true, rule: '', issue: '', suggestion: '' }));
    const g = new MessagingToneGate({ evaluate } as unknown as IntelligenceProvider, { advisoryMigration: true });
    const live: GateSignal[] = [];
    g.setSignalShadow({ observe, liveSignals: () => Promise.resolve({ signals: live, jevUsed: true }) });
    await g.review(PLAIN, ctx);
    expect(observe).not.toHaveBeenCalled();
    expect(evaluate.mock.calls[0][0]).toContain('(no artifact signals)');
  });

  it('a THROWING liveSignals cannot break the gate', async () => {
    const evaluate = vi.fn(async () => JSON.stringify({ pass: true, rule: '', issue: '', suggestion: '' }));
    const g = new MessagingToneGate({ evaluate } as unknown as IntelligenceProvider, { advisoryMigration: true });
    g.setSignalShadow({ observe: () => {}, liveSignals: () => { throw new Error('boom'); } });
    const r = await g.review(PATHY, ctx);
    expect(r.pass).toBe(true);
  });
});
