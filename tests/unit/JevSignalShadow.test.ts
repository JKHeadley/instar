/**
 * JevSignalShadow — the dark, measure-only Jev comparison.
 * Spec: docs/specs/jev-signal-layer-shadow.md
 *
 * No network: every test injects a fetch stub. The contract under test is the
 * one that makes the shadow safe — it decides nothing, is never awaited, stays
 * inert outside its soak window, and never records message text.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JevSignalShadow, SHADOW_QUESTIONS, JEV_SHADOW_FEATURE, KEY_REREAD_MS } from '../../src/core/JevSignalShadow.js';
import { GATE_SIGNAL_KINDS } from '../../src/core/GateSignalDetectors.js';

const NOW = Date.parse('2026-09-21T12:00:00Z');
const FUTURE = '2026-10-05T12:00:00Z';
const PATHY = 'The failure is in /Users/someone/project/src/core/SessionManager.ts around line 400.';
const SECRET_TEXT = 'a very specific sentence that must never appear in the log';

let dir: string;
let logPath: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-shadow-'));
  logPath = path.join(dir, 'logs', 'jev-signal-shadow.jsonl');
});
const rows = () => (fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);

function okResponse(answers: Record<string, number>, model = 'jev-1.13.0') {
  return {
    ok: true, status: 200,
    json: async () => ({
      model,
      usage: { input_tokens: 321 },
      answers: Object.fromEntries(Object.entries(answers).map(([k, v]) => [k, { noul: v }])),
    }),
  } as unknown as Response;
}
const allLow = () => Object.fromEntries(SHADOW_QUESTIONS.map((q) => [q.rule, 0.02]));

function make(opts: {
  cfg?: Record<string, unknown>;
  key?: string | null;
  fetchImpl?: typeof fetch;
  random?: () => number;
  metrics?: Array<Record<string, unknown>>;
}) {
  const metrics = opts.metrics ?? [];
  return new JevSignalShadow({
    getConfig: () => ({ enabled: true, soakEndsAt: FUTURE, model: 'jev-1.13.0', timeoutMs: 200, ...opts.cfg }) as never,
    readKey: () => (opts.key === undefined ? 'test-key' : opts.key),
    logPath,
    metrics: { record: (r) => metrics.push(r) },
    fetchImpl: opts.fetchImpl ?? (async () => okResponse(allLow())),
    now: () => NOW,
    random: opts.random,
  });
}

describe('the comparison contract is frozen and complete', () => {
  it('asks one question per B1–B7 detector kind, and no kind is left uncovered', () => {
    const kinds = SHADOW_QUESTIONS.map((q) => q.signalKind).sort();
    expect(kinds).toEqual([...GATE_SIGNAL_KINDS].sort());
  });
});

describe('inert unless enabled, in-window, and keyed', () => {
  it('writes nothing when disabled (the shipped default)', async () => {
    const s = make({ cfg: { enabled: false } });
    s.observe(PATHY); await s.lastDispatch;
    expect(rows()).toHaveLength(0);
  });

  it('is inert with a missing soakEndsAt — one soak-expired status row, not one per message', async () => {
    let calls = 0;
    const s = make({ cfg: { soakEndsAt: null }, fetchImpl: (async () => { calls++; return okResponse(allLow()); }) as never });
    s.observe(PATHY); s.observe(PATHY); await s.lastDispatch;
    expect(calls).toBe(0);
    expect(rows().map((r) => r.reason)).toEqual(['soak-expired']);
  });

  it('is inert past soakEndsAt', async () => {
    let calls = 0;
    const s = make({ cfg: { soakEndsAt: '2026-09-20T00:00:00Z' }, fetchImpl: (async () => { calls++; return okResponse(allLow()); }) as never });
    s.observe(PATHY); await s.lastDispatch;
    expect(calls).toBe(0);
    expect(rows()[0].reason).toBe('soak-expired');
  });

  it('is inert with no vault key — one disabled-no-key row', async () => {
    const s = make({ key: null });
    s.observe(PATHY); s.observe(PATHY); await s.lastDispatch;
    expect(rows().map((r) => r.reason)).toEqual(['disabled-no-key']);
  });
});

describe('comparison rows', () => {
  it('records a compared row with detector kinds, probabilities and disagreements — never the text', async () => {
    const answers = { ...allLow(), raw_path: 0.97 };
    const s = make({ fetchImpl: (async () => okResponse(answers)) as never });
    s.observe(PATHY); await s.lastDispatch;
    const [r] = rows();
    expect(r.kind).toBe('compared');
    expect(r.detectorSignals).toContain('file-path');
    expect(r.jev.raw_path).toBe(0.97);
    expect(r.disagree).toEqual([]);          // Jev and the detector agree
    expect(r.modelServed).toBe('jev-1.13.0');
    expect(JSON.stringify(r)).not.toContain('SessionManager');
  });

  it('flags a disagreement when Jev and the detector differ', async () => {
    const s = make({ fetchImpl: (async () => okResponse(allLow())) as never });
    s.observe(PATHY); await s.lastDispatch;
    expect(rows()[0].disagree).toEqual(['raw_path']); // detector saw a path, Jev said no
  });

  it('excludes a response from a different model (model-mismatch)', async () => {
    const s = make({ fetchImpl: (async () => okResponse(allLow(), 'jev-1.14.0')) as never });
    s.observe(PATHY); await s.lastDispatch;
    expect(rows()[0]).toMatchObject({ kind: 'not-compared', reason: 'model-mismatch' });
  });
});

describe('every closed-set not-compared reason is reachable, and none carries text', () => {
  it('http-error — and the vendor body is never recorded', async () => {
    const s = make({ fetchImpl: (async () => ({ ok: false, status: 500, json: async () => ({ detail: SECRET_TEXT }) })) as never });
    s.observe(SECRET_TEXT); await s.lastDispatch;
    const [r] = rows();
    expect(r.reason).toBe('http-error');
    expect(JSON.stringify(r)).not.toContain('specific sentence');
  });

  it('timeout — the request is aborted at timeoutMs', async () => {
    const hanging: typeof fetch = (_u, init) => new Promise((_res, rej) => {
      (init?.signal as AbortSignal).addEventListener('abort', () => { const e = new Error('aborted'); e.name = 'AbortError'; rej(e); });
    });
    const s = new JevSignalShadow({
      getConfig: () => ({ enabled: true, soakEndsAt: FUTURE, timeoutMs: 30 }) as never,
      readKey: () => 'k', logPath, fetchImpl: hanging, now: () => NOW,
    });
    s.observe(PATHY); await s.lastDispatch;
    expect(rows()[0].reason).toBe('timeout');
  });

  it('oversize', async () => {
    const s = new JevSignalShadow({
      getConfig: () => ({ enabled: true, soakEndsAt: FUTURE }) as never,
      readKey: () => 'k', logPath, fetchImpl: (async () => okResponse(allLow())) as never, now: () => NOW, maxScanBytes: 10,
    });
    s.observe(PATHY); await s.lastDispatch;
    expect(rows()[0].reason).toBe('oversize');
  });

  it('skipped-sample', async () => {
    const s = make({ cfg: { sampleRate: 0.1 }, random: () => 0.9 });
    s.observe(PATHY); await s.lastDispatch;
    expect(rows()[0].reason).toBe('skipped-sample');
  });

  it('skipped-concurrent — single flight, the overflow is a row not a queue', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const s = make({ fetchImpl: (async () => { await gate; return okResponse(allLow()); }) as never });
    s.observe(PATHY);
    s.observe(PATHY);                // arrives while the first is in flight
    const first = s.lastDispatch;
    release(); await first;
    const reasons = rows().map((r) => r.kind === 'compared' ? 'compared' : r.reason);
    expect(reasons).toContain('skipped-concurrent');
    expect(reasons).toContain('compared');
  });
});

describe('isolation from the message path', () => {
  it('observe() returns synchronously even while the network call hangs', () => {
    const s = make({ fetchImpl: (() => new Promise(() => {})) as never });
    const t0 = performance.now();
    s.observe(PATHY);
    expect(performance.now() - t0).toBeLessThan(50);
  });

  it('observe() never throws, even when config and key reads throw', () => {
    const s = new JevSignalShadow({
      getConfig: () => { throw new Error('boom'); },
      readKey: () => { throw new Error('boom'); },
      logPath,
    });
    expect(() => s.observe(PATHY)).not.toThrow();
  });

  it('reads the vault key once and caches it', async () => {
    let reads = 0;
    const s = new JevSignalShadow({
      getConfig: () => ({ enabled: true, soakEndsAt: FUTURE }) as never,
      readKey: () => { reads++; return 'k'; },
      logPath, fetchImpl: (async () => okResponse(allLow())) as never, now: () => NOW,
    });
    s.observe(PATHY); await s.lastDispatch;
    s.observe(PATHY); await s.lastDispatch;
    expect(reads).toBe(1);
  });
});

describe('the vault key is never read per message (it can block on a keychain lookup)', () => {
  it('reads at construction, not on the first message', () => {
    let reads = 0;
    new JevSignalShadow({ getConfig: () => ({ enabled: false }) as never, readKey: () => { reads++; return 'k'; }, logPath });
    expect(reads).toBe(1);
  });

  it('after a 401, re-reads at most once per KEY_REREAD_MS', async () => {
    let t = NOW;
    let reads = 0;
    const s = new JevSignalShadow({
      getConfig: () => ({ enabled: true, soakEndsAt: FUTURE }) as never,
      readKey: () => { reads++; return 'k'; },
      logPath,
      fetchImpl: (async () => ({ ok: false, status: 401, json: async () => ({}) })) as never,
      now: () => t,
    });
    s.observe(PATHY); await s.lastDispatch;           // 401 → key dropped
    for (let i = 0; i < 5; i++) { t += 1000; s.observe(PATHY); await s.lastDispatch; }
    expect(reads).toBe(1);                              // no per-message re-read
    t += KEY_REREAD_MS; s.observe(PATHY); await s.lastDispatch;
    expect(reads).toBe(2);
  });

  it('a key added to the vault later is picked up without a restart', async () => {
    let t = NOW;
    let key: string | null = null;
    let calls = 0;
    const s = new JevSignalShadow({
      getConfig: () => ({ enabled: true, soakEndsAt: FUTURE }) as never,
      readKey: () => key, logPath,
      fetchImpl: (async () => { calls++; return okResponse(allLow()); }) as never,
      now: () => t,
    });
    s.observe(PATHY); await s.lastDispatch;
    key = 'k'; t += KEY_REREAD_MS;
    s.observe(PATHY); await s.lastDispatch;
    expect(calls).toBe(1);
  });
});

describe('token-audit visibility', () => {
  it('meters every call into the feature-metrics funnel', async () => {
    const metrics: Array<Record<string, unknown>> = [];
    const s = make({ metrics });
    s.observe(PATHY); await s.lastDispatch;
    expect(metrics).toHaveLength(1);
    expect(metrics[0]).toMatchObject({ feature: JEV_SHADOW_FEATURE, kind: 'llm', tokensIn: 321, tokensOut: 0, model: 'jev-1.13.0' });
  });
});
